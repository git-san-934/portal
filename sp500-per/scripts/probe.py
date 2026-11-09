"""S&P 500 の PER・PBR の取得先を試す(一時的な確認用。あとで消す)"""
import os, sys, urllib.request
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "raw")
os.makedirs(OUT, exist_ok=True)
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
SRC = {
    "multpl_pe_month.html": "https://www.multpl.com/s-p-500-pe-ratio/table/by-month",
    "multpl_pb_quarter.html": "https://www.multpl.com/s-p-500-price-to-book/table/by-quarter",
    "multpl_bv_quarter.html": "https://www.multpl.com/s-p-500-book-value/table/by-quarter",
    "multpl_eps_month.html": "https://www.multpl.com/s-p-500-earnings/table/by-month",
    "multpl_price_month.html": "https://www.multpl.com/s-p-500-historical-prices/table/by-month",
    "spglobal_eps.xlsx": "https://www.spglobal.com/spdji/en/documents/additional-material/sp-500-eps-est.xlsx",
    "shiller_yale.xls": "http://www.econ.yale.edu/~shiller/data/ie_data.xls",
    "stooq_spx.csv": "https://stooq.com/q/d/l/?s=%5Espx&i=d",
    "yahoo_gspc.json": "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?period1=0&period2=9999999999&interval=1d",
    "fred_sp500.csv": "https://fred.stlouisfed.org/graph/fredgraph.csv?id=SP500",
}
log = []
for name, url in SRC.items():
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
        with urllib.request.urlopen(req, timeout=60) as r:
            b = r.read()
        open(os.path.join(OUT, name), "wb").write(b)
        log.append(f"OK {name} {len(b)}")
    except Exception as e:
        log.append(f"NG {name} {e!r}")
print("\n".join(log))
open(os.path.join(OUT, "_log.txt"), "w").write("\n".join(log) + "\n")
