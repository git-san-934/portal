"""持ち株(../data/holdings.json に載っている銘柄)の過去1年の日次終値を
yfinance(Yahoo Finance)から取得し、../data/prices.json に書き出す。
holdings.json はページの「銘柄リストの編集」から書き換わる。無いときは check.json の銘柄を使う。

日本株は ticker を省略すると "<code>.T"。米国株などは holdings.json に
"ticker"(例: "ORCL")と "currency"(例: "USD")を書く。円以外の銘柄があれば
円換算用の為替レート(例: USDJPY=X)の終値も fx に書き出す。

GitHub Actions(.github/workflows/update-holdings.yml)から定期実行される。
取得に失敗した銘柄があるときは既存の prices.json を上書きせずに終了コード1で終わる。
ただし前回の prices.json に無い(新しく追加された)銘柄が取れないときは、コードの打ち間違いの
可能性があるので、その銘柄だけ外して "missing" に書き、ほかの銘柄は更新する。
"""

import json
import math
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
CHECK_PATH = DATA_DIR / "check.json"
LIST_PATH = DATA_DIR / "holdings.json"
OUT_PATH = DATA_DIR / "prices.json"

MIN_ROWS = 100  # これより少ない銘柄があれば取得失敗とみなす
# 前後の値の中央値からこの倍率以上離れた値は Yahoo 側の誤データとして捨てる
OUTLIER_WINDOW = 11
OUTLIER_RATIO = 2.0
RETRIES = 3
JST = timezone(timedelta(hours=9))


def load_codes():
    """(code, name, yfinance のティッカー, 通貨) の一覧"""
    path = LIST_PATH if LIST_PATH.exists() else CHECK_PATH
    stocks = json.loads(path.read_text(encoding="utf-8"))["stocks"]
    return [
        (s["code"], s["name"], s.get("ticker") or f"{s['code']}.T", s.get("currency") or "JPY")
        for s in stocks
    ]


def previous_rows():
    """前回の prices.json に載っていた銘柄ごとの行数(新しく追加された銘柄や、上場1年未満の銘柄の見分けに使う)"""
    try:
        stocks = json.loads(OUT_PATH.read_text(encoding="utf-8"))["stocks"]
        return {s["code"]: sum(v is not None for v in s["close"]) for s in stocks}
    except (OSError, ValueError, KeyError, TypeError):
        return None


def fx_ticker(currency):
    return f"{currency}JPY=X"


def download(tickers):
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


def count_rows(close, col):
    return int(close[col].notna().sum()) if col in close.columns else 0


def download_all(tickers):
    """全銘柄をまとめて取得し、Yahoo 側の一時的な失敗で行数が足りない銘柄だけ取り直す"""
    close = download(tickers)
    if isinstance(close, pd.Series):  # 1銘柄だけのときは列名を付け直す
        close = close.to_frame(tickers[0])
    for attempt in range(1, RETRIES + 1):
        missing = [t for t in tickers if count_rows(close, t) < MIN_ROWS]
        if not missing:
            break
        print(f"retry {attempt} for {missing}", file=sys.stderr)
        time.sleep(5 * attempt)
        try:
            again = download(missing)
        except RuntimeError as e:
            print(f"  {e}", file=sys.stderr)
            continue
        if isinstance(again, pd.Series):
            again = again.to_frame(missing[0])
        for t in missing:
            if count_rows(again, t) > count_rows(close, t):
                close = close.drop(columns=t, errors="ignore").join(again[[t]], how="outer")
    return close


def main():
    codes = load_codes()
    currencies = sorted({cur for *_, cur in codes if cur != "JPY"})
    fx_cols = [fx_ticker(cur) for cur in currencies]
    close = download_all([t for _, _, t, _ in codes] + fx_cols)
    # 東証と米国市場で休場日が違うため、どちらかが取引した日を日付に並べ、取引のない日は null
    stock_cols = [t for _, _, t, _ in codes]
    close = close.dropna(how="all", subset=[c for c in stock_cols if c in close.columns]).sort_index()
    dates = [d.strftime("%Y-%m-%d") for d in close.index]

    prev = previous_rows()
    stocks = []
    problems = []
    missing = []
    for code, name, col, currency in codes:
        if col not in close.columns:
            values, n = [], 0
        else:
            values = [to_num(v) for v in drop_outliers(close[col].dropna()).reindex(close.index).tolist()]
            n = sum(v is not None for v in values)
        print(f"{code} {name}: {n} rows, last={next((v for v in reversed(values) if v is not None), None)}")
        if n == 0 and prev is not None and code not in prev:
            # 新しく追加した銘柄が1日分も取れない: コード違いの可能性。ほかの銘柄の更新は止めない
            print(f"  {code}: 新しい銘柄の株価が取れないため外します(ティッカー {col})", file=sys.stderr)
            missing.append(code)
            continue
        # 上場から1年未満の銘柄は行数が少ない。新しく追加した銘柄は1日分でもあれば載せ、
        # 前回も載っていた銘柄は前回の行数(最大 MIN_ROWS)を下回ったときだけ取得失敗とみなす
        if prev is not None and code not in prev:
            need = 1
        else:
            need = min(MIN_ROWS, prev[code]) if prev else MIN_ROWS
        if n < need:
            problems.append(f"{code}: only {n} rows (need {need})")
        entry = {"code": code, "close": values}
        if currency != "JPY":
            entry["currency"] = currency
        stocks.append(entry)

    # 円換算用: 通貨ごとの直近レートとその日付
    fx = {}
    for cur, col in zip(currencies, fx_cols):
        series = close[col].dropna() if col in close.columns else pd.Series(dtype=float)
        if series.empty:
            problems.append(f"{col}: no data")
            continue
        fx[f"{cur}JPY"] = {"rate": round(float(series.iloc[-1]), 3), "date": series.index[-1].strftime("%Y-%m-%d")}
        print(f"{col}: {fx[f'{cur}JPY']}")

    if problems:
        print("取得に問題があったため prices.json を更新しません:", *problems, sep="\n  ", file=sys.stderr)
        sys.exit(1)

    generated_at = datetime.now(JST).isoformat(timespec="minutes")
    # 1銘柄1行にして、日々の差分を小さく・読みやすくする
    lines = [
        "{",
        f"  \"generated_at\": {json.dumps(generated_at)},",
        '  "source": "Yahoo Finance (yfinance)",',
        *([f"  \"fx\": {json.dumps(fx, separators=(',', ':'))},"] if fx else []),
        *([f"  \"missing\": {json.dumps(missing)},"] if missing else []),
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
