#!/usr/bin/env python3
"""総務省統計局サイト（www.stat.go.jp）の統計を取り込む（消費者物価の全国分は fetch_cpi.py）。

series.json の db が "STAT" の系列が対象。
- CPI_TKY_*_YOY: 東京都区部の消費者物価（2025年基準、前年比は2026年1月から）。全国より約1か月早く出る
- CTI_TOTAL_REAL: 総消費動向指数（実質、2025年基準、傾向推計値）。最新の公表列を使う（毎月過去に遡って改定される）
- CTI_TOTAL_REAL_YOY: 上の前年同月比
"""
import csv, datetime as dt, io, os, urllib.request
from fetch import RAW, load_series, csv_path, read_csv, write_csv, load_summary, save_summary, guarded

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


def tokyo_cpi(rawdir):
    """東京都区部の消費者物価の前年比。{code: {date: value}} を返す。"""
    res = {}
    rows = get_rows(TKY_URL, rawdir)
    header = rows[0]
    months = {f"{r[0][:4]}-{r[0][4:]}": r for r in rows if r and len(r[0]) == 6 and r[0].isdigit()}
    for code, name in TKY_COLUMNS.items():
        col = header.index(name)
        res[code] = yoy_series({m: float(r[col]) for m, r in months.items() if len(r) > col and r[col]})
    return res


def cti(rawdir):
    """総消費動向指数（実質）とその前年比。"""
    rows = get_rows(CTI_URL, rawdir)
    idx = {}
    for r in rows:
        if r and len(r[0]) == 10 and r[0].isdigit():  # 2017000101 → 2017-01
            vals = [x for x in r[2:] if x]
            if vals:
                idx[f"{r[0][:4]}-{r[0][6:8]}"] = float(vals[0])  # 左端が最新の公表
    if not idx:
        raise RuntimeError("総消費動向指数のCSVに月次の行が見つからない")
    return {"CTI_TOTAL_REAL": {m: f"{v:.2f}" for m, v in idx.items()}, "CTI_TOTAL_REAL_YOY": yoy_series(idx)}


# (エラーに付ける名前, 取得関数, その取得元の系列コードの接頭辞)。名前と接頭辞は status.py が失敗した系列を見分けるのにも使う
SOURCES = (("東京都区部CPI", tokyo_cpi, ("CPI_TKY_",)), ("総消費動向指数", cti, ("CTI_",)))


def main():
    series = [s for s in load_series() if s["db"] == "STAT"]
    today = dt.date.today().isoformat()
    rawdir = os.path.join(RAW, today)
    os.makedirs(rawdir, exist_ok=True)
    summary = load_summary()
    data = {}
    for name, fn, _ in SOURCES:
        try:
            data.update(fn(rawdir))
        except Exception as e:  # 1つ失敗しても他は続ける
            summary["errors"].append(f"STAT {name}: {type(e).__name__}: {e}")
    if data:
        for s in series:
            if s["code"] not in data:
                continue
            path = csv_path("STAT", s["code"])
            rows = read_csv(path)
            before = dict(rows)
            rows.update(data[s["code"]])
            write_csv(path, rows)
            new = set(rows) - set(before)
            revised = [k for k in before if rows.get(k) != before[k]]
            if new or revised:
                summary["updated"].append({"db": "STAT", "code": s["code"], "new": len(new),
                                           "revised": len(revised), "latest": max(rows)})
    save_summary(summary)
    return 0 if data else 1


if __name__ == "__main__":
    raise SystemExit(guarded("STAT", main))
