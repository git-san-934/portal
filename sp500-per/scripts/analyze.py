"""data/source.json から S&P 500 の日次 PER・PBR と買いの合図を計算して data/analysis.json を書く。

- PER = 終値 ÷ その日に使える最新の EPS(12か月合計、as reported)
- PBR = 終値 ÷ その日に使える最新の1株純資産
- 「使える」は四半期末の3か月後(または実際に取れた日)から。後から分かる値で判定しないため
- 買いの合図(売りの合図は出さない)は3種類:
  - per20: PER が 20倍を上から下に割った日。次の合図は PER が一度 23倍を超えてから
  - perma: PER が PER の250日(約1年)移動平均より15%以上低くなった日。次の合図は PER が移動平均の上に戻ってから
  - pbrma: PBR が PBR の500日(約2年)移動平均より5%以上低くなった日。次の合図は PBR が移動平均の上に戻ってから
  - PBR の水準そのもの(固定の倍率)には線を置かない(2000年以降で上がり続けていて、成績が安定しなかった。README 参照)
- 成績: 合図の日から 365日後・1095日後の終値の変化率と、同じ期間に毎日買った場合の平均(配当は含めない)

標準ライブラリのみ。--check は計算だけして書かない。
"""
import bisect
import datetime as dt
import json
import os
import statistics as st
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "data", "source.json")
OUT = os.path.join(HERE, "..", "data", "analysis.json")
CALC_FROM = "1976-01-01"  # 移動平均の助走のため、計算はここから
FROM = "1990-01-01"  # ページに出す期間と、合図・成績を数える期間
PBR_FROM = "2000-03-01"  # 1株純資産は1999年末から
PER_LO, PER_RE = 20.0, 23.0
PER_MA, PER_MA_TH = 250, 0.85
PBR_MA, PBR_MA_TH = 500, 0.95
KINDS = {
    "per20": {"label": f"PER {PER_LO:.0f}倍割れ", "short": "PER"},
    "perma": {"label": f"PER が1年平均の−{round((1 - PER_MA_TH) * 100)}%", "short": "PER平均"},
    "pbrma": {"label": f"PBR が2年平均の−{round((1 - PBR_MA_TH) * 100)}%", "short": "PBR平均"},
}


def add(d, days):
    return (dt.date.fromisoformat(d) + dt.timedelta(days=days)).isoformat()


def pct_rank(arr, v):
    return sum(1 for a in arr if a < v) / len(arr)


def sma(x, n):
    """単純移動平均。窓の中に欠け(None)があれば None"""
    out, s, k = [None] * len(x), 0.0, 0
    for i, v in enumerate(x):
        if v is None:
            s, k = 0.0, 0
            continue
        s += v
        k += 1
        if k > n:
            s -= x[i - n]
            k = n
        if k == n:
            out[i] = s / n
    return out


def cross_down(vals, lo, re):
    """vals が lo を上から下に割った日の番号。次は vals が一度 re を超えてから"""
    out, ok, prev = [], True, None
    for i, v in enumerate(vals):
        if v is None:
            prev = None
            continue
        if v > re:
            ok = True
        if ok and prev is not None and prev >= lo and v < lo:
            out.append(i)
            ok = False
        prev = v
    return out, ok


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
    PERM, PBRM = sma(PER, PER_MA), sma(PBR, PBR_MA)
    rper = [None if m is None or p is None else p / m for p, m in zip(PER, PERM)]
    rpbr = [None if m is None or p is None else p / m for p, m in zip(PBR, PBRM)]

    def fwd(i, days):
        t = add(D[i], days)
        if t > D[-1]:
            return None
        return C[bisect.bisect_left(D, t)] / C[i] - 1

    s0 = bisect.bisect_left(D, FROM)
    found = {
        "per20": cross_down(PER, PER_LO, PER_RE),
        "perma": cross_down(rper, PER_MA_TH, 1.0),
        "pbrma": cross_down(rpbr, PBR_MA_TH, 1.0),
    }
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

    # 毎日買った場合の平均は、その合図が出うる最初の日から数える(PBR の移動平均は2002年から)
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
        "rule": {"per_lo": PER_LO, "per_re": PER_RE, "from": FROM, "pbr_from": PBR_FROM,
                 "per_ma": PER_MA, "per_ma_th": PER_MA_TH, "pbr_ma": PBR_MA, "pbr_ma_th": PBR_MA_TH},
        "kinds": KINDS,
        "current": {
            "date": D[n], "close": C[n], "per": PER[n], "pbr": PBR[n],
            "eps": e[2], "eps_q": e[1], "bps": b[2] if b else None, "bps_q": b[1] if b else None,
            "price_lo": round(e[2] * PER_LO, 2), "price_re": round(e[2] * PER_RE, 2),
            "armed": found["per20"][1],
            "per_ma": round(PERM[n], 2), "per_dev": round(rper[n] - 1, 4), "perma_armed": found["perma"][1],
            "price_perma": round(e[2] * PERM[n] * PER_MA_TH, 2),
            "pbr_ma": round(PBRM[n], 3) if PBRM[n] else None, "pbr_dev": round(rpbr[n] - 1, 4) if rpbr[n] else None,
            "pbrma_armed": found["pbrma"][1],
            "price_pbrma": round(b[2] * PBRM[n] * PBR_MA_TH, 2) if b and PBRM[n] else None,
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
    print(json.dumps({k: out[k] for k in ("current", "stats")}, ensure_ascii=False))
    for s in sigs:
        print(s)
    if "--check" in sys.argv:
        return
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")


if __name__ == "__main__":
    main()
