#!/usr/bin/env python3
"""ポータルの「日銀統計の新着」ページ用データ ../data/feed.json を作る。

run_daily.sh（取得→status.py→analyze.py）の後に実行する。
- 公表: 月次・四半期の系列で、最新の観測期が前回と変わったもの（reports/releases_log.csv に記録）
- 変化検知: reports/signals_log.csv（analyze.py が書く）
日次の系列（金利・為替など）は毎日値が入るので新着には載せず、「毎日の値」に最新値を出す。
標準ライブラリのみ。
"""
import csv, datetime as dt, glob, json, os, re

import analyze

ROOT = os.path.dirname(os.path.abspath(__file__))
REPORTS = os.path.join(ROOT, "reports")
OUT = os.path.join(os.path.dirname(ROOT), "data", "feed.json")
RELEASES = os.path.join(REPORTS, "releases_log.csv")
FEED_DAYS = 90  # 新着に載せる日数

BOJ = ("日本銀行 時系列統計データ検索サイト", "https://www.stat-search.boj.or.jp/")
SOURCES = {
    "MOF": ("財務省 国債金利情報", "https://www.mof.go.jp/jgbs/reference/interest_rate/index.htm"),
    "CPI": ("総務省統計局 消費者物価指数", "https://www.stat.go.jp/data/cpi/1.html"),
    "STAT": ("総務省統計局", "https://www.stat.go.jp/"),
    "ESTAT": ("政府統計の総合窓口 e-Stat", "https://www.e-stat.go.jp/"),
}
TRADE = ("財務省 貿易統計（e-Stat 貿易概況）", "https://www.customs.go.jp/toukei/info/index.htm")

# (見出し, 判定) の順に最初に当てはまったカテゴリに入れる
CATEGORIES = [
    ("短期金利・為替", lambda s: s["db"] in ("FM01", "FM04", "FM08", "IR01")),
    ("国債利回り", lambda s: s["db"] == "MOF"),
    ("日銀の資金供給", lambda s: s["db"] in ("MD01", "MD06", "BS01")),
    ("物価", lambda s: s["db"] in ("PR01", "PR02", "CPI") or s["code"].startswith(("CPI_", "KOURI_"))),
    ("お金の量・貸出", lambda s: s["db"] in ("MD02", "MD13", "IR04", "LA05")),
    ("景況感・家計の資産", lambda s: s["db"] in ("CO", "FF")),
    ("貿易（国別・品目別）", lambda s: s["code"].startswith(("TRADE_EX_", "TRADE_IM_"))),
    ("国際収支・貿易", lambda s: s["db"] == "BP01" or s["code"].startswith("TRADE_")),
    ("消費・雇用・人口", lambda s: True),
]


def sid(s):
    """系列のID。data/ の CSV ファイル名（拡張子なし）と同じ。"""
    return f"{s['db']}_{s['code'].replace('@', '_at_')}"


def category(s):
    return next(name for name, f in CATEGORIES if f(s))


def read_rows(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def seed_releases(series):
    """初回だけ: 過去の日次レポート（reports/YYYY-MM-DD.md の最新値の表）から公表日を復元する。
    最も古いレポートは基準（公表日不明）として記録し、新着には出さない。"""
    by_name = {s["name"]: s for s in series if s["freq"] != "D"}
    rows, prev = [], {}
    for i, path in enumerate(sorted(glob.glob(os.path.join(REPORTS, "????-??-??.md")))):
        day = os.path.basename(path)[:10]
        for line in open(path, encoding="utf-8"):
            m = re.match(r"\| (.+?) \| (\d{4}(?:-\d{2}|Q\d)) \|", line)
            if not m or m.group(1) not in by_name:
                continue
            s = by_name[m.group(1)]
            if prev.get(s["code"]) != m.group(2):
                rows.append({"seen_on": "" if i == 0 else day, "db": s["db"], "code": s["code"], "obs_date": m.group(2)})
                prev[s["code"]] = m.group(2)
    return rows


def main():
    today = dt.date.today().isoformat()
    series = json.load(open(os.path.join(ROOT, "series.json"), encoding="utf-8"))["series"]
    with open(os.path.join(REPORTS, "latest.json"), encoding="utf-8") as f:
        latest = json.load(f)["latest"]
    key = {(s["db"], s["code"]): s for s in series}

    # 公表の記録（月次・四半期の最新観測期が変わった日）
    releases = read_rows(RELEASES) if os.path.exists(RELEASES) else seed_releases(series)
    known = {(r["db"], r["code"], r["obs_date"]) for r in releases}
    for s in series:
        l = latest.get(s["code"])
        if s["freq"] == "D" or not l or (s["db"], s["code"], l["date"]) in known:
            continue
        # その系列の記録が無ければ基準扱い（新しく追加した系列を新着にしない）
        seen = today if any(r["db"] == s["db"] and r["code"] == s["code"] for r in releases) else ""
        releases.append({"seen_on": seen, "db": s["db"], "code": s["code"], "obs_date": l["date"]})
    with open(RELEASES, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["seen_on", "db", "code", "obs_date"])
        w.writeheader()
        w.writerows(releases)

    # 前回比。analyze.py の水準系列は対数変化率なので、ページでは普通の変化率にそろえる
    def change(s, v, p):
        if v is None or p is None:
            return None
        if s["kind"] in ("rate", "flow"):
            return analyze.fmt_change(s, v - p)
        return analyze.fmt_change(s, (v / p - 1) * 100) if p else None

    # 観測期ごとの値（公表の行に値を出すため）
    def value_at(s, obs):
        rows = read_rows(os.path.join(ROOT, "data", sid(s) + ".csv"))
        vals = [r for r in rows if r["value"] not in ("", None)]
        for i, r in enumerate(vals):
            if r["date"] == obs:
                return float(r["value"]), (float(vals[i - 1]["value"]) if i else None)
        return None, None

    since = (dt.date.fromisoformat(today) - dt.timedelta(days=FEED_DAYS)).isoformat()
    days = {}
    for r in releases:
        s = key.get((r["db"], r["code"]))
        if not s or not r["seen_on"] or r["seen_on"] < since:
            continue
        v, p = value_at(s, r["obs_date"])
        days.setdefault(r["seen_on"], []).append({
            "kind": "release", "id": sid(s), "name": s["name"], "obs": r["obs_date"],
            "value": None if v is None else analyze.num(v), "unit": s["unit"],
            "change": change(s, v, p),
        })
    for r in read_rows(os.path.join(REPORTS, "signals_log.csv")):
        s = key.get((r["db"], r["code"]))
        # 毎日値が出る金利・為替・国債利回りは新着に載せない（「毎日の値」に出す）
        if not s or s["freq"] == "D" or r["detected_on"] < since:
            continue
        days.setdefault(r["detected_on"], []).append({
            "kind": "signal", "id": sid(s), "name": s["name"], "obs": r["obs_date"],
            "type": r["type"], "dir": r["dir"], "detail": r["detail"],
        })

    info = {}
    for s in series:
        l = latest.get(s["code"])
        info[sid(s)] = {
            "name": s["name"], "db": s["db"], "code": s["code"], "freq": s["freq"], "unit": s["unit"],
            "kind": s["kind"], "category": category(s),
            "date": l and l["date"], "value": l and analyze.num(l["value"]), "change": l and change(s, l["value"], l["prev"]),
            "implication": analyze.IMPLICATIONS.get(s["code"], ""),
            "source": TRADE if s["code"].startswith("TRADE_") else SOURCES.get(s["db"], BOJ),
        }

    # 取り込み状況（status.py が書く）。失敗した系列と長く更新の無い系列をページに出す
    fetch_status = None
    try:
        with open(os.path.join(REPORTS, "status.json"), encoding="utf-8") as f:
            st = json.load(f)
        fetch_status = {
            "checked_at": st["checked_at"], "counts": st["counts"], "total": len(st["series"]),
            "problems": [{"id": k, "name": v["name"], "state": v["state"], "error": v["error"],
                          "latest": v["latest"], "last_ok": v["last_ok"], "last_new": v["last_new"]}
                         for k, v in st["series"].items() if v["state"] in ("error", "stale")],
            "other_errors": [e for e in st["errors"]
                             if not any(v["error"] == e for v in st["series"].values())],
        }
    except (OSError, ValueError, KeyError):
        pass

    trade_updated = None  # 半導体関連の国別推移（trade.html）のデータの更新日
    try:
        with open(os.path.join(ROOT, "data", "trade_by_country.json"), encoding="utf-8") as f:
            trade_updated = json.load(f).get("updated")
    except (OSError, ValueError):
        pass

    out = {
        "generated_at": dt.datetime.now().astimezone().isoformat(timespec="minutes"),
        "report_date": today,
        "days": [{"date": d, "items": days[d]} for d in sorted(days, reverse=True)],
        "categories": [c for c, _ in CATEGORIES],
        "series": info,
        "fetch_status": fetch_status,
        "trade_updated": trade_updated,
        "disclaimer": analyze.DISCLAIMER,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"feed.json: {sum(len(d['items']) for d in out['days'])}件 / {len(out['days'])}日, 系列 {len(info)}")


if __name__ == "__main__":
    main()
