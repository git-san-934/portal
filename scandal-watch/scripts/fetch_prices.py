"""不祥事のあった銘柄の、その後の株価の動きを計算する。

1. ../data/cases.json(手で調べて書いた不祥事の一覧)を読む
2. yfinance(Yahoo Finance)から、各銘柄と TOPIX連動ETF(1306)の日次終値(株式分割のみ調整)を取得する
3. 不祥事が知られた日の前日を基準に、1週間後・底値・半年後・1年後・現在の騰落率と TOPIX との差を計算する
4. ../data/prices.json に書き出す

GitHub Actions(.github/workflows/update-scandal-watch.yml)から定期実行される。
上場廃止などで株価が取れない銘柄は null にして、ほかの銘柄だけで続ける。
取得できた銘柄が少なすぎるときは既存のデータを上書きせずに終了コード1で終わる。
"""

import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

BENCH = "1306"  # TOPIX連動ETF
START = "2020-01-01"  # 直近5年の不祥事の1年前から取れれば足りる
HORIZONS = {"w1": 5, "m6": 120, "y1": 250}  # 約1週間後(公表が取引時間後でも反応を含むように) / 約半年後 / 約1年後(営業日)
BOTTOM_WINDOW = 120  # 底値を探す期間(営業日、約半年)
CHART_BEFORE = 250  # チャートに出す期間: 基準日の約1年前から
RETRIES = 3
MIN_OK_RATIO = 0.6  # 上場中の銘柄のうちこの割合以上取得できなければ失敗とみなす
SPLIT_DOWN = 0.6  # 1日でこれ未満・SPLIT_UP超の段差は株式分割の調整漏れとみなす(ath-breakout と同じ)
SPLIT_UP = 1.67

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
JST = timezone(timedelta(hours=9))


def download(codes):
    tickers = [f"{c}.T" for c in codes]
    last_err = None
    for attempt in range(1, RETRIES + 1):
        try:
            df = yf.download(
                tickers, start=START, interval="1d",
                auto_adjust=False,  # 終値は株式分割のみ調整(配当は調整しない)
                actions=False, progress=False, threads=True,
            )
            if not df.empty:
                close = df["Close"]
                if isinstance(close, pd.Series):
                    close = close.to_frame(tickers[0])
                close.columns = [str(c).removesuffix(".T") for c in close.columns]
                return close.sort_index()
            last_err = "empty result"
        except Exception as e:  # noqa: BLE001 — yfinance は色々な例外を投げる
            last_err = e
        print(f"download attempt {attempt} failed: {last_err}", file=sys.stderr)
        time.sleep(10 * attempt)
    raise RuntimeError(f"download failed: {last_err}")


def fix_splits(series):
    """分割の調整漏れで値が段差のように飛んでいるところは、それより前の値をまとめて掛け直す"""
    r = series / series.shift(1)
    factor = pd.Series(1.0, index=series.index)
    for d, v in r[(r < SPLIT_DOWN) | (r > SPLIT_UP)].items():
        factor[factor.index < d] *= v
    return series * factor


def r4(v):
    return None if v is None or pd.isna(v) else round(float(v), 4)


def pct(a, b):
    return r4(a / b - 1) if a is not None and b else None


def analyze(s, bench, date):
    """s, bench: 日付を index にした終値。date: 不祥事が知られた日(この前の営業日の終値を基準にする)"""
    s = s.dropna()
    before = s[s.index < pd.Timestamp(date)]
    if before.empty:
        return None
    base_i = len(before) - 1
    base_date = s.index[base_i]
    base = float(s.iloc[base_i])
    b = bench.dropna().reindex(s.index).ffill()
    b_base = b.iloc[base_i]

    out = {"baseDate": base_date.strftime("%Y-%m-%d"), "base": round(base, 2), "moves": {}}
    for key, n in HORIZONS.items():
        i = base_i + n
        if i < len(s):
            p = pct(s.iloc[i], base)
            bp = pct(b.iloc[i], b_base)
            out["moves"][key] = {
                "date": s.index[i].strftime("%Y-%m-%d"),
                "ret": p,
                "excess": r4(p - bp) if p is not None and bp is not None else None,
            }
        else:
            out["moves"][key] = None

    after = s.iloc[base_i + 1: base_i + 1 + BOTTOM_WINDOW]
    if not after.empty:
        low_date = after.idxmin()
        out["bottom"] = {"date": low_date.strftime("%Y-%m-%d"), "ret": pct(after.min(), base)}
        # 底値から基準の株価まで戻ったか(戻った最初の日)
        rest = s[s.index > low_date]
        back = rest[rest >= base]
        out["recovered"] = back.index[0].strftime("%Y-%m-%d") if not back.empty else None
    else:
        out["bottom"] = None
        out["recovered"] = None

    last = float(s.iloc[-1])
    lp = pct(last, base)
    lb = pct(b.iloc[-1], b_base)
    out["latest"] = {
        "date": s.index[-1].strftime("%Y-%m-%d"),
        "close": round(last, 2),
        "ret": lp,
        "excess": r4(lp - lb) if lp is not None and lb is not None else None,
    }

    # 週足チャート(基準日=100)。株価と TOPIX を並べる
    w = s.iloc[max(0, base_i - CHART_BEFORE):]
    wb = b.reindex(w.index)
    weekly = pd.DataFrame({"p": w, "b": wb}).resample("W-FRI").last().dropna()
    out["chart"] = [
        [d.strftime("%Y-%m-%d"), round(row.p / base * 100, 1), round(row.b / b_base * 100, 1)]
        for d, row in weekly.iterrows()
    ]
    return out


def main():
    cases = json.loads((DATA_DIR / "cases.json").read_text(encoding="utf-8"))["cases"]
    codes = sorted({c["code"] for c in cases} | {BENCH})
    close = download(codes)

    if BENCH not in close or close[BENCH].dropna().empty:
        print("TOPIX連動ETF(1306)が取得できませんでした", file=sys.stderr)
        sys.exit(1)
    bench = fix_splits(close[BENCH].dropna())

    result = {}
    ok = 0
    listed = [c for c in cases if c.get("status") != "delisted"]
    for c in cases:
        s = close[c["code"]].dropna() if c["code"] in close else pd.Series(dtype=float)
        if s.empty:
            result[c["id"]] = None
            print(f"{c['code']} {c['name']}: 株価なし", file=sys.stderr)
            continue
        a = analyze(fix_splits(s), bench, c["date"])
        result[c["id"]] = a
        if a and c.get("status") != "delisted":
            ok += 1
        if a:
            m = a["moves"]
            y1 = m["y1"]["ret"] if m["y1"] else None
            print(f"{c['code']} {c['name']}: 1週間後 {m['w1']['ret'] if m['w1'] else None} "
                  f"底 {a['bottom']['ret'] if a['bottom'] else None} 1年後 {y1} 現在 {a['latest']['ret']}")

    if ok < len(listed) * MIN_OK_RATIO:
        print(f"取得できた銘柄が少なすぎます({ok}/{len(listed)})。上書きしません", file=sys.stderr)
        sys.exit(1)

    out = {
        "updated": datetime.now(JST).strftime("%Y-%m-%d %H:%M"),
        "bench": BENCH,
        "cases": result,
    }
    (DATA_DIR / "prices.json").write_text(
        json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"prices.json を書き出しました({ok}/{len(listed)} 銘柄)")


if __name__ == "__main__":
    main()
