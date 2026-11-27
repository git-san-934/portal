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
for p in ["/markets/statistics-derivatives/monthly-statistics/index.html", "/markets/statistics-derivatives/daily/index.html", "/markets/derivatives/open-interest/index.html", "/markets/statistics-derivatives/monthly-statistics/02.html"]:
    t = get(p).decode("utf-8", "replace")
    print("=== PAGE", p)
    for s in sorted(set(re.findall(r'(?:src|href|data-[a-z-]+)="([^"]+)"', t))):
        if re.search(r"\.(js|json|xls|xlsx|csv|pdf)|automation|att/", s): print("  R", s)
    for s in sorted(set(re.findall(r'["\']([^"\']+\.(?:json|csv|xlsx?|pdf))["\']', t))): print("  Q", s)
    i = t.find("オプション")
    print("  TXT", re.sub(r"<[^>]+>", " ", t[i-300:i+600]).split()[:80] if i >= 0 else "-")
dump("/automation/markets/statistics-derivatives/trading-volume/files/soukatsu_M.xlsx", 30)
dump("/markets/statistics-derivatives/trading-volume/nlsgeu000004j469-att/tv_ts202610.xls", 60)
dump("/markets/derivatives/trading-volume/t13vrt0000026aes-att/20261126open_interest.xlsx", 50)
