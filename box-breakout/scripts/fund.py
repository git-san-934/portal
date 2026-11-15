"""本の「ファンダメンタルズ確認の4つのポイント」を Yahoo Finance の決算で判定する.

① 1年ごとの業績の安定性: 前の年も営業利益が+5%以上
② 直近の通期営業利益が+20%以上(理想は+30%)
③ 直近の四半期の営業利益が前年同期比+20%以上、売上高が+10%以上(最も重要)
④ 通期の売上高営業利益率が前の年より改善
"""
import time
import numpy as np, pandas as pd, yfinance as yf


def _row(df, name):
    return df.loc[name] if df is not None and not df.empty and name in df.index else None


def fundamentals(ticker):
    t = yf.Ticker(ticker)
    a, q = t.income_stmt, t.quarterly_income_stmt
    f = {}
    o, s = _row(a, "Operating Income"), _row(a, "Total Revenue")
    if o is not None:
        cols = sorted(c for c in a.columns if pd.notna(o[c]))
        ov = [float(o[c]) for c in cols]
        sv = [float(s[c]) if s is not None and pd.notna(s[c]) else np.nan for c in cols]
        g = [ov[i] / ov[i - 1] - 1 if ov[i - 1] > 0 else None for i in range(1, len(ov))]
        if g:
            f["a_op_g"] = g[-1]; f["a_period"] = str(cols[-1].date())
        if len(g) >= 2: f["a_op_g2"] = g[-2]
        if len(ov) >= 2 and sv[-1] and sv[-2] and not np.isnan(sv[-1]) and not np.isnan(sv[-2]):
            f["margin_up"] = ov[-1] / sv[-1] > ov[-2] / sv[-2]
    o, s = _row(q, "Operating Income"), _row(q, "Total Revenue")
    if o is not None and s is not None:
        for c in sorted(q.columns, reverse=True):
            p = [k for k in q.columns if abs((c - k).days - 365) <= 20]
            if not p: continue
            p = p[0]
            if pd.notna(s[c]) and pd.notna(s[p]) and s[p] > 0 and pd.notna(o[c]) and pd.notna(o[p]):
                f["q_sales_g"] = float(s[c] / s[p] - 1)
                f["q_op_g"] = float(o[c] / o[p] - 1) if o[p] > 0 else None
                f["q_period"] = str(c.date())
                if o[p] <= 0 and o[c] > 0: f["q_note"] = "黒字転換"
                break
    ok = lambda v, th: v is not None and v >= th
    f["c1"] = ok(f.get("a_op_g2"), 0.05)
    f["c2"] = ok(f.get("a_op_g"), 0.20)
    f["c3"] = ok(f.get("q_op_g"), 0.20) and ok(f.get("q_sales_g"), 0.10)
    f["c4"] = bool(f.get("margin_up"))
    f["score"] = int(f["c1"]) + int(f["c2"]) + int(f["c3"]) + int(f["c4"])
    return f


def add_fundamentals(items):
    cache = {}
    for it in items:
        code = it["code"]
        if code not in cache:
            for a in range(3):
                try:
                    cache[code] = fundamentals(code + ".T"); break
                except Exception as e:
                    print("fund error", code, e, flush=True); time.sleep(10 * (a + 1))
            else:
                cache[code] = {}
            time.sleep(0.3)
        for k, v in cache[code].items():
            it[k] = round(v, 4) if isinstance(v, float) else v
