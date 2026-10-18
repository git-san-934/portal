"""米国上場の3倍ブルETF/ETNの日次終値を yfinance(Yahoo Finance)から取得し、
過去1年の最高値からの下落率などを ../data/lev3x.json に書き出す。

GitHub Actions(.github/workflows/update-lev3x.yml)から平日に定期実行される。
取得できなかった銘柄は前回の値を残し、stale として印をつける。半分以上取れなければ上書きせずに終了コード1で終わる。
"""

import json
import math
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yfinance as yf

# (ティッカー, 対象, 種類) — 種類は ETF か ETN
FUNDS = [
    ("TQQQ", "ナスダック100", "ETF"),
    ("UPRO", "S&P500", "ETF"),
    ("SPXL", "S&P500", "ETF"),
    ("UDOW", "ダウ30", "ETF"),
    ("TNA", "米小型株", "ETF"),
    ("URTY", "ラッセル2000", "ETF"),
    ("MIDU", "米中型株", "ETF"),
    ("UMDD", "米中型株", "ETF"),
    ("HIBL", "S&P500高ベータ", "ETF"),
    ("SOXL", "半導体", "ETF"),
    ("TECL", "テクノロジー", "ETF"),
    ("FNGU", "FANG+", "ETN"),
    ("BULZ", "FANG+イノベーション", "ETN"),
    ("WEBL", "インターネット", "ETF"),
    ("LABU", "バイオ", "ETF"),
    ("CURE", "ヘルスケア", "ETF"),
    ("FAS", "金融", "ETF"),
    ("DPST", "地方銀行", "ETF"),
    ("BNKU", "米大手銀行", "ETN"),
    ("NAIL", "住宅建設", "ETF"),
    ("DRN", "不動産", "ETF"),
    ("WANT", "一般消費財", "ETF"),
    ("RETL", "小売", "ETF"),
    ("DUSL", "資本財", "ETF"),
    ("TPOR", "運輸", "ETF"),
    ("DFEN", "防衛・航空宇宙", "ETF"),
    ("UTSL", "公益", "ETF"),
    ("OILU", "石油・ガス開発", "ETN"),
    ("GDXU", "金鉱株", "ETN"),
    ("TMF", "米国債20年超", "ETF"),
    ("TYD", "米国債7-10年", "ETF"),
    ("YINN", "中国株", "ETF"),
    ("KORU", "韓国株", "ETF"),
    ("EDC", "新興国株", "ETF"),
    ("EURL", "欧州株", "ETF"),
    ("MEXX", "メキシコ株", "ETF"),
]

YEAR = 252  # 1年 = 252営業日
WIN20 = 20
SPARK = 260  # ページの小さなチャート用に残す日数
RETRIES = 3
# 前後の値の中央値からこの倍率以上離れた値は Yahoo 側の誤データとして捨てる
OUTLIER_WINDOW = 11
OUTLIER_RATIO = 2.5
OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "lev3x.json"
JST = timezone(timedelta(hours=9))


def download():
    tickers = [t for t, _, _ in FUNDS]
    last_err = None
    for attempt in range(1, RETRIES + 1):
        try:
            df = yf.download(
                tickers,
                period="2y",
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


def r2(v):
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else round(float(v), 4 if abs(v) < 1 else 2)


def summarize(s):
    """s: 日付順の終値(pandas Series, NaNなし)。"""
    if len(s) < WIN20 + 1:
        return None
    last_d, last = s.index[-1], float(s.iloc[-1])
    prev = float(s.iloc[-2])
    y = s.iloc[-YEAR:]
    hi_d = y.idxmax()
    return {
        "date": last_d.strftime("%Y-%m-%d"),
        "close": r2(last),
        "chg": round(last / prev - 1, 4),
        "high1y": r2(y.max()),
        "high1y_date": hi_d.strftime("%Y-%m-%d"),
        "low1y": r2(y.min()),
        "dd1y": round(last / float(y.max()) - 1, 4),
        "dd20": round(last / float(s.iloc[-WIN20:].max()) - 1, 4),
        "spark": [r2(v) for v in s.iloc[-SPARK:].tolist()],
    }


def main():
    old = {}
    if OUT_PATH.exists():
        old = {f["ticker"]: f for f in json.loads(OUT_PATH.read_text(encoding="utf-8")).get("funds", [])}
    close = download().sort_index()
    funds, failed = [], []
    for t, target, kind in FUNDS:
        s = None
        if t in close.columns:
            s = drop_outliers(close[t].dropna()).dropna()
        info = summarize(s) if s is not None else None
        if info is None:
            failed.append(t)
            prev = old.get(t)
            if prev:
                funds.append({**prev, "stale": True})
            continue
        print(f"{t}: {info['date']} close={info['close']} dd1y={info['dd1y']:+.1%}")
        funds.append({"ticker": t, "target": target, "kind": kind, **info})

    if len(failed) > len(FUNDS) // 2:
        print("半分以上の銘柄が取得できなかったため lev3x.json を更新しません:", failed, file=sys.stderr)
        sys.exit(1)
    if failed:
        print("取得できなかった銘柄(前回の値を残す):", failed, file=sys.stderr)

    out = {
        "generated_at": datetime.now(JST).isoformat(timespec="minutes"),
        "source": "Yahoo Finance (yfinance)",
        "funds": funds,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    # 1銘柄1行にして、日々の差分を小さく・読みやすくする
    lines = [
        "{",
        f'  "generated_at": {json.dumps(out["generated_at"])},',
        f'  "source": {json.dumps(out["source"])},',
        '  "funds": [',
        ",\n".join("    " + json.dumps(f, ensure_ascii=False, separators=(",", ":")) for f in funds),
        "  ]",
        "}",
    ]
    OUT_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {OUT_PATH} ({len(funds)} funds, {len(failed)} failed)")


if __name__ == "__main__":
    main()
