"""cf/build/codes.txt の銘柄について、有価証券報告書(直近7期分)と最新の半期報告書の XBRL CSV から
財務諸表の数字と、設備投資などの文章を取り出して cf/build/raw/<コード>.json.gz に保存する。
投資分析ページ(cf/<コード>/)を作るための下準備で、GitHub Actions(.github/workflows/cf-build-raw.yml)から動かす。
EDINET_API_KEY(環境変数)が必要。
"""

import gzip
import io
import json
import os
import re
import sys
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

EDINET_API = "https://api.edinet-fsa.go.jp/api/v2"
HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
JST = timezone(timedelta(hours=9))
START_DAY = date(2019, 6, 1)  # 2019年3月期の報告書から
WORKERS = 6
HEADERS = {"User-Agent": "portal-cf-build"}
TEXTS = (
    "DescriptionOfBusinessTextBlock",
    "OverviewOfCapitalExpendituresEtcTextBlock",
    "PlannedAdditionsRetirementsEtcOfFacilitiesTextBlock",
    "ResearchAndDevelopmentActivitiesTextBlock",
    "BusinessPolicyBusinessEnvironmentIssuesToAddressEtcTextBlock",
    "ManagementAnalysisOfFinancialPositionOperatingResultsAndCashFlowsTextBlock",
    "OverviewOfBusinessResultsTextBlock",
    "DividendPolicyTextBlock",
)
TEXT_MAX = 6000
CTX_OK = re.compile(r"^[A-Za-z0-9]+(Duration|Instant)(_NonConsolidatedMember)?$")


def log(*a):
    print(*a, flush=True)


def get(url, params, retries=4):
    last = None
    for attempt in range(1, retries + 1):
        try:
            r = requests.get(url, params=params, headers=HEADERS, timeout=120)
            if r.status_code == 200:
                return r
            last = f"HTTP {r.status_code}"
            if r.status_code in (400, 401, 403, 404):
                break
        except requests.RequestException as e:
            last = e
        time.sleep(3 * attempt)
    raise RuntimeError(f"{url}: {last}")


def scan(key, codes):
    today = datetime.now(JST).date()
    days = [START_DAY + timedelta(days=i) for i in range((today - START_DAY).days + 1)]
    days = [d for d in days if d.weekday() < 5]
    want = set(codes)
    docs = {c: [] for c in codes}

    def work(d):
        try:
            return get(f"{EDINET_API}/documents.json", {"date": d.isoformat(), "type": 2, "Subscription-Key": key}).json()
        except Exception as e:  # noqa: BLE001
            log(f"  {d}: {e}")
            return None

    with ThreadPoolExecutor(WORKERS) as ex:
        for n, res in enumerate(ex.map(work, days)):
            for doc in (res or {}).get("results") or []:
                sec = (doc.get("secCode") or "").strip()
                code = sec[:4].upper()
                if len(sec) != 5 or code not in want or doc.get("docTypeCode") not in ("120", "160", "140"):
                    continue
                if doc.get("withdrawalStatus") not in (None, "0"):
                    continue
                docs[code].append({k: doc.get(k) for k in ("docID", "docTypeCode", "submitDateTime", "periodStart", "periodEnd", "docDescription", "filerName", "csvFlag")})
            if n % 200 == 199:
                log(f"  書類一覧 {n + 1}/{len(days)} 日")
    return docs


def read_doc(key, doc_id, keep_text):
    r = get(f"{EDINET_API}/documents/{doc_id}", {"type": 5, "Subscription-Key": key})
    z = zipfile.ZipFile(io.BytesIO(r.content))
    facts, texts = [], {}
    for name in z.namelist():
        base = name.split("/")[-1]
        if not name.endswith(".csv") or not base.startswith("jpcrp"):
            continue
        for line in z.read(name).decode("utf-16", "replace").splitlines()[1:]:
            c = [x.strip('"') for x in line.split("\t")]
            if len(c) < 9:
                continue
            elem, label, ctx, unit, val = c[0], c[1], c[2], c[6], c[8]
            short = elem.split(":")[-1]
            if short.endswith("TextBlock"):
                if keep_text and short in TEXTS and not ctx.endswith("NonConsolidatedMember"):
                    t = re.sub(r"<[^>]+>", " ", val)
                    t = re.sub(r"[ 　]+", " ", t).strip()
                    texts[short] = t[:TEXT_MAX]
                continue
            if not CTX_OK.match(ctx) or unit not in ("JPY", "pure", "shares", "JPYPerShares"):
                continue
            try:
                v = float(val.replace(",", ""))
            except ValueError:
                continue
            facts.append([elem, label, ctx, unit, v])
    # 連結の財務諸表があれば単体の数字は捨てる(容量を減らすため。経営指標の単体分だけは残す)
    has_cons = any(not f[2].endswith("NonConsolidatedMember") and (f[0].startswith("jppfs_cor:") or f[0].startswith("jpigp_cor:")) for f in facts)
    if has_cons:
        facts = [f for f in facts if not f[2].endswith("NonConsolidatedMember") or "SummaryOfBusinessResults" in f[0]]
    return facts, texts


def main():
    key = os.environ.get("EDINET_API_KEY")
    if not key:
        sys.exit("EDINET_API_KEY がありません")
    codes = [c.strip() for c in (HERE / "codes.txt").read_text().split() if c.strip()]
    RAW.mkdir(exist_ok=True)
    todo = [c for c in codes if not (RAW / f"{c}.json.gz").exists()]
    log(f"{len(todo)} 銘柄を取得します")
    if not todo:
        return
    docs = scan(key, todo)
    for code in todo:
        lst = sorted(docs[code], key=lambda d: d["submitDateTime"])
        annual = {}
        for d in lst:
            if d["docTypeCode"] == "120" and d["periodEnd"]:
                annual[d["periodEnd"][:7]] = d  # 同じ期はあとに出したもの
        periods = sorted(annual, reverse=True)[:7]
        half = [d for d in lst if d["docTypeCode"] in ("160", "140")]
        half = half[-1:] if half else []
        out = {"code": code, "docs": []}
        for i, p in enumerate(periods):
            d = annual[p]
            try:
                facts, texts = read_doc(key, d["docID"], keep_text=True)
            except Exception as e:  # noqa: BLE001
                log(f"  {code} {d['docID']}: {e}")
                continue
            if i > 0:  # 古い報告書は設備投資の概要だけ残す
                texts = {k: v for k, v in texts.items() if k == "OverviewOfCapitalExpendituresEtcTextBlock"}
            out["docs"].append({**d, "facts": facts, "texts": texts})
        for d in half:
            try:
                facts, texts = read_doc(key, d["docID"], keep_text=False)
                out["docs"].append({**d, "facts": facts, "texts": texts})
            except Exception as e:  # noqa: BLE001
                log(f"  {code} {d['docID']}: {e}")
        with gzip.open(RAW / f"{code}.json.gz", "wt", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        log(f"{code}: 有報 {len(periods)} 期分, 半期 {len(half)}")


if __name__ == "__main__":
    main()
