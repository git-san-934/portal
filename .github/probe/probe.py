import io, re
import requests, pandas as pd
H = {"User-Agent": "Mozilla/5.0 (portal data probe)"}
def get(u):
    r = requests.get(u, headers=H, timeout=60); print("GET", u, r.status_code, len(r.content)); return r
def links(html, pat):
    return sorted(set(re.findall(r'href="([^"]*' + pat + r'[^"]*)"', html)))
r = get("https://www.jpx.co.jp/markets/public/short-selling/index.html")
h = r.content.decode("utf-8", "replace")
print(re.findall(r'value="(/markets/public/short-selling/00-archives-\d+\.html)">([^<]+)<', h))
r = get("https://www.jpx.co.jp/markets/public/short-selling/00-archives-06.html")
L = links(r.content.decode("utf-8", "replace"), r"\.xls"); print(len(L), L[:3], L[-3:])
r = get("https://www.jpx.co.jp/markets/public/short-selling/t13vrt000001yqks-att/20260918_Short_Positions.xls")
df = pd.read_excel(io.BytesIO(r.content), header=None)
with pd.option_context("display.max_columns", 40, "display.width", 250, "display.max_colwidth", 22):
    print(df.iloc[6:9].T.to_string())
    print(df.iloc[20:60, [1,2,5,6,7,8,9,10,13,14,15]].to_string())
    print(df.tail(5).to_string())
print(df[10].describe())
for p in ["00-01.html", "00-02.html"]:
    r = get("https://www.jpx.co.jp/markets/statistics-equities/investor-type/" + p)
    L = links(r.content.decode("utf-8", "replace"), r"stock_val_1_[^\"]*\.xls"); print(len(L), L[:3], L[-3:])
r = get("https://www.jpx.co.jp/markets/statistics-equities/investor-type/t13vrt000001yhs9-att/stock_val_1_260902.xls")
df = pd.read_excel(io.BytesIO(r.content), header=None, sheet_name=0)
with pd.option_context("display.max_columns", 40, "display.width", 250, "display.max_colwidth", 28):
    print(df.to_string())
