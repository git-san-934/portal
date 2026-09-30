#!/usr/bin/env python3
"""総務省統計局サイト（www.stat.go.jp）の統計を取り込む（消費者物価の全国分は fetch_cpi.py）。

series.json の db が "STAT" の系列が対象。
- CPI_TKY_*_YOY: 東京都区部の消費者物価（2025年基準、前年比は2026年1月から）。全国より約1か月早く出る
- CTI_TOTAL_REAL: 総消費動向指数（実質、2025年基準、傾向推計値）。最新の公表列を使う（毎月過去に遡って改定される）
- CTI_TOTAL_REAL_YOY: 上の前年同月比
"""
import csv, datetime as dt, io, json, os, urllib.request
from fetch import ROOT, RAW, load_series, csv_path, read_csv, write_csv

BASE = "https://www.stat.go.jp"
TKY_URL = BASE + "/data/cpi/2025/csv/tmi2025aa.csv"
CTI_URL = BASE + "/data/cti/zuhyou/tc-25_030.csv"
TKY_COLUMNS = {"CPI_TKY_ALL_YOY": "総合", "CPI_TKY_CORE_YOY": "生鮮食品を除く総合",
               "CPI_TKY_CORECORE_YOY": "生鮮食品及びエネルギーを除く総合"}


def get_rows(url, rawdir):
    req = urllib.request.Request(url, headers={"User-Agent": "boj-stats-collector/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
    with open(os.path.join(rawdir, os.path.basename(url)), "wb") as f:
        f.write(body)
    return list(csv.reader(io.StringIO(body.decode("cp932"))))


def yoy_series(idx):
    out = {}
    for m, v in idx.items():
        prev = f"{int(m[:4]) - 1}{m[4:]}"
        if prev in idx and idx[prev]:
            out[m] = str(round((v / idx[prev] - 1) * 100, 1) + 0.0)
    return out


def build(rawdir):
    """{code: {date: value}} を返す。"""
    res = {}
    rows = get_rows(TKY_URL, rawdir)
    header = rows[0]
    months = {f"{r[0][:4]}-{r[0][4:]}": r for r in rows if r and len(r[0]) == 6 and r[0].isdigit()}
    for code, name in TKY_COLUMNS.items():
        col = header.index(name)
        res[code] = yoy_series({m: float(r[col]) for m, r in months.items() if len(r) > col and r[col]})
    rows = get_rows(CTI_URL, rawdir)
    idx = {}
    for r in rows:
        if r and len(r[0]) == 10 and r[0].isdigit():  # 2017000101 → 2017-01
            vals = [x for x in r[2:] if x]
            if vals:
                idx[f"{r[0][:4]}-{r[0][6:8]}"] = float(vals[0])  # 左端が最新の公表
    res["CTI_TOTAL_REAL"] = {m: f"{v:.2f}" for m, v in idx.items()}
    res["CTI_TOTAL_REAL_YOY"] = yoy_series(idx)
    return res


def main():
    series = [s for s in load_series() if s["db"] == "STAT"]
    today = dt.date.today().isoformat()
    rawdir = os.path.join(RAW, today)
    os.makedirs(rawdir, exist_ok=True)
    lf = os.path.join(ROOT, "last_fetch.json")
    summary = json.load(open(lf, encoding="utf-8")) if os.path.exists(lf) else {"date": today, "updated": [], "errors": []}
    try:
        data = build(rawdir)
    except Exception as e:
        summary["errors"].append(f"STAT: {type(e).__name__}: {e}")
        data = None
    if data:
        for s in series:
            path = csv_path("STAT", s["code"])
            rows = read_csv(path)
            before = dict(rows)
            rows.update(data.get(s["code"], {}))
            write_csv(path, rows)
            new = set(rows) - set(before)
            revised = [k for k in before if rows.get(k) != before[k]]
            if new or revised:
                summary["updated"].append({"db": "STAT", "code": s["code"], "new": len(new),
                                           "revised": len(revised), "latest": max(rows)})
    with open(lf, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    return 1 if data is None else 0


if __name__ == "__main__":
    raise SystemExit(main())
