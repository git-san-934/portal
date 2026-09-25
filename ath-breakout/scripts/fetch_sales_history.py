"""対象銘柄の過去の年次売上高を、EDINET の有価証券報告書から集める(ブレイク後の成績との関係を検証するため)。

- EDINET API の書類一覧(過去10年分まで取得できる)から、対象銘柄の有価証券報告書を探す
- 有価証券報告書の「主要な経営指標等の推移」には5期分の売上高があるので、
  新しい報告書から順に読み、まだ持っていない決算期がある報告書だけを開く
- 決算期ごとに「その売上が世の中に出た日」(有価証券報告書の提出日)も記録する。
  検証ではブレイクした日より前に出ていた売上だけを使い、後から分かった数字を使わないようにする
- 同じ書類一覧から「自己株券買付状況報告書」(自社株買いの実施中に毎月出す報告書)の提出日も集め、
  data/buyback.json に銘柄ごとに書き出す(この報告書は公開期間が1年なので、直近1年分だけ)
- 過去の自社株買いは、有価証券報告書のキャッシュフロー計算書「自己株式の取得による支出」(当期・前期)と
  親会社株主に帰属する当期純利益(5期分)から決算期ごとに記録する

GitHub Actions(.github/workflows/update-ath-sales-history.yml)から実行される。
時間がかかるので TIME_LIMIT で打ち切り、途中までの結果を保存して次回に続きを取る。
EDINET_API_KEY(環境変数)が必要。
"""

import io
import json
import os
import re
import sys
import time
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

EDINET_API = "https://api.edinet-fsa.go.jp/api/v2"
YEARS = 10  # 書類一覧 API で遡れる年数
TIME_LIMIT = 100 * 60  # 秒。これを過ぎたら保存して終わる(次回に続き)
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DOCS_PATH = DATA_DIR / "edinet_docs.json"
OUT_PATH = DATA_DIR / "sales_history.json"
BUYBACK_PATH = DATA_DIR / "buyback.json"
SCAN_VERSION = 3  # 書類一覧から拾う書類を増やしたら上げる(全期間を見直す)
JST = timezone(timedelta(hours=9))
HEADERS = {"User-Agent": "portal-ath-breakout"}

# 「主要な経営指標等の推移」の売上高にあたる要素。業種で名前が違う(銀行は経常収益、IFRSは売上収益 など)
REVENUE_RE = re.compile(r"(NetSales|Revenue|OperatingRevenue|OrdinaryIncome)\w*SummaryOfBusinessResults$")
EXCLUDE_RE = re.compile(r"Cost|Ratio|Per|Loss|Profit|Growth|Expense")
# キャッシュフロー計算書の「自己株式の取得による支出」(J-GAAP / IFRS / 米国基準で名前が違う)
BUYBACK_RE = re.compile(r"(PurchaseOfTreasury|PaymentsForPurchaseOfTreasury|RepurchaseOfTreasury)\w*(FinCF|Financing)\w*$")
PROFIT_RE = re.compile(r"(ProfitLossAttributableToOwnersOfParent|NetIncomeLossAttributableToOwnersOfParent|NetIncomeLoss)\w*SummaryOfBusinessResults$")
PROFIT_EXCLUDE_RE = re.compile(r"Per|Ratio|Comprehensive|Diluted|Basic")
CTX_RE = re.compile(r"^(CurrentYear|Prior([1-4])Year)Duration(_NonConsolidatedMember)?$")

START = time.monotonic()
VERSION = 3  # sales_history.json の読み方の版。上げると全部読み直す


def log(*a):
    print(*a, flush=True)


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


def out_of_time():
    return time.monotonic() - START > TIME_LIMIT


def load(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n", encoding="utf-8")


def universe_codes():
    return {u["code"] for u in json.loads((DATA_DIR / "universe.json").read_text(encoding="utf-8"))}


# ---------- 1. 書類一覧から有価証券報告書を探す ----------

def scan_documents(key, codes):
    cache = load(DOCS_PATH, {"scanned": [], "docs": {}})
    if cache.get("v") != SCAN_VERSION:
        cache.update({"v": SCAN_VERSION, "scanned": []})
    buyback = cache.setdefault("buyback", {})  # 銘柄 -> 自己株券買付状況報告書の提出日
    scanned = set(cache["scanned"])
    today = datetime.now(JST).date()
    first = today - timedelta(days=365 * YEARS - 7)
    days = [first + timedelta(days=i) for i in range((today - first).days)]  # 今日の分は次回
    todo = [d for d in days if d.isoformat() not in scanned]
    log(f"書類一覧: {len(todo)} 日分を確認します")
    for n, d in enumerate(sorted(todo, reverse=True)):
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
            if kind not in ("120", "220") or len(sec) != 5:
                continue
            code = sec[:4].upper()
            if code not in codes:
                continue
            if kind == "220":
                dates = buyback.setdefault(code, [])
                if doc["submitDateTime"][:10] not in dates:
                    dates.append(doc["submitDateTime"][:10])
                    dates.sort()
                continue
            if not doc.get("periodEnd"):
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
        time.sleep(0.2)
    cache["scanned"] = sorted(s for s in scanned if s >= first.isoformat())
    save(DOCS_PATH, cache)
    save(BUYBACK_PATH, {"updated": today.isoformat(), "scanned_from": min(cache["scanned"], default=None), "dates": buyback})
    log(f"自己株券買付状況報告書: {len(buyback)} 銘柄、延べ {sum(map(len, buyback.values()))} 件")
    return cache["docs"]


# ---------- 2. 有価証券報告書から5期分の売上高を読む ----------

def shift_years(period_end, n):
    y, m, dd = map(int, period_end.split("-"))
    return f"{y - n:04d}-{m:02d}"


def pick(rows, name_re, exclude_re=None, largest=False):
    """rows から name_re にあう要素を {何期前: 値} で返す。連結を優先。largest なら当期の絶対値が最大の要素"""
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
        cands = {k: v for k, v in found.items() if k[1] == nonconsolidated and 0 in v}
        if cands:
            key = (lambda kv: abs(kv[1][0])) if largest else (lambda kv: -len(kv[0][0]))
            return max(cands.items(), key=key)[1]
    return {}


def parse_rows(rows):
    """rows: (要素名, コンテキスト, 値) → {何期前: 売上高}。連結を優先し、なければ単体"""
    found = {}  # (要素名, 単体か) -> {何期前: 値}
    for elem, ctx, val in rows:
        name = elem.split(":")[-1]
        if not REVENUE_RE.search(name) or EXCLUDE_RE.search(name):
            continue
        m = CTX_RE.match(ctx)
        if not m:
            continue
        try:
            v = float(val)
        except ValueError:
            continue
        back = int(m.group(2) or 0)
        found.setdefault((name, bool(m.group(3))), {})[back] = v
    for nonconsolidated in (False, True):
        cands = {k: v for k, v in found.items() if k[1] == nonconsolidated and v.get(0)}
        if cands:
            # 売上高にあたる要素のうち、当期の値がいちばん大きいもの(内訳の項目を避ける)
            (name, _), vals = max(cands.items(), key=lambda kv: kv[1][0])
            if nonconsolidated:
                # 連結の売上が見つからず単体を使うとき、連結側にどんな要素があったかを残す(要素名の取りこぼし調査用)
                cons = sorted({e.split(":")[-1] for e, c, _ in rows if c == "CurrentYearDuration" and "SummaryOfBusinessResults" in e})
                log(f"    単体の {name} を使用。連結の要素: {', '.join(cons[:12]) or 'なし'}")
            return vals, ("単体:" if nonconsolidated else "連結:") + name
    return {}, None


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


XBRL_RE = re.compile(r"<([\w-]+:\w+(?:SummaryOfBusinessResults|Treasury\w*))\b([^>]*)>([^<]*)<")
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


def collect_sales(key, docs):
    out = load(OUT_PATH, {})
    opened = with_bb = 0
    for code in sorted(docs):
        rec = out.setdefault(code, {"annual": {}, "avail": {}, "read": []})
        if rec.get("v") != VERSION:  # 読み方を変えたら読み直す
            rec.update({"v": VERSION, "annual": {}, "src": {}, "read": [], "buyback": {}, "profit": {}})
        lst = sorted(docs[code], key=lambda x: x[0], reverse=True)
        # 提出日 = その決算期の売上が出た日(開かない報告書の分も記録できる)
        for submit, period_end, _, _ in lst:
            p = period_end[:7]
            if p not in rec["avail"] or submit < rec["avail"][p]:
                rec["avail"][p] = submit
        for submit, period_end, doc_id, csv in lst:
            if doc_id in rec["read"]:
                continue
            covered = {shift_years(period_end, n) for n in range(5)}
            if covered <= set(rec["annual"]) and period_end[:7] in rec["buyback"]:
                continue  # 新しい決算期がない報告書は開かない(自社株買いは当期・前期分しかないので毎年開く)
            if out_of_time():
                save(OUT_PATH, out)
                log(f"時間切れ: 有価証券報告書を {opened} 件読んだところで止めます")
                return out
            try:
                rows = read_csv(key, doc_id) if csv else []
                vals, src = parse_rows(rows)
                if not vals:
                    rows = read_xbrl(key, doc_id)
                    vals, src = parse_rows(rows)
                bb = pick(rows, BUYBACK_RE)
                pf = pick(rows, PROFIT_RE, PROFIT_EXCLUDE_RE, largest=True)
            except Exception as e:  # noqa: BLE001
                log(f"  {code} {doc_id}: {e}")
                continue
            rec["read"].append(doc_id)
            opened += 1
            for back, v in vals.items():
                p = shift_years(period_end, back)
                if p not in rec["annual"]:
                    rec["annual"][p] = v
                    rec["src"][p] = src  # 成長率は同じ要素どうしで比べる(連結と単体を混ぜない)
            with_bb += bool(bb)
            # 自己株式の取得による支出(マイナスで載る)。要素がなければ 0(買っていない)として記録
            for back in (0, 1):
                p = shift_years(period_end, back)
                if p not in rec["buyback"] or back == 0:
                    rec["buyback"][p] = abs(bb.get(back, 0.0))
            for back, v in pf.items():
                rec["profit"].setdefault(shift_years(period_end, back), v)
            if not vals:
                log(f"  {code} {doc_id}: 売上高が見つかりませんでした")
            if opened % 50 == 0:
                save(OUT_PATH, out)
                log(f"  有価証券報告書 {opened} 件")
            time.sleep(0.3)
    save(OUT_PATH, out)
    log(f"有価証券報告書を {opened} 件読みました(うち自己株式の取得の行があったもの {with_bb} 件)")
    return out


def main():
    key = os.environ.get("EDINET_API_KEY", "").strip()
    if not key:
        print("EDINET_API_KEY が未設定です", file=sys.stderr)
        sys.exit(1)
    codes = universe_codes()
    docs = scan_documents(key, codes)
    out = collect_sales(key, docs)
    have = sum(1 for c in codes if out.get(c, {}).get("annual"))
    years = sum(len(v["annual"]) for v in out.values())
    log(f"売上高: {have}/{len(codes)} 銘柄、延べ {years} 期分")


if __name__ == "__main__":
    main()
