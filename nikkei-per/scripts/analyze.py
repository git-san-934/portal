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
BASIS_CHANGE = "2004-01"
# 利益が一時的に落ちて PER が意味を持たない月(2009年春は100〜290倍)は、相対バンドの平均・σの計算から外す。
# 入れると、その後5〜10年の線が何十倍にも広がって判定にならないため。判定そのもの(線より上か下か)はそのまま行う
REL_EXCLUDE_ABOVE = 50.0  # この頃から連結決算ベース(それより前は単体)


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
                          "per_index": r.get("index_based"), "per_weighted": r.get("weighted"),
                          "pbr": r.get("pbr_weighted")})
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
            vals = [month_end[k] for k in months[bisect.bisect_left(months, lo):bisect.bisect_left(months, ym)]
                    if month_end[k] <= REL_EXCLUDE_ABOVE]
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


# ---------- 売買ルール(持つ / 現金 を交互に) ----------
# 2004年9月〜の PER・PBR で約500通りを比べて決めた。キリのよい数字にして、たまたま当たった細かい値を避けている
TRADE_BUY_PBR = 1.1    # 現金のとき: PBR がこれを下回ったあと、下から上に抜けた日 → 次の営業日に買う(底を確かめてから買う。1.0倍割れは22年中5つの年しかなく少なすぎるため1.1倍)
TRADE_SELL_PBR = 2.0   # 持っているとき: PBR がこれを超え、
TRADE_SELL_PER = 16.0  #   しかも PER がこれを超えた日(利益が落ちて PER だけ高い時期は売らない) → 次の営業日に売る
TRADE_COST = 0.001     # 売買1回ごとのコスト(片道0.1%)。現金の利息は0とする
ROLL_STEP_DAYS = 91


def trade_signal(p: dict, holding: bool, st: dict) -> str | None:
    """st["armed"]: 現金のときに PBR が買いの線を下回ったことがあるか。下回ったあと上に抜けた日が買いの合図。"""
    if p.get("pbr") is None:
        return None
    if holding:
        st["armed"] = False
    elif p["pbr"] < TRADE_BUY_PBR:
        st["armed"] = True
    elif st["armed"] and p["pbr"] > TRADE_BUY_PBR:
        st["armed"] = False
        return "buy"
    if holding and p["pbr"] > TRADE_SELL_PBR and TRADE_SELL_PER < p["per"] <= REL_EXCLUDE_ABOVE:
        return "sell"
    return None


def simulate(pts: list[dict], start: int, end: int, holding: bool = True) -> dict:
    """pts[start:end] を、はじめは holding の状態から売買ルールどおりに動かす。合図は終値で判定し、次の営業日の終値で売買。"""
    eq, peak, mdd, pending = 1.0, 1.0, 0.0, None
    trades, curve, entry = [], [], (start, 1.0) if holding else None
    days_in, st = 0, {"armed": False}
    for i in range(start, end):
        if i > start and holding:
            eq *= pts[i]["close"] / pts[i - 1]["close"]
        if pending == "buy" and not holding:
            holding, eq = True, eq * (1 - TRADE_COST)
            entry = (i, eq)
            trades.append({"date": pts[i]["date"], "side": "buy", "close": pts[i]["close"], "pbr": pts[i]["pbr"], "per": round(pts[i]["per"], 2)})
        elif pending == "sell" and holding:
            holding, eq = False, eq * (1 - TRADE_COST)
            trades.append({"date": pts[i]["date"], "side": "sell", "close": pts[i]["close"], "pbr": pts[i]["pbr"], "per": round(pts[i]["per"], 2),
                           "ret": round(eq / entry[1] - 1, 4) if entry else None, "from": pts[entry[0]]["date"] if entry else None})
            entry = None
        pending = trade_signal(pts[i], holding, st)
        if pending:
            pts[i].setdefault("sig", pending)
        days_in += holding
        peak = max(peak, eq)
        mdd = min(mdd, eq / peak - 1)
        curve.append(eq)
    return {"eq": eq, "mdd": mdd, "trades": trades, "curve": curve, "holding": holding, "pending": pending, "armed": st["armed"],
            "in_market": days_in / max(1, end - start), "open_from": pts[entry[0]]["date"] if (holding and entry) else None,
            "open_ret": (eq / entry[1] - 1) if (holding and entry) else None}


def hold_stats(pts: list[dict], start: int, end: int) -> dict:
    peak, mdd = 0.0, 0.0
    for p in pts[start:end]:
        peak = max(peak, p["close"])
        mdd = min(mdd, p["close"] / peak - 1)
    return {"eq": pts[end - 1]["close"] / pts[start]["close"], "mdd": mdd}


def cagr(eq: float, d0: str, d1: str) -> float:
    yrs = (date.fromisoformat(d1) - date.fromisoformat(d0)).days / 365.25
    return eq ** (1 / yrs) - 1 if yrs > 0 else 0.0


def trade_report(pts: list[dict]) -> dict | None:
    idx = [i for i, p in enumerate(pts) if p.get("pbr") is not None]
    if len(idx) < 250:
        return None
    s, e = idx[0], idx[-1] + 1
    sim = simulate(pts, s, e, holding=True)
    hold = hold_stats(pts, s, e)
    d0, d1 = pts[s]["date"], pts[e - 1]["date"]
    sells = [t for t in sim["trades"] if t["side"] == "sell" and t.get("ret") is not None]
    rounds = [t["ret"] for t in sells] + ([sim["open_ret"]] if sim["open_ret"] is not None else [])
    # 開始日を約3か月ずつずらして、5年・10年続けた場合に「持ち続け」と比べる
    rolling = {}
    for years in (5, 10):
        diffs = []
        t = date.fromisoformat(d0)
        while True:
            i0 = bisect.bisect_left([p["date"] for p in pts], t.isoformat(), lo=s, hi=e)
            t1 = (date.fromisoformat(pts[i0]["date"]) + timedelta(days=int(365.25 * years))).isoformat() if i0 < e else None
            if t1 is None or t1 > d1:
                break
            i1 = bisect.bisect_left([p["date"] for p in pts], t1, lo=s, hi=e)
            r = simulate([dict(p) for p in pts], i0, i1 + 1, holding=True)
            diffs.append(r["eq"] / (pts[i1]["close"] / pts[i0]["close"]) - 1)
            t += timedelta(days=ROLL_STEP_DAYS)
        if diffs:
            rolling[f"{years}y"] = {"n": len(diffs), "win": sum(d > 0.001 for d in diffs) / len(diffs),
                                    "same": sum(abs(d) <= 0.001 for d in diffs) / len(diffs),
                                    "lose": sum(d < -0.001 for d in diffs) / len(diffs),
                                    "median": statistics.median(diffs), "worst": min(diffs), "best": max(diffs)}
    # 資産の推移(週1点に間引く)
    curve = {"date": [], "rule": [], "hold": []}
    base = pts[s]["close"]
    for k, i in enumerate(range(s, e)):
        if k % 5 and i != e - 1:
            continue
        curve["date"].append(pts[i]["date"])
        curve["rule"].append(round(sim["curve"][i - s], 4))
        curve["hold"].append(round(pts[i]["close"] / base, 4))
    last = pts[e - 1]
    bps, eps = last["close"] / last["pbr"], last["close"] / last["per"]
    return {
        "rule": {"buy_pbr": TRADE_BUY_PBR, "sell_pbr": TRADE_SELL_PBR, "sell_per": TRADE_SELL_PER, "cost": TRADE_COST},
        "from": d0, "to": d1,
        "now": {"holding": sim["holding"], "pending": sim["pending"], "armed": sim["armed"], "since": (sim["trades"][-1]["date"] if sim["trades"] else d0),
                "pbr": last["pbr"], "per": round(last["per"], 2), "close": last["close"], "bps": round(bps), "eps": round(eps),
                "buy_price": round(bps * TRADE_BUY_PBR),
                "sell_price": round(max(bps * TRADE_SELL_PBR, eps * TRADE_SELL_PER))},
        "trades": sim["trades"],
        "stats": {"rule": {"eq": sim["eq"], "cagr": cagr(sim["eq"], d0, d1), "mdd": sim["mdd"], "in_market": sim["in_market"],
                           "n": len(sim["trades"]), "rounds": len(rounds),
                           "win": (sum(r > 0 for r in rounds) / len(rounds)) if rounds else None},
                  "hold": {"eq": hold["eq"], "cagr": cagr(hold["eq"], d0, d1), "mdd": hold["mdd"]}},
        "rolling": rolling,
        "curve": curve,
    }


# ---------- 持ち方のくらべ(全部・半分・段階) ----------
# 同じ PBR・PER の線で「全部売り買い」「半分ずつ」「現金の半分だけ買う」などを比べる。売買は合図の次の営業日の終値、
# コストは動かした割合 × TRADE_COST。保有の割合 w(0〜1)は、上がる向きは買いの条件、下がる向きは売りの条件でだけ動く
def _pbr_lt(th):
    return lambda p: p["pbr"] < th


def _pbr_gt(th, per=None):
    return lambda p: p["pbr"] > th and (per is None or per < p["per"] <= REL_EXCLUDE_ABOVE)


def _per_lt(th):
    return lambda p: p["per"] < th


def _per_gt(th):
    return lambda p: th < p["per"] <= REL_EXCLUDE_ABOVE


def _steps(buys, sells):
    """buys/sells: [(条件, 目標の割合)]。上へは買いの条件、下へは売りの条件でだけ動く(行ったり来たりを防ぐ)。"""
    def f(p, w):
        up = [tw for c, tw in buys if tw > w + 1e-9 and c(p)]
        if up:
            return max(up)
        down = [tw for c, tw in sells if tw < w - 1e-9 and c(p)]
        return min(down) if down else None
    return f


def _linear(lo, hi, step=0.25):
    def f(p, w):
        t = round(min(1.0, max(0.0, (hi - p["pbr"]) / (hi - lo))) / step) * step
        return t if abs(t - w) >= step - 1e-9 else None
    return f


def _recross(arm, up):
    """現金のとき PBR が arm を割ったら「準備」、そのあと PBR が up を上に抜けた日に全部買う(底を確かめてから買う)。売りは上の売買ルール。"""
    st = {"armed": False}

    def f(p, w):
        if w < 0.5:
            if p["pbr"] < arm:
                st["armed"] = True
            if st["armed"] and p["pbr"] > up:
                st["armed"] = False
                return 1.0
            return None
        st["armed"] = False
        return 0.0 if _pbr_gt(TRADE_SELL_PBR, TRADE_SELL_PER)(p) else None
    return f


PATTERNS = [
    ("all", "全部売り・全部買い(上の売買ルール)", f"PBR {TRADE_BUY_PBR}倍を割ったあと上に抜けたら全部買い / PBR {TRADE_SELL_PBR}倍超かつPER {TRADE_SELL_PER:g}倍超で全部売り",
     _recross(TRADE_BUY_PBR, TRADE_BUY_PBR)),
    ("under", "線を割ったらすぐ買う", f"PBR {TRADE_BUY_PBR}倍を割った日に全部買い / 売りは上の売買ルールと同じ",
     _steps([(_pbr_lt(TRADE_BUY_PBR), 1.0)], [(_pbr_gt(TRADE_SELL_PBR, TRADE_SELL_PER), 0.0)])),
    ("recross", "1倍割れのあと上抜けで買う", "PBR 1.0倍を割ったあと、1.0倍を上に抜けた日に全部買い / 売りは上の売買ルールと同じ",
     _recross(1.0, 1.0)),
    ("half", "半分ずつ", "PBR 1.0倍割れで半分・0.9倍割れで残りを買い / PBR 1.8倍超で半分・2.0倍超かつPER 16倍超で残りを売り",
     _steps([(_pbr_lt(1.0), 0.5), (_pbr_lt(0.9), 1.0)], [(_pbr_gt(1.8), 0.5), (_pbr_gt(2.0, 16), 0.0)])),
    ("keep_half", "半分だけ売る", "売りの合図で半分だけ売り(最低でも半分は持つ) / 買いの合図で全部に戻す",
     _steps([(_pbr_lt(1.0), 1.0)], [(_pbr_gt(2.0, 16), 0.5)])),
    ("third", "3段階(1/3ずつ)", "PBR 1.6・1.8・2.0倍超で1/3ずつ売り / 1.2・1.1・1.0倍割れで1/3ずつ買い",
     _steps([(_pbr_lt(1.2), 1 / 3), (_pbr_lt(1.1), 2 / 3), (_pbr_lt(1.0), 1.0)], [(_pbr_gt(1.6), 2 / 3), (_pbr_gt(1.8), 1 / 3), (_pbr_gt(2.0), 0.0)])),
    ("cash_half", "現金の半分だけ買う", "売りの合図で全部売り / 買いの合図では現金の半分だけ買う",
     _steps([(_pbr_lt(1.0), 0.5)], [(_pbr_gt(2.0, 16), 0.0)])),
    ("linear", "PBR に合わせて毎日調整", "PBR 1.0倍以下で全部、2.0倍以上で0、そのあいだは25%刻みで割合を変える",
     _linear(1.0, 2.0)),
    ("per_all", "PER だけ・全部", "PER 14倍割れで全部買い / PER 16倍超で全部売り",
     _steps([(_per_lt(14), 1.0)], [(_per_gt(16), 0.0)])),
    ("per_half", "PER だけ・半分ずつ", "PER 14倍割れで半分・13倍割れで残りを買い / 16倍超で半分・17倍超で残りを売り",
     _steps([(_per_lt(14), 0.5), (_per_lt(13), 1.0)], [(_per_gt(16), 0.5), (_per_gt(17), 0.0)])),
]


def weight_sim(pts: list[dict], s: int, e: int, target) -> dict:
    w, eq, peak, mdd, pend, n, inm, curve = 1.0, 1.0, 1.0, 0.0, None, 0, 0.0, []
    for i in range(s, e):
        if i > s:
            eq *= 1 + w * (pts[i]["close"] / pts[i - 1]["close"] - 1)
        if pend is not None and abs(pend - w) > 1e-9:
            eq *= 1 - TRADE_COST * abs(pend - w)
            w, n = pend, n + 1
        t = target(pts[i], w)
        pend = t if t is not None and abs(t - w) > 1e-9 else None
        peak, inm = max(peak, eq), inm + w
        mdd = min(mdd, eq / peak - 1)
        curve.append(eq)
    return {"eq": eq, "mdd": mdd, "n": n, "w": w, "pending": pend, "in_market": inm / max(1, e - s), "curve": curve}


def patterns_report(pts: list[dict]) -> dict | None:
    idx = [i for i, p in enumerate(pts) if p.get("pbr") is not None]
    if len(idx) < 250:
        return None
    s, e = idx[0], idx[-1] + 1
    d0, d1 = pts[s]["date"], pts[e - 1]["date"]
    dates = [p["date"] for p in pts[s:e]]
    hold = [p["close"] / pts[s]["close"] for p in pts[s:e]]
    keep = [k for k in range(e - s) if k % 5 == 0 or k == e - s - 1]
    out = {"from": d0, "to": d1, "date": [dates[k] for k in keep], "hold": [round(hold[k], 4) for k in keep],
           "hold_stats": {"eq": hold[-1], "cagr": cagr(hold[-1], d0, d1), "mdd": hold_stats(pts, s, e)["mdd"]}, "items": []}
    for key, name, desc, target in PATTERNS:
        r = weight_sim(pts, s, e, target)
        c = r["curve"]
        # 開始日を3か月ずつずらして5年続けたとき、持ち続けより良かった/悪かった割合
        win = lose = cnt = 0
        t = date.fromisoformat(d0)
        while True:
            i0 = bisect.bisect_left(dates, t.isoformat())
            t1 = (date.fromisoformat(dates[i0]) + timedelta(days=int(365.25 * 5))).isoformat()
            if t1 > d1:
                break
            i1 = bisect.bisect_left(dates, t1)
            diff = c[i1] / c[i0] - hold[i1] / hold[i0]
            cnt, win, lose = cnt + 1, win + (diff > 0.005), lose + (diff < -0.005)
            t += timedelta(days=ROLL_STEP_DAYS)
        out["items"].append({"key": key, "name": name, "desc": desc, "eq": r["eq"], "cagr": cagr(r["eq"], d0, d1), "mdd": r["mdd"],
                             "n": r["n"], "in_market": r["in_market"], "w": r["w"], "pending": r["pending"],
                             "win5": win / cnt if cnt else None, "lose5": lose / cnt if cnt else None,
                             "curve": [round(c[k], 4) for k in keep]})
    return out


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

    trade = trade_report(pts)
    patterns = patterns_report(pts)

    # チャート用の系列(日次は全部、月次期間は月末)
    series = {"date": [], "close": [], "per": [], "pbr": [], "sig": [], "eps": [], "freq": []}
    for n in REL_YEARS:
        series[f"m{n}"] = []
        series[f"s{n}"] = []
    for p in pts:
        series["date"].append(p["date"])
        series["close"].append(round(p["close"], 2))
        series["per"].append(round(p["per"], 2))
        series["pbr"].append(p.get("pbr"))
        series["sig"].append(p.get("sig"))
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

    out = {"updated": now, "ready": True, "info": info, "current": cur, "trade": trade, "patterns": patterns, "tests": tests, "series": series,
           "settings": {"fixed": [FIXED_LOW, FIXED_HIGH], "rel_years": list(REL_YEARS), "rel_sigma": REL_SIGMA,
                        "event_gap_days": EVENT_GAP_DAYS, "basis_change": BASIS_CHANGE,
                        "per_columns": list(PER_COLUMNS), "rel_exclude_above": REL_EXCLUDE_ABOVE}}
    if trade:
        st_ = trade["stats"]
        print(f"  trade: {'持つ' if trade['now']['holding'] else '現金'} 取引{st_['rule']['n']}回 x{st_['rule']['eq']:.2f} (持ち続け x{st_['hold']['eq']:.2f}) "
              f"最大下落 {st_['rule']['mdd']:.0%} / {st_['hold']['mdd']:.0%} 5年比較 {trade['rolling'].get('5y')}")
    for it in (patterns or {}).get("items", []):
        print(f"  pattern {it['key']}: x{it['eq']:.2f} 最大下落 {it['mdd']:.0%} 売買{it['n']}回 いま{it['w']:.0%}")
    print(f"{info} 最新 {last['date']} PER {last['per']} 終値 {last['close']}")
    for k, t in tests.items():
        if "buy" in t:
            print(f"  {k}: 買い合図 {len(t['buy']['events'])}回 / 売り合図 {len(t['sell']['events'])}回 ({t['from']}〜)")
    if not args.check:
        OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
