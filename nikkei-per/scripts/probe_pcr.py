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
t = get("/automation/markets/statistics-derivatives/monthly-statistics/json/monthly_statistics_report2024.json").decode("utf-8-sig")
for r in json.loads(t)["TableDatas"]: print("  Q", r["Quotations"], r.get("Jan"))
B = "/automation/markets/statistics-derivatives/monthly-statistics/"
for u in [B+"json/monthly_statistics_report2023.json", B+"json/monthly_statistics_report2016.json"]:
    try: get(u); print("OK", u)
    except Exception as e: print("NG", u, e)
for y in (2014, 2016, 2018, 2020, 2022, 2023):
    for ext in ("xlsx", "xls", "pdf"):
        u = f"{B}files/{y}/SIOP_D_{y}06.{ext}"
        try: n = len(get(u)); print("OK", u, n)
        except Exception as e: print("NG", u, e)
dump(B + "files/2024/SIOP_D_202401.xlsx", 60)
