"""カップウィズハンドル × 四半期業績(売上・営業利益 前年同期比+20%以上) スクリーニング.

1. JPX の東証上場銘柄一覧から プライム/スタンダード/グロース の内国株を取得
2. Yahoo Finance (yfinance) で2年分の日足を取得し、cwh.detect でパターン判定
3. パターンに該当した銘柄だけ四半期決算を取得し、前年同期比を計算
4. cup-handle/data/result.json と history.json を書き出す
"""
import io, json, os, sys, time, datetime as dt
import numpy as np, pandas as pd, requests, yfinance as yf
sys.path.insert(0, os.path.dirname(__file__))
from cwh import detect, P

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
JPX_PAGE = "https://www.jpx.co.jp/markets/statistics-equities/misc/01.html"
MARKETS = ["プライム（内国株式）", "スタンダード（内国株式）", "グロース（内国株式）"]
GROWTH_MIN = 0.20
JST = dt.timezone(dt.timedelta(hours=9))


def universe():
    import re
    html = requests.get(JPX_PAGE, timeout=60).text
    path = re.search(r'href="([^"]*data_j\.xlsx)"', html).group(1)
    xl = requests.get("https://www.jpx.co.jp" + path, timeout=120).content
    d = pd.read_excel(io.BytesIO(xl), dtype=str)
    d = d[d["市場・商品区分"].isin(MARKETS)]
    return d[["コード", "銘柄名", "市場・商品区分", "33業種区分"]].reset_index(drop=True)


def prices(tickers, batch=150):
    frames = []
    for i in range(0, len(tickers), batch):
        for attempt in range(4):
            try:
                df = yf.download(tickers[i:i + batch], period="2y", interval="1d", auto_adjust=True,
                                 group_by="ticker", threads=True, progress=False)
                frames.append(df); break
            except Exception as e:
                print("download error", i, e, flush=True); time.sleep(20 * (attempt + 1))
        print(f"prices {min(i + batch, len(tickers))}/{len(tickers)}", flush=True)
        time.sleep(2)
    return pd.concat(frames, axis=1)


def yoy(t):
    q = yf.Ticker(t).quarterly_income_stmt
    if q is None or q.empty:
        return dict(note="決算データなし")
    q = q[sorted(q.columns, reverse=True)]
    g = lambda name, col: float(q.loc[name, col]) if name in q.index and pd.notna(q.loc[name, col]) else None
    for col in q.columns:
        prev = [c for c in q.columns if abs((col - c).days - 365) <= 20]
        if not prev: continue
        s, s0 = g("Total Revenue", col), g("Total Revenue", prev[0])
        if s is None or s0 is None or s0 <= 0: continue
        o, o0 = g("Operating Income", col), g("Operating Income", prev[0])
        r = dict(quarter=str(col.date()), sales=s, sales_prev=s0, op=o, op_prev=o0,
                 sales_yoy=s / s0 - 1, op_yoy=None, note="")
        if o is not None and o0 is not None:
            if o0 > 0: r["op_yoy"] = o / o0 - 1
            elif o > 0: r["note"] = "営業黒字転換"
        return r
    return dict(note="前年同期データなし")


def main():
    uni = universe()
    print("universe", len(uni), flush=True)
    tick = [c + ".T" for c in uni["コード"]]
    px = prices(tick)
    have = set(px.columns.get_level_values(0))
    hits, last_date = [], None
    for _, u in uni.iterrows():
        t = u["コード"] + ".T"
        if t not in have: continue
        d = px[t].dropna(subset=["Close"])
        if len(d) == 0: continue
        last_date = max(last_date or d.index[-1], d.index[-1])
        r = detect(d["Close"].values, d["Volume"].values)
        if not r: continue
        s = d["Close"].iloc[-260:]
        rec = dict(code=u["コード"], name=u["銘柄名"], market=u["市場・商品区分"].replace("（内国株式）", ""),
                   sector=u["33業種区分"], status=r["status"], last=r["last"], pivot=r["pivot"],
                   dist_to_pivot=r["dist_to_pivot"], cup_days=r["cup_days"], cup_depth=r["cup_depth"],
                   handle_days=r["handle_days"], handle_depth=r["handle_depth"],
                   handle_vol_ratio=r["handle_vol_ratio"], above_ma200=bool(r["ma200_ok"]))
        for k in ("left_lip_i", "bottom_i", "right_lip_i"):
            rec[k.replace("_i", "_date")] = str(d.index[r[k]].date())
        rec["chart"] = dict(dates=[str(x.date()) for x in s.index], close=[round(float(x), 1) for x in s.values])
        hits.append(rec)
    print("pattern hits", len(hits), flush=True)
    for h in hits:
        for attempt in range(3):
            try: h.update(yoy(h["code"] + ".T")); break
            except Exception as e: print("fund error", h["code"], e); time.sleep(10)
        h["pass"] = bool(h.get("sales_yoy") is not None and h["sales_yoy"] >= GROWTH_MIN
                         and h.get("op_yoy") is not None and h["op_yoy"] >= GROWTH_MIN)
        time.sleep(0.5)
    hits.sort(key=lambda h: (not h["pass"], -(h.get("sales_yoy") or -9)))

    def clean(o):
        if isinstance(o, dict): return {k: clean(v) for k, v in o.items()}
        if isinstance(o, list): return [clean(v) for v in o]
        if isinstance(o, (np.floating, float)): return None if np.isnan(o) else round(float(o), 4)
        if isinstance(o, np.integer): return int(o)
        if isinstance(o, np.bool_): return bool(o)
        return o

    price_date = str(last_date.date()) if last_date is not None else None
    out = dict(generated_at=dt.datetime.now(JST).strftime("%Y-%m-%d %H:%M"), price_date=price_date,
               universe=len(uni), growth_min=GROWTH_MIN, params=P, stocks=hits)
    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, "result.json"), "w", encoding="utf-8") as f:
        json.dump(clean(out), f, ensure_ascii=False, separators=(",", ":"))
    hp = os.path.join(DATA, "history.json")
    hist = json.load(open(hp, encoding="utf-8")) if os.path.exists(hp) else []
    hist = [x for x in hist if x["price_date"] != price_date]
    hist.append(dict(price_date=price_date, passed=[dict(code=h["code"], name=h["name"]) for h in hits if h["pass"]],
                     pattern_hits=len(hits)))
    hist.sort(key=lambda x: x["price_date"])
    with open(hp, "w", encoding="utf-8") as f:
        json.dump(hist[-120:], f, ensure_ascii=False, indent=1)
    print("passed", [h["code"] for h in hits if h["pass"]])


if __name__ == "__main__":
    main()
