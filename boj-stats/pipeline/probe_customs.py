"""一時的な調査用: 税関の検索システムに問い合わせる"""
import os, sys, urllib.request, urllib.parse, http.cookiejar
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
URL = "https://www.customs.go.jp/JCWSV01/servlet/JCWSV01"
cj = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
op.addheaders = [("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36")]
for u in ("https://www.customs.go.jp/toukei/srch/index.htm?M=01&P=0", "https://www.customs.go.jp/toukei/srch/jccht01j.htm",
          "https://www.customs.go.jp/toukei/srch/jccht00p.htm"):
    print(u, op.open(u, timeout=30).status)
print("cookies", [c.name for c in cj])
def q(name, hs, kuni, kunikbn, ym=(2026, 9), cnt=200, kname="", enc="utf-8"):
    f = [("CW_SEARCHID", "JCCHT01S"), ("CW_JAPANKBN", "1"), ("CW_IMPKBN", "1"), ("CW_CARGOKBN", ""), ("CW_SUMKBN", ""),
         ("CW_SPCODE", ""), ("CW_SPNAME", ""), ("CW_YMSORTKBN", ""), ("CW_SISUKBN", ""), ("CW_SENKIKBN", ""), ("CW_HKKBN", ""),
         ("CW_YMKBN", "1"), ("CW_KI", ""), ("CW_SYY", str(ym[0])), ("CW_EYY", ""), ("CW_SMM", str(ym[1])), ("CW_EMM", ""),
         ("CW_HSKBN", "2")]
    for i in range(10):
        f += [("CW_HSCODE", hs if i == 0 else ""), ("CW_HSNAME", "")]
    f += [("CW_KUNIKBN", kunikbn)]
    for i in range(10):
        f += [("CW_KUNICODE", kuni if i == 0 else ""), ("CW_KUNINAME", kname if i == 0 else "")]
    f += [("CW_ZMKBN", "")] + [("CW_ZMCODE", ""), ("CW_ZMNAME", "")] * 10 + [("CW_MEISAICNT", str(cnt))]
    try:
        r = op.open(urllib.request.Request(URL, data=urllib.parse.urlencode(f, encoding=enc).encode(),
            headers={"Referer": "https://www.customs.go.jp/toukei/srch/jccht01j.htm",
                     "Origin": "https://www.customs.go.jp", "Content-Type": "application/x-www-form-urlencoded"}), timeout=60)
        body = r.read(); info = f"{r.status} {r.headers.get('Content-Type')} {len(body)} {r.geturl()}"
    except Exception as e:
        body = str(e).encode(); info = f"ERR {e}"
    open(os.path.join(out, name), "wb").write(body)
    print(name, info)
q("nand_tw.html", "854232921", "106", "5", kname="台湾")
q("nand_tw_sj.html", "854232921", "106", "5", kname="台湾", enc="shift_jis")
q("ic_all.html", "8542", "", "1")
