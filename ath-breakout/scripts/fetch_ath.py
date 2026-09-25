"""過去最高値ブレイク検証のデータを作る。

1. tse-price-db の latest.json から時価総額上位の銘柄を選ぶ(取得できなければ前回の universe.json を使う)
2. yfinance(Yahoo Finance)から、取得できる最も古い日からの日次終値(株式分割のみ調整)を取得する
3. 「過去最高値ブレイク」を判定し、その後の値動き(騰落率・TOPIX比の超過リターン・最大下落率・推移)を計算する
4. ../data/ に events.json(ブレイク一覧と集計用の値)と stocks/<code>.json(週足チャート用)を書き出す

GitHub Actions(.github/workflows/update-ath-breakout.yml)から定期実行される。
取得できた銘柄が少なすぎるときは既存のデータを上書きせずに終了コード1で終わる。
"""

import json
import math
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

LATEST_URL = "https://git-san-934.github.io/tse-price-db/data/latest.json"
UNIVERSE_SIZE = 500  # 時価総額上位この数の銘柄を対象にする
BENCH = ("1306", "TOPIX連動ETF(1306)")  # 超過リターンの比較対象

# ---- ブレイクの定義 ----
MIN_HISTORY = 60  # 上場(データ開始)からこの営業日数(約3ヶ月)たつまでは判定しない
MIN_GAP = 60  # 前回の最高値からこの営業日数(約3ヶ月)以上あいた更新だけを1回のブレイクとして数える
HORIZONS = [5, 20, 60, 120, 250]  # 1週 / 1ヶ月 / 3ヶ月 / 6ヶ月 / 1年後(営業日)
PATH_OFFSETS = [-60, -40, -20, -10, -5, 0, 5, 10, 20, 40, 60, 90, 120, 150, 180, 210, 250]
DD_WINDOW = 250  # ブレイク後の最大下落率・再更新を見る期間

BATCH = 100
RETRIES = 3
MIN_OK_RATIO = 0.8  # 対象銘柄のうちこの割合以上取得できなければ失敗とみなす
OUTLIER_WINDOW = 11
OUTLIER_RATIO = 2.0

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
JST = timezone(timedelta(hours=9))


# ---------- 対象銘柄 ----------

def load_universe():
    cache = DATA_DIR / "universe.json"
    try:
        req = urllib.request.Request(LATEST_URL, headers={"User-Agent": "portal-ath-breakout"})
        with urllib.request.urlopen(req, timeout=60) as res:
            items = json.load(res).get("items", [])
        items = [
            it for it in items
            if it.get("code") and isinstance(it.get("market_cap"), (int, float))
            and not any(k in str(it.get("market", "")) for k in ("ETF", "ETN", "REIT", "インフラ"))
        ]
        items.sort(key=lambda it: it["market_cap"], reverse=True)
        universe = [
            {"code": str(it["code"]).removesuffix(".T"), "name": it.get("name", ""),
             "market": it.get("market", ""), "market_cap": it["market_cap"]}
            for it in items[:UNIVERSE_SIZE]
        ]
        if len(universe) < UNIVERSE_SIZE // 2:
            raise RuntimeError(f"too few items in latest.json: {len(universe)}")
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(universe, ensure_ascii=False, indent=0) + "\n", encoding="utf-8")
        return universe
    except Exception as e:  # noqa: BLE001
        print(f"latest.json を取得できませんでした({e})。前回の universe.json を使います", file=sys.stderr)
        return json.loads(cache.read_text(encoding="utf-8"))


# ---------- 株価取得 ----------

def download(codes):
    frames = []
    for i in range(0, len(codes), BATCH):
        tickers = [f"{c}.T" for c in codes[i:i + BATCH]]
        last_err = None
        for attempt in range(1, RETRIES + 1):
            try:
                df = yf.download(
                    tickers, period="max", interval="1d",
                    auto_adjust=False,  # 終値は株式分割のみ調整(配当は調整しない)
                    actions=False, progress=False, threads=True,
                )
                if not df.empty:
                    close = df["Close"]
                    if isinstance(close, pd.Series):
                        close = close.to_frame(tickers[0])
                    frames.append(close)
                    break
                last_err = "empty result"
            except Exception as e:  # noqa: BLE001 — yfinance は色々な例外を投げる
                last_err = e
            print(f"batch {i // BATCH} attempt {attempt} failed: {last_err}", file=sys.stderr)
            time.sleep(10 * attempt)
        time.sleep(2)
    if not frames:
        raise RuntimeError("download failed")
    close = pd.concat(frames, axis=1).sort_index()
    close.columns = [str(c).removesuffix(".T") for c in close.columns]
    return close


def drop_outliers(series):
    med = series.rolling(OUTLIER_WINDOW, center=True, min_periods=3).median()
    ratio = series / med
    bad = (ratio > OUTLIER_RATIO) | (ratio < 1 / OUTLIER_RATIO)
    return series[~bad]


# ---------- ブレイク判定と、その後の値動き ----------

def r4(v):
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else round(float(v), 4)


def find_events(s, bench):
    """s: 1銘柄の終値(欠損なし、日付昇順)。bench: TOPIX連動ETFの終値(同じ日付に前方補完済み)。"""
    vals = s.to_numpy()
    dates = s.index
    b = bench.reindex(dates).ffill().to_numpy() if bench is not None else None
    n = len(vals)
    events = []
    run_max = vals[0]
    last_high_idx = 0  # 直近で最高値を付けた日
    for t in range(1, n):
        v = vals[t]
        if v <= run_max:
            continue
        gap = t - last_high_idx
        prev_high = run_max
        run_max = v
        last_high_idx = t
        if t < MIN_HISTORY or gap < MIN_GAP:
            continue

        ev = {
            "date": dates[t].strftime("%Y-%m-%d"),
            "price": round(float(v), 2),
            "gap": int(gap),  # 前回の最高値から何営業日ぶりの更新か
            "prev_date": dates[t - gap].strftime("%Y-%m-%d"),
            "above": r4(v / prev_high - 1),  # 前回の最高値を何%上抜けたか
        }
        ret, exc = [], []
        for h in HORIZONS:
            if t + h < n:
                r = vals[t + h] / v - 1
                ret.append(r4(r))
                if b is not None and not math.isnan(b[t]) and not math.isnan(b[t + h]):
                    exc.append(r4(r - (b[t + h] / b[t] - 1)))
                else:
                    exc.append(None)
            else:
                ret.append(None)
                exc.append(None)
        ev["ret"] = ret
        ev["exc"] = exc

        window = vals[t + 1:t + 1 + DD_WINDOW]
        complete = len(window) == DD_WINDOW
        ev["mdd"] = r4(window.min() / v - 1) if complete else None  # 1年以内の最大下落率
        ev["mup"] = r4(window.max() / v - 1) if complete else None  # 1年以内の最大上昇率

        # ブレイク日=100 とした推移(株価とTOPIX比)。整数(×10)で持って容量を減らす
        path, rel = [], []
        for off in PATH_OFFSETS:
            j = t + off
            if 0 <= j < n:
                path.append(round(vals[j] / v * 1000))
                if b is not None and not math.isnan(b[j]) and not math.isnan(b[t]):
                    rel.append(round((vals[j] / v) / (b[j] / b[t]) * 1000))
                else:
                    rel.append(None)
            else:
                path.append(None)
                rel.append(None)
        ev["path"] = path
        ev["rel"] = rel
        events.append(ev)
    return events


def weekly(s):
    """週足(金曜締め)の終値。日付は start から7日ずつなので値だけ持つ(取引のない週は null)"""
    w = s.resample("W-FRI").last()
    return w.index[0].strftime("%Y-%m-%d"), [None if math.isnan(v) else round(float(v), 1) for v in w]


def main():
    universe = load_universe()
    codes = [u["code"] for u in universe]
    close = download(codes + [BENCH[0]])

    bench = close[BENCH[0]].dropna() if BENCH[0] in close.columns else None
    if bench is not None:
        bench = drop_outliers(bench)
    else:
        print("TOPIX連動ETFを取得できなかったため、超過リターンは空になります", file=sys.stderr)

    stocks_dir = DATA_DIR / "stocks"
    stocks_dir.mkdir(parents=True, exist_ok=True)

    all_events = []
    stocks = []
    ok = 0
    for u in universe:
        code = u["code"]
        if code not in close.columns:
            continue
        s = drop_outliers(close[code].dropna())
        if len(s) < 50:
            continue
        ok += 1
        evs = find_events(s, bench)
        for ev in evs:
            ev["code"] = code
        all_events.extend(evs)

        vals = s.to_numpy()
        ath_idx = int(vals.argmax())
        last = float(vals[-1])
        stocks.append({
            "code": code,
            "name": u["name"],
            "market_cap": u["market_cap"],
            "first_date": s.index[0].strftime("%Y-%m-%d"),
            "last_date": s.index[-1].strftime("%Y-%m-%d"),
            "last": round(last, 2),
            "ath": round(float(vals[ath_idx]), 2),
            "ath_date": s.index[ath_idx].strftime("%Y-%m-%d"),
            "from_ath": r4(last / vals[ath_idx] - 1),  # 最高値から何%下にいるか
            "days": len(s),
            "events": len(evs),
        })
        wk_start, wk = weekly(s)
        (stocks_dir / f"{code}.json").write_text(
            json.dumps({"code": code, "name": u["name"], "start": wk_start, "weekly": wk,
                        "events": [ev["date"] for ev in evs]},
                       ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )

    print(f"{ok}/{len(universe)} 銘柄を取得、ブレイク {len(all_events)} 件")
    if ok < len(universe) * MIN_OK_RATIO:
        print("取得できた銘柄が少なすぎるため events.json を更新しません", file=sys.stderr)
        sys.exit(1)

    all_events.sort(key=lambda e: (e["date"], e["code"]))
    out = {
        "generated_at": datetime.now(JST).isoformat(timespec="minutes"),
        "source": "Yahoo Finance (yfinance)",
        "benchmark": BENCH[1] if bench is not None else None,
        "rules": {"min_history": MIN_HISTORY, "min_gap": MIN_GAP, "universe": len(universe)},
        "horizons": HORIZONS,
        "path_offsets": PATH_OFFSETS,
        "stocks": stocks,
        "events": all_events,
    }
    # 1件1行にして差分を読みやすくする
    head = {k: v for k, v in out.items() if k not in ("stocks", "events")}
    lines = ["{"]
    lines += [f"  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False, separators=(',', ':'))}," for k, v in head.items()]
    for key in ("stocks", "events"):
        lines.append(f'  "{key}": [')
        lines.append(",\n".join("    " + json.dumps(x, ensure_ascii=False, separators=(",", ":")) for x in out[key]))
        lines.append("  ]," if key == "stocks" else "  ]")
    lines.append("}")
    (DATA_DIR / "events.json").write_text("\n".join(lines) + "\n", encoding="utf-8")

    # 対象から外れた銘柄のチャートファイルを消す
    keep = {f"{s['code']}.json" for s in stocks}
    for f in stocks_dir.glob("*.json"):
        if f.name not in keep:
            f.unlink()
    print(f"wrote {DATA_DIR / 'events.json'}")


if __name__ == "__main__":
    main()
