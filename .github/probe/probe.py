# 一時的な調査用(マージ前に消す)
import re, requests
H={"User-Agent":"Mozilla/5.0 (compatible; portal-news/1.0)","Accept-Language":"en,ja;q=0.8"}
for u in ["https://blog.adobe.com/feed.xml","https://blog.adobe.com/en/feed.xml","https://blog.adobe.com/en/publish/feed.xml","https://news.adobe.com/rss.xml","https://news.adobe.com/feed.xml","https://news.adobe.com/news/feed.xml","https://news.adobe.com/news.rss","https://www.adobe.com/news-room/news.rss"]:
    try: r=requests.get(u,headers=H,timeout=30)
    except Exception as e: print("##",u,"ERR",e); continue
    t=r.text
    print("\n##",u,r.status_code,len(t),r.headers.get("Content-Type"),"items:",t.count("<item"),"entries:",t.count("<entry"))
    for m in list(re.finditer(r"<(item|entry)\b.*?</\1>",t,re.S))[:4]:
        s=m.group(0)
        ti=re.search(r"<title[^>]*>(.*?)</title>",s,re.S); li=re.search(r"<link[^>]*>(.*?)</link>|<link[^>]+href=\"([^\"]+)\"",s,re.S); d=re.search(r"<(pubDate|updated|published|dc:date)>(.*?)</",s,re.S)
        print("  ",(ti.group(1) if ti else "")[:100],"|",(li.group(1) or li.group(2) if li else ""),"|",d.group(2) if d else "")
