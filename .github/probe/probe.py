import io, re, zipfile, sys
import requests, pandas as pd
H = {"User-Agent": "Mozilla/5.0 (portal data probe)"}
def get(u):
    r = requests.get(u, headers=H, timeout=60); print("GET", u, r.status_code, len(r.content), r.headers.get("content-type")); return r
def links(html, pat):
    return sorted(set(re.findall(r'href="([^"]*' + pat + r'[^"]*)"', html)))
def show_excel(u):
    r = get(u)
    try:
        xl = pd.read_excel(io.BytesIO(r.content), sheet_name=None, header=None)
    except Exception as e:
        print("read fail", e); return
    for name, df in xl.items():
        print("SHEET", name, df.shape)
        with pd.option_context("display.max_columns", 40, "display.width", 400, "display.max_colwidth", 30):
            print(df.head(14).to_string())
print("==== SHORT")
r = get("https://www.jpx.co.jp/markets/public/short-selling/index.html")
h = r.content.decode("utf-8", "replace")
L = links(h, r"\.(?:xls|xlsx|csv|zip|pdf)")
print(len(L)); print("\n".join(L[:10])); print("..."); print("\n".join(L[-10:]))
print("HTML links:", "\n".join(links(h, r"short-selling/[^\"]*\.html")))
xl = [l for l in L if re.search(r"\.xlsx?$", l)]
if xl:
    u = xl[-1] if xl[-1].startswith("http") else "https://www.jpx.co.jp" + xl[-1]
    show_excel(u)
idx = h.find(".xls")
print(h[max(0, idx-1500): idx+300])
print("==== INVESTOR TYPE")
r = get("https://www.jpx.co.jp/markets/statistics-equities/investor-type/index.html")
h = r.content.decode("utf-8", "replace")
L = links(h, r"\.(?:xls|xlsx|csv|zip|pdf)")
print(len(L)); print("\n".join(L[:40]))
print("HTML links:", "\n".join(links(h, r"investor-type/[^\"]*\.html")))
xl = [l for l in L if re.search(r"\.xlsx?$", l)]
for l in xl[:2]:
    show_excel(l if l.startswith("http") else "https://www.jpx.co.jp" + l)
print("==== TOPIX")
r = get("https://www.jpx.co.jp/automation/markets/indices/topix/files/topixweight_j.csv")
print(r.content[:1500].decode("cp932", "replace"))
print("==== EDINET CODE")
r = get("https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip")
try:
    z = zipfile.ZipFile(io.BytesIO(r.content)); print(z.namelist())
    raw = z.read(z.namelist()[0]).decode("cp932", "replace")
    print(raw[:1200])
    df = pd.read_csv(io.StringIO(raw), skiprows=1)
    print(df.columns.tolist()); print(df.iloc[:, 1].value_counts())
except Exception as e:
    print("fail", e)
print("==== EDINET API nokey")
r = get("https://api.edinet-fsa.go.jp/api/v2/documents.json?date=2026-09-18&type=2")
print(r.text[:500])
print("==== MARGIN")
r = get("https://www.jpx.co.jp/markets/statistics-equities/margin/05.html")
h = r.content.decode("utf-8", "replace")
L = links(h, r"\.(?:xls|xlsx|csv|zip|pdf)"); print(len(L)); print("\n".join(L[:12]))
