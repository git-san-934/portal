"""一時的な調査用: 税関の検索システムに問い合わせる"""
import os, sys, urllib.request, urllib.parse
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
URL = "https://www.customs.go.jp/JCWSV01/servlet/JCWSV01"
def q(name, hs, kuni, kunikbn, ym=(2026, 9), cnt=200):
    f = [("CW_SEARCHID", "JCCHT01S"), ("CW_JAPANKBN", "1"), ("CW_IMPKBN", "1"),
         ("CW_YMKBN", "1"), ("CW_SYY", str(ym[0])), ("CW_EYY", ""), ("CW_SMM", str(ym[1])), ("CW_EMM", ""), ("CW_KI", ""),
         ("CW_HSKBN", "2")]
    for i in range(10):
        f += [("CW_HSCODE", hs if i == 0 else ""), ("CW_HSNAME", "")]
    f += [("CW_KUNIKBN", kunikbn)]
    for i in range(10):
        f += [("CW_KUNICODE", kuni if i == 0 else ""), ("CW_KUNINAME", "台湾" if (i == 0 and kuni) else "")]
    f += [("CW_MEISAICNT", str(cnt))]
    try:
        r = urllib.request.urlopen(urllib.request.Request(URL, data=urllib.parse.urlencode(f).encode(),
            headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.customs.go.jp/toukei/srch/jccht01j.htm"}), timeout=60)
        body = r.read(); info = f"{r.status} {r.headers.get('Content-Type')} {len(body)}"
    except Exception as e:
        body = str(e).encode(); info = f"ERR {e}"
    open(os.path.join(out, name), "wb").write(body)
    print(name, info)
q("nand_tw.html", "854232921", "106", "5")
q("ic_all.html", "8542", "", "1")
q("mlcc_tw_aug.html", "853224", "106", "5", ym=(2026, 8))
