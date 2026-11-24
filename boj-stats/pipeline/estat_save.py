#!/usr/bin/env python3
"""日次チェック（Claude）が書いた e-Stat 新着の分析を reports/estat_analysis.json に足す。

  python3 boj-stats/pipeline/estat_save.py 分析.json

分析.json は次の形の配列（estat_pending.py の key ごとに1件）:
  [{"key": "2026-11-24|00450011", "name": "人口動態調査", "org": "厚生労働省", "period": "2026年9月分",
    "headline": "9月の出生は5.9万人で前年同月比2.2%減、死亡は12.0万人で横ばい。自然減は6.1万人",
    "points": ["1〜9月累計の出生は52.3万人（前年比0.3%減）で減少幅は縮小", "..."],
    "tables": [{"title": "人口動態統計速報 令和８年９月分", "url": "https://..."}]}]
- headline は1文（120字まで）、points は3つまで（各120字まで）。数値は表から読んだものだけを書く
- 同じ key があれば上書き。analyzed_on（日本時間の今日）を付ける。公開日から120日より古い分は消す
build_site.py がこのファイルを読んで新着ページの e-Stat の行に分析を出す。
"""
import datetime as dt, json, os, re, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "reports", "estat_analysis.json")
KEEP_DAYS = 120
JST = dt.timezone(dt.timedelta(hours=9))


def clean(x, n):
    x = re.sub(r"\s+", " ", str(x or "")).strip()
    return x if len(x) <= n else x[: n - 1] + "…"


def main():
    with open(sys.argv[1], encoding="utf-8") as f:
        new = json.load(f)
    if isinstance(new, dict):
        new = [new]
    items = {}
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as f:
            items = json.load(f).get("items", {})
    today = dt.datetime.now(JST).date()
    for a in new:
        k = a["key"]
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}\|.+", k):
            raise SystemExit(f"key の形式が違う: {k}")
        if not a.get("headline"):
            raise SystemExit(f"{k}: headline が空")
        items[k] = {
            "date": k[:10], "toukei": k[11:], "name": clean(a.get("name"), 80), "org": clean(a.get("org"), 40),
            "period": clean(a.get("period"), 40), "headline": clean(a["headline"], 120),
            "points": [clean(p, 120) for p in (a.get("points") or [])[:3] if p],
            "tables": [{"title": clean(t.get("title"), 80), "url": t.get("url") if re.match(r"https://www\.e-stat\.go\.jp/", t.get("url") or "") else None}
                       for t in (a.get("tables") or [])[:3]],
            "analyzed_on": today.isoformat(),
        }
    cut = (today - dt.timedelta(days=KEEP_DAYS)).isoformat()
    items = {k: v for k, v in sorted(items.items(), reverse=True) if v["date"] >= cut}
    with open(OUT + ".tmp", "w", encoding="utf-8") as f:
        json.dump({"items": items}, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(OUT + ".tmp", OUT)
    print(f"estat_analysis.json: {len(new)}件を保存（計{len(items)}件）")


if __name__ == "__main__":
    main()
