"""業種別ETF(NEXT FUNDS TOPIX-17 シリーズ + 東証銀行業)の過去5年の日次終値を
yfinance(Yahoo Finance)から取得し、../data/etf.json に書き出す。

GitHub Actions(.github/workflows/update-sector-etf.yml)から定期実行される。
取得に失敗した銘柄があるときは既存の etf.json を上書きせずに終了コード1で終わる。
"""

import json
import math
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yfinance as yf

# (コード, 業種名, 正式名称) — 表示順もこの順
ETFS = [
    ("1617", "食品", "NEXT FUNDS 食品(TOPIX-17)上場投信"),
    ("1618", "エネルギー資源", "NEXT FUNDS エネルギー資源(TOPIX-17)上場投信"),
    ("1619", "建設・資材", "NEXT FUNDS 建設・資材(TOPIX-17)上場投信"),
    ("1620", "素材・化学", "NEXT FUNDS 素材・化学(TOPIX-17)上場投信"),
    ("1621", "医薬品", "NEXT FUNDS 医薬品(TOPIX-17)上場投信"),
    ("1622", "自動車・輸送機", "NEXT FUNDS 自動車・輸送機(TOPIX-17)上場投信"),
    ("1623", "鉄鋼・非鉄", "NEXT FUNDS 鉄鋼・非鉄(TOPIX-17)上場投信"),
    ("1624", "機械", "NEXT FUNDS 機械(TOPIX-17)上場投信"),
    ("1625", "電機・精密", "NEXT FUNDS 電機・精密(TOPIX-17)上場投信"),
    ("1626", "情報通信・サービスその他", "NEXT FUNDS 情報通信・サービスその他(TOPIX-17)上場投信"),
    ("1627", "電力・ガス", "NEXT FUNDS 電力・ガス(TOPIX-17)上場投信"),
    ("1628", "運輸・物流", "NEXT FUNDS 運輸・物流(TOPIX-17)上場投信"),
    ("1629", "商社・卸売", "NEXT FUNDS 商社・卸売(TOPIX-17)上場投信"),
    ("1630", "小売", "NEXT FUNDS 小売(TOPIX-17)上場投信"),
    ("1631", "銀行", "NEXT FUNDS 銀行(TOPIX-17)上場投信"),
    ("1632", "金融(除く銀行)", "NEXT FUNDS 金融(除く銀行)(TOPIX-17)上場投信"),
    ("1633", "不動産", "NEXT FUNDS 不動産(TOPIX-17)上場投信"),
    ("1615", "銀行業(東証)", "NEXT FUNDS 東証銀行業株価指数連動型上場投信"),
]

MIN_ROWS = 200  # これより少ない銘柄があれば取得失敗とみなす
RETRIES = 3
OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "etf.json"
JST = timezone(timedelta(hours=9))


def download():
    tickers = [f"{code}.T" for code, _, _ in ETFS]
    last_err = None
    for attempt in range(1, RETRIES + 1):
        try:
            df = yf.download(
                tickers,
                period="5y",
                interval="1d",
                auto_adjust=False,  # 終値は株式分割のみ調整(分配金は調整しない)
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


def to_num(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return round(float(v), 2)


def main():
    close = download()
    close = close.dropna(how="all").sort_index()
    dates = [d.strftime("%Y-%m-%d") for d in close.index]

    etfs = []
    problems = []
    for code, sector, name in ETFS:
        col = f"{code}.T"
        if col not in close.columns:
            problems.append(f"{code}: no column")
            continue
        values = [to_num(v) for v in close[col].tolist()]
        n = sum(v is not None for v in values)
        print(f"{code} {sector}: {n} rows, last={next((v for v in reversed(values) if v is not None), None)}")
        if n < MIN_ROWS:
            problems.append(f"{code}: only {n} rows")
        etfs.append({"code": code, "sector": sector, "name": name, "close": values})

    if problems:
        print("取得に問題があったため etf.json を更新しません:", *problems, sep="\n  ", file=sys.stderr)
        sys.exit(1)

    out = {
        "generated_at": datetime.now(JST).isoformat(timespec="minutes"),
        "source": "Yahoo Finance (yfinance)",
        "dates": dates,
        "etfs": etfs,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    # 1銘柄1行にして、日々の差分を小さく・読みやすくする
    lines = [
        "{",
        f'  "generated_at": {json.dumps(out["generated_at"])},',
        f'  "source": {json.dumps(out["source"])},',
        f'  "dates": {json.dumps(dates, separators=(",", ":"))},',
        '  "etfs": [',
        ",\n".join("    " + json.dumps(e, ensure_ascii=False, separators=(",", ":")) for e in etfs),
        "  ]",
        "}",
    ]
    OUT_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {OUT_PATH} ({len(dates)} dates, {len(etfs)} ETFs)")


if __name__ == "__main__":
    main()
