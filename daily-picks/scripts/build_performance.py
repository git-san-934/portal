#!/usr/bin/env python3
"""今日の3銘柄の「その後」を集計して data/performance.json を書き出す。

基準: 分析に使った終値(picks.json の close、price_date の終値)
本のルールで売買したと仮定した結果も出す:
  - 損切り: 直近の押し安値(サポート)の少し下 (安値 × 0.99)
  - 利確目標: リスクリワード 1:3 (基準 + 3 × (基準 − 損切り))
  - 高値後の安値割れ: 基準より上で高値を更新したあと、その上昇の起点の安値を終値で割ったら売り(ダウ理論)

株価: GitHub Actions では yfinance。ローカルでは --tse-db (git-san-934/tse-price-db) と
--csv (code,date,open,high,low,close,volume) を重ねて使える。取得できた株価は
data/prices.json に貯めておき、次回以降も使う。
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"
PICKS = DATA / "picks.json"
PRICES = DATA / "prices.json"
OUT = DATA / "performance.json"

LOOKBACK_DAYS = 60  # サポートを探すのに使う基準日より前の日数(暦日)
STOP_BUFFER = 0.99  # サポートの1%下を損切りに
RR = 3.0
SWING_BARS = 20  # 押し安値を探す基準日より前の営業日数
HORIZONS = [1, 3, 5, 10, 20]


def load_json(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def unique_picks(days):
    """同じ終値日・同じ銘柄は1件にまとめる(再分析で同じ銘柄が並ぶことがあるため)。"""
    seen = {}
    for day in sorted(days, key=lambda d: d["date"]):
        pd_ = day.get("price_date") or day["date"]
        for p in day.get("picks", []):
            key = (pd_, p["code"])
            if key in seen:
                seen[key]["dates"].append(day["date"])
                continue
            seen[key] = {
                "date": day["date"],
                "dates": [day["date"]],
                "price_date": pd_,
                "code": p["code"],
                "name": p.get("name", ""),
                "rank": p.get("rank"),
                "base": p.get("close"),
            }
    return list(seen.values())


# ---------------------------------------------------------------- 株価の取得
def merge(store, code, rows):
    cur = {r[0]: r for r in store.get(code, [])}
    for r in rows:
        if r[4] is None:
            continue
        cur[r[0]] = r
    store[code] = [cur[k] for k in sorted(cur)]


def from_tse_db(store, codes, root: Path):
    for c in codes:
        f = root / "data" / "history" / f"{c}0.json"
        if not f.exists():
            continue
        rows = [[r["date"], r["open"], r["high"], r["low"], r["close"], r.get("volume")]
                for r in json.loads(f.read_text())]
        merge(store, c, rows)


def from_csv(store, path: Path):
    by = {}
    with path.open(encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            try:
                row = [r["date"], float(r["open"]), float(r["high"]), float(r["low"]),
                       float(r["close"]), int(float(r.get("volume") or 0))]
            except (ValueError, KeyError):
                continue
            by.setdefault(r["code"].strip(), []).append(row)
    for c, rows in by.items():
        merge(store, c, rows)


def from_yfinance(store, codes, start: str):
    import yfinance as yf  # Actions でのみ使う

    tickers = [f"{c}.T" for c in codes]
    df = yf.download(tickers, start=start, interval="1d", auto_adjust=False,
                     group_by="ticker", progress=False, threads=True)
    for c in codes:
        t = f"{c}.T"
        try:
            sub = df[t] if len(tickers) > 1 else df
        except KeyError:
            continue
        rows = []
        for idx, r in sub.dropna(subset=["Close"]).iterrows():
            rows.append([idx.strftime("%Y-%m-%d"), round(float(r["Open"]), 2), round(float(r["High"]), 2),
                         round(float(r["Low"]), 2), round(float(r["Close"]), 2), int(r["Volume"] or 0)])
        merge(store, c, rows)


# ---------------------------------------------------------------- 評価
def swing_low_before(bars, i_base, base):
    """基準日以前で、基準より下にある直近の押し安値(前後2本より安い安値)。無ければ20日安値。"""
    lows = [b[3] for b in bars]
    for i in range(i_base - 2, max(1, i_base - SWING_BARS) , -1):
        l = lows[i]
        if l < base and l <= min(lows[i - 2:i]) and l <= min(lows[i + 1:i + 3]):
            return l, bars[i][0]
    window = bars[max(0, i_base - 19):i_base + 1]
    j = min(range(len(window)), key=lambda k: window[k][3])
    return window[j][3], window[j][0]


def evaluate(pick, bars):
    base = pick["base"]
    res = dict(pick)
    idx = {b[0]: i for i, b in enumerate(bars)}
    if pick["price_date"] not in idx or base is None:
        res["status"] = "株価データなし"
        return res
    ib = idx[pick["price_date"]]
    after = bars[ib + 1:]
    res["data_close"] = bars[ib][4]

    support, support_date = swing_low_before(bars, ib, base)
    stop = round(support * STOP_BUFFER, 1)
    if stop >= base:  # 念のため
        stop = round(base * 0.95, 1)
    risk = base - stop
    target = round(base + RR * risk, 1)
    res.update(support=support, support_date=support_date, stop=stop, target=target,
               risk_pct=round(risk / base * 100, 1), target_pct=round(RR * risk / base * 100, 1))

    res["days_held"] = len(after)
    if not after:
        res["status"] = "これから"
        return res

    last = after[-1]
    res["last_date"], res["last_close"] = last[0], last[4]
    res["ret_pct"] = round((last[4] / base - 1) * 100, 2)
    res["max_up_pct"] = round((max(b[2] for b in after) / base - 1) * 100, 2)
    res["max_down_pct"] = round((min(b[3] for b in after) / base - 1) * 100, 2)
    res["horizon"] = {str(h): round((after[h - 1][4] / base - 1) * 100, 2) for h in HORIZONS if len(after) >= h}

    # 本のルールでの売買
    peak = base
    pre_low = bars[ib][3]  # 上昇の起点の安値(初期値は基準日の安値)
    run_low = bars[ib][3]  # 直近の高値以降の安値
    exit_ = None
    for b in after:
        d, o, h, l, c = b[0], b[1], b[2], b[3], b[4]
        if l <= stop:
            px = min(o, stop) if o is not None else stop
            exit_ = {"date": d, "price": px, "reason": "損切り"}
            break
        if h >= target:
            px = max(o, target) if o is not None else target
            exit_ = {"date": d, "price": px, "reason": "利確(1:3)"}
            break
        if h > peak:
            if peak > base or h > base:
                pre_low = run_low
            peak = h
            run_low = l
        else:
            run_low = min(run_low, l)
        if peak > base and pre_low > stop and c < pre_low:
            exit_ = {"date": d, "price": c, "reason": "高値後の安値割れ"}
            break
    if exit_:
        exit_["ret_pct"] = round((exit_["price"] / base - 1) * 100, 2)
        exit_["r"] = round((exit_["price"] - base) / risk, 2)
        res["exit"] = exit_
        res["status"] = exit_["reason"]
    else:
        res["status"] = "保有中"
        res["open_r"] = round((last[4] - base) / risk, 2)
    return res


def summarize(rows):
    done = [r for r in rows if "ret_pct" in r]
    s = {"picks": len(rows), "with_data": len(done)}
    if done:
        rets = [r["ret_pct"] for r in done]
        s["avg_ret_pct"] = round(sum(rets) / len(rets), 2)
        s["win_rate_pct"] = round(sum(1 for x in rets if x > 0) / len(rets) * 100, 1)
        s["best"] = max(done, key=lambda r: r["ret_pct"])["name"]
        s["worst"] = min(done, key=lambda r: r["ret_pct"])["name"]
    closed = [r for r in rows if "exit" in r]
    s["closed"] = len(closed)
    s["closed_wins"] = sum(1 for r in closed if r["exit"]["ret_pct"] > 0)
    s["closed_sum_r"] = round(sum(r["exit"]["r"] for r in closed), 2)
    s["open"] = sum(1 for r in rows if r.get("status") == "保有中")
    for h in HORIZONS:
        xs = [r["horizon"][str(h)] for r in done if str(h) in r.get("horizon", {})]
        if xs:
            s[f"avg_{h}d_pct"] = round(sum(xs) / len(xs), 2)
            s[f"n_{h}d"] = len(xs)
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--yfinance", action="store_true", help="yfinance で取得する(Actions用)")
    ap.add_argument("--tse-db", type=Path, help="git-san-934/tse-price-db のチェックアウト")
    ap.add_argument("--csv", type=Path, action="append", default=[], help="code,date,open,high,low,close,volume")
    args = ap.parse_args()

    picks = unique_picks(load_json(PICKS, {"days": []})["days"])
    codes = sorted({p["code"] for p in picks})
    store = load_json(PRICES, {"prices": {}})["prices"]

    if args.tse_db:
        from_tse_db(store, codes, args.tse_db)
    for c in args.csv:
        from_csv(store, c)
    if args.yfinance and codes:
        first = min(p["price_date"] for p in picks)
        start = (dt.date.fromisoformat(first) - dt.timedelta(days=LOOKBACK_DAYS)).isoformat()
        try:
            from_yfinance(store, codes, start)
        except Exception as e:  # 取得に失敗しても貯めてある株価で集計する
            print(f"yfinance failed: {e}", file=sys.stderr)

    # 不要に古い日を落とす
    if picks:
        keep_from = (dt.date.fromisoformat(min(p["price_date"] for p in picks))
                     - dt.timedelta(days=LOOKBACK_DAYS)).isoformat()
        store = {c: [r for r in store.get(c, []) if r[0] >= keep_from] for c in codes}

    rows = [evaluate(p, store.get(p["code"], [])) for p in picks]
    rows.sort(key=lambda r: (r["price_date"], -(r["rank"] or 0)), reverse=True)
    latest = max((b[0] for bs in store.values() for b in bs), default=None)

    PRICES.write_text(json.dumps({"prices": store}, ensure_ascii=False, separators=(",", ":")) + "\n",
                      encoding="utf-8")
    OUT.write_text(json.dumps({
        "updated_at": dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).isoformat(timespec="minutes"),
        "latest_price_date": latest,
        "rules": {"stop_buffer": STOP_BUFFER, "rr": RR},
        "summary": summarize(rows),
        "rows": rows,
    }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(json.dumps(summarize(rows), ensure_ascii=False))


if __name__ == "__main__":
    main()
