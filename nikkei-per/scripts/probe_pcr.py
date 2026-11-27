"""一時的: プットコールレシオのデータ源を探す(Actions 上で実行)。"""
import io, re, sys, urllib.request
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"
J = "https://www.jpx.co.jp"
def get(u):
    req = urllib.request.Request(u if u.startswith("http") else J + u, headers={"User-Agent": UA, "Accept-Language": "ja"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()
def rows(raw, name):
    if name.endswith(".xlsx"):
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        for ws in wb.worksheets:
            yield ws.title, [list(r) for r in ws.iter_rows(values_only=True)]
    else:
        import xlrd
        wb = xlrd.open_workbook(file_contents=raw)
        for sh in wb.sheets():
            yield sh.name, [sh.row_values(i) for i in range(sh.nrows)]
def dump(u, n=40):
    try:
        raw = get(u)
    except Exception as e:
        print("NG", u, e); return
    print("##### FILE", u, len(raw))
    for title, rs in rows(raw, u):
        print("--- sheet", title, len(rs))
        for r in rs[:n]:
            r = [c for c in r if c not in (None, "")]
            if r: print("   ", r[:16])
        if len(rs) > n:
            for r in rs[-5:]:
                r = [c for c in r if c not in (None, "")]
                if r: print("  END", r[:16])

import json
for u in ["/automation/markets/statistics-derivatives/monthly-statistics/json/monthly_statistics_report_yearlist.json",
          "/automation/markets/statistics-derivatives/daily/json/daily_report_monthlylist.json",
          "/markets/statistics-derivatives/daily/daily_report_monthlylist.json"]:
    try:
        t = get(u).decode("utf-8-sig", "replace")
        print("=== JSON", u, len(t)); print("  ", t[:1500]); print("  END", t[-400:])
    except Exception as e:
        print("NG", u, e)
js = get("/public/javascripts/backnumber.js").decode("utf-8", "replace")
print("=== JS backnumber", len(js))
for m in sorted(set(re.findall(r"[\"']([^\"']*(?:json|automation)[^\"']*)[\"']", js))): print("  J", m)
print(js[:3000])
# 建玉 xlsx の 別紙1 合計行
raw = get("/markets/derivatives/trading-volume/t13vrt0000026aes-att/20261126open_interest.xlsx")
for title, rs in rows(raw, "x.xlsx"):
    if title.startswith("別紙1"):
        for r in rs:
            if any(isinstance(c, str) and ("合計" in c or "計" == c.strip()) for c in r): print("  SUM", [c for c in r if c not in (None, "")])
        print("  rows", len(rs))
