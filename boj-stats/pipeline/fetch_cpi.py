#!/usr/bin/env python3
"""総務省統計局の消費者物価指数（全国・月次）CSVから前年比を作り data/CPI_<CODE>.csv に蓄積する。

series.json の db が "CPI" の系列が対象。
- 2020年基準（2020年1月〜）と2025年基準（2025年1月〜）の指数を取り、前年同月比を計算する
- 2025年12月までは2020年基準、2026年1月以降は2025年基準の指数から計算（基準改定後の公表値に合わせる）
公表の前年比は指数の丸め前の値から計算されるため、小数第1位で±0.1ずれることがある。
https://www.stat.go.jp/data/cpi/1.html
"""
import csv, datetime as dt, io, os, urllib.request
from fetch import RAW, load_series, csv_path, read_csv, write_csv, load_summary, save_summary, guarded

URLS = {"2020": "https://www.stat.go.jp/data/cpi/2020/csv/zmi2020aa.csv",
        "2025": "https://www.stat.go.jp/data/cpi/2025/csv/zmi2025aa.csv"}
SWITCH = "2026-01"  # この月以降は2025年基準
COLUMNS = {"CPI_ALL": "総合", "CPI_CORE": "生鮮食品を除く総合", "CPI_CORECORE": "生鮮食品及びエネルギーを除く総合"}


def get(url, rawdir):
    req = urllib.request.Request(url, headers={"User-Agent": "boj-stats-collector/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
    with open(os.path.join(rawdir, os.path.basename(url)), "wb") as f:
        f.write(body)
    rows = list(csv.reader(io.StringIO(body.decode("cp932"))))
    header = rows[0]
    out = {}
    for r in rows:
        if r and len(r[0]) == 6 and r[0].isdigit():
            out[f"{r[0][:4]}-{r[0][4:]}"] = r
    return header, out


def yoy(idx, month):
    prev = f"{int(month[:4]) - 1}{month[4:]}"
    if month in idx and prev in idx and idx[prev]:
        return round((idx[month] / idx[prev] - 1) * 100, 1)
    return None


def main():
    series = [s for s in load_series() if s["db"] == "CPI"]
    today = dt.date.today().isoformat()
    rawdir = os.path.join(RAW, today)
    os.makedirs(rawdir, exist_ok=True)
    summary = load_summary()
    try:
        data = {base: get(url, rawdir) for base, url in URLS.items()}
    except Exception as e:
        summary["errors"].append(f"CPI: {type(e).__name__}: {e}")
        data = None
    if data:
        for s in series:
            key = s["code"].replace("_YOY", "")
            idx = {}
            try:
                for base, (header, rows) in data.items():
                    col = header.index(COLUMNS[key])
                    idx[base] = {m: float(r[col]) for m, r in rows.items() if len(r) > col and r[col]}
            except ValueError as e:  # 列見出しの変更や数値でない値
                summary["errors"].append(f"CPI/{s['code']}: {type(e).__name__}: {e}")
                continue
            path = csv_path("CPI", s["code"])
            rows = read_csv(path)
            before = dict(rows)
            for m in sorted(set(idx["2020"]) | set(idx["2025"])):
                v = yoy(idx["2025"] if m >= SWITCH else idx["2020"], m)
                if v is not None:
                    rows[m] = str(v + 0.0)  # -0.0 を 0.0 に
            write_csv(path, rows)
            new = set(rows) - set(before)
            revised = [k for k in before if rows.get(k) != before[k]]
            if new or revised:
                summary["updated"].append({"db": "CPI", "code": s["code"], "new": len(new),
                                           "revised": len(revised), "latest": max(rows)})
    save_summary(summary)
    return 1 if data is None else 0


if __name__ == "__main__":
    raise SystemExit(guarded("CPI", main))
