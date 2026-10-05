# 一時的な調査用(マージ前に消す)
import re, requests
H={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36","Accept-Language":"en"}
U=["https://www.spacex.com/updates/","https://www.spacex.com/sitemap.xml","https://www.spacex.com/robots.txt","https://ir.spacex.com/","https://investor.spacex.com/","https://investors.spacex.com/","https://www.spacex.com/investors/","https://www.spacex.com/news/","https://www.spacex.com/api/updates","https://content.spacex.com/api/spacex-website/updates","https://www.spacex.com/feed.xml","https://www.sec.gov/cgi-bin/browse-edgar?company=space+exploration&type=&dateb=&owner=include&count=10&action=getcompany"]
for u in U:
    try: r=requests.get(u,headers=H,timeout=20)
    except Exception as e: print("##",u,"ERR",type(e).__name__); continue
    t=r.text
    print("\n##",u,"->",r.url,r.status_code,len(t),r.headers.get("Content-Type"))
    print("  ",re.sub(r"\s+"," ",t[:600]))
    for m in re.findall(r"(?:src|href)=\"([^\"]+\.(?:js|json|xml)[^\"]*)\"",t)[:10]: print("   asset:",m)
    for m in re.findall(r"https?://[a-z0-9.-]*spacex[a-z0-9.-]*/[^\"' )]{0,80}",t)[:15]: print("   url:",m)
