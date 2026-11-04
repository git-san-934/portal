"""日経平均の PER から買い時・売り時の合図を出し、合図のあとの値動きを検証して ../data/analysis.json を書く。

入力:
  ../data/per_daily.json          — fetch_per.py が毎日ためる日次の PER・終値(日経公式)
  ../data/per_history_monthly.csv — 日次データより前の期間を補う月次の PER・終値(任意。無ければ日次だけで計算)
                                    列: month(YYYY-MM), close, per, basis(単体/連結), source

判定:
  固定バンド : PER < 14 で「買い検討」、PER > 16 で「売り検討」
  相対バンド : その月より前の N 年(5年・10年)の月末 PER の平均 ± 1σ。
               平均 −1σ より下で「買い検討」、平均 +1σ より上で「売り検討」。
               時代ごとの水準の違い(バブル期の60倍、2004年の単体→連結の計算変更など)を吸収するため
理論株価   : EPS = 終値 ÷ PER として、EPS × 14・EPS × 16(相対バンドは EPS × 平均±1σ)

検証:
  合図の出た日から 1か月・3か月・1年後の終値の変化率を集める。
  「合図」は、バンドの外に出た最初の日(前にバンドの外だった日から30日以上空いたとき)。
  比べる相手は、同じ期間のすべての日の平均(いつ買っても同じだったか)。

使い方: python analyze.py [--check]   (--check は書き込まずに結果の要約だけ出す)
標準ライブラリのみ。
"""

import argparse
import bisect
import csv
import json
import math
import statistics
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
DAILY_PATH = DATA / "per_daily.json"
HISTORY_PATH = DATA / "per_history_monthly.csv"
OUT_PATH = DATA / "analysis.json"
JST = timezone(timedelta(hours=9))

# 分析に使う PER の列。日経の表の「加重平均」が長く続いている系列なのでこれを先に使い、無い日は「指数ベース」
PER_COLUMNS = ("weighted", "index_based")
FIXED_LOW, FIXED_HIGH = 14.0, 16.0
REL_YEARS = (5, 10)
REL_SIGMA = 1.0
HORIZONS = (("1m", 30), ("3m", 91), ("1y", 365))
EVENT_GAP_DAYS = 30
FIXED_RECENT_YEARS = 10
BASIS_CHANGE = "2004-01"  # この頃から連結決算ベース(それより前は単体)


def load_points() -> tuple[list[dict], dict]:
    """日次と月次をつないだ [{date, close, per, freq, basis}] を古い順に返す。"""
    daily = []
    cols_used = {}
    if DAILY_PATH.exists():
        for r in json.loads(DAILY_PATH.read_text(encoding="utf-8")).get("rows", []):
            per = next((r[c] for c in PER_COLUMNS if r.get(c)), None)
            col = next((c for c in PER_COLUMNS if r.get(c)), None)
            if per is None or not r.get("close"):
                continue
            cols_used[col] = cols_used.get(col, 0) + 1
            daily.append({"date": r["date"], "close": r["close"], "per": per, "freq": "d", "basis": "連結",
                          "per_index": r.get("index_based"), "per_weighted": r.get("weighted")})
    first_daily = daily[0]["date"] if daily else "9999-99-99"

    monthly = []
    if HISTORY_PATH.exists():
        with HISTORY_PATH.open(encoding="utf-8") as f:
            for r in csv.DictReader(f):
                try:
                    y, m = map(int, r["month"].split("-"))
                    close, per = float(r["close"]), float(r["per"])
                except (KeyError, ValueError):
                    continue
                # 月末の日付として扱う
                d = (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)).isoformat()
                if d >= first_daily[:8] + "01":
                    continue
                monthly.append({"date": d, "close": close, "per": per, "freq": "m",
                                "basis": r.get("basis") or ("単体" if r["month"] < BASIS_CHANGE else "連結")})
    pts = sorted(monthly + daily, key=lambda p: p["date"])
    info = {"daily_from": daily[0]["date"] if daily else None, "daily_days": len(daily),
            "monthly_from": monthly[0]["date"][:7] if monthly else None, "monthly_months": len(monthly),
            "per_columns": cols_used}
    for p in pts:
        p["eps"] = p["close"] / p["per"]
    return pts, info


def month_key(d: str) -> str:
    return d[:7]


def add_months(ym: str, k: int) -> str:
    y, m = map(int, ym.split("-"))
    t = y * 12 + (m - 1) + k
    return f"{t // 12:04d}-{t % 12 + 1:02d}"


def relative_bands(pts: list[dict]) -> dict:
    """{years: {YYYY-MM: (mean, sd)}}。その月より前の N 年の月末 PER から作る(その月自身は含めない)。"""
    month_end = {}
    for p in pts:
        month_end[month_key(p["date"])] = p["per"]
    months = sorted(month_end)
    out = {}
    for n in REL_YEARS:
        bands = {}
        need = int(n * 12 * 0.8)
        for ym in months:
            lo = add_months(ym, -n * 12)
            vals = [month_end[k] for k in months[bisect.bisect_left(months, lo):bisect.bisect_left(months, ym)]]
            if len(vals) >= need:
                bands[ym] = (statistics.fmean(vals), statistics.pstdev(vals))
        out[n] = bands
    return out


def forward_returns(pts: list[dict]) -> None:
    dates = [p["date"] for p in pts]
    last = date.fromisoformat(dates[-1])
    for p in pts:
        d0 = date.fromisoformat(p["date"])
        for key, days in HORIZONS:
            target = d0 + timedelta(days=days)
            if target > last:
                p["r" + key] = None
                continue
            j = bisect.bisect_left(dates, target.isoformat())
            # 月次の期間で行き先が半月以上ずれるときは使わない
            if j >= len(pts) or (date.fromisoformat(dates[j]) - target).days > 16:
                p["r" + key] = None
                continue
            p["r" + key] = pts[j]["close"] / p["close"] - 1


def zone_of(per: float, lo: float, hi: float) -> str:
    return "buy" if per < lo else "sell" if per > hi else "mid"


def summarize(vals: list[float], side: str) -> dict | None:
    vals = [v for v in vals if v is not None]
    if not vals:
        return None
    win = sum(1 for v in vals if (v > 0 if side == "buy" else v < 0))
    return {"n": len(vals), "mean": statistics.fmean(vals), "median": statistics.median(vals),
            "win": win / len(vals)}


def backtest(pts: list[dict], band_of, since: str | None, label: str, note: str) -> dict:
    """band_of(p) -> (lo, hi) or None。"""
    sel = [p for p in pts if (since is None or p["date"] >= since) and band_of(p) is not None]
    res = {"label": label, "note": note, "from": sel[0]["date"] if sel else None,
           "to": sel[-1]["date"] if sel else None, "days": len(sel)}
    if not sel:
        return res
    # 日次と月次が混ざるので、平均は月末の1日だけで数える(日次の期間ばかり重くならないように)
    month_end = list({month_key(p["date"]): p for p in sel}.values())
    res["months"] = len(month_end)
    base = {k: summarize([p["r" + k] for p in month_end], "buy") for k, _ in HORIZONS}
    res["baseline"] = base
    for side in ("buy", "sell"):
        events = []
        last_in = None
        for p in sel:
            lo, hi = band_of(p)
            if zone_of(p["per"], lo, hi) != side:
                continue
            d = date.fromisoformat(p["date"])
            if last_in is None or (d - last_in).days > EVENT_GAP_DAYS:
                events.append({"date": p["date"], "per": round(p["per"], 2), "close": p["close"],
                               "lo": round(lo, 2), "hi": round(hi, 2),
                               **{k: (None if p["r" + k] is None else round(p["r" + k], 4)) for k, _ in HORIZONS}})
            last_in = d
        in_zone_m = [p for p in month_end if zone_of(p["per"], *band_of(p)) == side]
        res[side] = {
            "months": len(in_zone_m),
            "share": len(in_zone_m) / len(month_end),
            "events": events,
            "event_stats": {k: summarize([e[k] for e in events], side) for k, _ in HORIZONS},
            "month_stats": {k: summarize([p["r" + k] for p in in_zone_m], side) for k, _ in HORIZONS},
        }
    return res


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    pts, info = load_points()
    now = datetime.now(JST).isoformat(timespec="minutes")
    if len(pts) < 2:
        out = {"updated": now, "ready": False, "info": info,
               "message": "まだ PER のデータがありません。毎日の取得が始まるとここに結果が出ます。"}
        print(out["message"])
        if not args.check:
            OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        return 0

    rel = relative_bands(pts)
    forward_returns(pts)

    def fixed(_p):
        return (FIXED_LOW, FIXED_HIGH)

    def rel_of(n):
        def f(p):
            b = rel[n].get(month_key(p["date"]))
            return None if b is None else (b[0] - REL_SIGMA * b[1], b[0] + REL_SIGMA * b[1])
        return f

    last = pts[-1]
    recent_since = (date.fromisoformat(last["date"]) - timedelta(days=365 * FIXED_RECENT_YEARS)).isoformat()
    tests = {
        "fixed_recent": backtest(pts, fixed, recent_since, f"固定 14/16倍(直近{FIXED_RECENT_YEARS}年)",
                                 "14倍未満で買い検討、16倍超で売り検討。今の水準に合わせた線なので直近の期間で見ます"),
        "fixed_all": backtest(pts, fixed, None, "固定 14/16倍(全期間)",
                              "参考。PER の水準が今と違う昔の期間も同じ線で判定しています"),
    }
    for n in REL_YEARS:
        tests[f"rel{n}"] = backtest(pts, rel_of(n), None, f"相対 過去{n}年の平均±1σ(全期間)",
                                    f"その月より前の{n}年間の月末 PER の平均から1σ下で買い検討、1σ上で売り検討")

    # チャート用の系列(日次は全部、月次期間は月末)
    series = {"date": [], "close": [], "per": [], "eps": [], "freq": []}
    for n in REL_YEARS:
        series[f"m{n}"] = []
        series[f"s{n}"] = []
    for p in pts:
        series["date"].append(p["date"])
        series["close"].append(round(p["close"], 2))
        series["per"].append(round(p["per"], 2))
        series["eps"].append(round(p["eps"], 2))
        series["freq"].append(p["freq"])
        for n in REL_YEARS:
            b = rel[n].get(month_key(p["date"]))
            series[f"m{n}"].append(None if b is None else round(b[0], 2))
            series[f"s{n}"].append(None if b is None else round(b[1], 3))

    cur = {"date": last["date"], "close": last["close"], "per": last["per"], "eps": round(last["eps"], 2),
           "per_index": last.get("per_index"), "per_weighted": last.get("per_weighted"),
           "fixed": {"lo": FIXED_LOW, "hi": FIXED_HIGH, "zone": zone_of(last["per"], FIXED_LOW, FIXED_HIGH),
                     "price_lo": round(last["eps"] * FIXED_LOW), "price_hi": round(last["eps"] * FIXED_HIGH)}}
    for n in REL_YEARS:
        b = rel[n].get(month_key(last["date"]))
        if b:
            lo, hi = b[0] - REL_SIGMA * b[1], b[0] + REL_SIGMA * b[1]
            cur[f"rel{n}"] = {"mean": round(b[0], 2), "sd": round(b[1], 2), "lo": round(lo, 2), "hi": round(hi, 2),
                              "zone": zone_of(last["per"], lo, hi),
                              "price_lo": round(last["eps"] * lo), "price_hi": round(last["eps"] * hi),
                              "price_mean": round(last["eps"] * b[0])}

    out = {"updated": now, "ready": True, "info": info, "current": cur, "tests": tests, "series": series,
           "settings": {"fixed": [FIXED_LOW, FIXED_HIGH], "rel_years": list(REL_YEARS), "rel_sigma": REL_SIGMA,
                        "event_gap_days": EVENT_GAP_DAYS, "basis_change": BASIS_CHANGE,
                        "per_columns": list(PER_COLUMNS)}}
    print(f"{info} 最新 {last['date']} PER {last['per']} 終値 {last['close']}")
    for k, t in tests.items():
        if "buy" in t:
            print(f"  {k}: 買い合図 {len(t['buy']['events'])}回 / 売り合図 {len(t['sell']['events'])}回 ({t['from']}〜)")
    if not args.check:
        OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
