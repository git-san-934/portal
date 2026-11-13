#!/usr/bin/env python3
"""picks.json の各銘柄について、分析に使った終値の日までの過去1年チャート用データを書き出す。

data/charts/<price_date>_<code>.json に保存する(すでにある銘柄は作り直さない。--force で作り直す)。
株価は tse-price-db の clone から読む:
  - data/history_weekly/<code>0.json (週次の終値。5年分)
  - data/history/<code>0.json        (日次の四本値。直近約120営業日)
1年のうち日次がある期間は日次の終値、それより前は週次の終値を使う。
40週移動平均線(分析で200日線の代わりに使っている線)も週次から計算して入れる。

使い方: python3 scripts/make_charts.py --tse-db /path/to/tse-price-db [--force]
"""
import argparse
import datetime as dt
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PICKS = os.path.join(ROOT, "data", "picks.json")
OUT = os.path.join(ROOT, "data", "charts")


def load_rows(path):
    if not os.path.exists(path):
        return []
    r = json.load(open(path, encoding="utf-8"))
    rows = r if isinstance(r, list) else r.get("rows", r.get("data", []))
    return sorted((x for x in rows if x.get("close") is not None), key=lambda x: x["date"])


def build(db, code, price_date, close):
    weekly = load_rows(os.path.join(db, "data", "history_weekly", code + "0.json"))
    daily = load_rows(os.path.join(db, "data", "history", code + "0.json"))
    end = dt.date.fromisoformat(price_date)
    start = (end - dt.timedelta(days=365)).isoformat()

    weekly = [w for w in weekly if w["date"] <= price_date]
    daily = [d for d in daily if start <= d["date"] <= price_date]
    if not weekly and not daily:
        return None

    first_daily = daily[0]["date"] if daily else "9999-99-99"
    pts = [[w["date"], w["close"]] for w in weekly if start <= w["date"] < first_daily]
    pts += [[d["date"], d["close"]] for d in daily]
    if close is not None and (not pts or pts[-1][0] < price_date):
        pts.append([price_date, close])  # 株価DBが分析日に追いついていないときは分析に使った終値を足す
    pts.sort()

    ma = []
    closes = [w["close"] for w in weekly]
    for i, w in enumerate(weekly):
        if i >= 39 and w["date"] >= start:
            ma.append([w["date"], round(sum(closes[i - 39:i + 1]) / 40, 1)])

    return {"code": code, "price_date": price_date, "close": pts, "ma40w": ma,
            "note": "日次がある期間は日次の終値、それより前は週次の終値。40週線は週次の終値から計算"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tse-db", required=True)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    days = json.load(open(PICKS, encoding="utf-8"))["days"]
    made = skipped = missing = 0
    for day in days:
        pd = day.get("price_date") or day["date"]
        for p in day.get("picks", []):
            path = os.path.join(OUT, "%s_%s.json" % (pd, p["code"]))
            if os.path.exists(path) and not a.force:
                skipped += 1
                continue
            c = build(a.tse_db, str(p["code"]), pd, p.get("close"))
            if not c:
                missing += 1
                print("株価なし:", pd, p["code"], file=sys.stderr)
                continue
            with open(path, "w", encoding="utf-8") as f:
                json.dump(c, f, ensure_ascii=False, separators=(",", ":"))
            made += 1
    print("作成 %d / 既存 %d / 株価なし %d" % (made, skipped, missing))


if __name__ == "__main__":
    main()
