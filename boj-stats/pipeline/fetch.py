#!/usr/bin/env python3
"""日本銀行 時系列統計データ検索サイト API から系列を取得し data/ に蓄積する。

使い方:
  python3 fetch.py                 # series.json の全系列を取得して CSV に追記・更新
  python3 fetch.py --years 5       # 初回など、過去5年分を取得（既定: 既存データがあれば直近3か月、無ければ10年）
  python3 fetch.py discover FM08   # DB内の系列一覧（コード・名称・頻度）を表示。新しい系列を探すとき用

蓄積形式: data/<DB>_<CODE>.csv（date,value）。同じ日付は最新の取得値で上書き（改定に追随）。
取得したAPIの生レスポンスは raw/YYYY-MM-DD/ に保存。標準ライブラリのみで動作。
API仕様: https://www.stat-search.boj.or.jp/info/api_manual.pdf
"""
import csv, datetime as dt, gzip, json, os, sys, time, urllib.parse, urllib.request
from collections import defaultdict

BASE = "https://www.stat-search.boj.or.jp/api/v1"
ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
RAW = os.path.join(ROOT, "raw")
MAX_CODES = 250          # 1リクエストあたりの系列コード上限（API仕様）
SLEEP = 2.0              # 高頻度アクセスを避けるためのリクエスト間隔（秒）


def api(endpoint, **params):
    params.setdefault("format", "json")
    params.setdefault("lang", "jp")
    url = f"{BASE}/{endpoint}?{urllib.parse.urlencode(params, safe=',@')}"
    req = urllib.request.Request(url, headers={"Accept-Encoding": "gzip", "User-Agent": "boj-stats-collector/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
    return json.loads(body.decode("utf-8"))


def load_series():
    with open(os.path.join(ROOT, "series.json"), encoding="utf-8") as f:
        return json.load(f)["series"]


def csv_path(db, code):
    return os.path.join(DATA, f"{db}_{code.replace('@', '_at_')}.csv")


def read_csv(path):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return {row["date"]: row["value"] for row in csv.DictReader(f)}


def write_csv(path, rows):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "value"])
        for d in sorted(rows):
            w.writerow([d, rows[d]])
    os.replace(tmp, path)


def norm_date(s, freq="M"):
    """APIの期表記を ISO 風に揃える: YYYYMMDD→YYYY-MM-DD, YYYYMM→YYYY-MM, 四半期 YYYY0Q→YYYYQn, それ以外はそのまま。"""
    s = str(s)
    if freq == "Q" and len(s) == 6 and s.isdigit():
        return f"{s[:4]}Q{int(s[4:])}"
    if len(s) == 8 and s.isdigit():
        return f"{s[:4]}-{s[4:6]}-{s[6:]}"
    if len(s) == 6 and s.isdigit():
        return f"{s[:4]}-{s[4:]}"
    return s


def fetch(years=None):
    series = load_series()
    today = dt.date.today()
    rawdir = os.path.join(RAW, today.isoformat())
    os.makedirs(DATA, exist_ok=True)
    os.makedirs(rawdir, exist_ok=True)

    # getDataCode は同一DB・同一期種でまとめて取得する
    groups = defaultdict(list)
    for s in series:
        if s["db"] in ("MOF", "CPI", "STAT", "ESTAT"):  # 日銀以外は fetch_mof.py / fetch_cpi.py / fetch_stat.py / fetch_estat.py で取る
            continue
        groups[(s["db"], s["freq"])].append(s)

    summary = {"date": today.isoformat(), "updated": [], "errors": []}
    for (db, freq), items in groups.items():
        for i in range(0, len(items), MAX_CODES):
            chunk = items[i:i + MAX_CODES]
            has_all = all(os.path.exists(csv_path(db, s["code"])) for s in chunk)
            back = years * 12 if years else (3 if has_all else 120)
            start = (today.replace(day=1) - dt.timedelta(days=31 * back)).strftime("%Y%m")
            if freq == "Q":  # 四半期の開始期は YYYY0Q
                start = start[:4] + "01"
            params = {"db": db, "code": ",".join(s["code"] for s in chunk), "startDate": start}
            pos = None
            while True:
                if pos:
                    params["startPosition"] = pos
                try:
                    res = api("getDataCode", **params)
                except Exception as e:  # ネットワーク遮断など
                    summary["errors"].append(f"{db}/{freq}: {type(e).__name__}: {e}")
                    break
                with open(os.path.join(rawdir, f"{db}_{freq}_{pos or 0}.json"), "w", encoding="utf-8") as f:
                    json.dump(res, f, ensure_ascii=False)
                if str(res.get("STATUS")) != "200":
                    summary["errors"].append(f"{db}/{freq}: {res.get('MESSAGEID')} {res.get('MESSAGE')}")
                    break
                returned = set()
                for d in res.get("RESULTSET") or res.get("data") or []:
                    code = d.get("SERIES_CODE")
                    returned.add(code)
                    path = csv_path(db, code)
                    rows = read_csv(path)
                    before = dict(rows)
                    v = d.get("VALUES")
                    # APIは VALUES の中に SURVEY_DATES と VALUES を入れ子で返す
                    dates, vals = (v.get("SURVEY_DATES"), v.get("VALUES")) if isinstance(v, dict) else (d.get("SURVEY_DATES"), v)
                    for date, val in zip(dates or [], vals or []):
                        if val is None or val == "":
                            continue
                        rows[norm_date(date, freq)] = str(val)
                    write_csv(path, rows)
                    new = sorted(set(rows) - set(before))
                    revised = [k for k in before if k in rows and rows[k] != before[k]]
                    if new or revised:
                        summary["updated"].append({"db": db, "code": code, "new": len(new),
                                                   "revised": len(revised), "latest": max(rows) if rows else None})
                for s in chunk:
                    if s["code"] not in returned and pos is None:
                        summary["errors"].append(f"{db}/{s['code']}: データが返らなかった（コード誤りの可能性）")
                pos = res.get("NEXTPOSITION")
                if not pos:
                    break
                time.sleep(SLEEP)
            time.sleep(SLEEP)

    with open(os.path.join(ROOT, "last_fetch.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 1 if summary["errors"] and not summary["updated"] else 0


def discover(db, freq=None):
    res = api("getMetadata", db=db)
    if str(res.get("STATUS")) != "200":
        print(res.get("MESSAGEID"), res.get("MESSAGE"))
        return 1
    for d in res.get("RESULTSET") or res.get("data") or []:
        f = d.get("FREQUENCY", "")
        if freq and not f.upper().startswith(freq.upper()):
            continue
        if not d.get("SERIES_CODE"):
            continue
        print(f"{d.get('SERIES_CODE')}\t{f}\t{d.get('NAME_OF_TIME_SERIES_J')}\t{d.get('UNIT_J')}\t{d.get('LAST_UPDATE', '')}")
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "discover":
        sys.exit(discover(args[1], args[2] if len(args) > 2 else None))
    years = int(args[args.index("--years") + 1]) if "--years" in args else None
    sys.exit(fetch(years))
