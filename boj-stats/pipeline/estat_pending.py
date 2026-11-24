#!/usr/bin/env python3
"""日次チェック（Claude）が分析する e-Stat の新着を集め、公表された表の中身を1つのテキストにまとめる。

  python3 boj-stats/pipeline/estat_pending.py [出力先.md] [--days N]

- e-Stat の新着情報一覧をその場で取り直し（Actions の取り込みを待たない）、reports/estat_news.csv と合わせる
- 直近 N 日（既定 4日）の新着のうち、まだ reports/estat_analysis.json に分析が無く、
  取り込み済みの系列で数値を出している統計（build_site.ESTAT_LINKS）でないものが対象
- 新着ごとに、その日に公表された表（estat_tables.released）を最大 MAX_TABLES 件、Excel・CSV は中身のテキスト、
  PDF だけの表は PDF の URL を書き出す（ダウンロードして読む）
分析を書いたら estat_save.py で reports/estat_analysis.json に足す。
"""
import csv, datetime as dt, json, os, sys

import estat_tables
import fetch_estat_news
from build_site import ESTAT_LINKS

ROOT = os.path.dirname(os.path.abspath(__file__))
NEWS = os.path.join(ROOT, "reports", "estat_news.csv")
ANALYSIS = os.path.join(ROOT, "reports", "estat_analysis.json")
MAX_TABLES = 3
JST = dt.timezone(dt.timedelta(hours=9))


def key(r):
    return f"{r['date']}|{r['toukei'] or r['name']}"


def load_analysis():
    if not os.path.exists(ANALYSIS):
        return {}
    with open(ANALYSIS, encoding="utf-8") as f:
        return json.load(f).get("items", {})


def current_news():
    items = []
    for dtype in (1, 2):
        for page in range(1, fetch_estat_news.MAX_PAGES + 1):
            d = json.loads(fetch_estat_news.get_json(fetch_estat_news.API.format(dtype, page)))
            got = fetch_estat_news.parse(d.get("view", ""))
            items += got
            if not got or "ページ" not in d.get("viewPagenate", "") or f"{page}/{page}ページ" in d["viewPagenate"]:
                break
    return items


def main():
    out = next((a for a in sys.argv[1:] if not a.startswith("--") and not a.isdigit()), None)
    days = int(sys.argv[sys.argv.index("--days") + 1]) if "--days" in sys.argv else 4
    today = dt.datetime.now(JST).date()
    since = (today - dt.timedelta(days=days)).isoformat()
    rows = {}
    if os.path.exists(NEWS):
        with open(NEWS, encoding="utf-8") as f:
            rows = {key(r): r for r in csv.DictReader(f)}
    try:
        for r in current_news():
            rows.setdefault(key(r), r)
    except Exception as e:  # 一覧が取れなくても CSV の分は続ける
        print(f"（e-Stat の新着一覧を取り直せなかった: {type(e).__name__}: {e}）", file=sys.stderr)
    done = load_analysis()
    todo = sorted((r for k, r in rows.items() if r["date"] >= since and k not in done
                   and r["toukei"] not in ESTAT_LINKS), key=lambda r: (r["date"], r["toukei"]))
    lines = [f"# 分析待ちの e-Stat 新着 {len(todo)}件（{since} 以降、{today} 時点）", ""]
    for r in todo:
        lines += [f"## {r['name']}（{r['org']}・{r['status']}・公開 {r['date']}）", f"- key: `{key(r)}`",
                  f"- 一覧: {r['url']}", f"- 説明: {r['info'] or 'なし'}"]
        try:
            tables = estat_tables.released(r["toukei"], r["date"]) if r["toukei"] else []
        except Exception as e:
            tables = []
            lines.append(f"- 表の一覧を取れなかった: {type(e).__name__}: {e}")
        if not tables:
            lines.append("- その日に公表されたファイルが一覧に見つからない（データベースだけの更新か、公開日が違う）")
        lines.append(f"- その日に公表された表: {len(tables)}件" + (f"（先頭 {MAX_TABLES} 件を読む）" if len(tables) > MAX_TABLES else ""))
        for t in tables[:MAX_TABLES]:
            lines += ["", f"### {t['title']}（{t['period']}、{t['path']}、{t['type']}）", f"URL: {t['url'] or t['pdf'] or '（ファイルなし）'}"]
            try:
                text = estat_tables.table_text(t["url"], t["type"]) if t["url"] else None
            except Exception as e:
                text = None
                lines.append(f"（読めなかった: {type(e).__name__}: {e}）")
            if text:
                lines += ["```", text, "```"]
            elif t["pdf"]:
                try:
                    text = estat_tables.pdf_text(t["pdf"])
                except Exception as e:
                    text = None
                    lines.append(f"（PDF を読めなかった: {type(e).__name__}: {e}）")
                if text:
                    lines += ["（PDF の先頭4ページのテキスト。表の段組みが崩れていることがあるので、数値は PDF で確かめる）", "```", text, "```"]
                else:
                    lines.append("（PDF のみ。上の URL をダウンロードして読む）")
        for t in tables[MAX_TABLES:MAX_TABLES + 10]:
            lines.append(f"- ほかの表: {t['title']}（{t['period']}）")
        if len(tables) > MAX_TABLES + 10:
            lines.append(f"- ほか {len(tables) - MAX_TABLES - 10}件")
        lines.append("")
    text = "\n".join(lines)
    if out:
        with open(out, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"{out} に {len(todo)}件を書いた")
    else:
        print(text)


if __name__ == "__main__":
    main()
