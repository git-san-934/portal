"""投資分析ページ(cf/<コード>/)の銘柄の最新の終値を yfinance(Yahoo Finance)から取り、
../data/price.json に書き出す。「EPS・BPS・配当の推移」のグラフで、決算期末の株価の線を今の株価まで延ばすのに使う。

グラフの株価は最新の有価証券報告書の株数にそろえてある(報告書の提出までに効力が出た分割は、報告書の EPS に
織り込み済み)。報告書の提出日より後に株式分割・併合があった銘柄は、今の終値にその比率を掛けて同じ株数の
基準にそろえ、"price" に書く("close" は実際の終値)。

GitHub Actions(.github/workflows/update-cf-price.yml)から実行される。
半分以上の銘柄が取れないときは既存の price.json を上書きせずに終了コード1で終わる。
取れなかった銘柄は前回の値を残す。
"""

import json
import math
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

CF_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = CF_DIR / "data"
EPS_PATH = DATA_DIR / "eps.json"
DOCS_PATH = DATA_DIR / "eps_docs.json"
OUT_PATH = DATA_DIR / "price.json"
CHUNK = 50
JST = timezone(timedelta(hours=9))


def load(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def save(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n", encoding="utf-8")


def target_codes():
    return sorted(p.name for p in CF_DIR.iterdir() if p.is_dir() and re.fullmatch(r"\d{3}[0-9A-Z]", p.name) and (p / "index.html").exists())


def fy_end(ym):
    """"2026-03" → 2026-03-31"""
    y, m = int(ym[:4]), int(ym[5:7])
    return date(y + m // 12, m % 12 + 1, 1) - timedelta(days=1)


def column(df, ticker, name):
    try:
        s = df[ticker][name] if isinstance(df.columns, pd.MultiIndex) else df[name]
    except KeyError:
        return None
    return s.dropna()


def main():
    codes = target_codes()
    companies = load(EPS_PATH, {}).get("companies", {})
    # 最新の報告書の提出日(書類一覧の [提出日, 期末, 書類ID, …])。わからなければ決算期末
    submitted = {d[2]: date.fromisoformat(d[0]) for ds in load(DOCS_PATH, {}).get("docs", {}).values() for d in ds}
    ends = {}
    for c in codes:
        e = companies.get(c, {})
        if e.get("years"):
            ends[c] = max(fy_end(e["years"][-1]), submitted.get((e.get("read") or [None])[0], date.min))
    # 分割を見落とさないよう、いちばん古い基準日から取る
    start = min(ends.values(), default=date.today() - timedelta(days=30)) - timedelta(days=5)
    prices = {}
    for i in range(0, len(codes), CHUNK):
        part = codes[i:i + CHUNK]
        tickers = [f"{c}.T" for c in part]
        df = yf.download(tickers, start=start.isoformat(), actions=True, auto_adjust=False,
                         progress=False, group_by="ticker", threads=True)
        for c, t in zip(part, tickers):
            close = column(df, t, "Close")
            if close is None or close.empty or not math.isfinite(close.iloc[-1]):
                continue
            ratio = 1.0
            splits = column(df, t, "Stock Splits")
            if splits is not None and c in ends:
                for d, r in splits.items():
                    if r and r > 0 and d.date() > ends[c]:
                        ratio *= float(r)
                        print(f"{c}: {d.date()} に分割・併合 {r} (報告書 {ends[c]} より後)")
            v = float(close.iloc[-1])
            prices[c] = {"date": close.index[-1].date().isoformat(), "close": round(v, 2), "price": round(v * ratio, 2)}
            if ratio != 1:
                prices[c]["split"] = ratio

    print(f"{len(codes)} 銘柄のうち {len(prices)} 銘柄の終値を取りました")
    if len(prices) < len(codes) / 2:
        print("取れた銘柄が少ないので price.json を更新しません", file=sys.stderr)
        sys.exit(1)
    old = load(OUT_PATH, {}).get("prices", {})
    missing = [c for c in codes if c not in prices]
    for c in missing:
        if c in old:
            prices[c] = old[c]
    if missing:
        print("取れなかった銘柄(前回の値を残す): " + " ".join(missing))
    save(OUT_PATH, {"updated": datetime.now(JST).isoformat(timespec="minutes"), "prices": prices})


if __name__ == "__main__":
    main()
