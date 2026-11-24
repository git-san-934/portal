#!/usr/bin/env python3
"""日次チェック（Claude）が書いた e-Stat 新着の分析を reports/estat_analysis.json に足す。

  python3 boj-stats/pipeline/estat_save.py 分析.json [--keep-date]

分析.json は次の形の配列（estat_pending.py の key ごとに1件）:
  [{"key": "2026-11-24|00450011", "name": "人口動態調査", "org": "厚生労働省", "period": "2026年9月分",
    "headline": "9月の出生は5.9万人で前年同月比2.2%減、死亡は12.0万人で横ばい。自然減は6.1万人",
    "points": ["1〜9月累計の出生は52.3万人（前年比0.3%減）で減少幅は縮小", "..."],
    "about": "出生・死亡・婚姻・離婚の届出を毎月まとめる統計。少子化や人口減少の速さを最も早く確かめられる",
    "charts": [{"title": "9月の出生・死亡・婚姻（前年同月と比べて）", "type": "bar", "unit": "人",
                "labels": ["出生", "死亡", "婚姻"],
                "series": [{"name": "2026年9月", "values": [59194, 120418, 27887]},
                           {"name": "2025年9月", "values": [60547, 120288, 27503]}]}],
    "tables": [{"title": "人口動態統計速報 令和８年９月分", "url": "https://..."}]}]
- headline は1文（120字まで）、points は3つまで（各120字まで）。数値は表から読んだものだけを書く
- about（任意）: この統計が何を数えていて、何が分かるのかを、統計に詳しくない人向けに1〜2文（200字まで）
- charts（任意・2つまで）: 分析ページ（estat.html）に描くグラフ。値は表から読んだものだけ
  - type "line": labels は時点（古い順、最大40）、series は線（最大4本）。推移を見せるとき
  - type "bar": labels は項目（最大20）、series は棒（最大3本。今回と前回・前年の比較など）。
    "stacked": true で積み上げ。マイナスの値（前年比など）は0から左に伸びる
  - values は labels と同じ数（無い値は null）。unit は「人」「億円」「%」など。note（任意）に表の注記
- 同じ key があれば上書き。analyzed_on（日本時間の今日）を付ける（--keep-date なら既にある分の日付を残す）。
  公開日から120日より古い分は消す
build_site.py がこのファイルを読んで新着ページの e-Stat の行に分析を出し、estat.html が分析とグラフを出す。
"""
import datetime as dt, json, os, re, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "reports", "estat_analysis.json")
KEEP_DAYS = 120
JST = dt.timezone(dt.timedelta(hours=9))


def clean(x, n):
    x = re.sub(r"\s+", " ", str(x or "")).strip()
    return x if len(x) <= n else x[: n - 1] + "…"


def chart(c, k):
    """グラフの形を確かめて整える（おかしければ止める）。"""
    kind = c.get("type")
    labels = [clean(x, 24) for x in c.get("labels") or []]
    series = c.get("series") or []
    lim = {"line": (40, 4), "bar": (20, 3)}.get(kind)
    if not lim:
        raise SystemExit(f"{k}: charts の type は line か bar: {kind}")
    if not (2 if kind == "line" else 1) <= len(labels) <= lim[0] or not 1 <= len(series) <= lim[1]:
        raise SystemExit(f"{k}: charts「{c.get('title')}」の labels か series の数が範囲外")
    out = []
    for s in series:
        vals = s.get("values") or []
        if len(vals) != len(labels):
            raise SystemExit(f"{k}: charts「{c.get('title')}」の {s.get('name')} の値の数が labels と違う")
        if any(v is not None and not isinstance(v, (int, float)) for v in vals):
            raise SystemExit(f"{k}: charts「{c.get('title')}」の値は数か null")
        out.append({"name": clean(s.get("name"), 30), "values": vals})
    r = {"title": clean(c.get("title"), 60), "type": kind, "unit": clean(c.get("unit"), 20), "labels": labels, "series": out}
    if c.get("stacked") and kind == "bar":
        r["stacked"] = True
    if c.get("note"):
        r["note"] = clean(c["note"], 160)
    return r


def main():
    keep = "--keep-date" in sys.argv
    with open(next(a for a in sys.argv[1:] if not a.startswith("--")), encoding="utf-8") as f:
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
        old = items.get(k)
        items[k] = {
            "date": k[:10], "toukei": k[11:], "name": clean(a.get("name"), 80), "org": clean(a.get("org"), 40),
            "period": clean(a.get("period"), 40), "headline": clean(a["headline"], 120),
            "points": [clean(p, 120) for p in (a.get("points") or [])[:3] if p],
            "tables": [{"title": clean(t.get("title"), 80), "url": t.get("url") if re.match(r"https://www\.e-stat\.go\.jp/", t.get("url") or "") else None}
                       for t in (a.get("tables") or [])[:3]],
            "analyzed_on": old["analyzed_on"] if keep and old else today.isoformat(),
        }
        if a.get("about"):
            items[k]["about"] = clean(a["about"], 200)
        charts = [chart(c, k) for c in (a.get("charts") or [])[:2]]
        if charts:
            items[k]["charts"] = charts
    cut = (today - dt.timedelta(days=KEEP_DAYS)).isoformat()
    items = {k: v for k, v in sorted(items.items(), reverse=True) if v["date"] >= cut}
    with open(OUT + ".tmp", "w", encoding="utf-8") as f:
        json.dump({"items": items}, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(OUT + ".tmp", OUT)
    print(f"estat_analysis.json: {len(new)}件を保存（計{len(items)}件）")


if __name__ == "__main__":
    main()
