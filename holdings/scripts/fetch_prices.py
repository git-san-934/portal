"""持ち株(../data/check.json に載っている銘柄)の過去1年の日次終値を
yfinance(Yahoo Finance)から取得し、../data/prices.json に書き出す。

GitHub Actions(.github/workflows/update-holdings.yml)から定期実行される。
取得に失敗した銘柄があるときは既存の prices.json を上書きせずに終了コード1で終わる。
"""

import json
import math
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yfinance as yf

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
CHECK_PATH = DATA_DIR / "check.json"
OUT_PATH = DATA_DIR / "prices.json"

MIN_ROWS = 100  # これより少ない銘柄があれば取得失敗とみなす
# 前後の値の中央値からこの倍率以上離れた値は Yahoo 側の誤データとして捨てる
OUTLIER_WINDOW = 11
OUTLIER_RATIO = 2.0
RETRIES = 3
JST = timezone(timedelta(hours=9))


def load_codes():
    check = json.loads(CHECK_PATH.read_text(encoding="utf-8"))
    return [(s["code"], s["name"]) for s in check["stocks"]]


def download(codes):
    tickers = [f"{code}.T" for code, _ in codes]
    last_err = None
    for attempt in range(1, RETRIES + 1):
        try:
            df = yf.download(
                tickers,
                period="1y",
                interval="1d",
                auto_adjust=False,  # 終値は株式分割のみ調整(配当は調整しない)
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


def to_num(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return round(float(v), 2)


def main():
    codes = load_codes()
    close = download(codes)
    close = close.dropna(how="all").sort_index()
    dates = [d.strftime("%Y-%m-%d") for d in close.index]

    stocks = []
    problems = []
    for code, name in codes:
        col = f"{code}.T"
        if col not in close.columns:
            problems.append(f"{code}: no column")
            continue
        values = [to_num(v) for v in drop_outliers(close[col].dropna()).reindex(close.index).tolist()]
        n = sum(v is not None for v in values)
        print(f"{code} {name}: {n} rows, last={next((v for v in reversed(values) if v is not None), None)}")
        if n < MIN_ROWS:
            problems.append(f"{code}: only {n} rows")
        stocks.append({"code": code, "close": values})

    if problems:
        print("取得に問題があったため prices.json を更新しません:", *problems, sep="\n  ", file=sys.stderr)
        sys.exit(1)

    generated_at = datetime.now(JST).isoformat(timespec="minutes")
    # 1銘柄1行にして、日々の差分を小さく・読みやすくする
    lines = [
        "{",
        f"  \"generated_at\": {json.dumps(generated_at)},",
        '  "source": "Yahoo Finance (yfinance)",',
        f"  \"dates\": {json.dumps(dates, separators=(',', ':'))},",
        '  "stocks": [',
        ",\n".join("    " + json.dumps(s, separators=(",", ":")) for s in stocks),
        "  ]",
        "}",
    ]
    OUT_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {OUT_PATH} ({len(dates)} dates, {len(stocks)} stocks)")


if __name__ == "__main__":
    main()
