"""東証全銘柄のボックス上放れシグナルを判定して box-breakout/data/result.json に書き出す."""
import io, json, os, re, sys, time, datetime as dt
import numpy as np, pandas as pd, requests, yfinance as yf
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from box import scan, RULE
from fund import add_fundamentals

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
MARKETS = ["プライム（内国株式）", "スタンダード（内国株式）", "グロース（内国株式）"]
JST = dt.timezone(dt.timedelta(hours=9))
HOLD_DAYS = 365
# 2026-11-15 に過去5年の東証全銘柄で検証した結果(同じルール)
BACKTEST = ("過去5年（2022〜2026年）の東証全銘柄での検証：取引2,815回、勝率52%、平均損益+11.9%"
            "（平均の勝ち+34.0%・平均の負け-12.1%）、平均保有156日。同じ期間に TOPIX を持った場合より平均1.5%低い結果でした。"
            "上場廃止の銘柄は含まないため、実際より良く出ている可能性があります。"
            "業績で絞った検証では、通期の営業利益+20%以上かつ利益率改善の銘柄に限ると平均+11.2%（TOPIX比-0.7%）、減益の銘柄は平均+8.6%（TOPIX比-3.8%）でした。")   # この日数以内に買いシグナルが出て、まだ保有中の銘柄を表示する


def universe():
    html = requests.get("https://www.jpx.co.jp/markets/statistics-equities/misc/01.html", timeout=60).text
    path = re.search(r'href="([^"]*data_j\.xlsx)"', html).group(1)
    d = pd.read_excel(io.BytesIO(requests.get("https://www.jpx.co.jp" + path, timeout=120).content), dtype=str)
    d = d[d["市場・商品区分"].isin(MARKETS)]
    return d[["コード", "銘柄名", "市場・商品区分", "33業種区分"]].reset_index(drop=True)


def prices(tickers, batch=150):
    frames = []
    for i in range(0, len(tickers), batch):
        for a in range(4):
            try:
                frames.append(yf.download(tickers[i:i + batch], period="2y", interval="1d", auto_adjust=True,
                                          group_by="ticker", threads=True, progress=False)); break
            except Exception as e:
                print("download error", i, e, flush=True); time.sleep(20 * (a + 1))
        print(f"prices {min(i + batch, len(tickers))}/{len(tickers)}", flush=True); time.sleep(2)
    return pd.concat(frames, axis=1)


def r(x, nd=1):
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), nd)


def main():
    uni = universe(); print("universe", len(uni), flush=True)
    px = prices([c + ".T" for c in uni["コード"]])
    have = set(px.columns.get_level_values(0))
    buys, holds, watch, last_date = [], [], [], None
    for _, u in uni.iterrows():
        t = u["コード"] + ".T"
        if t not in have: continue
        d = px[t].dropna(subset=["Close"])
        if len(d) < 300: continue
        last_date = max(last_date or d.index[-1], d.index[-1])
        if d.index[-1] < last_date - pd.Timedelta(days=7): continue
        res = scan(d.Open.values, d.High.values, d.Low.values, d.Close.values, d.Volume.values.astype(float))
        c = float(d.Close.iloc[-1]); idx = d.index
        base = dict(code=u["コード"], name=u["銘柄名"], market=u["市場・商品区分"].replace("（内国株式）", ""),
                    sector=u["33業種区分"], last=r(c))
        s = d.Close.iloc[-260:]
        chart = dict(dates=[str(x.date()) for x in s.index], close=[r(x) for x in s.values])
        if res["signal"]:
            g = res["signal"]
            buys.append(dict(base, box_top=r(g["box_top"]), box_bot=r(g["box_bot"]), width=r(g["width"], 4),
                             box_days=g["box_days"], stop=r(g["stop"]), above_top=r(c / g["box_top"] - 1, 4),
                             box_start=str(idx[g["signal_i"] - g["box_days"]].date()), chart=chart))
        if res["pos"]:
            p = res["pos"]
            if (idx[-1] - idx[p["i"]]).days <= HOLD_DAYS:
                holds.append(dict(base, entry_date=str(idx[p["i"]].date()), entry=r(p["entry"]), stop=r(p["stop"]),
                                  ret=r(c / p["entry"] - 1, 4), to_stop=r(p["stop"] / c - 1, 4), n_boxes=p["n_boxes"],
                                  sell_signal=bool(p.get("sell_signal"))))
        if res["box"] and res["box"]["confirmed"] and res["box"]["turnover"] >= RULE["min_turnover"]:
            b = res["box"]; width = (b["top"] - b["bot"]) / b["top"]; days = len(d) - 1 - b["top_i"]
            dist = b["top"] / c - 1
            if width <= RULE["width_max"] and dist <= 0.05:
                watch.append(dict(base, box_top=r(b["top"]), box_bot=r(b["bot"]), width=r(width, 4),
                                  box_days=days, to_top=r(dist, 4), ready=days >= RULE["min_box_days"]))
    watch_total = len(watch)
    watch.sort(key=lambda x: x["to_top"]); watch = watch[:60]
    print("fundamentals", len(buys) + len(holds) + len(watch), flush=True)
    add_fundamentals(buys + holds + watch)
    buys.sort(key=lambda x: x["width"]); holds.sort(key=lambda x: x["entry_date"], reverse=True)
    watch.sort(key=lambda x: (-x.get("score", 0), x["to_top"]))
    price_date = str(last_date.date())
    out = dict(generated_at=dt.datetime.now(JST).strftime("%Y-%m-%d %H:%M"), price_date=price_date,
               universe=len(uni), rule=RULE, backtest=BACKTEST, buys=buys, holds=holds, watch=watch, watch_total=watch_total)
    os.makedirs(DATA, exist_ok=True)
    json.dump(out, open(os.path.join(DATA, "result.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    hp = os.path.join(DATA, "history.json")
    hist = json.load(open(hp, encoding="utf-8")) if os.path.exists(hp) else []
    hist = [x for x in hist if x["price_date"] != price_date]
    hist.append(dict(price_date=price_date, buys=[dict(code=b["code"], name=b["name"]) for b in buys],
                     sells=[dict(code=h["code"], name=h["name"]) for h in holds if h["sell_signal"]]))
    hist.sort(key=lambda x: x["price_date"])
    json.dump(hist[-120:], open(hp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("buys", len(buys), "holds", len(holds), "sell signals", sum(h["sell_signal"] for h in holds), "watch", len(watch))


if __name__ == "__main__":
    main()
