# 一時的な調査用(マージ前に消す)
import re, json, requests
H={"User-Agent":"Mozilla/5.0 (compatible; portal-news/1.0)","Accept-Language":"en,ja;q=0.8"}
for u in ["https://news.adobe.com/query-index.json","https://news.adobe.com/news/query-index.json","https://news.adobe.com/news-index.json","https://news.adobe.com/sitemap.xml","https://news.adobe.com/news/sitemap.xml","https://news.adobe.com/","https://news.adobe.com/sitemap-index.xml"]:
    try: r=requests.get(u,headers=H,timeout=30)
    except Exception as e: print("##",u,"ERR",e); continue
    print("\n##",u,r.status_code,len(r.text),r.headers.get("Content-Type"))
    t=r.text
    if "json" in (r.headers.get("Content-Type") or ""):
        try:
            d=r.json(); print(" keys:",list(d)[:10] if isinstance(d,dict) else type(d)); rows=d.get("data") if isinstance(d,dict) else d
            print(" total:",d.get("total") if isinstance(d,dict) else "", json.dumps(rows[:3],ensure_ascii=False)[:1500])
        except Exception as e: print(" json err",e)
    elif u.endswith(".xml"):
        print(" ",re.sub(r"\s+"," ",t[:1200]))
    else:
        for m in list(re.finditer(r"<h3[^>]*>.*?</h3>|<a[^>]+href=\"[^\"]*/news/20\d\d/[^\"]+\"[^>]*>",t))[:8]: print("  ",re.sub(r"\s+"," ",m.group(0))[:200])
        for m in list(re.finditer(r"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2}, 20\d\d|20\d\d-\d\d-\d\d|\d{1,2}/\d{1,2}/20\d\d",t))[:6]: print("  date:",re.sub(r"\s+"," ",t[max(0,m.start()-200):m.end()+50]))
