"""海外投資家の需給ダッシュボード(foreign-flow)のデータを作る。

集めるもの(すべて無料の公開データ):
- 空売り残高報告(JPX、毎営業日): 発行済株式の0.5%以上を空売りしている機関と割合。
  直近12か月分の日次ファイルを読み、銘柄ごとの「報告された空売り残高割合の合計」の推移を作る。
- 投資部門別売買状況(JPX、毎週・毎月): 東証プライムでの海外投資家の買い越し・売り越し(市場全体)。
- 株価・出来高(Yahoo Finance、yfinance 経由): 13週・26週のTOPIX比騰落率と出来高の増え方。
- 大量保有報告書(EDINET API): 海外勢の5%超の保有と増減。EDINET_API_KEY があるときだけ。

対象銘柄は、持ち株(holdings/data/check.json の日本株)、../data/watchlist.json、
TOPIX 500(Core30 + Large70 + Mid400)。「有望銘柄ベスト5」は TOPIX 500 から選ぶ。

GitHub Actions(.github/workflows/update-foreign-flow.yml)から平日に実行する。
空売り残高と株価のどちらかが取れなかったときは、既存の flow.json を上書きせずに終了コード1で終わる。
"""

import io
import json
import math
import os
import re
import sys
import time
import unicodedata
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import requests
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUT_PATH = DATA_DIR / "flow.json"
WATCH_PATH = DATA_DIR / "watchlist.json"
EDINET_CACHE_PATH = DATA_DIR / "edinet_cache.json"
HOLDINGS_PATH = ROOT.parent / "holdings" / "data" / "check.json"
# ダウンロードした空売り残高ファイルの置き場(リポジトリには入れない。Actions ではキャッシュする)
CACHE_DIR = Path(os.environ.get("FLOW_CACHE_DIR") or ROOT / ".cache")

JPX = "https://www.jpx.co.jp"
SHORT_INDEX = f"{JPX}/markets/public/short-selling/index.html"
INVESTOR_INDEX = f"{JPX}/markets/statistics-equities/investor-type/index.html"
INVESTOR_ARCHIVE = f"{JPX}/markets/statistics-equities/investor-type/00-01.html"
TOPIX_WEIGHT = f"{JPX}/automation/markets/indices/topix/files/topixweight_j.csv"
EDINET_API = "https://api.edinet-fsa.go.jp/api/v2"
EDINET_CODELIST = "https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip"
TOPIX_ETF = "1306.T"  # TOPIX 連動ETF。TOPIX比の騰落率に使う

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; portal-foreign-flow/1.0; +https://git-san-934.github.io/portal/)"}
JST = timezone(timedelta(hours=9))
SHORT_MONTHS = 12  # 空売り残高を遡る月数
SHORT_MIN = 0.5  # 報告義務の下限(%)。これ未満の報告は「ポジション解消」とみなす
LARGE_CLASSES = ("TOPIX Core30", "TOPIX Large70", "TOPIX Mid400")
EDINET_DAYS = 120  # 大量保有報告書を遡る日数
LH_WINDOW = 90  # スコアに使う大量保有報告書の期間(日)
WEEKS = 26  # チャート用の週次系列の長さ

# 日本法人名義で出てくる海外の運用会社・投資銀行(大量保有報告書の提出者名で判定)
FOREIGN_GROUPS = [
    "ブラックロック", "バンガード", "フィデリティ", "エフエムアール", "キャピタル・リサーチ", "キャピタル・インターナショナル",
    "ゴールドマン", "モルガン・スタンレー", "JPモルガン", "ジェー・ピー・モルガン", "シティグループ", "UBS", "バークレイズ",
    "ノルウェー", "ステート・ストリート", "インベスコ", "アライアンス・バーンスタイン", "ウエリントン", "ウェリントン",
    "シュローダー", "ティー・ロウ・プライス", "オアシス", "エリオット", "バリューアクト", "サード・ポイント", "シルチェスター",
    "ダルトン", "スリーディー", "エフィッシモ", "マッコーリー", "BNP", "ドイチェ", "HSBC", "アムンディ", "ピクテ",
    "ベイリー・ギフォード", "ノーザン・トラスト", "ジェーピーモルガン", "メリルリンチ", "ソシエテ", "クレディ",
]


def log(*a):
    print(*a, flush=True)


def nfkc(s):
    return unicodedata.normalize("NFKC", str(s or "")).strip()


def get(url, retries=3, **kw):
    last = None
    for attempt in range(1, retries + 1):
        try:
            r = requests.get(url, headers=HEADERS, timeout=60, **kw)
            if r.status_code == 200:
                return r
            last = f"HTTP {r.status_code}"
            if r.status_code in (401, 403, 404):
                break
        except requests.RequestException as e:
            last = e
        time.sleep(3 * attempt)
    raise RuntimeError(f"{url}: {last}")


def links(html, pattern):
    return [m if m.startswith("http") else JPX + m for m in dict.fromkeys(re.findall(r'href="([^"]*' + pattern + r')"', html))]


def rnd(v, d=2):
    if v is None or (isinstance(v, float) and (math.isnan(v) or math.isinf(v))):
        return None
    return round(float(v), d)


def clamp(v, lo=-2.0, hi=2.0):
    return max(lo, min(hi, v))


def norm_code(v):
    s = nfkc(v)
    if s.endswith(".0"):
        s = s[:-2]
    return s.upper()


def to_date(v):
    if isinstance(v, (datetime, pd.Timestamp)):
        return v.date()
    if isinstance(v, date):
        return v
    s = nfkc(v)
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d"):
        try:
            return datetime.strptime(s[:10], fmt).date()
        except ValueError:
            pass
    return None


# ---------------------------------------------------------------------------
# 対象銘柄
# ---------------------------------------------------------------------------


def load_targets():
    """持ち株(日本株)とウォッチリストの銘柄 {code: name}"""
    holdings, watch = {}, {}
    try:
        check = json.loads(HOLDINGS_PATH.read_text(encoding="utf-8"))
        for s in check.get("stocks", []):
            if (s.get("currency") or "JPY") == "JPY":
                holdings[norm_code(s["code"])] = s.get("name") or ""
    except (OSError, ValueError) as e:
        log(f"持ち株リストを読めませんでした: {e}")
    try:
        wl = json.loads(WATCH_PATH.read_text(encoding="utf-8"))
        for s in wl.get("stocks", []):
            watch[norm_code(s["code"])] = s.get("name") or ""
    except (OSError, ValueError) as e:
        log(f"watchlist.json を読めませんでした: {e}")
    return holdings, watch


def fetch_topix():
    """TOPIX 構成銘柄 {code: {name, sector, cls}}"""
    r = get(TOPIX_WEIGHT)
    df = pd.read_csv(io.StringIO(r.content.decode("cp932", "replace")), dtype=str)
    out = {}
    for _, row in df.iterrows():
        code = norm_code(row.get("コード"))
        if not code or code == "NAN":
            continue
        out[code] = {
            "name": nfkc(row.get("銘柄名")),
            "sector": nfkc(row.get("業種")),
            "cls": nfkc(row.get("ニューインデックス区分")),
        }
    log(f"TOPIX: {len(out)} 銘柄 (うち TOPIX500 {sum(v['cls'] in LARGE_CLASSES for v in out.values())})")
    return out


# ---------------------------------------------------------------------------
# 空売り残高
# ---------------------------------------------------------------------------


def short_file_urls():
    """直近 SHORT_MONTHS か月分の日次ファイル [(公表日, url)]"""
    html = get(SHORT_INDEX).content.decode("utf-8", "replace")
    pages = [SHORT_INDEX] + [JPX + p for p in dict.fromkeys(re.findall(r'"(/markets/public/short-selling/00-archives-\d+\.html)"', html))][:SHORT_MONTHS]
    urls = {}
    for i, page in enumerate(pages):
        body = html if i == 0 else get(page).content.decode("utf-8", "replace")
        for u in links(body, r"[^\"]*?\d{8}_Short_Positions\.xlsx?"):
            m = re.search(r"(\d{8})_Short_Positions", u)
            urls[m.group(1)] = u
    cutoff = (date.today() - timedelta(days=SHORT_MONTHS * 31)).strftime("%Y%m%d")
    out = sorted((d, u) for d, u in urls.items() if d >= cutoff)
    log(f"空売り残高ファイル: {len(out)} 件 ({out[0][0] if out else '-'} 〜 {out[-1][0] if out else '-'})")
    return out


def load_short_file(pub, url):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / Path(url).name
    if not path.exists() or path.stat().st_size == 0:
        path.write_bytes(get(url).content)
        time.sleep(0.3)  # JPX に負荷をかけない
    df = pd.read_excel(path, header=None)
    # 見出し行(「計算年月日」「銘柄コード」がある行)を探す
    head = None
    for i in range(min(20, len(df))):
        cells = [nfkc(v) for v in df.iloc[i].tolist()]
        if "計算年月日" in cells and "銘柄コード" in cells:
            head = i
            cols = {name: j for j, name in enumerate(cells)}
            break
    if head is None:
        raise RuntimeError(f"{url}: 見出し行が見つかりません")

    def col(*keys):
        for name, j in cols.items():
            if any(k in name for k in keys):
                return j
        return None

    c_date, c_code, c_name = cols["計算年月日"], cols["銘柄コード"], col("銘柄名")
    c_seller, c_saddr = col("商号・名称・氏名"), None
    c_client = col("委託者・投資一任契約の相手方の商号")
    c_caddr = col("委託者・投資一任契約の相手方の住所")
    c_fund = col("信託財産")
    c_ratio = col("空売り残高割合")
    # 商号の次の列が住所(見出しは「住所・所在地」)
    for name, j in cols.items():
        if name.startswith("住所"):
            c_saddr = j
    rows = []
    for vals in df.iloc[head + 2 :].itertuples(index=False):
        vals = list(vals)
        code = norm_code(vals[c_code])
        d = to_date(vals[c_date])
        if not code or code == "NAN" or d is None:
            continue
        try:
            ratio = float(vals[c_ratio]) * 100
        except (TypeError, ValueError):
            ratio = 0.0  # 「0.5%未満」などの表記は解消扱い
        if math.isnan(ratio):
            ratio = 0.0
        seller = nfkc(vals[c_seller]) if c_seller is not None else ""
        client = nfkc(vals[c_client]) if c_client is not None else ""
        client = "" if client == "nan" else client
        fund = nfkc(vals[c_fund]) if c_fund is not None else ""
        fund = "" if fund == "nan" else fund
        addr = nfkc(vals[c_caddr] if client and c_caddr is not None else vals[c_saddr] if c_saddr is not None else "")
        name = nfkc(vals[c_name]) if c_name is not None else ""
        name = re.sub(r"\s*(普通株式|受益証券|優先株式).*$", "", name)
        rows.append((d, pub, code, name, seller, client, fund, ratio, is_foreign_address(addr)))
    return rows


JP_ADDR = re.compile(r"JAPAN|TOKYO|OSAKA|[ぁ-んァ-ヶ一-龠]")


def is_foreign_address(addr):
    a = addr.upper()
    if not a or a == "NAN":
        return False
    return not JP_ADDR.search(a)


def build_shorts(files):
    """日次ファイルを計算日順に積み上げ、銘柄ごとの空売り残高割合の合計の推移を作る。

    戻り値: (series{code: [(date, total%, 海外%, 件数)]}, positions{code: [...]}, names{code: name}, 最終計算日)
    同じ空売り主体(商号 + 委託者 + 信託財産)の最新の報告だけを残し、0.5%未満になった報告で外す。
    """
    all_rows, names = [], {}
    for pub, url in files:
        try:
            rows = load_short_file(pub, url)
        except Exception as e:  # noqa: BLE001
            log(f"  {pub}: 読めませんでした ({e})")
            continue
        all_rows.extend(rows)
    if not all_rows:
        raise RuntimeError("空売り残高のデータが1件も読めませんでした")
    all_rows.sort(key=lambda r: (r[0], r[1]))
    state = {}  # code -> {key: (ratio, date, foreign, seller, client)}
    series = {}
    for d, pub, code, name, seller, client, fund, ratio, foreign in all_rows:
        names[code] = name or names.get(code, "")
        pos = state.setdefault(code, {})
        key = (seller, client, fund)
        if ratio < SHORT_MIN:
            pos.pop(key, None)
        else:
            pos[key] = (ratio, d, foreign, seller, client)
        total = sum(p[0] for p in pos.values())
        fr = sum(p[0] for p in pos.values() if p[2])
        s = series.setdefault(code, [])
        point = (d, round(total, 3), round(fr, 3), len(pos))
        if s and s[-1][0] == d:
            s[-1] = point
        else:
            s.append(point)
    last = max(r[0] for r in all_rows)
    first = min(r[0] for r in all_rows)
    log(f"空売り残高: {len(all_rows)} 件の報告、{len(series)} 銘柄 ({first} 〜 {last})")
    positions = {}
    for code, pos in state.items():
        positions[code] = sorted(
            (
                {"who": p[4] or p[3], "via": p[3] if p[4] else "", "pct": round(p[0], 2), "date": p[1].isoformat(), "foreign": p[2]}
                for p in pos.values()
            ),
            key=lambda x: -x["pct"],
        )
    return series, positions, names, first, last


def short_at(series_list, d):
    """d 時点の(合計%, 海外%, 件数)。それ以前に報告がなければ 0"""
    val = (0.0, 0.0, 0)
    for p in series_list or []:
        if p[0] > d:
            break
        val = p[1:]
    return val


# ---------------------------------------------------------------------------
# 投資部門別売買状況(市場全体)
# ---------------------------------------------------------------------------


def parse_num(v):
    s = nfkc(v).replace(",", "")
    try:
        return float(s)
    except ValueError:
        return None


def parse_investor_file(url):
    """東証プライムの海外投資家の売り・買い(千円)。週次は前週と当週の2期間ぶん"""
    df = pd.read_excel(io.BytesIO(get(url).content), header=None, sheet_name=0)
    title = " ".join(nfkc(v) for v in df.iloc[:5, 0].tolist() if nfkc(v) != "nan")
    m = re.search(r"(\d{4})年(\d{1,2})月", title)
    if not m:
        raise RuntimeError(f"{url}: 期間が読めません")
    year, month = int(m.group(1)), int(m.group(2))
    row = None
    for i in range(len(df)):
        if nfkc(df.iat[i, 0]).startswith("海外投資家") and nfkc(df.iat[i, 1]).startswith("売"):
            row = i
            break
    if row is None:
        raise RuntimeError(f"{url}: 海外投資家の行が見つかりません")
    periods = []
    # 期間ラベル(例: 08/31～09/04)は金額の2つ左の列、同じ見出し行にある
    label_row = None
    for i in range(row):
        if any(re.search(r"\d{1,2}/\d{1,2}\s*[～~〜-]\s*\d{1,2}/\d{1,2}", nfkc(v)) for v in df.iloc[i].tolist()):
            label_row = i
    value_cols = [j for j in range(df.shape[1]) if parse_num(df.iat[row, j]) is not None and parse_num(df.iat[row + 1, j]) is not None and parse_num(df.iat[row, j]) > 1000]
    for j in value_cols:
        sell, buy = parse_num(df.iat[row, j]), parse_num(df.iat[row + 1, j])
        label = ""
        if label_row is not None:
            for k in range(j, -1, -1):
                t = nfkc(df.iat[label_row, k])
                if re.search(r"\d{1,2}/\d{1,2}", t):
                    label = t
                    break
        periods.append((label, sell, buy))
    return year, month, periods


def end_date_of(label, year, month):
    m = re.findall(r"(\d{1,2})/(\d{1,2})", label)
    if not m:
        return None
    em, ed = int(m[-1][0]), int(m[-1][1])
    y = year + 1 if em < month - 6 else year - 1 if em > month + 6 else year
    try:
        return date(y, em, ed)
    except ValueError:
        return None


def fetch_market(previous):
    """海外投資家の週次・月次の差引き(億円)。過去の週は前回の flow.json から引き継ぐ"""
    weeks = {w["end"]: w for w in (previous or {}).get("weeks", [])}
    months = {}
    html = get(INVESTOR_INDEX).content.decode("utf-8", "replace")
    for url in links(html, r"[^\"]*stock_val_1_\d{6}\.xls"):
        try:
            year, month, periods = parse_investor_file(url)
        except Exception as e:  # noqa: BLE001
            log(f"  {url}: {e}")
            continue
        for label, sell, buy in periods:
            end = end_date_of(label, year, month)
            if end is None:
                continue
            weeks[end.isoformat()] = {
                "end": end.isoformat(),
                "label": label.replace("～", "〜"),
                "net": round((buy - sell) / 1e5, 1),  # 千円 → 億円
                "buy": round(buy / 1e5),
                "sell": round(sell / 1e5),
            }
    try:
        arch = get(INVESTOR_ARCHIVE).content.decode("utf-8", "replace")
        for url in links(arch, r"[^\"]*stock_val_1_m\d{4}\.xls"):
            try:
                year, month, periods = parse_investor_file(url)
            except Exception as e:  # noqa: BLE001
                log(f"  {url}: {e}")
                continue
            if periods:
                _, sell, buy = periods[-1]
                key = f"{year:04d}-{month:02d}"
                months[key] = {"month": key, "net": round((buy - sell) / 1e5, 1)}
    except RuntimeError as e:
        log(f"月次の投資部門別を読めませんでした: {e}")
    for m in (previous or {}).get("months", []):
        months.setdefault(m["month"], m)
    w = sorted(weeks.values(), key=lambda x: x["end"])[-52:]
    mo = sorted(months.values(), key=lambda x: x["month"])[-24:]
    log(f"投資部門別: 週次 {len(w)} 件、月次 {len(mo)} 件" + (f"、最新 {w[-1]['end']} {w[-1]['net']}億円" if w else ""))
    return {"weeks": w, "months": mo}


# ---------------------------------------------------------------------------
# 株価・出来高
# ---------------------------------------------------------------------------


def fetch_prices(codes):
    tickers = [f"{c}.T" for c in codes] + [TOPIX_ETF]
    close, volume = [], []
    for i in range(0, len(tickers), 150):
        chunk = tickers[i : i + 150]
        for attempt in range(1, 4):
            try:
                df = yf.download(chunk, period="1y", interval="1d", auto_adjust=False, actions=False, progress=False, threads=True)
                if not df.empty:
                    close.append(df["Close"])
                    volume.append(df["Volume"])
                    break
            except Exception as e:  # noqa: BLE001 — yfinance は色々な例外を投げる
                log(f"  download failed ({attempt}): {e}")
            time.sleep(10 * attempt)
        time.sleep(2)
    if not close:
        raise RuntimeError("株価を1件も取得できませんでした")
    c = pd.concat(close, axis=1).sort_index()
    v = pd.concat(volume, axis=1).sort_index()
    c = c.loc[:, ~c.columns.duplicated()]
    v = v.loc[:, ~v.columns.duplicated()]
    return c, v


def price_metrics(c, v, topix):
    s = c.dropna()
    if len(s) < 60:
        return None
    last = float(s.iloc[-1])

    def ret(n):
        return (last / float(s.iloc[-1 - n]) - 1) * 100 if len(s) > n else None

    vol = v.reindex(s.index).fillna(0)
    v20 = float(vol.iloc[-20:].mean())
    v120 = float(vol.iloc[-120:].mean()) if len(vol) >= 60 else None
    r4, r13, r26 = ret(20), ret(65), ret(130)
    t13, t26 = topix.get("r13"), topix.get("r26")
    weekly = s.resample("W-FRI").last().dropna().iloc[-WEEKS:]
    return {
        "close": rnd(last, 1),
        "date": s.index[-1].strftime("%Y-%m-%d"),
        "r4": rnd(r4, 1),
        "r13": rnd(r13, 1),
        "r26": rnd(r26, 1),
        "rel13": rnd(r13 - t13, 1) if r13 is not None and t13 is not None else None,
        "rel26": rnd(r26 - t26, 1) if r26 is not None and t26 is not None else None,
        "vol_ratio": rnd(v20 / v120, 2) if v120 else None,
        "turnover": rnd(v20 * last / 1e8, 1),  # 20日平均売買代金(億円)
        "weekly": weekly,
    }


# ---------------------------------------------------------------------------
# 大量保有報告書(EDINET)
# ---------------------------------------------------------------------------


def edinet_codelist():
    r = get(EDINET_CODELIST)
    z = zipfile.ZipFile(io.BytesIO(r.content))
    raw = z.read(z.namelist()[0]).decode("cp932", "replace")
    df = pd.read_csv(io.StringIO(raw), skiprows=1, dtype=str)
    issuer, filer_type = {}, {}
    for _, row in df.iterrows():
        ec = nfkc(row.iloc[0])
        filer_type[ec] = nfkc(row.iloc[1])
        sec = nfkc(row.iloc[11])
        if sec and sec != "nan" and len(sec) == 5:
            issuer[ec] = sec[:4].upper()
    return issuer, filer_type


def is_foreign_filer(name, ftype):
    if ftype.startswith("外国") or "非居住者" in ftype:
        return True
    n = nfkc(name).upper()
    return any(nfkc(g).upper() in n for g in FOREIGN_GROUPS)


def edinet_ratio(doc_id, key):
    """大量保有報告書のCSV(XBRL変換)から、今回と前回の株券等保有割合(%)を読む"""
    r = get(f"{EDINET_API}/documents/{doc_id}", params={"type": 5, "Subscription-Key": key})
    z = zipfile.ZipFile(io.BytesIO(r.content))
    cur, prev = [], []
    for name in z.namelist():
        if not name.endswith(".csv"):
            continue
        text = z.read(name).decode("utf-16", "replace")
        for line in text.splitlines():
            cells = [c.strip('"') for c in line.split("\t")]
            if len(cells) < 9:
                continue
            elem, ctx, val = cells[0], cells[2], cells[-1]
            try:
                x = float(val)
            except ValueError:
                continue
            x = x * 100 if x <= 1 else x
            if elem.endswith("HoldingRatioOfShareCertificatesEtcPerLastReport"):
                prev.append((ctx, x))
            elif elem.endswith("HoldingRatioOfShareCertificatesEtc"):
                cur.append((ctx, x))

    def pick(vals):
        if not vals:
            return None
        exact = [x for c, x in vals if c in ("FilingDateInstant", "CurrentYearInstant")]
        return round(exact[0] if exact else max(x for _, x in vals), 2)

    return pick(cur), pick(prev)


def fetch_edinet(targets):
    """対象銘柄の大量保有報告書(直近 EDINET_DAYS 日)。{code: [報告]}"""
    key = os.environ.get("EDINET_API_KEY", "").strip()
    if not key:
        log("EDINET_API_KEY が未設定のため、大量保有報告書は取得しません")
        return None
    try:
        cache = json.loads(EDINET_CACHE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cache = {}
    days_done = set(cache.get("days", []))
    docs = cache.get("docs", {})
    issuer_map, filer_type = edinet_codelist()
    today = datetime.now(JST).date()
    start = today - timedelta(days=EDINET_DAYS)
    d = start
    while d <= today:
        ds = d.isoformat()
        # 直近3日分は訂正・追加があるので毎回取り直す
        if ds in days_done and (today - d).days > 3:
            d += timedelta(days=1)
            continue
        try:
            r = get(f"{EDINET_API}/documents.json", params={"date": ds, "type": 2, "Subscription-Key": key})
            res = r.json().get("results") or []
        except Exception as e:  # noqa: BLE001
            log(f"  EDINET {ds}: {e}")
            d += timedelta(days=1)
            continue
        for doc in res:
            if doc.get("docTypeCode") not in ("350", "360") or doc.get("withdrawalStatus") not in (None, "0"):
                continue
            code = issuer_map.get(doc.get("issuerEdinetCode") or "")
            if not code:
                continue
            doc_id = doc["docID"]
            old = docs.get(doc_id, {})
            docs[doc_id] = {
                "code": code,
                "date": (doc.get("submitDateTime") or ds)[:10],
                "filer": nfkc(doc.get("filerName")),
                "type": "新規" if doc.get("docTypeCode") == "350" else "変更",
                "foreign": is_foreign_filer(doc.get("filerName"), filer_type.get(doc.get("edinetCode") or "", "")),
                "reason": nfkc(doc.get("currentReportReason") or "")[:60],
                "csv": doc.get("csvFlag") == "1",
                **{k: old[k] for k in ("pct", "prev") if k in old},
            }
        days_done.add(ds)
        time.sleep(0.2)
        d += timedelta(days=1)
    # 期間外を捨てる
    docs = {k: v for k, v in docs.items() if v["date"] >= start.isoformat()}
    # 対象銘柄 × 海外勢の報告だけ、保有割合を読む(結果はキャッシュ)
    fetched = 0
    for doc_id, v in sorted(docs.items(), key=lambda kv: kv[1]["date"], reverse=True):
        if v["code"] not in targets or not v["foreign"] or "pct" in v or not v.get("csv"):
            continue
        if fetched >= 400:
            break
        try:
            v["pct"], v["prev"] = edinet_ratio(doc_id, key)
        except Exception as e:  # noqa: BLE001
            log(f"  EDINET {doc_id}: {e}")
            v["pct"], v["prev"] = None, None
        fetched += 1
        time.sleep(0.2)
    cache = {"days": sorted(x for x in days_done if x >= start.isoformat()), "docs": dict(sorted(docs.items()))}
    EDINET_CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    by_code = {}
    for doc_id, v in docs.items():
        by_code.setdefault(v["code"], []).append({"id": doc_id, **{k: v[k] for k in ("date", "filer", "type", "foreign", "pct", "prev") if k in v}})
    for items in by_code.values():
        items.sort(key=lambda x: x["date"], reverse=True)
    log(f"EDINET: {len(docs)} 件の大量保有報告書、保有割合を新たに {fetched} 件読み取り")
    return by_code


# ---------------------------------------------------------------------------
# スコア
# ---------------------------------------------------------------------------


def score_stock(pm, sh, lh, lh_enabled, asof):
    """買い圧力と売り圧力をそれぞれ点数化(各 −2〜+2)。合計がプラスなら買い優勢。"""
    parts, reasons = {}, []

    # 売り圧力: 空売り残高割合の合計の増減(13週と4週)。増えるほどマイナス
    if sh is not None:
        now, d4, d13 = sh["now"], sh["d4"], sh["d13"]
        s = clamp(-(0.6 * d13 + 0.4 * d4) / 0.75)
        if now >= 5:
            s = clamp(s - 0.3)
        parts["short"] = round(s, 2)
        if d13 >= 0.3:
            reasons.append((-abs(s) - 0.1, f"空売り残高が13週で{d13:.1f}ポイント増(売り圧力が強まる)"))
        elif d13 <= -0.3:
            reasons.append((abs(s) + 0.1, f"空売り残高が13週で{-d13:.1f}ポイント減(売り圧力が弱まる)"))
        elif now < SHORT_MIN:
            reasons.append((0.05, "目立った空売り(0.5%以上)なし"))
        if now >= 5:
            reasons.append((-0.4, f"空売り残高が多い(合計{now:.1f}%)"))

    # 買い圧力(株価と出来高): TOPIX に勝っているか、出来高を伴っているか
    if pm is not None and pm.get("rel13") is not None:
        rel13, rel26 = pm["rel13"], pm.get("rel26") or 0
        s13, s26 = 0.6 * clamp(rel13 / 10), 0.4 * clamp(rel26 / 15)
        s = s13 + s26
        vr, r4 = pm.get("vol_ratio") or 1, pm.get("r4") or 0
        if vr >= 1.3 and r4 > 0:
            s = clamp(s + 0.4)
            reasons.append((0.5, f"出来高が増えながら上昇(直近20日の出来高が普段の{vr:.1f}倍)"))
        elif vr >= 1.3 and r4 < 0:
            s = clamp(s - 0.4)
            reasons.append((-0.5, f"出来高が増えながら下落(直近20日の出来高が普段の{vr:.1f}倍)"))
        parts["trend"] = round(s, 2)
        if abs(rel13) >= 3:
            reasons.append((s13, f"13週でTOPIXより{abs(rel13):.0f}ポイント{'強い' if rel13 > 0 else '弱い'}"))
        if abs(rel26) >= 10 and (rel26 > 0) != (rel13 > 0):
            reasons.append((s26, f"26週ではTOPIXより{abs(rel26):.0f}ポイント{'強い' if rel26 > 0 else '弱い'}"))

    # 買い圧力(大量保有): 海外勢の5%超の保有の増減(直近90日)
    if lh_enabled:
        since = (asof - timedelta(days=LH_WINDOW)).isoformat()
        delta, news, n = 0.0, [], 0
        for x in lh or []:
            if not x.get("foreign") or x["date"] < since:
                continue
            n += 1
            pct, prev = x.get("pct"), x.get("prev")
            if pct is not None and prev is not None:
                delta += pct - prev
            elif x["type"] == "新規":
                delta += 1.0
            news.append(x)
        s = clamp(delta / 1.0) if n else 0.0
        parts["holders"] = round(s, 2)
        if n:
            top = news[0]
            chg = f"{top['prev']:.1f}%→{top['pct']:.1f}%" if top.get("pct") is not None and top.get("prev") is not None else top["type"]
            reasons.append((s if s else 0.1, f"海外勢の大量保有報告{n}件(90日)。直近は{top['filer']} {chg}"))

    # 踏み上げ: 空売りが多い銘柄で買い戻しが進み、株価が上がっている
    if sh is not None and pm is not None and sh["now"] >= 2 and sh["d4"] <= -0.3 and (pm.get("r4") or 0) > 0:
        parts["squeeze"] = 0.4
        reasons.append((0.6, "空売りの買い戻し(踏み上げ)が進行中"))

    if not parts:
        return None
    total = round(sum(parts.values()), 2)
    label = "買い優勢" if total >= 1.5 else "やや買い優勢" if total >= 0.5 else "中立" if total > -0.5 else "やや売り優勢" if total > -1.5 else "売り優勢"
    reasons.sort(key=lambda r: -abs(r[0]))
    return {
        "total": total,
        "label": label,
        "parts": parts,
        "reasons": [{"text": t, "tone": "up" if w > 0 else "down"} for w, t in reasons[:4]],
    }


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main():
    holdings, watch = load_targets()
    try:
        previous = json.loads(OUT_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        previous = {}
    problems = []

    try:
        topix = fetch_topix()
    except RuntimeError as e:
        log(f"TOPIX 構成銘柄を読めませんでした: {e}")
        topix = {}
        problems.append("topix")
    universe = [c for c, v in topix.items() if v["cls"] in LARGE_CLASSES]
    tracked = list(dict.fromkeys(list(holdings) + list(watch)))
    price_codes = list(dict.fromkeys(tracked + universe))

    # 空売り残高(必須)
    series, positions, short_names, short_first, short_last = build_shorts(short_file_urls())
    asof = short_last

    # 投資部門別(失敗しても続ける)
    try:
        market = fetch_market(previous.get("market"))
    except Exception as e:  # noqa: BLE001
        log(f"投資部門別を読めませんでした: {e}")
        market = previous.get("market") or {"weeks": [], "months": []}
        problems.append("market")

    # 株価(必須)
    close, volume = fetch_prices(price_codes)
    tcol = close.get(TOPIX_ETF)
    topix_m = {}
    if tcol is not None:
        t = tcol.dropna()
        if len(t) > 130:
            topix_m = {"r13": (t.iloc[-1] / t.iloc[-66] - 1) * 100, "r26": (t.iloc[-1] / t.iloc[-131] - 1) * 100, "r4": (t.iloc[-1] / t.iloc[-21] - 1) * 100}
    got = sum(1 for c in price_codes if f"{c}.T" in close.columns and close[f"{c}.T"].notna().sum() >= 60)
    log(f"株価: {got}/{len(price_codes)} 銘柄")
    if got < len(price_codes) * 0.6 or not topix_m:
        raise SystemExit("株価の取得に失敗した銘柄が多いため flow.json を更新しません")

    # 大量保有(任意)
    lh = fetch_edinet(set(price_codes))
    lh_enabled = lh is not None
    if not lh_enabled and os.environ.get("EDINET_API_KEY"):
        problems.append("edinet")

    d4, d13, d26 = asof - timedelta(days=28), asof - timedelta(days=91), asof - timedelta(days=182)
    codes = list(dict.fromkeys(price_codes + list(series)))
    stocks = {}
    for code in codes:
        col = f"{code}.T"
        pm = price_metrics(close[col], volume[col], topix_m) if col in close.columns else None
        s_list = series.get(code)
        sh = None
        if s_list or pm is not None:
            now, now_f, n = short_at(s_list, asof)
            sh = {
                "now": round(now, 2),
                "foreign": round(now_f, 2),
                "n": n,
                "d4": round(now - short_at(s_list, d4)[0], 2),
                "d13": round(now - short_at(s_list, d13)[0], 2),
                "d26": round(now - short_at(s_list, d26)[0], 2),
            }
        sc = score_stock(pm, sh, (lh or {}).get(code), lh_enabled, asof)
        info = topix.get(code, {})
        name = holdings.get(code) or watch.get(code) or info.get("name") or short_names.get(code) or ""
        e = {"name": name}
        if info.get("cls"):
            e["cls"] = info["cls"].replace("TOPIX ", "")
        if info.get("sector"):
            e["sector"] = info["sector"]
        if pm is not None:
            e["price"] = {k: v for k, v in pm.items() if k != "weekly"}
        if sh is not None:
            e["short"] = sh
        if sc is not None:
            e["score"] = sc
        # 週次の株価と空売り残高(チャート用)。持ち株・ウォッチ・TOPIX500 のみ
        if pm is not None:
            wk = pm["weekly"]
            e["weeks"] = {
                "close": [rnd(x, 1) for x in wk.tolist()],
                "short": [round(short_at(s_list, d.date())[0], 2) for d in wk.index],
            }
        if code in tracked:
            e["positions"] = positions.get(code, [])[:8]
            if lh_enabled:
                e["holders"] = [x for x in (lh or {}).get(code, []) if x["date"] >= (asof - timedelta(days=EDINET_DAYS)).isoformat()][:8]
        stocks[code] = e

    week_dates = []
    ref = next((stocks[c] for c in price_codes if "weeks" in stocks.get(c, {}) and len(stocks[c]["weeks"]["close"]) == WEEKS), None)
    if ref is not None:
        tcol_w = close[TOPIX_ETF].dropna().resample("W-FRI").last().dropna().iloc[-WEEKS:]
        week_dates = [d.strftime("%Y-%m-%d") for d in tcol_w.index]

    # 有望銘柄ベスト5: TOPIX500 から、売り圧力が強まっていない(空売りが増えていない)銘柄をスコア順に
    cands = []
    for code in universe:
        e = stocks.get(code, {})
        sc, sh, pm = e.get("score"), e.get("short"), e.get("price")
        if not sc or not pm or sh is None or "trend" not in sc["parts"]:
            continue
        if sh["d13"] > 0.2 or sh["d4"] > 0.2 or sc["parts"]["trend"] <= 0 or (pm.get("turnover") or 0) < 5:
            continue
        cands.append((sc["total"], pm.get("rel13") or 0, code))
    cands.sort(reverse=True)
    top5 = [c for *_, c in cands[:5]]

    out = {
        "generated_at": datetime.now(JST).isoformat(timespec="minutes"),
        "asof": asof.isoformat(),
        "short_range": [short_first.isoformat(), short_last.isoformat()],
        "price_date": close.dropna(how="all").index[-1].strftime("%Y-%m-%d"),
        "edinet": lh_enabled,
        "problems": problems,
        "topix": {k: rnd(v, 1) for k, v in topix_m.items()},
        "week_dates": week_dates,
        "holdings": list(holdings),
        "watch": list(watch),
        "top5": top5,
        "market": market,
    }
    head = json.dumps(out, ensure_ascii=False, separators=(",", ":"))[:-1]
    lines = [head + ',"stocks":{']
    items = sorted(stocks.items())
    lines += [f"{json.dumps(c)}:{json.dumps(e, ensure_ascii=False, separators=(',', ':'))}" + ("," if i < len(items) - 1 else "") for i, (c, e) in enumerate(items)]
    lines.append("}}")
    OUT_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    top5_text = ", ".join(f"{c} {stocks[c]['name']}" for c in top5)
    log(f"wrote {OUT_PATH} ({len(stocks)} 銘柄、ベスト5: {top5_text})")
    for c in tracked:
        e = stocks.get(c, {})
        log(f"  {c} {e.get('name')}: {e.get('score', {}).get('label')} {e.get('score', {}).get('total')} short={e.get('short')}")


if __name__ == "__main__":
    main()
