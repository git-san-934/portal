"""data/source.json から S&P 500 の日次 PER・PBR と買いの合図を計算して data/analysis.json を書く。

- PER = 終値 ÷ その日に使える最新の EPS(12か月合計、as reported)
- PBR = 終値 ÷ その日に使える最新の1株純資産
- 「使える」は四半期末の3か月後(または実際に取れた日)から。後から分かる値で判定しないため
- 買いの合図(売りの合図は出さない)は3種類。線は毎回 tune.py が過去のデータから選び直す(2026-11-11〜):
  - per20: PER が lo 倍を上から下に割った日。次の合図は PER が一度 lo+gap 倍を超えてから
  - perma: PER が PER の n 日移動平均の th 倍を下に割った日。次の合図は PER が移動平均の上に戻ってから
  - pbrma: PBR が PBR の n 日移動平均の th 倍を下に割った日。次の合図は PBR が移動平均の上に戻ってから
  - PBR の水準そのもの(固定の倍率)には線を置かない(2000年以降で上がり続けていて、成績が安定しなかった。README 参照)
- いま使っている線は前回の analysis.json から引き継ぎ、もっと良い線との差が小さいうちは変えない
- 成績: 合図の日から 365日後・1095日後の終値の変化率と、同じ期間に毎日買った場合の平均(配当は含めない)
- 「歩きながらの見直し」: 毎年1月1日に、その時点までに分かっていたデータだけで線を選び直して、
  その年の合図を出した場合の成績も計算する(線を後から選ぶと良く見えすぎるため、その確かめ)

標準ライブラリのみ。--check は計算だけして書かない。
"""
import bisect
import datetime as dt
import json
import os
import statistics as st
import sys

from tune import GRID, Tuner

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "data", "source.json")
OUT = os.path.join(HERE, "..", "data", "analysis.json")
CALC_FROM = "1976-01-01"  # 移動平均の助走のため、計算はここから
FROM = "1990-01-01"  # ページに出す期間と、合図・成績を数える期間
PBR_FROM = "2000-03-01"  # 1株純資産は1999年末から
WALK_FROM = (2005, 2012)  # 歩きながらの見直しの成績を数えはじめる年
# はじめて見直す前に使っていた線(2026-11-10 に手で決めたもの)
DEFAULT = {"per20": {"lo": 20, "gap": 3}, "perma": {"n": 250, "th": 0.85}, "pbrma": {"n": 500, "th": 0.95}}


def span(n):
    """営業日の数 → 「約1年」など"""
    m = round(n / 21)
    return f"約{m}か月" if m < 12 else ("約1年" if m < 15 else f"約{m / 12:.1f}年".replace(".0年", "年"))


def kinds(P):
    return {
        "per20": {"label": f"PER {P['per20']['lo']}倍割れ", "short": "PER"},
        "perma": {"label": f"PER が{span(P['perma']['n'])}平均の−{round((1 - P['perma']['th']) * 100)}%", "short": "PER平均"},
        "pbrma": {"label": f"PBR が{span(P['pbrma']['n'])}平均の−{round((1 - P['pbrma']['th']) * 100)}%", "short": "PBR平均"},
    }


def add(d, days):
    return (dt.date.fromisoformat(d) + dt.timedelta(days=days)).isoformat()


def pct_rank(arr, v):
    return sum(1 for a in arr if a < v) / len(arr)


def load_previous():
    try:
        with open(OUT, encoding="utf-8") as f:
            old = json.load(f)
    except (OSError, ValueError):
        return {}, []
    return old.get("params") or {}, old.get("tune_history") or []


def walk_forward(T, kind, D, C):
    """毎年1月1日に、それまでのデータだけで線を選び直して、その年の合図を出す"""
    cur, picks, sig = None, [], []
    for y in range(int(D[0][:4]) + 1, int(D[-1][:4]) + 1):
        end = bisect.bisect_left(D, f"{y}-01-01")
        p, _, _ = T.tune(kind, cur, end)
        if p is None:
            continue
        if p != cur:
            picks.append({"year": y, **p})
        cur = p
        nxt = bisect.bisect_left(D, f"{y + 1}-01-01")
        sig += [i for i in T.signals(kind, p, nxt)[0] if end <= i < nxt]
    out = {"picks": picks, "periods": []}
    for y0 in WALK_FROM:
        s0 = bisect.bisect_left(D, f"{y0}-01-01")
        f1 = [C[T.j1[i]] / C[i] - 1 for i in sig if i >= s0 and T.j1[i] < T.N]
        b1 = [C[T.j1[i]] / C[i] - 1 for i in range(s0, T.N) if T.j1[i] < T.N]
        out["periods"].append({
            "from": y0, "n": sum(1 for i in sig if i >= s0), "n1": len(f1),
            "mean1": round(st.mean(f1), 4) if f1 else None, "win1": sum(x > 0 for x in f1),
            "all1": round(st.mean(b1), 4),
            "dates": [D[i] for i in sig if i >= s0],
        })
    return out


def main():
    with open(SRC, encoding="utf-8") as f:
        src = json.load(f)
    daily = [r for r in src["daily"] if r[0] >= CALC_FROM]
    ek = sorted((r[2], r[0], r[1]) for r in src["eps"])  # (使える日, 四半期, 値)
    bk = sorted((r[2], r[0], r[1]) for r in src["bv"])
    ekd, bkd = [x[0] for x in ek], [x[0] for x in bk]

    D, C, PER, PBR, EQ, BQ = [], [], [], [], [], []
    for d, c in daily:
        i = bisect.bisect_right(ekd, d) - 1
        j = bisect.bisect_right(bkd, d) - 1
        # 使える日の順と四半期の順は同じはずだが、念のためその日までに使える中で一番新しい四半期を使う
        e = max(ek[: i + 1], key=lambda x: x[1]) if i >= 0 else None
        b = max(bk[: j + 1], key=lambda x: x[1]) if j >= 0 and d >= PBR_FROM else None
        D.append(d)
        C.append(c)
        PER.append(round(c / e[2], 2) if e else None)
        PBR.append(round(c / b[2], 3) if b else None)
        EQ.append(e)
        BQ.append(b)
    s0 = bisect.bisect_left(D, FROM)
    T = Tuner(D, C, PER, PBR, s0)

    # ---------- 線を選び直す ----------
    prev, history = load_previous()
    today = D[-1]
    P, tune_out = {}, {}
    for kind in GRID:
        cur = prev.get(kind) or DEFAULT[kind]
        pick, rows, changed = T.tune(kind, cur)
        P[kind] = pick or cur
        if changed:
            history.append({"date": today, "kind": kind, "from": cur, "to": P[kind]})
        top = sorted((r for r in rows if r["smooth"] is not None), key=lambda r: -r["smooth"])[:6]
        mine = next((r for r in rows if all(r[k] == P[kind][k] for k in P[kind])), None)
        tune_out[kind] = {"top": top, "current": mine, "candidates": len(rows),
                          "walk": walk_forward(T, kind, D, C)}
    K = kinds(P)
    lo, re = P["per20"]["lo"], P["per20"]["lo"] + P["per20"]["gap"]
    rper, rpbr = T.ratio("per", P["perma"]["n"]), T.ratio("pbr", P["pbrma"]["n"])
    PERM = [None if r is None else p / r for p, r in zip(PER, rper)]
    PBRM = [None if r is None else p / r for p, r in zip(PBR, rpbr)]

    def fwd(i, days):
        t = add(D[i], days)
        if t > D[-1]:
            return None
        return C[bisect.bisect_left(D, t)] / C[i] - 1

    found = {kind: T.signals(kind, P[kind]) for kind in GRID}
    sigs = []
    for kind, (idx, _) in found.items():
        for i in idx:
            if i < s0:
                continue
            r1, r3 = fwd(i, 365), fwd(i, 1095)
            sigs.append({"kind": kind, "date": D[i], "close": C[i], "per": PER[i], "pbr": PBR[i],
                         "dev": round((rper if kind == "perma" else rpbr)[i] - 1, 4) if kind != "per20" else None,
                         "r1": None if r1 is None else round(r1, 4), "r3": None if r3 is None else round(r3, 4)})
    sigs.sort(key=lambda s: (s["date"], s["kind"]))

    # 毎日買った場合の平均は、その合図が出うる最初の日から数える(PBR の移動平均は2000年代から)
    def first_day(vals):
        return max(s0, next(i for i, v in enumerate(vals) if v is not None))

    starts = {"per20": s0, "perma": first_day(rper), "pbrma": first_day(rpbr)}
    stats = {}
    for kind, a in starts.items():
        b1 = [x for x in (fwd(i, 365) for i in range(a, len(D))) if x is not None]
        b3 = [x for x in (fwd(i, 1095) for i in range(a, len(D))) if x is not None]
        g1 = [s["r1"] for s in sigs if s["kind"] == kind and s["r1"] is not None]
        g3 = [s["r3"] for s in sigs if s["kind"] == kind and s["r3"] is not None]
        stats[kind] = {
            "from": D[a], "n": sum(1 for s in sigs if s["kind"] == kind),
            "sig1": {"mean": round(st.mean(g1), 4) if g1 else None, "win": sum(x > 0 for x in g1), "n": len(g1)},
            "sig3": {"mean": round(st.mean(g3), 4) if g3 else None, "win": sum(x > 0 for x in g3), "n": len(g3)},
            "all1": {"mean": round(st.mean(b1), 4), "win": round(sum(x > 0 for x in b1) / len(b1), 3)},
            "all3": {"mean": round(st.mean(b3), 4), "win": round(sum(x > 0 for x in b3) / len(b3), 3)},
        }

    n = len(D) - 1
    e, b = EQ[n], BQ[n]
    per_hist = [x for x in PER[s0:] if x is not None and x < 100]
    pbr_hist = [x for x in PBR[s0:] if x is not None]
    out = {
        "updated": dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).strftime("%Y-%m-%dT%H:%M+09:00"),
        "ready": True,
        "params": P,
        "rule": {"per_lo": lo, "per_re": re, "from": FROM, "pbr_from": PBR_FROM,
                 "per_ma": P["perma"]["n"], "per_ma_th": P["perma"]["th"], "per_ma_span": span(P["perma"]["n"]),
                 "pbr_ma": P["pbrma"]["n"], "pbr_ma_th": P["pbrma"]["th"], "pbr_ma_span": span(P["pbrma"]["n"])},
        "kinds": K,
        "tune": tune_out,
        "tune_history": history,
        "grid": {k: {a: v for a, v in g["axes"]} for k, g in GRID.items()},
        "current": {
            "date": D[n], "close": C[n], "per": PER[n], "pbr": PBR[n],
            "eps": e[2], "eps_q": e[1], "bps": b[2] if b else None, "bps_q": b[1] if b else None,
            "price_lo": round(e[2] * lo, 2), "price_re": round(e[2] * re, 2),
            "armed": found["per20"][1],
            "per_ma": round(PERM[n], 2), "per_dev": round(rper[n] - 1, 4), "perma_armed": found["perma"][1],
            "price_perma": round(e[2] * PERM[n] * P["perma"]["th"], 2),
            "pbr_ma": round(PBRM[n], 3) if PBRM[n] else None, "pbr_dev": round(rpbr[n] - 1, 4) if rpbr[n] else None,
            "pbrma_armed": found["pbrma"][1],
            "price_pbrma": round(b[2] * PBRM[n] * P["pbrma"]["th"], 2) if b and PBRM[n] else None,
            "per_rank": round(pct_rank(per_hist, PER[n]), 3),
            "pbr_rank": round(pct_rank(pbr_hist, PBR[n]), 3) if PBR[n] else None,
            "pbr_min": min(pbr_hist), "pbr_max": max(pbr_hist),
            "pbr_median": round(st.median(pbr_hist), 2), "per_median": round(st.median(per_hist), 2),
        },
        "signals": sigs,
        "stats": stats,
        "series": {
            "date": D[s0:], "close": C[s0:], "per": PER[s0:], "pbr": PBR[s0:],
            "per_ma": [None if x is None else round(x, 2) for x in PERM[s0:]],
            "pbr_ma": [None if x is None else round(x, 3) for x in PBRM[s0:]],
        },
    }
    print(json.dumps({"params": P, "history": history, "stats": stats}, ensure_ascii=False))
    for kind, t in tune_out.items():
        print(kind, "いまの線", t["current"])
        print("   歩きながら", [{k: v for k, v in p.items() if k != "dates"} for p in t["walk"]["periods"]], t["walk"]["picks"])
    if "--check" in sys.argv:
        return
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")


if __name__ == "__main__":
    main()
