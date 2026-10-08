#!/usr/bin/env python3
"""日本銀行ホームページ「新着情報（総合）」の RSS を取り、reports/boj_news.csv に蓄積する。

RSS には直近1か月ほどしか載らないため、毎回取った分を CSV に足していく（同じ掲載日時・題名・URL は1件）。
為替相場（基準外国為替相場・報告省令レート）は新着に要らないので取り込まない。
build_site.py が feed.json の新着に「日銀」として載せる。
結果は last_fetch.json の errors に追記する（fetch.py の後に実行する前提）。
https://www.boj.or.jp/whatsnew/index.htm
"""
import csv, datetime as dt, email.utils, os, re, urllib.request
import xml.etree.ElementTree as ET
from fetch import ROOT, RAW, load_summary, save_summary, guarded

URL = "https://www.boj.or.jp/rss/whatsnew.xml"
OUT = os.path.join(ROOT, "reports", "boj_news.csv")
FIELDS = ["published", "title", "url"]
SKIP = re.compile(r"外国為替相場|省令レート")  # 為替は新着に載せない
JST = dt.timezone(dt.timedelta(hours=9))


def parse(body):
    items = []
    for it in ET.fromstring(body).iter("item"):
        title = (it.findtext("title") or "").strip()
        url = (it.findtext("link") or "").strip().replace("http://", "https://", 1)
        try:
            when = email.utils.parsedate_to_datetime(it.findtext("pubDate") or "").astimezone(JST)
        except (TypeError, ValueError):
            continue
        if title and url and not SKIP.search(title):
            items.append({"published": when.strftime("%Y-%m-%dT%H:%M"), "title": title, "url": url})
    return items


def main():
    rawdir = os.path.join(RAW, dt.date.today().isoformat())
    os.makedirs(rawdir, exist_ok=True)
    summary = load_summary()
    try:
        req = urllib.request.Request(URL, headers={"User-Agent": "boj-stats-collector/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read()
        with open(os.path.join(rawdir, "boj_whatsnew.xml"), "wb") as f:
            f.write(body)
        items = parse(body)
        if not items:
            raise ValueError("RSS に項目が無い（形式が変わった可能性）")
    except Exception as e:
        summary["errors"].append(f"BOJNEWS: 日銀の新着情報 {type(e).__name__}: {e}")
        save_summary(summary)
        return 1
    rows = []
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
    known = {(r["published"], r["title"], r["url"]) for r in rows}
    added = [x for x in items if (x["published"], x["title"], x["url"]) not in known]
    rows += added
    rows.sort(key=lambda r: r["published"], reverse=True)
    with open(OUT + ".tmp", "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)
    os.replace(OUT + ".tmp", OUT)
    print(f"日銀の新着情報: {len(added)}件を追加（計{len(rows)}件）")
    return 0


if __name__ == "__main__":
    raise SystemExit(guarded("BOJNEWS", main))
