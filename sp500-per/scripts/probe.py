"""S&P 500 の日次終値の取得先を試す(一時的な確認用。あとで消す)"""
import os, time, urllib.request
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "raw")
os.makedirs(OUT, exist_ok=True)
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
SRC = {
    "yahoo1.json": "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?period1=946684800&period2=1900000000&interval=1d",
    "yahoo2.json": "https://query2.finance.yahoo.com/v8/finance/chart/%5EGSPC?period1=946684800&period2=1900000000&interval=1d",
    "nasdaq.json": "https://api.nasdaq.com/api/quote/SPX/historical?assetclass=index&fromdate=2000-01-01&limit=9999&todate=2026-12-31",
    "fred.csv": "https://fred.stlouisfed.org/graph/fredgraph.csv?id=SP500",
    "cboe.csv": "https://cdn.cboe.com/api/global/delayed_quotes/charts/historical/_SPX.json",
}
log = []
for name, url in SRC.items():
    for k in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json,text/csv,*/*", "Accept-Language": "en-US"})
            with urllib.request.urlopen(req, timeout=120) as r:
                b = r.read()
            open(os.path.join(OUT, name), "wb").write(b)
            log.append(f"OK {name} {len(b)} try{k}")
            break
        except Exception as e:
            err = repr(e)
            time.sleep(5 * (k + 1))
    else:
        log.append(f"NG {name} {err}")
print("\n".join(log))
open(os.path.join(OUT, "_log2.txt"), "w").write("\n".join(log) + "\n")
