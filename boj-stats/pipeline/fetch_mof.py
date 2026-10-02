#!/usr/bin/env python3
"""財務省「国債金利情報」CSVから国債利回りを取得し data/MOF_<CODE>.csv に蓄積する。

series.json の db が "MOF" の系列が対象（code は JGB2Y / JGB10Y / JGB30Y のように年限を表す）。
初回（CSVが無いとき）は全期間の jgbcm_all.csv、以降は当月分の jgbcm.csv を取る。
結果は last_fetch.json の updated / errors に追記する（fetch.py の後に実行する前提）。
https://www.mof.go.jp/jgbs/reference/interest_rate/index.htm
"""
import csv, datetime as dt, io, os, urllib.request
from fetch import RAW, load_series, csv_path, read_csv, write_csv, load_summary, save_summary, guarded

URL_ALL = "https://www.mof.go.jp/jgbs/reference/interest_rate/data/jgbcm_all.csv"
URL_CUR = "https://www.mof.go.jp/jgbs/reference/interest_rate/jgbcm.csv"
ERA = {"M": 1867, "T": 1911, "S": 1925, "H": 1988, "R": 2018}


def iso(s):
    """R8.9.25 のような和暦を 2026-09-25 に。"""
    try:
        era, rest = s[0], s[1:]
        y, m, d = (int(x) for x in rest.split("."))
        return f"{ERA[era] + y:04d}-{m:02d}-{d:02d}"
    except (KeyError, ValueError, IndexError):
        return None


def get(url, rawdir):
    req = urllib.request.Request(url, headers={"User-Agent": "boj-stats-collector/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
    with open(os.path.join(rawdir, os.path.basename(url)), "wb") as f:
        f.write(body)
    rows = list(csv.reader(io.StringIO(body.decode("cp932"))))
    head = next(i for i, r in enumerate(rows) if r and r[0] == "基準日")
    return rows[head], rows[head + 1:]


def main():
    series = [s for s in load_series() if s["db"] == "MOF"]
    today = dt.date.today().isoformat()
    rawdir = os.path.join(RAW, today)
    os.makedirs(rawdir, exist_ok=True)
    summary = load_summary()
    first = not all(os.path.exists(csv_path("MOF", s["code"])) for s in series)
    try:
        header, body = get(URL_ALL if first else URL_CUR, rawdir)
    except Exception as e:
        summary["errors"].append(f"MOF: {type(e).__name__}: {e}")
        body = None
    if body is not None:
        for s in series:
            try:
                col = header.index(s["code"].replace("JGB", "").replace("Y", "年"))
            except ValueError:  # 表の列見出しが変わったとき
                summary["errors"].append(f"MOF/{s['code']}: CSVに列が見つからない")
                continue
            path = csv_path("MOF", s["code"])
            rows = read_csv(path)
            before = dict(rows)
            for r in body:
                d = iso(r[0]) if r else None
                if d and len(r) > col and r[col] not in ("", "-"):
                    rows[d] = r[col]
            write_csv(path, rows)
            new = set(rows) - set(before)
            revised = [k for k in before if rows.get(k) != before[k]]
            if new or revised:
                summary["updated"].append({"db": "MOF", "code": s["code"], "new": len(new),
                                           "revised": len(revised), "latest": max(rows)})
    save_summary(summary)
    return 1 if body is None else 0


if __name__ == "__main__":
    raise SystemExit(guarded("MOF", main))
