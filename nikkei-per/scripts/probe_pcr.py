"""一時的: プットコールレシオのデータ源を探す(Actions 上で実行)。"""
import re, sys, urllib.request
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"
J = "https://www.jpx.co.jp"
def get(u):
    req = urllib.request.Request(u, headers={"User-Agent": UA, "Accept-Language": "ja"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()
pages = [
 "/markets/statistics-derivatives/monthly-statistics/index.html",
 "/markets/statistics-derivatives/monthly-statistics/archives-01.html",
 "/markets/statistics-derivatives/daily/index.html",
 "/markets/statistics-derivatives/index.html",
 "/markets/derivatives/trading-volume/index.html",
 "/markets/statistics-derivatives/open-interests/index.html",
 "/markets/derivatives/option-price/index.html",
 "/markets/statistics-derivatives/trading-volume/index.html",
]
for p in pages:
    try:
        t = get(J + p).decode("utf-8", "replace")
    except Exception as e:
        print("NG", p, e); continue
    hrefs = sorted(set(re.findall(r'href="([^"#]+)"', t)))
    files = [h for h in hrefs if re.search(r"\.(xls|xlsx|csv|pdf|zip)$", h, re.I)]
    navs = [h for h in hrefs if "statistics-derivatives" in h or "derivatives" in h]
    print("=== OK", p, len(t), "files", len(files))
    for h in files[:60]: print("  F", h)
    if len(files) > 60: print("  ... last:", files[-10:])
    for h in navs[:80]: print("  L", h)
