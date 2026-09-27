"""上場企業の広告宣伝費と売上高・営業利益の推移を、EDINET の有価証券報告書から集める。

- EDINET API の書類一覧(直近 SCAN_DAYS 日分)から、上場企業の有価証券報告書と
  「自己株券買付状況報告書」(自社株買いの実施中に毎月出す報告書)を探す
- 広告宣伝費は損益計算書か「販売費及び一般管理費のうち主要な費目」の注記に、当期と前期の2期分が載る。
  載せていない会社(広告が少ない会社や部品メーカーなど)は対象外
- まず全社の最新の報告書を読み、広告宣伝費が載っていた会社だけ2年前の報告書も読んで4期分にする
- 売上高は「主要な経営指標等の推移」(5期分)、営業利益は損益計算書(当期・前期)から取る

GitHub Actions(.github/workflows/update-ad-watch.yml)から実行される。
時間がかかるので TIME_LIMIT(秒、環境変数で変更可)で打ち切り、途中までの結果を保存して次回に続きを取る。
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
SCAN_DAYS = 800  # 2年前の有価証券報告書まで届くように
BUYBACK_DAYS = 400  # 自己株券買付状況報告書は公開期間が1年
TIME_LIMIT = int(os.environ.get("TIME_LIMIT", 100 * 60))
WORKERS = 4
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DOCS_PATH = DATA_DIR / "edinet_docs.json"
OUT_PATH = DATA_DIR / "ad.json"
VERSION = 1  # ad.json の読み方の版。上げると全部読み直す
JST = timezone(timedelta(hours=9))
HEADERS = {"User-Agent": "portal-ad-watch"}

# 広告宣伝費(J-GAAP: AdvertisingExpensesSGA、会社独自の要素名も Advertis を含むことが多い)
AD_RE = re.compile(r"Advertis", re.I)
AD_EXCLUDE_RE = re.compile(r"Ratio|Per|Provision|Reserve|Payable|Prepaid|Accrued|TextBlock", re.I)
REVENUE_RE = re.compile(r"(NetSales|Revenue|OperatingRevenue)\w*SummaryOfBusinessResults$")
REVENUE_EXCLUDE_RE = re.compile(r"Cost|Ratio|Per|Loss|Profit|Growth|Expense")
OP_RE = re.compile(r"^Operating(Income|Profit)(Loss)?(IFRS|USGAAP)?(SummaryOfBusinessResults)?$")
CTX_RE = re.compile(r"^(CurrentYear|Prior([1-4])Year)Duration(_NonConsolidatedMember)?$")

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


# ---------- 1. 書類一覧から有価証券報告書と自己株券買付状況報告書を探す ----------

def scan_documents(key):
    cache = load(DOCS_PATH, {"scanned": [], "docs": {}, "buyback": {}, "names": {}})
    scanned = set(cache["scanned"])
    today = datetime.now(JST).date()
    first = today - timedelta(days=SCAN_DAYS)
    days = [first + timedelta(days=i) for i in range((today - first).days)]  # 今日の分は次回
    todo = sorted((d for d in days if d.isoformat() not in scanned), reverse=True)
    log(f"書類一覧: {len(todo)} 日分を確認します")
    for n, d in enumerate(todo):
        if out_of_time():
            log("時間切れのため、書類一覧の確認を途中で止めます")
            break
        try:
            res = get(f"{EDINET_API}/documents.json", {"date": d.isoformat(), "type": 2, "Subscription-Key": key}).json()
        except Exception as e:  # noqa: BLE001
            log(f"  {d}: {e}")
            continue
        for doc in res.get("results") or []:
            sec = (doc.get("secCode") or "").strip()
            kind = doc.get("docTypeCode")
            if len(sec) != 5 or kind not in ("120", "220"):
                continue
            code = sec[:4].upper()
            submit = doc["submitDateTime"][:10]
            if kind == "220":
                dates = cache["buyback"].setdefault(code, [])
                if submit not in dates:
                    dates.append(submit)
                    dates.sort()
                continue
            # 国内の会社の有価証券報告書だけ(投資信託や外国会社は形式が違う)
            if doc.get("ordinanceCode") != "010" or doc.get("formCode") != "030000" or not doc.get("periodEnd"):
                continue
            cache["names"].setdefault(code, [submit, doc.get("filerName") or ""])
            if submit >= cache["names"][code][0]:
                cache["names"][code] = [submit, doc.get("filerName") or ""]
            entry = [submit, doc["periodEnd"], doc["docID"], doc.get("csvFlag") == "1"]
            lst = cache["docs"].setdefault(code, [])
            if entry[2] not in {x[2] for x in lst}:
                lst.append(entry)
        scanned.add(d.isoformat())
        if n % 100 == 99:
            cache["scanned"] = sorted(scanned)
            save(DOCS_PATH, cache)
            log(f"  {n + 1} 日分まで確認")
        time.sleep(0.2)
    first_s = first.isoformat()
    bb_first = (today - timedelta(days=BUYBACK_DAYS)).isoformat()
    cache["scanned"] = sorted(s for s in scanned if s >= first_s)
    for code in list(cache["docs"]):
        cache["docs"][code] = [x for x in cache["docs"][code] if x[0] >= first_s]
        if not cache["docs"][code]:
            del cache["docs"][code]
    for code in list(cache["buyback"]):
        cache["buyback"][code] = [x for x in cache["buyback"][code] if x >= bb_first]
        if not cache["buyback"][code]:
            del cache["buyback"][code]
    save(DOCS_PATH, cache)
    log(f"有価証券報告書: {len(cache['docs'])} 社 / 自己株券買付状況報告書: {len(cache['buyback'])} 社")
    return cache


# ---------- 2. 有価証券報告書を読む ----------

def read_csv(key, doc_id):
    r = get(f"{EDINET_API}/documents/{doc_id}", {"type": 5, "Subscription-Key": key})
    z = zipfile.ZipFile(io.BytesIO(r.content))
    rows = []
    for name in z.namelist():
        if not name.endswith(".csv"):
            continue
        for line in z.read(name).decode("utf-16", "replace").splitlines():
            cells = [c.strip('"') for c in line.split("\t")]
            if len(cells) >= 9:
                rows.append((cells[0], cells[2], cells[-1].replace(",", "")))
    return rows


XBRL_RE = re.compile(r"<([\w-]+:(?:\w*Advertis\w*|\w+SummaryOfBusinessResults|Operating(?:Income|Profit)\w*))\b([^>]*)>([^<]*)<")
CTXREF_RE = re.compile(r'contextRef="([^"]+)"')


def read_xbrl(key, doc_id):
    r = get(f"{EDINET_API}/documents/{doc_id}", {"type": 1, "Subscription-Key": key})
    z = zipfile.ZipFile(io.BytesIO(r.content))
    rows = []
    for name in z.namelist():
        if "PublicDoc" in name and name.endswith(".xbrl"):
            text = z.read(name).decode("utf-8", "replace")
            for elem, attrs, val in XBRL_RE.findall(text):
                m = CTXREF_RE.search(attrs)
                if m:
                    rows.append((elem, m.group(1), val.strip()))
    return rows


def pick(rows, name_re, exclude_re=None):
    """rows から name_re にあう要素を ({何期前: 値}, "連結:要素名") で返す。
    連結を優先し、当期の値の絶対値がいちばん大きい要素(内訳の項目を避ける)"""
    found = {}
    for elem, ctx, val in rows:
        name = elem.split(":")[-1]
        if not name_re.search(name) or (exclude_re and exclude_re.search(name)):
            continue
        m = CTX_RE.match(ctx)
        if not m:
            continue
        try:
            v = float(val)
        except ValueError:
            continue
        found.setdefault((name, bool(m.group(3))), {})[int(m.group(2) or 0)] = v
    for nonconsolidated in (False, True):
        cands = {k: v for k, v in found.items() if k[1] == nonconsolidated and v.get(0)}
        if cands:
            (name, _), vals = max(cands.items(), key=lambda kv: abs(kv[1][0]))
            return vals, ("単体:" if nonconsolidated else "連結:") + name
    return {}, None


def shift_years(period_end, n):
    y, m, _ = map(int, period_end.split("-"))
    return f"{y - n:04d}-{m:02d}"


def read_doc(key, entry):
    _, period_end, doc_id, csv = entry
    rows = read_csv(key, doc_id) if csv else []
    ad, _ = pick(rows, AD_RE, AD_EXCLUDE_RE)
    if not rows or not ad:
        rows = read_xbrl(key, doc_id)
    ad, ad_src = pick(rows, AD_RE, AD_EXCLUDE_RE)
    sales, sales_src = pick(rows, REVENUE_RE, REVENUE_EXCLUDE_RE)
    op, _ = pick(rows, OP_RE)
    res = {"ad": {}, "sales": {}, "op": {}, "ad_src": ad_src, "sales_src": sales_src}
    for key_, vals, n in (("ad", ad, 2), ("sales", sales, 5), ("op", op, 2)):
        for back, v in vals.items():
            if back < n:
                res[key_][shift_years(period_end, back)] = v
    return res


def merge(rec, entry, res):
    """新しい報告書の値を優先する(前期の数字が後から修正されることがあるため)"""
    rec["read"].append(entry[2])
    newest = entry[1][:7] >= rec.get("latest", "")
    for k in ("ad", "sales", "op"):
        for p, v in res[k].items():
            if newest or p not in rec[k]:
                rec[k][p] = v
    if newest:
        rec["latest"] = entry[1][:7]
        rec["ad_src"] = res["ad_src"] or rec.get("ad_src")
        rec["sales_src"] = res["sales_src"] or rec.get("sales_src")
    if not res["ad"] and newest:
        rec["noad"] = True


def plan(cache, out):
    """読む報告書を決める。1巡目: 全社の最新。2巡目: 広告宣伝費があった会社の2年前"""
    first, second = [], []
    for code, docs in cache["docs"].items():
        docs = sorted(docs, key=lambda x: x[1], reverse=True)
        rec = out.get(code)
        latest = docs[0]
        if not rec or latest[2] not in rec["read"]:
            if not rec or latest[1][:7] > rec.get("latest", ""):
                first.append((code, latest))
                continue
        if rec.get("noad"):
            continue
        want = shift_years(latest[1], 2)
        older = [d for d in docs if d[1][:7] <= want and d[2] not in rec["read"]]
        if older and want not in rec["ad"]:
            second.append((code, older[0]))
    return first + second


def collect(key, cache):
    out = load(OUT_PATH, {})
    if out.get("v") != VERSION:
        out = {"v": VERSION, "companies": {}}
    comp = out["companies"]
    todo = plan(cache, comp)
    log(f"読む有価証券報告書: {len(todo)} 件")
    done = 0

    def work(item):
        code, entry = item
        if out_of_time():
            return code, entry, None
        try:
            return code, entry, read_doc(key, entry)
        except Exception as e:  # noqa: BLE001
            log(f"  {code} {entry[2]}: {e}")
            return code, entry, None

    with ThreadPoolExecutor(WORKERS) as ex:
        for code, entry, res in ex.map(work, todo):
            if res is None:
                continue
            rec = comp.setdefault(code, {"ad": {}, "sales": {}, "op": {}, "read": []})
            if res["ad"] and rec.get("noad") and entry[1][:7] >= rec.get("latest", ""):
                rec.pop("noad")
            merge(rec, entry, res)
            done += 1
            if done % 100 == 0:
                save(OUT_PATH, finalize(out, cache))
                log(f"  {done} 件読みました")
    if out_of_time():
        log("時間切れ: 残りは次回に読みます")
    return finalize(out, cache), done


def finalize(out, cache):
    for code, rec in out["companies"].items():
        rec["name"] = cache["names"].get(code, ["", ""])[1]
        rec["buyback"] = (cache["buyback"].get(code) or [None])[-1]
    out["updated"] = datetime.now(JST).date().isoformat()
    return out


def main():
    key = os.environ.get("EDINET_API_KEY", "").strip()
    if not key:
        print("EDINET_API_KEY が未設定です", file=sys.stderr)
        sys.exit(1)
    cache = scan_documents(key)
    out, done = collect(key, cache)
    save(OUT_PATH, out)
    comp = out["companies"]
    with_ad = sum(1 for r in comp.values() if r["ad"] and not r.get("noad"))
    log(f"今回 {done} 件読みました。広告宣伝費あり {with_ad} 社 / 読んだ会社 {len(comp)} 社")


if __name__ == "__main__":
    main()
