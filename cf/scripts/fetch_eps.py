"""投資分析ページ(cf/<コード>/)の銘柄について、EPS と BPS の過去10年分の推移を EDINET から集める。

- 有価証券報告書の「主要な経営指標等の推移」には5期分の1株当たり当期純利益(EPS)と
  1株当たり純資産(BPS)が載る。最新の報告書と、その4年前の報告書…と、1年ずつ重ねてつなぐ
- 古い報告書の数字は、その後の株式分割を反映していない。重なった年の BPS(と EPS)の比が
  分割の比率(1/2、1/3 など)に近ければ、古い年の数字をその比率でそろえる
- 連結の数字を優先し、ない会社は単体の数字を使う。IFRS・米国基準の数字があればそちらを優先する

GitHub Actions(.github/workflows/update-cf-eps.yml)から実行される。
書類一覧の確認に時間がかかるので TIME_LIMIT(秒)で打ち切り、途中までの結果を保存して次回に続きを取る。
あわせて、最新の半期報告書から「最新の半期」の節の数字(cf/<コード>/half.js)を作り直す(half.py)。
EDINET_API_KEY(環境変数)が必要。
"""

import io
import json
import math
import os
import re
import sys
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

import half

EDINET_API = "https://api.edinet-fsa.go.jp/api/v2"
SCAN_DAYS = 3700  # 10年前の有価証券報告書まで届くように
HALF_DAYS = 400  # 半期報告書は直近のものだけ使う
YEARS = 10
TIME_LIMIT = int(os.environ.get("TIME_LIMIT", 100 * 60))
WORKERS = 3
CF_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = CF_DIR / "data"
DOCS_PATH = DATA_DIR / "eps_docs.json"
OUT_PATH = DATA_DIR / "eps.json"
VERSION = 19  # eps.json の読み方の版。上げると全部読み直す
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
# 1株当たり配当額(年間。中間配当だけの要素は除く)。単体の欄に載ることが多い
DPS_RE = re.compile(r"^DividendPaidPerShare\w*" + SUMMARY + "$")
DPS_EXCLUDE_RE = re.compile(r"Interim")
# 発行済株式総数(配当の株式分割をそろえるのに使う)
IDPS_RE = re.compile(r"^InterimDividendPaidPerShare\w*" + SUMMARY + "$")
SHARES_RE = re.compile(r"^TotalNumberOfIssuedShares\w*" + SUMMARY + "$")
# 表に出す指標の元になる数字(比率は小数、金額は円)
BASES = r"(IFRS|USGAAP|JMIS)?"
PER_RE = re.compile(r"^PriceEarningsRatio" + BASES + SUMMARY + "$")
ROE_RE = re.compile(r"^RateOfReturnOnEquity" + BASES + SUMMARY + "$")
EQR_RE = re.compile(r"^(EquityToAssetRatio|RatioOfOwnersEquityToGrossAssets|EquityToTotalAssetsRatio)" + BASES + SUMMARY + "$")
NI_RE = re.compile(r"^ProfitLossAttributableToOwnersOfParent" + BASES + SUMMARY + "$")
NI_SINGLE_RE = re.compile(r"^(NetIncomeLoss|ProfitLoss)" + BASES + SUMMARY + "$")
TA_RE = re.compile(r"^TotalAssets" + BASES + SUMMARY + "$")
# 自己株式の取得による支出(連結キャッシュフロー計算書の財務活動。当期と前期が載る)
BUY_RE = re.compile(r"Treasury\w*FinCF")
BUY_EXCLUDE_RE = re.compile(r"Proceeds|Sale|Disposal|Dispose|Subsidiar")
PER_SHARE, PURE, YEN = re.compile(r"PerShare"), re.compile(r"(?i)^pure$"), re.compile(r"^JPY$")
CTX_RE = re.compile(r"^(CurrentYear|Prior([1-4])Year)(Duration|Instant)(_NonConsolidatedMember)?$")
# 分割・併合の比率(新しい報告書の数字 / 古い報告書の数字)
SPLITS = [1 / n for n in (1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 20, 25, 50, 100)] + [2, 3, 4, 5, 10]

START = time.monotonic()


def log(*a):
    print(*a, flush=True)


def out_of_time():
    return time.monotonic() - START > TIME_LIMIT


def get(url, params, retries=3, want_zip=False):
    """EDINET は混み合うと HTTP 200 のまま zip ではなくエラーの JSON を返すことがある。
    want_zip のときは中身が zip かどうかも確かめ、違えば間を空けてやり直す"""
    last = None
    for attempt in range(1, (6 if want_zip else retries) + 1):
        try:
            r = requests.get(url, params=params, headers=HEADERS, timeout=90)
            if r.status_code == 200:
                if not want_zip or r.content[:2] == b"PK":
                    return r
                last = f"zip ではない応答: {r.content[:150]!r}"
            else:
                last = f"HTTP {r.status_code}"
                if r.status_code in (400, 401, 403, 404):
                    break
        except requests.RequestException as e:
            last = e
        time.sleep((10 if want_zip else 3) * attempt)
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
    cache.setdefault("half", {})
    cache.setdefault("half_scanned", [])
    if set(codes) - set(cache["codes"]):
        # 新しい銘柄のページが増えたら、10年分を確認し直す
        log("新しい銘柄があるため、書類一覧を最初から確認します")
        cache["scanned"] = []
        cache["half_scanned"] = []
    cache["codes"] = codes
    want = set(codes)
    scanned = set(cache["scanned"])
    half_scanned = set(cache["half_scanned"])
    today = datetime.now(JST).date()
    first = today - timedelta(days=SCAN_DAYS)
    days = [first + timedelta(days=i) for i in range((today - first).days)]  # 今日の分は次回
    half_first = today - timedelta(days=HALF_DAYS)
    # 半期報告書を探す前に確認した日は、半期報告書のためだけにもう一度見る
    todo = sorted((d for d in days if d.weekday() < 5 and (d.isoformat() not in scanned or (d >= half_first and d.isoformat() not in half_scanned))), reverse=True)
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
                if len(sec) != 5 or code not in want:
                    continue
                if doc.get("docTypeCode") == "160" and doc.get("periodStart") and doc.get("withdrawalStatus") in (None, "0"):
                    entry = [doc["submitDateTime"][:10], doc["periodStart"], doc["docID"], doc.get("csvFlag") == "1"]
                    lst = cache["half"].setdefault(code, [])
                    if entry[2] not in {x[2] for x in lst}:
                        lst.append(entry)
                    continue
                if doc.get("docTypeCode") != "120":
                    continue
                if doc.get("ordinanceCode") != "010" or doc.get("formCode") != "030000" or not doc.get("periodEnd"):
                    continue
                entry = [doc["submitDateTime"][:10], doc["periodEnd"], doc["docID"], doc.get("csvFlag") == "1"]
                lst = cache["docs"].setdefault(code, [])
                if entry[2] not in {x[2] for x in lst}:
                    lst.append(entry)
            scanned.add(d.isoformat())
            half_scanned.add(d.isoformat())
            if n % 200 == 199:
                cache["scanned"] = sorted(scanned)
                cache["half_scanned"] = sorted(half_scanned)
                save(DOCS_PATH, cache)
                log(f"  {n + 1} 日分まで確認")
    if out_of_time():
        log("時間切れのため、書類一覧の確認を途中で止めます")
    first_s = first.isoformat()
    cache["scanned"] = sorted(s for s in scanned if s >= first_s)
    half_s = half_first.isoformat()
    cache["half_scanned"] = sorted(s for s in half_scanned if s >= half_s)
    for code in list(cache["half"]):
        cache["half"][code] = sorted(x for x in cache["half"][code] if x[0] >= half_s and code in want)
        if not cache["half"][code]:
            del cache["half"][code]
    for code in list(cache["docs"]):
        cache["docs"][code] = sorted(x for x in cache["docs"][code] if x[0] >= first_s and code in want)
        if not cache["docs"][code]:
            del cache["docs"][code]
    save(DOCS_PATH, cache)
    log(f"有価証券報告書が見つかった銘柄: {len(cache['docs'])} / {len(codes)}")
    return cache


# ---------- 2. 有価証券報告書から EPS・BPS を読む ----------

def read_csv(key, doc_id):
    r = get(f"{EDINET_API}/documents/{doc_id}", {"type": 5, "Subscription-Key": key}, want_zip=True)
    z = zipfile.ZipFile(io.BytesIO(r.content))
    rows = []
    for name in z.namelist():
        if not name.endswith(".csv"):
            continue
        for line in z.read(name).decode("utf-16", "replace").splitlines():
            cells = [c.strip('"') for c in line.split("\t")]
            if len(cells) >= 9 and (SUMMARY in cells[0] or BUY_RE.search(cells[0])):
                rows.append((cells[0], cells[2], cells[-1].replace(",", ""), cells[6]))
    return rows


XBRL_RE = re.compile(r"<([\w-]+:(?:\w*SummaryOfBusinessResults|\w*Treasury\w*FinCF\w*))\b([^>]*)>([^<]*)<")
CTXREF_RE = re.compile(r'contextRef="([^"]+)"')
UNITREF_RE = re.compile(r'unitRef="([^"]*)"')


def read_xbrl(key, doc_id):
    r = get(f"{EDINET_API}/documents/{doc_id}", {"type": 1, "Subscription-Key": key}, want_zip=True)
    z = zipfile.ZipFile(io.BytesIO(r.content))
    rows = []
    for name in z.namelist():
        if "PublicDoc" in name and name.endswith(".xbrl"):
            text = z.read(name).decode("utf-8", "replace")
            for elem, attrs, val in XBRL_RE.findall(text):
                m, u = CTXREF_RE.search(attrs), UNITREF_RE.search(attrs)
                if m and u:
                    rows.append((elem, m.group(1), val.strip(), u.group(1)))
    return rows


def basis(name):
    for b in ("IFRS", "USGAAP", "JMIS"):
        if b in name:
            return b
    return "JGAAP"


BASIS_ORDER = {"IFRS": 0, "USGAAP": 1, "JMIS": 2, "JGAAP": 3}


def pick(rows, name_re, exclude_re, kind, unit=PER_SHARE):
    """kind(Duration か Instant。None ならどちらでも)・単位が unit の値から {何期前: (値, 会計基準, 単体か)} を返す。
    連結を優先し、同じ期に複数の基準があれば IFRS などを優先する"""
    found = {}
    for elem, ctx, val, u in rows:
        name = elem.split(":")[-1]
        if not name_re.search(name) or (exclude_re and exclude_re.search(name)) or (unit and not unit.search(u)):
            continue
        m = CTX_RE.match(ctx)
        if not m or (kind and m.group(3) != kind):
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
    names = sorted({e.split(":")[-1] for e, c, _, u in rows
                    if c.startswith("CurrentYear") and "NonConsolidated" not in c and "PerShare" in u})
    if names and (any(v[2] for v in eps.values()) or any(v[2] for v in bps.values())):
        # 連結の1株当たりの要素があるのに単体の数字を使ったときは、取りこぼしを確認できるように出しておく
        log(f"  {doc_id}: 連結の EPS・BPS が見つかりません。連結の1株当たりの要素: {names}")
    res = {"eps": {}, "bps": {}, "basis": {}, "single": False, "period": period_end[:7], "dps": {}, "idps": {}, "shares": {}}
    ni = pick(rows, NI_RE, None, "Duration", YEN) or pick(rows, NI_SINGLE_RE, None, "Duration", YEN)
    for k, name_re, ex, kind, unit in (("dps", DPS_RE, DPS_EXCLUDE_RE, "Duration", PER_SHARE),
                                       ("idps", IDPS_RE, None, "Duration", PER_SHARE),
                                       ("shares", SHARES_RE, None, "Instant", None),
                                       ("per", PER_RE, None, None, PURE), ("roe", ROE_RE, None, None, PURE),
                                       ("eqr", EQR_RE, None, "Instant", PURE), ("ni", None, None, None, None),
                                       ("ta", TA_RE, None, "Instant", YEN),
                                       ("buy", BUY_RE, BUY_EXCLUDE_RE, "Duration", YEN)):
        res[k] = {}
        for back, (v, _, _) in (ni if k == "ni" else pick(rows, name_re, ex, kind, unit)).items():
            res[k][shift_years(period_end, back)] = v
    for k, vals in (("eps", eps), ("bps", bps)):
        for back, (v, b, single) in vals.items():
            ym = shift_years(period_end, back)
            res[k][ym] = v
            res["basis"].setdefault(ym, b)  # EPS の基準を優先
            res["single"] = res["single"] or single
    return res


# ---------- 3. 報告書をつなぐ ----------

def chain(docs):
    """直近10年分の有価証券報告書を、新しい順に(同じ期は、あとに出したもの)"""
    by_period = {}
    for d in sorted(docs):
        by_period[d[1][:7]] = d
    periods = sorted(by_period, reverse=True)
    if not periods:
        return []
    oldest = shift_years(periods[0] + "-01", YEARS - 1)
    return [by_period[p] for p in periods if p >= oldest]


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


def link_ratio(newer, older, years):
    """新しい報告書と古い報告書で重なった年のうち最も新しい年の 新/古 の比(株式分割の比率)。
    BPS で見て、なければ EPS で見る。分割の比率に近くなければ 1(会計基準の変更などは直さない)"""
    for y in sorted(years, reverse=True):
        for k in ("bps", "eps"):
            r = split_ratio(newer[k].get(y), older[k].get(y))
            if r is not None:
                return r
    return 1


def split_adjusted_dps(results, years, chain_splits=()):
    """配当は実際に払った額がそのまま載り、分割後も前の年を直さない。
    期末の発行済株式総数が分割の比率で増えた年を見つけ、それより前の年の配当を今の株数にそろえる。
    (EPS・BPS の倍率は使わない。4月1日の分割では、3月期の報告書の EPS はもう分割後に直っているのに、配当は分割前の実額のため)
    株数が読めない会社もあるので、EPS・BPS で見つけた分割(chain_splits: [(その期以前を直す期, 比率)])のうち
    株数で見つからなかったものは配当にも当てる。4月1日の分割では配当の境目が1年ずれるので、配当がなめらかにつながる方を選ぶ。
    期の途中で分割した年は「分割前の中間配当＋分割後の期末配当」になっているので、中間配当だけ直す"""
    dps, idps, shares = {}, {}, {}
    # その年の報告書(当期)の実額を優先する。翌年の報告書は前期の配当を分割後の株数で直していることがあるので、
    # 当期の報告書がない年だけ、ほかの報告書(新しい順)の値で埋める
    for own in (True, False):
        for res in results:
            for k, dst in (("dps", dps), ("idps", idps), ("shares", shares)):
                for ym, v in res.get(k, {}).items():
                    if not own or ym == res.get("period"):
                        dst.setdefault(ym, v)
    # ratio[i]: years[i-1] と years[i] の間の分割の比率
    ratio = [1] * len(years)
    for i in range(1, len(years)):
        s0, s1 = shares.get(years[i - 1]), shares.get(years[i])
        if s0 and s1:
            ratio[i] = next((sp for sp in SPLITS if abs(s0 / s1 / sp - 1) < 0.05), 1)
    latest = 1  # 最新の期のあと(4月1日など)に分割したときは、最新の期の配当も直す
    for p, r in chain_splits:
        if p not in years:
            continue
        j = years.index(p) + 1
        if any(abs(x / r - 1) < 0.05 for x in ratio[j:j + 2]):
            continue
        # p と次の年の配当が r 倍ずれていれば境目はそこ、ずれていなければ1年あと
        a, b = dps.get(p), dps.get(years[j]) if j < len(years) else None
        here = j < len(years) and (not (a and b and a > 0 and b > 0)
                                   or abs(math.log(b / (a * r))) < abs(math.log(b / a)))
        if here:
            ratio[j] = r
        elif j + 1 < len(years):
            ratio[j + 1] = r
        else:
            latest = r
    out, f = {}, latest
    for i in range(len(years) - 1, -1, -1):
        y = years[i]
        r = ratio[i]
        v = dps.get(y)
        if v is not None:
            v *= f
            iv = idps.get(y)
            if r != 1 and iv and 0 < iv < dps[y]:
                # 分割した年: 中間配当が期末配当のおよそ 1/r 倍なら、中間配当は分割前の株数で払っている
                ye = dps[y] - iv
                if abs(math.log(iv / ye * r)) < abs(math.log(iv / ye)):
                    v = (iv * r + ye) * f
            out[y] = round(v, 2)
        f *= r
    return out


def own_first(results, k):
    """各年の値を、その年の報告書(当期)を優先して、なければ新しい報告書から"""
    out = {}
    for own in (True, False):
        for res in results:
            for ym, v in res.get(k, {}).items():
                if own == (ym == res["period"]):
                    out.setdefault(ym, v)
    return out


def ratios(results, years, eps, bps, dps):
    """表に出す指標。株価は報告書の PER × EPS で求める(赤字で PER がない年は、株価を使う指標は出さない)。
    EPS・BPS・配当は分割をそろえた後の数字を使うので、分割の前後でも比が変わらない。
    時価総額は PER × 親会社株主に帰属する当期純利益(= 株価 × 期中平均の株数、自己株式を除く)"""
    per, roe, eqr, ni, ta = (own_first(results, k) for k in ("per", "roe", "eqr", "ni", "ta"))
    r = {k: [] for k in ("per", "pbr", "roe", "roa", "yield", "eqr", "mcap")}
    for i, y in enumerate(years):
        p = per.get(y)
        p = p if p and p > 0 else None
        price = p * eps[y] if p and eps.get(y) else None
        t0, t1 = ta.get(years[i - 1]) if i else None, ta.get(y)
        avg = (t0 + t1) / 2 if t0 and t1 else t1
        r["per"].append(round(p, 1) if p else None)
        r["pbr"].append(round(price / bps[y], 2) if price and bps.get(y) else None)
        r["roe"].append(round(roe[y] * 100, 1) if y in roe else None)
        r["roa"].append(round(ni[y] / avg * 100, 1) if y in ni and avg else None)
        r["yield"].append(round(dps[y] / price * 100, 2) if price and dps.get(y) is not None else None)
        r["eqr"].append(round(eqr[y] * 100, 1) if y in eqr else None)
        r["mcap"].append(round(p * ni[y] / 1e8) if p and ni.get(y) else None)
    # 自社株買い(億円)。キャッシュフロー計算書に行がない年は、買っていないとみなして 0
    buy = own_first(results, "buy")
    r["buy"] = [round(abs(buy.get(y, 0)) / 1e8, 1) for y in years] if buy else [None] * len(years)
    return r


def combine(results):
    """新しい順の読み取り結果をつなぐ。
    分割があった年の報告書は、当期と前期の数字を分割後の株数で載せるが、それより前の年は直していないことが多い。
    そこで各報告書からはまず当期と前期の数字を使い、1年前の報告書の当期と重なる年の比で分割をそろえる。
    報告書が欠けている年だけ、2〜4期前の数字で埋める"""
    eps, bps, bas, notes, splits = {}, {}, {}, [], []
    factors = []
    for i, res in enumerate(results):
        f = 1
        if i:
            prev = results[i - 1]
            r = link_ratio(prev, res, set(prev["bps"]) | set(prev["eps"]))
            f = factors[-1] * r
            if r != 1:
                splits.append((res["period"], r))
                notes.append(f"{res['period']}以前を {f:.4g} 倍")
        factors.append(f)
    for recent in (True, False):
        # 埋めるときは、その年にいちばん近い(古い)報告書から
        pairs = list(zip(results, factors))
        for res, f in (pairs if recent else reversed(pairs)):
            near = {res["period"], shift_years(res["period"] + "-01", 1)}
            for k, dst in (("eps", eps), ("bps", bps)):
                for ym, v in res.get(k, {}).items():
                    if (ym in near) == recent and ym not in dst:
                        dst[ym] = round(v * f, 2)
                        bas.setdefault(ym, res["basis"].get(ym))
    years = sorted(set(eps) | set(bps))[-YEARS:]
    dps = split_adjusted_dps(results, years, splits)
    return {**ratios(results, years, eps, bps, dps),
        "years": years,
        "eps": [eps.get(y) for y in years],
        "bps": [bps.get(y) for y in years],
        "dps": [dps.get(y) for y in years],
        "basis": [bas.get(y) for y in years],
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


# ---------- 4. 最新の半期報告書から half.js を作り直す ----------

HALF_JS = re.compile(r"=\s*(\{.*\})\s*;?\s*$", re.S)


def read_half_rows(key, doc_id):
    """半期報告書の XBRL CSV の数字をすべて (要素名, コンテキスト, 値, 単位) で返す"""
    r = get(f"{EDINET_API}/documents/{doc_id}", {"type": 5, "Subscription-Key": key}, want_zip=True)
    z = zipfile.ZipFile(io.BytesIO(r.content))
    rows = []
    for name in z.namelist():
        if not name.endswith(".csv"):
            continue
        for line in z.read(name).decode("utf-16", "replace").splitlines()[1:]:
            cells = [c.strip('"') for c in line.split("\t")]
            if len(cells) >= 9 and cells[6] in ("JPY", "JPYPerShares", "shares"):
                rows.append((cells[0], cells[2], cells[-1].replace(",", ""), cells[6]))
    return rows


def update_half(key, cache):
    """half.js があるページについて、それより新しい半期報告書が出ていれば作り直す"""
    todo = []
    for code, docs in cache.get("half", {}).items():
        path = CF_DIR / code / "half.js"
        if not path.exists():
            continue
        try:
            old = json.loads(HALF_JS.search(path.read_text(encoding="utf-8")).group(1))
        except (AttributeError, json.JSONDecodeError):
            continue
        # 同じ半期の訂正などは、あとに出たものを使う
        latest = max((d for d in docs if d[3]), key=lambda d: (d[1], d[0]), default=None)
        if latest and (latest[1][:7] > old.get("halfStart", "") or (latest[1][:7] == old.get("halfStart") and "eps" not in old)):
            todo.append((code, path, old, latest))
    log(f"作り直す半期の数字: {len(todo)} 社")

    def work(item):
        code, path, old, latest = item
        if out_of_time():
            return item, None
        try:
            return item, read_half_rows(key, latest[2])
        except Exception as e:  # noqa: BLE001
            log(f"  {code} {latest[2]}: {e}")
            return item, None

    done = 0
    with ThreadPoolExecutor(WORKERS) as ex:
        for (code, path, old, latest), rows in ex.map(work, todo):
            if not rows:
                continue
            res = half.extract(rows, latest[1], old.get("bank", False) or half.is_bank(rows))
            if res["sales"][0] is None and res["assets"][0] is None:
                log(f"  {code} {latest[2]}: 半期の数字が読めないため、前のままにします")
                continue
            annual = old.get("annualEnd") or res["fyEnd"]
            new = {"code": code, "annualEnd": annual, **res, "doc": latest[2], "newer": res["fyEnd"] > annual,
                   "next": half.periods(latest[1])["next"]}
            path.write_text("window.CF_HALF = " + json.dumps(new, ensure_ascii=False) + ";\n", encoding="utf-8")
            done += 1
    if out_of_time():
        log("時間切れ: 残りの半期の数字は次回に作ります")
    log(f"半期の数字を {done} 社作り直しました")


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
    update_half(key, cache)
    comp = out["companies"]
    full = sum(1 for r in comp.values() if len(r["years"]) >= YEARS)
    log(f"今回 {done} 社読みました。{len(comp)} 社のうち {full} 社が{YEARS}年分そろっています")


if __name__ == "__main__":
    main()
