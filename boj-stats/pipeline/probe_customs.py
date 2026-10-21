"""一時的な調査用: 税関サイトのページを集める"""
import os, re, sys, urllib.request, urllib.parse
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
START = ["https://www.customs.go.jp/toukei/info/index.htm",
         "https://www.customs.go.jp/toukei/latest/index.htm",
         "https://www.customs.go.jp/toukei/srch/index.htm",
         "https://www.customs.go.jp/toukei/search/index1.htm",
         "https://www.customs.go.jp/toukei/shinbun/happyou.htm",
         "https://www.customs.go.jp/toukei/sankou/howto/kensaku.html"]
seen, queue = set(), [(u, 0) for u in START]
log = open(os.path.join(out, "_index.txt"), "w")
while queue and len(seen) < 150:
    u, d = queue.pop(0)
    if u in seen: continue
    seen.add(u)
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}), timeout=30)
        body = r.read(); ct = r.headers.get("Content-Type", "")
    except Exception as e:
        log.write(f"ERR {u} {e}\n"); continue
    name = re.sub(r"[^A-Za-z0-9._-]", "_", u.split("//", 1)[1])[:150]
    open(os.path.join(out, name), "wb").write(body[:3_000_000])
    log.write(f"OK {u} {ct} {len(body)}\n")
    if d < 1 and ("html" in ct or u.endswith((".htm", ".html"))):
        text = body.decode("shift_jis", "replace") if b"charset=Shift_JIS" in body[:2000] or b"shift_jis" in body[:2000].lower() else body.decode("utf-8", "replace")
        for h in re.findall(r'href="([^"#]+)"', text):
            v = urllib.parse.urljoin(u, h)
            if v.startswith("https://www.customs.go.jp/toukei/") and v not in seen:
                queue.append((v, d + 1))
