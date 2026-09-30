# 一時的な調査用(マージ前に消す)。各社のニュース一覧ページの作りを調べる
import re, requests
from bs4 import BeautifulSoup
H={"User-Agent":"Mozilla/5.0 (compatible; portal-news/1.0; +https://git-san-934.github.io/portal/news/)","Accept-Language":"ja,en;q=0.8"}
URLS="""
https://www.nintendo.co.jp/ir/news/index.html
https://www.nintendo.co.jp/corporate/release/index.html
https://www.nintendo.com/jp/topics/
https://www.nintendo.com/jp/topics/c/news
https://www.nintendo.co.jp/news/whatsnew.xml
https://www.nintendo.co.jp/ir/news/news.xml
https://www.keyence.co.jp/
https://www.keyence.co.jp/news/
https://www.keyence.co.jp/company/
https://www.keyence.co.jp/products/new/
https://news.adobe.com/news
https://news.adobe.com/rss
https://news.adobe.com/news/rss
https://blog.adobe.com/feed.xml
https://www.fuji.co.jp/
https://www.fuji.co.jp/news
https://www.fuji.co.jp/news/
https://www.fuji.co.jp/ir/news.html
""".split()
DATE=re.compile(r"20\d\d[./年-]\s*\d{1,2}[./月-]\s*\d{1,2}")
for u in URLS:
    try:
        r=requests.get(u,headers=H,timeout=30)
    except Exception as e:
        print("##",u,"ERR",type(e).__name__); continue
    if not r.encoding or r.encoding.lower()=="iso-8859-1": r.encoding=r.apparent_encoding
    t=r.text
    print("\n##",u,"->",r.url,r.status_code,len(t),r.headers.get("Content-Type"))
    s=BeautifulSoup(t,"html.parser")
    print("title:",(s.title.string if s.title else "")[:80] if s.title and s.title.string else "")
    txt=re.sub(r"\s+"," ",s.get_text(" "))
    for m in list(DATE.finditer(txt))[:3]: print("  date:",txt[max(0,m.start()-40):m.end()+60])
    for m in list(DATE.finditer(t))[:3]: print("  raw:",re.sub(r"\s+"," ",t[max(0,m.start()-120):m.end()+80]))
    refs=set(re.findall(r"""["']([^"'\s]+\.(?:json|xml|rss)(?:\?[^"'\s]*)?)["']""",t))
    print("  refs:",sorted(refs)[:15])
    print("  scripts:",[x.get("src") for x in s.find_all("script",src=True)][:12])
    news=[ (re.sub(r"\s+"," ",a.get_text(" ")).strip()[:30],a["href"]) for a in s.find_all("a",href=True) if re.search(r"news|topics|release|ニュース|お知らせ|新製品|プレス",a.get_text(" ")+a["href"],re.I)]
    print("  newslinks:",news[:15])
