"""投資分析ページを新しく作る銘柄について、有価証券報告書7年分の数字と本文の一部を EDINET から集める。

- 対象は cf/data/cf_queue.json の "codes"(証券コード4桁)。ページがまだない銘柄の下ごしらえ用
- 書類一覧を約7年分さかのぼり、有価証券報告書(docTypeCode=120)を全銘柄ぶん cf/data/cf_docs.json に控える。
  次に別の銘柄を足したときは、書類一覧を見直さずにすむ
- 銘柄ごとに直近7期の有報の XBRL CSV を読み、当期(と最新の有報は前期)の円単位の数字を全部と、
  「設備投資等の概要」などの本文を cf/data/cf_raw/<コード>.json に書く
- ページ(cf/<コード>/data.js・index.html)は、この json をもとに作る(build_cf.py)

GitHub Actions(.github/workflows/build-cf-raw.yml)から実行される。EDINET_API_KEY(環境変数)が必要。
TIME_LIMIT(秒)で打ち切り、途中までの結果を保存して次回に続きを取る。
"""

import io
import json
import os
import re
import sys
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from html import unescape

from fetch_eps import EDINET_API, JST, WORKERS, get, load, log, out_of_time, save, DATA_DIR

SCAN_DAYS = 7 * 365 + 150  # 7期前の有報まで届くように
YEARS = 7
QUEUE_PATH = DATA_DIR / "cf_queue.json"
DOCS_PATH = DATA_DIR / "cf_docs.json"
RAW_DIR = DATA_DIR / "cf_raw"
VERSION = 1  # cf_raw の形の版。上げると全部読み直す

# 当期・前期(連結と単体)。セグメントなどの軸がついたコンテキストは使わない
CTX_RE = re.compile(r"^(CurrentYear|Prior1Year)(Duration|Instant)(_NonConsolidatedMember)?$")
# 本文。(キー, 要素名, 最新の有報だけか, 最大文字数)
TEXTS = [
    ("business", "DescriptionOfBusinessTextBlock", True, 4000),
    ("capex", "OverviewOfCapitalExpendituresEtcTextBlock", False, 3000),
    ("plan", "PlannedAdditionsRetirementsEtcOfFacilitiesTextBlock", True, 3000),
    ("dividend", "DividendPolicyTextBlock", True, 2000),
    ("policy", "BusinessPolicyBusinessEnvironmentIssuesToAddressEtcTextBlock", True, 5000),
    ("rd", "ResearchAndDevelopmentActivitiesTextBlock", True, 2000),
    ("mda", "ManagementAnalysisOfFinancialPositionOperatingResultsAndCashFlowsTextBlock", True, 9000),
    ("segment", "NotesSegmentInformationEtcConsolidatedFinancialStatementsTextBlock", True, 5000),
]
TEXT_NAMES = {t[1]: t for t in TEXTS}


def queue_codes():
    return sorted({c.upper() for c in load(QUEUE_PATH, {}).get("codes", [])})


# ---------- 1. 書類一覧から有価証券報告書を探す(全銘柄) ----------

def scan_documents(key):
    cache = load(DOCS_PATH, {"scanned": [], "docs": {}})
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
                if len(sec) != 5 or doc.get("docTypeCode") != "120" or doc.get("withdrawalStatus") not in (None, "0"):
                    continue
                if doc.get("ordinanceCode") != "010" or doc.get("formCode") != "030000" or not doc.get("periodEnd"):
                    continue
                entry = [doc["submitDateTime"][:10], doc["periodEnd"], doc["docID"], doc.get("csvFlag") == "1", doc.get("filerName") or ""]
                lst = cache["docs"].setdefault(sec[:4].upper(), [])
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
        cache["docs"][code] = sorted(x for x in cache["docs"][code] if x[0] >= first_s)
        if not cache["docs"][code]:
            del cache["docs"][code]
    save(DOCS_PATH, cache)
    log(f"有価証券報告書が見つかった銘柄: {len(cache['docs'])}")
    return cache


def chain(docs):
    """直近7期の有報を新しい順に(同じ期は、あとに出したもの=訂正を含む)"""
    by_period = {}
    for d in sorted(docs):
        by_period[d[1][:7]] = d
    return [by_period[p] for p in sorted(by_period, reverse=True)[:YEARS]]


# ---------- 2. 有価証券報告書を読む ----------

def clean(text, limit):
    text = unescape(re.sub(r"<[^>]+>", " ", text))
    text = re.sub(r"[ \t　]+", " ", text)
    text = re.sub(r"\s*\n\s*", "\n", text).strip()
    return text[:limit]


def read_csv(key, doc_id):
    """(要素名, コンテキスト, 値, 単位) を返す。数字は円単位のものだけ、本文は TEXTS のものだけ"""
    r = get(f"{EDINET_API}/documents/{doc_id}", {"type": 5, "Subscription-Key": key}, want_zip=True)
    z = zipfile.ZipFile(io.BytesIO(r.content))
    rows = []
    for name in z.namelist():
        if not name.endswith(".csv") or "jpcrp" not in name.split("/")[-1]:
            continue
        for line in z.read(name).decode("utf-16", "replace").splitlines()[1:]:
            cells = [c.strip('"') for c in line.split("\t")]
            if len(cells) < 9:
                continue
            elem = cells[0].split(":")[-1]
            if cells[6] == "JPY" or elem in TEXT_NAMES:
                rows.append((elem, cells[2], "\t".join(cells[8:]), cells[6]))
    return rows


XBRL_RE = re.compile(r"<([\w-]+):(\w+)\b([^>]*?)(?:/>|>(.*?)</\1:\2>)", re.S)
CTXREF_RE = re.compile(r'contextRef="([^"]+)"')
UNITREF_RE = re.compile(r'unitRef="([^"]*)"')


def read_xbrl(key, doc_id):
    """CSV がない古い書類用。XBRL 本体から同じ形で返す"""
    r = get(f"{EDINET_API}/documents/{doc_id}", {"type": 1, "Subscription-Key": key}, want_zip=True)
    z = zipfile.ZipFile(io.BytesIO(r.content))
    rows = []
    for name in z.namelist():
        if "PublicDoc" in name and name.endswith(".xbrl"):
            text = z.read(name).decode("utf-8", "replace")
            for _, elem, attrs, val in XBRL_RE.findall(text):
                m, u = CTXREF_RE.search(attrs), UNITREF_RE.search(attrs)
                if not m:
                    continue
                unit = u.group(1) if u else ""
                if unit == "JPY" or elem in TEXT_NAMES:
                    rows.append((elem, m.group(1), unescape(val or ""), unit))
    return rows


def shift_years(period_end, n):
    y, m = int(period_end[:4]), int(period_end[5:7])
    return f"{y - n:04d}-{m:02d}"


def read_doc(key, entry, latest):
    _, period_end, doc_id, csv, _ = entry
    rows = read_csv(key, doc_id) if csv else []
    if not any(u == "JPY" for _, _, _, u in rows):
        rows = read_xbrl(key, doc_id)
    num, single, texts = {}, {}, {}
    for elem, ctx, val, unit in rows:
        if elem in TEXT_NAMES:
            k, _, only_latest, limit = TEXT_NAMES[elem]
            if ctx.startswith("FilingDate") or ctx.startswith("CurrentYear"):
                if latest or not only_latest:
                    texts[k] = clean(val, limit)
            continue
        m = CTX_RE.match(ctx)
        if not m or (m.group(1) == "Prior1Year" and not latest):
            continue
        try:
            v = float(val.replace(",", ""))
        except ValueError:
            continue
        ym = shift_years(period_end, 1 if m.group(1) == "Prior1Year" else 0)
        (single if m.group(3) else num).setdefault(elem, {})[ym] = v
    return {"period": period_end[:7], "doc": doc_id, "num": num, "single": single, "text": texts}


def build(results, name):
    """新しい有報の数字を優先して、要素ごとに年→値をつなぐ"""
    out = {"v": VERSION, "name": name, "docs": [[r["period"], r["doc"]] for r in results], "num": {}, "single": {}, "text": {}}
    for r in results:  # 新しい順
        for k in ("num", "single"):
            for elem, vals in r[k].items():
                dst = out[k].setdefault(elem, {})
                for ym, v in vals.items():
                    dst.setdefault(ym, v)
        if r["text"]:
            out["text"][r["period"]] = r["text"]
    return out


def collect(key, cache, codes):
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    todo = []
    for code in codes:
        ch = chain(cache["docs"].get(code, []))
        if not ch:
            log(f"  {code}: 有価証券報告書が見つかりません")
            continue
        old = load(RAW_DIR / f"{code}.json", {})
        if old.get("v") == VERSION and [d[1] for d in old.get("docs", [])] == [d[2] for d in ch]:
            continue
        todo.append((code, ch))
    log(f"読む銘柄: {len(todo)} 社")

    def work(item):
        code, ch = item
        results = []
        for i, entry in enumerate(ch):
            if out_of_time():
                return code, ch, None
            try:
                results.append(read_doc(key, entry, i == 0))
            except Exception as e:  # noqa: BLE001
                log(f"  {code} {entry[2]}: {e}")
                return code, ch, None
        return code, ch, results

    done = 0
    with ThreadPoolExecutor(WORKERS) as ex:
        for code, ch, results in ex.map(work, todo):
            if results is None:
                continue
            save(RAW_DIR / f"{code}.json", build(results, ch[0][4]))
            done += 1
            log(f"  {code} {ch[0][4]}: {len(results)} 期分")
    if out_of_time():
        log("時間切れ: 残りは次回に読みます")
    return done


def main():
    key = os.environ.get("EDINET_API_KEY", "").strip()
    if not key:
        print("EDINET_API_KEY が未設定です", file=sys.stderr)
        sys.exit(1)
    codes = queue_codes()
    cache = scan_documents(key)
    done = collect(key, cache, codes)
    have = sum(1 for c in codes if (RAW_DIR / f"{c}.json").exists())
    log(f"今回 {done} 社読みました。{len(codes)} 社のうち {have} 社の数字があります")


if __name__ == "__main__":
    main()
