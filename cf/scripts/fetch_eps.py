"""投資分析ページ(cf/<コード>/)の銘柄について、EPS と BPS の過去10年分の推移を EDINET から集める。

- 有価証券報告書の「主要な経営指標等の推移」には5期分の1株当たり当期純利益(EPS)と
  1株当たり純資産(BPS)が載る。最新の報告書と、その4年前の報告書…と、1年ずつ重ねてつなぐ
- 古い報告書の数字は、その後の株式分割を反映していない。重なった年の BPS(と EPS)の比が
  分割の比率(1/2、1/3 など)に近ければ、古い年の数字をその比率でそろえる
- 連結の数字を優先し、ない会社は単体の数字を使う。IFRS・米国基準の数字があればそちらを優先する

GitHub Actions(.github/workflows/update-cf-eps.yml)から実行される。
書類一覧の確認に時間がかかるので TIME_LIMIT(秒)で打ち切り、途中までの結果を保存して次回に続きを取る。
EDINET_API_KEY(環境変数)が必要。
"""

import io
import json
import os
import re
import sys
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

EDINET_API = "https://api.edinet-fsa.go.jp/api/v2"
SCAN_DAYS = 3700  # 10年前の有価証券報告書まで届くように
YEARS = 10
TIME_LIMIT = int(os.environ.get("TIME_LIMIT", 100 * 60))
WORKERS = 3
CF_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = CF_DIR / "data"
DOCS_PATH = DATA_DIR / "eps_docs.json"
OUT_PATH = DATA_DIR / "eps.json"
VERSION = 6  # eps.json の読み方の版。上げると全部読み直す
JST = timezone(timedelta(hours=9))
HEADERS = {"User-Agent": "portal-cf-eps"}

# 主要な経営指標等の推移の1株当たりの数字。単位が「円/株」の要素から探す
# - EPS: 期間の値で、要素名が BasicEarnings…PerShare…(IFRS・米国基準などで名前が少しずつ違う)
# - BPS: 時点の値すべて(J-GAAP は NetAssetsPerShare、IFRS は要素名が EquityToAssetRatioIFRS… になっている)
SUMMARY = "SummaryOfBusinessResults"
EPS_RE = re.compile(r"^BasicEarnings\w*PerShare\w*" + SUMMARY + "$")
EPS_EXCLUDE_RE = re.compile(r"Diluted|ContinuingOperations|DiscontinuedOperations|Adjusted")
BPS_RE = re.compile(SUMMARY + "$")
BPS_EXCLUDE_RE = re.compile(r"Dividend|NumberOf")
# 発行済株式総数(株式分割の検出に使う)
SHARES_RE = re.compile(r"^TotalNumberOfIssuedShares\w*" + SUMMARY + "$")
CTX_RE = re.compile(r"^(CurrentYear|Prior([1-4])Year)(Duration|Instant)(_NonConsolidatedMember)?$")
# 分割・併合の比率(新しい報告書の数字 / 古い報告書の数字)
SPLITS = [1 / n for n in (1.1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 20, 25, 50, 100)] + [2, 3, 4, 5, 10]

START = time.monotonic()


def log(*a):
    print(*a, flush=True)


def out_of_time():
    return time.monotonic() - START > TIME_LIMIT


def get(url, params, retries=3):
    last = None
    for attempt in range(1, retries + 1):
        try:
            r = requests.get(url, params=params, headers=HEADERS, timeout=90)
            if r.status_code == 200:
                return r
            last = f"HTTP {r.status_code}"
            if r.status_code in (400, 401, 403, 404):
                break
        except requests.RequestException as e:
            last = e
        time.sleep(3 * attempt)
    raise RuntimeError(f"{url}: {last}")


def load(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n", encoding="utf-8")


def target_codes():
    return sorted(p.name for p in CF_DIR.iterdir() if p.is_dir() and re.fullmatch(r"\d{3}[0-9A-Z]", p.name) and (p / "index.html").exists())


# ---------- 1. 書類一覧から対象銘柄の有価証券報告書を探す ----------

def scan_documents(key, codes):
    cache = load(DOCS_PATH, {"codes": [], "scanned": [], "docs": {}})
    if set(codes) - set(cache["codes"]):
        # 新しい銘柄のページが増えたら、10年分を確認し直す
        log("新しい銘柄があるため、書類一覧を最初から確認します")
        cache["scanned"] = []
    cache["codes"] = codes
    want = set(codes)
    scanned = set(cache["scanned"])
    today = datetime.now(JST).date()
    first = today - timedelta(days=SCAN_DAYS)
    days = [first + timedelta(days=i) for i in range((today - first).days)]  # 今日の分は次回
    todo = sorted((d for d in days if d.weekday() < 5 and d.isoformat() not in scanned), reverse=True)
    log(f"書類一覧: {len(todo)} 日分を確認します")

    def work(d):
        if out_of_time():
            return d, None
        try:
            return d, get(f"{EDINET_API}/documents.json", {"date": d.isoformat(), "type": 2, "Subscription-Key": key}).json()
        except Exception as e:  # noqa: BLE001
            log(f"  {d}: {e}")
            return d, None

    with ThreadPoolExecutor(WORKERS) as ex:
        for n, (d, res) in enumerate(ex.map(work, todo)):
            if res is None:
                continue
            for doc in res.get("results") or []:
                sec = (doc.get("secCode") or "").strip()
                code = sec[:4].upper()
                if len(sec) != 5 or code not in want or doc.get("docTypeCode") != "120":
                    continue
                if doc.get("ordinanceCode") != "010" or doc.get("formCode") != "030000" or not doc.get("periodEnd"):
                    continue
                entry = [doc["submitDateTime"][:10], doc["periodEnd"], doc["docID"], doc.get("csvFlag") == "1"]
                lst = cache["docs"].setdefault(code, [])
                if entry[2] not in {x[2] for x in lst}:
                    lst.append(entry)
            scanned.add(d.isoformat())
            if n % 200 == 199:
                cache["scanned"] = sorted(scanned)
                save(DOCS_PATH, cache)
                log(f"  {n + 1} 日分まで確認")
    if out_of_time():
        log("時間切れのため、書類一覧の確認を途中で止めます")
    first_s = first.isoformat()
    cache["scanned"] = sorted(s for s in scanned if s >= first_s)
    for code in list(cache["docs"]):
        cache["docs"][code] = sorted(x for x in cache["docs"][code] if x[0] >= first_s and code in want)
        if not cache["docs"][code]:
            del cache["docs"][code]
    save(DOCS_PATH, cache)
    log(f"有価証券報告書が見つかった銘柄: {len(cache['docs'])} / {len(codes)}")
    return cache


# ---------- 2. 有価証券報告書から EPS・BPS を読む ----------

def read_csv(key, doc_id):
    r = get(f"{EDINET_API}/documents/{doc_id}", {"type": 5, "Subscription-Key": key})
    z = zipfile.ZipFile(io.BytesIO(r.content))
    rows = []
    for name in z.namelist():
        if not name.endswith(".csv"):
            continue
        for line in z.read(name).decode("utf-16", "replace").splitlines():
            cells = [c.strip('"') for c in line.split("\t")]
            if len(cells) >= 9 and SUMMARY in cells[0] and ("PerShare" in cells[6] or "TotalNumberOfIssuedShares" in cells[0]):
                rows.append((cells[0], cells[2], cells[-1].replace(",", "")))
    return rows


XBRL_RE = re.compile(r"<([\w-]+:\w*SummaryOfBusinessResults)\b([^>]*)>([^<]*)<")
CTXREF_RE = re.compile(r'contextRef="([^"]+)"')
UNITREF_RE = re.compile(r'unitRef="([^"]*PerShare[^"]*)"')
SHARES_ELEM_RE = re.compile(r":TotalNumberOfIssuedShares")


def read_xbrl(key, doc_id):
    r = get(f"{EDINET_API}/documents/{doc_id}", {"type": 1, "Subscription-Key": key})
    z = zipfile.ZipFile(io.BytesIO(r.content))
    rows = []
    for name in z.namelist():
        if "PublicDoc" in name and name.endswith(".xbrl"):
            text = z.read(name).decode("utf-8", "replace")
            for elem, attrs, val in XBRL_RE.findall(text):
                m = CTXREF_RE.search(attrs)
                if m and (UNITREF_RE.search(attrs) or SHARES_ELEM_RE.search(elem)):
                    rows.append((elem, m.group(1), val.strip()))
    return rows


def basis(name):
    for b in ("IFRS", "USGAAP", "JMIS"):
        if b in name:
            return b
    return "JGAAP"


BASIS_ORDER = {"IFRS": 0, "USGAAP": 1, "JMIS": 2, "JGAAP": 3}


def pick(rows, name_re, exclude_re, kind):
    """kind(Duration か Instant)の値から {何期前: (値, 会計基準, 単体か)} を返す。
    連結を優先し、同じ期に複数の基準があれば IFRS などを優先する"""
    found = {}
    for elem, ctx, val in rows:
        name = elem.split(":")[-1]
        if not name_re.search(name) or (exclude_re and exclude_re.search(name)):
            continue
        m = CTX_RE.match(ctx)
        if not m or m.group(3) != kind:
            continue
        try:
            v = float(val)
        except ValueError:
            continue
        back, single = int(m.group(2) or 0), bool(m.group(4))
        cand = (single, BASIS_ORDER[basis(name)])
        if back not in found or cand < found[back][0]:
            found[back] = (cand, v, basis(name), single)
    if any(not f[3] for f in found.values()):  # 連結があれば単体は使わない
        found = {k: f for k, f in found.items() if not f[3]}
    return {k: (f[1], f[2], f[3]) for k, f in found.items()}


def shift_years(period_end, n):
    y, m, _ = map(int, period_end.split("-"))
    return f"{y - n:04d}-{m:02d}"


def read_doc(key, entry):
    _, period_end, doc_id, csv = entry
    rows = read_csv(key, doc_id) if csv else []
    eps, bps = pick(rows, EPS_RE, EPS_EXCLUDE_RE, "Duration"), pick(rows, BPS_RE, BPS_EXCLUDE_RE, "Instant")
    if not eps and not bps:
        rows = read_xbrl(key, doc_id)
        eps, bps = pick(rows, EPS_RE, EPS_EXCLUDE_RE, "Duration"), pick(rows, BPS_RE, BPS_EXCLUDE_RE, "Instant")
    names = sorted({e.split(":")[-1] for e, c, _ in rows if c.startswith("CurrentYear") and "NonConsolidated" not in c})
    if names and (any(v[2] for v in eps.values()) or any(v[2] for v in bps.values())):
        # 連結の1株当たりの要素があるのに単体の数字を使ったときは、取りこぼしを確認できるように出しておく
        log(f"  {doc_id}: 連結の EPS・BPS が見つかりません。連結の1株当たりの要素: {names}")
    res = {"eps": {}, "bps": {}, "basis": {}, "single": False, "shares": {}}
    for back, (v, _, _) in pick(rows, SHARES_RE, None, "Instant").items():
        res["shares"][shift_years(period_end, back)] = v
    for k, vals in (("eps", eps), ("bps", bps)):
        for back, (v, b, single) in vals.items():
            ym = shift_years(period_end, back)
            res[k][ym] = v
            res["basis"].setdefault(ym, b)  # EPS の基準を優先
            res["single"] = res["single"] or single
    return res


# ---------- 3. 報告書をつなぐ ----------

def chain(docs):
    """最新の報告書から、5期分が1年ずつ重なるように古い報告書を選ぶ"""
    by_period = {}
    for d in sorted(docs):  # 同じ期の報告書は、あとに出したもの
        by_period[d[1][:7]] = d
    periods = sorted(by_period, reverse=True)
    if not periods:
        return []
    picked = [by_period[periods[0]]]
    earliest = shift_years(periods[0] + "-01", 4)
    while True:
        cur = picked[-1][1][:7]
        if shift_years(periods[0] + "-01", YEARS - 1) >= earliest:
            break
        older = [p for p in periods if earliest <= p < cur]
        if not older:
            break
        p = min(older)  # 重なりを1年に抑えて、いちばん古くまで届くもの
        picked.append(by_period[p])
        earliest = shift_years(p + "-01", 4)
    return picked


def split_ratio(new, old):
    """重なった年の 新/古 の比が分割の比率に近ければ、その比率を返す。ほぼ同じなら 1、合わなければ None"""
    if not new or not old or (new > 0) != (old > 0):
        return None
    r = new / old
    if abs(r - 1) < 0.03:
        return 1
    for s in SPLITS:
        if abs(r / s - 1) < 0.04:
            return s
    return None


def adjust_splits(years, eps, bps, shares, notes):
    """報告書の中でも、古い年が分割前の株数のまま載っていることがある。
    発行済株式総数が k 倍になった年(期末より後の分割は前期の数字だけ直されるので、その1年前も見る)に
    BPS がおよそ 1/k になっていれば、それより前の年を 1/k 倍する"""
    for j in range(len(years) - 1, 0, -1):
        s0, s1 = shares.get(years[j - 1]), shares.get(years[j])
        if not (s0 and s1) or 0.75 < s1 / s0 < 1.3:
            continue
        k = s1 / s0
        k = next((1 / s for s in SPLITS if abs(k * s - 1) < 0.05), k)
        for i in (j, j - 1):
            if i < 1:
                continue
            b0, b1 = bps.get(years[i - 1]), bps.get(years[i])
            if b0 and b1 and b0 > 0 and b1 > 0 and 0.6 < b1 / b0 * k < 1.6:
                for d in (eps, bps):
                    for y in years[:i]:
                        if d.get(y) is not None:
                            d[y] = round(d[y] / k, 2)
                notes.append(f"{years[i]}より前を {1 / k:.4g} 倍")
                break


def combine(results):
    """新しい順の読み取り結果をつないで、古い年の数字を分割にあわせてそろえる"""
    eps, bps, bas, shares, notes = {}, {}, {}, {}, []
    for res in results:
        for ym, v in res.get("shares", {}).items():
            shares.setdefault(ym, v)
    for i, res in enumerate(results):
        if i == 0:
            eps, bps, bas = dict(res["eps"]), dict(res["bps"]), dict(res["basis"])
            continue
        overlap = sorted((set(bps) & set(res["bps"])) | (set(eps) & set(res["eps"])), reverse=True)
        factor = 1
        if overlap:
            y = overlap[0]
            fb = split_ratio(bps.get(y), res["bps"].get(y))
            fe = split_ratio(eps.get(y), res["eps"].get(y))
            if fb is not None and (fe is None or fe == fb):
                factor = fb
            elif fb is None and fe is not None:
                factor = fe
            if factor != 1:
                notes.append(f"{y}より前を {factor:.4g} 倍")
        first = min(set(eps) | set(bps), default="9999")  # 決算期の変更で年がずれても、新しい報告書の年と混ぜない
        for k, dst in (("eps", eps), ("bps", bps)):
            for ym, v in res[k].items():
                if ym < first:
                    dst[ym] = round(v * factor, 2)
                    bas.setdefault(ym, res["basis"].get(ym))
    years = sorted(set(eps) | set(bps))[-YEARS:]
    adjust_splits(years, eps, bps, shares, notes)
    return {
        "years": years,
        "eps": [eps.get(y) for y in years],
        "bps": [bps.get(y) for y in years],
        "basis": [bas.get(y) for y in years],
        "shares": [shares.get(y) for y in years],
        "adj": notes,
    }


def collect(key, cache):
    out = load(OUT_PATH, {})
    if out.get("v") != VERSION:
        out = {"v": VERSION, "companies": {}}
    comp = out["companies"]
    for code in list(comp):
        if code not in cache["codes"]:
            del comp[code]
    todo = []
    for code, docs in cache["docs"].items():
        ch = chain(docs)
        ids = [d[2] for d in ch]
        if ch and (comp.get(code) or {}).get("read") != ids:
            todo.append((code, ch))
    log(f"読み直す銘柄: {len(todo)} 社")
    done = 0

    def work(item):
        code, ch = item
        results = []
        for entry in ch:
            if out_of_time():
                return code, ch, None
            try:
                results.append(read_doc(key, entry))
            except Exception as e:  # noqa: BLE001
                log(f"  {code} {entry[2]}: {e}")
                return code, ch, None
        return code, ch, results

    with ThreadPoolExecutor(WORKERS) as ex:
        for code, ch, results in ex.map(work, todo):
            if results is None:
                continue
            rec = combine(results)
            rec["single"] = any(r["single"] for r in results)
            rec["read"] = [d[2] for d in ch]
            comp[code] = rec
            done += 1
            if done % 50 == 0:
                out["updated"] = datetime.now(JST).date().isoformat()
                save(OUT_PATH, out)
                log(f"  {done} 社読みました")
    if out_of_time():
        log("時間切れ: 残りは次回に読みます")
    out["updated"] = datetime.now(JST).date().isoformat()
    return out, done


def main():
    key = os.environ.get("EDINET_API_KEY", "").strip()
    if not key:
        print("EDINET_API_KEY が未設定です", file=sys.stderr)
        sys.exit(1)
    DATA_DIR.mkdir(exist_ok=True)
    codes = target_codes()
    cache = scan_documents(key, codes)
    out, done = collect(key, cache)
    save(OUT_PATH, out)
    comp = out["companies"]
    full = sum(1 for r in comp.values() if len(r["years"]) >= YEARS)
    log(f"今回 {done} 社読みました。{len(comp)} 社のうち {full} 社が{YEARS}年分そろっています")


if __name__ == "__main__":
    main()
