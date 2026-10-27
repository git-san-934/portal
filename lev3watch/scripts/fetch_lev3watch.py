"""3倍ブル見張り台のデータを yfinance(Yahoo Finance)から取得し、../data/lev3watch.json に書き出す。

- 案1: SPY の終値と200日平均。終値が平均の+3%を超えたら「持つ(UPRO)」、−3%を下回ったら「現金」。
  そのあいだは前の状態を続ける(過去全期間をさかのぼって状態を決める)。
- 案2: 米国株指数の3倍ブル5本の、過去1年の最高値からの下落率。

GitHub Actions(.github/workflows/update-lev3watch.yml)から平日に定期実行される。
SPY が取れなければ上書きせずに終了コード1で終わる。3倍ブルが取れなかった銘柄は前回の値を残す。
過去の検証結果(data/history.json)は固定で、このスクリプトでは変更しない。
"""

import json
import math
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yfinance as yf

SIGNAL = "SPY"
FUNDS = ["TQQQ", "UPRO", "UDOW", "TNA", "MIDU"]
MA_DAYS = 200
BAND = 0.03  # 200日平均から ±3%
YEAR = 252  # 1年 = 252営業日
KEEP = 756  # ページに載せる日数(約3年)
RETRIES = 3
OUTLIER_WINDOW = 11
OUTLIER_RATIO = 2.5
OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "lev3watch.json"
JST = timezone(timedelta(hours=9))


def download():
    last_err = None
    for attempt in range(1, RETRIES + 1):
        try:
            df = yf.download(
                [SIGNAL, *FUNDS],
                period="max",
                interval="1d",
                auto_adjust=False,  # 終値は株式分割・併合のみ調整(分配金は調整しない)
                actions=False,
                progress=False,
                threads=True,
            )
            if not df.empty:
                return df["Close"]
            last_err = "empty result"
        except Exception as e:  # noqa: BLE001 — yfinance は色々な例外を投げる
            last_err = e
        print(f"download attempt {attempt} failed: {last_err}", file=sys.stderr)
        time.sleep(10 * attempt)
    raise RuntimeError(f"download failed: {last_err}")


def drop_outliers(series):
    med = series.rolling(OUTLIER_WINDOW, center=True, min_periods=3).median()
    ratio = series / med
    bad = (ratio > OUTLIER_RATIO) | (ratio < 1 / OUTLIER_RATIO)
    for d, v in series[bad].items():
        print(f"  outlier dropped: {d.date()} {v}")
    return series.mask(bad)


def r(v, n):
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else round(float(v), n)


def signal_states(price, ma):
    """1 = 持つ(UPRO)、0 = 現金。±3%の帯の中では前日の状態を続ける。"""
    st, cur = [], 0
    for p, m in zip(price, ma):
        if not math.isnan(m):
            if p > m * (1 + BAND):
                cur = 1
            elif p < m * (1 - BAND):
                cur = 0
        st.append(cur)
    return st


def main():
    old = json.loads(OUT_PATH.read_text(encoding="utf-8")) if OUT_PATH.exists() else {}
    close = download().sort_index()

    if SIGNAL not in close.columns or close[SIGNAL].dropna().size < MA_DAYS + KEEP:
        print(f"{SIGNAL} が取得できなかったため lev3watch.json を更新しません", file=sys.stderr)
        sys.exit(1)
    spy = drop_outliers(close[SIGNAL].dropna()).dropna()
    ma = spy.rolling(MA_DAYS).mean()
    st = signal_states(spy.tolist(), ma.tolist())
    days = spy.index[-KEEP:]
    tail = slice(-KEEP, None)
    print(f"{SIGNAL}: {days[-1].date()} close={spy.iloc[-1]:.2f} ma200={ma.iloc[-1]:.2f} state={st[-1]}")

    old_dd = old.get("dd", {})
    old_pos = {d: i for i, d in enumerate(old_dd.get("d", []))}
    dd, failed = {"d": [d.strftime("%Y-%m-%d") for d in days]}, []
    for t in FUNDS:
        s = drop_outliers(close[t].dropna()).dropna() if t in close.columns else None
        if s is None or s.size < YEAR:
            failed.append(t)
            # 前回の値を日付で合わせて残す
            prev = old_dd.get(t, [])
            dd[t] = [prev[old_pos[d]] if d in old_pos and old_pos[d] < len(prev) else None for d in dd["d"]]
            continue
        hi = s.rolling(YEAR, min_periods=1).max()
        x = (s / hi - 1).reindex(days).ffill()
        dd[t] = [r(v, 3) for v in x.tolist()]
        print(f"{t}: dd1y={dd[t][-1]:+.1%}")
    if failed:
        print("取得できなかった銘柄(前回の値を残す):", failed, file=sys.stderr)

    out = {
        "generated_at": datetime.now(JST).isoformat(timespec="minutes"),
        "source": "Yahoo Finance (yfinance)",
        "asof": dd["d"][-1],
        "spy": {
            "d": dd["d"],
            "p": [r(v, 2) for v in spy.iloc[tail].tolist()],
            "ma": [r(v, 2) for v in ma.iloc[tail].tolist()],
            "st": st[-KEEP:],
        },
        "dd": dd,
        "stale": failed,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {OUT_PATH}")


if __name__ == "__main__":
    main()
