#!/usr/bin/env python3
"""政府統計の総合窓口(e-Stat)トップの「新着情報」を取り、reports/estat_news.csv に蓄積する。

新着情報一覧 https://www.e-stat.go.jp/whats-new は直近1週間ほど（約160件）しか載らないため、
毎回取った分を CSV に足していく（同じ公開日・政府統計コードは1件。「新着」と「更新」が両方あれば「新着」）。
一覧はページが画面内で読み込む JSON（news/api_database）から、ファイル(dataType=1)とデータベース(dataType=2)を別々に取る。
リンク先はファイルの一覧を優先し、データベースだけの統計はデータベースの一覧にする。
build_site.py が feed.json の新着に「e-Stat」として載せ、取り込み済みの系列がある統計には最新値と前回比を添える。
結果は last_fetch.json の errors に追記する（fetch.py の後に実行する前提）。
"""
import csv, datetime as dt, html, json, os, re, urllib.parse, urllib.request
from fetch import ROOT, RAW, load_summary, save_summary, guarded

ESTAT = "https://www.e-stat.go.jp/"
API = ESTAT + "news/api_database?dataType={}&page={}"
OUT = os.path.join(ROOT, "reports", "estat_news.csv")
FIELDS = ["date", "status", "org", "name", "toukei", "url", "info"]
MAX_PAGES = 20  # 1ページ20件。通常は9ページ前後

ROW = re.compile(r'<li class="stat-list-row">(.*?)</li>', re.S)


def _text(pat, block):
    m = re.search(pat, block, re.S)
    return html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", m.group(1)))).strip() if m else ""


def parse(view):
    """JSON の view（li の並び）から項目を取り出す。"""
    items = []
    for block in ROW.findall(view):
        date = _text(r'class="stat-newinfo-day">(.*?)</span>', block)
        name = _text(r'class="stat-newinfo-comment">(.*?)</span>', block)
        a = re.search(r'class="stat-newinfo-comment">\s*<a[^>]*href="([^"]+)"', block)
        info = re.search(r'class="info[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"', block)
        if not (re.fullmatch(r"\d{4}-\d{2}-\d{2}", date) and name and a):
            continue
        url = urllib.parse.urljoin(ESTAT, html.unescape(a.group(1)))
        code = re.search(r"toukei=(\d{8})", url)
        st = re.search(r"newslist (__\w+)", block)
        items.append({
            "date": date,
            "status": {"__new": "新着", "__up": "更新"}.get(st.group(1) if st else "", ""),
            "org": _text(r'class="stat-newinfo-kikan">(.*?)</span>', block),
            "name": name,
            "toukei": code.group(1) if code else "",
            "url": url,
            "info": html.unescape(info.group(1)).replace("http://", "https://", 1) if info else "",
        })
    return items


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "boj-stats-collector/1.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def main():
    rawdir = os.path.join(RAW, dt.date.today().isoformat())
    os.makedirs(rawdir, exist_ok=True)
    summary = load_summary()
    items = []
    try:
        for dtype in (1, 2):  # ファイルを先に取り、同じ統計はファイルの一覧へリンクする
            for page in range(1, MAX_PAGES + 1):
                body = get_json(API.format(dtype, page))
                d = json.loads(body)
                if page == 1:
                    with open(os.path.join(rawdir, f"estat_whatsnew_{dtype}.json"), "wb") as f:
                        f.write(body)
                got = parse(d.get("view", ""))
                items += got
                m = re.search(r"(\d+)/(\d+)ページ", d.get("viewPagenate", ""))
                if not got or not m or int(m.group(1)) >= int(m.group(2)):
                    break
        if not items:
            raise ValueError("新着情報に項目が無い（形式が変わった可能性）")
    except Exception as e:
        summary["errors"].append(f"ESTATNEWS: e-Statの新着情報 {type(e).__name__}: {e}")
        save_summary(summary)
        return 1

    rows = []
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
    by_key = {(r["date"], r["toukei"] or r["name"]): r for r in rows}
    added = 0
    for x in items:
        k = (x["date"], x["toukei"] or x["name"])
        if k not in by_key:
            by_key[k] = x
            added += 1
        elif x["status"] == "新着" and by_key[k]["status"] != "新着":
            by_key[k]["status"] = "新着"
    rows = sorted(by_key.values(), key=lambda r: (r["date"], r["toukei"]), reverse=True)
    with open(OUT + ".tmp", "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)
    os.replace(OUT + ".tmp", OUT)
    print(f"e-Statの新着情報: {added}件を追加（計{len(rows)}件）")
    return 0


if __name__ == "__main__":
    raise SystemExit(guarded("ESTATNEWS", main))
