"""data/source.json から S&P 500 の日次 PER・PBR と買いの合図を計算して data/analysis.json を書く。

- PER = 終値 ÷ その日に使える最新の EPS(12か月合計、as reported)
- PBR = 終値 ÷ その日に使える最新の1株純資産
- 「使える」は四半期末の3か月後(または実際に取れた日)から。後から分かる値で判定しないため
- 買いの合図(PER): PER が 20倍を上から下に割った日。次の合図は PER が一度 23倍を超えてから
- PBR には買いの線を置かない(固定の線も、過去の平均からの離れ方も、合図のあとの成績が安定しなかった。README 参照)
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
FROM = "1990-01-01"  # ページに出す期間と、合図・成績を数える期間
PBR_FROM = "2000-03-01"  # 1株純資産は1999年末から
PER_LO, PER_RE = 20.0, 23.0


def add(d, days):
    return (dt.date.fromisoformat(d) + dt.timedelta(days=days)).isoformat()


def pct_rank(arr, v):
    return sum(1 for a in arr if a < v) / len(arr)


def main():
    with open(SRC, encoding="utf-8") as f:
        src = json.load(f)
    daily = [r for r in src["daily"] if r[0] >= FROM]
    eps, bv = src["eps"], src["bv"]
    ek = sorted((r[2], r[0], r[1]) for r in eps)  # (使える日, 四半期, 値)
    bk = sorted((r[2], r[0], r[1]) for r in bv)
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

    def fwd(i, days):
        t = add(D[i], days)
        if t > D[-1]:
            return None
        return C[bisect.bisect_left(D, t)] / C[i] - 1

    def base(days):
        a = [x for x in (fwd(i, days) for i in range(len(D))) if x is not None]
        return {"mean": round(st.mean(a), 4), "win": round(sum(x > 0 for x in a) / len(a), 3), "n": len(a)}

    # 買いの合図(PER)
    sigs, ok, prev = [], True, None
    for i in range(len(D)):
        e = PER[i]
        if e is None:
            continue
        if e > PER_RE:
            ok = True
        if ok and prev is not None and prev >= PER_LO and e < PER_LO:
            sigs.append({"date": D[i], "close": C[i], "per": e, "pbr": PBR[i],
                         "r1": None if fwd(i, 365) is None else round(fwd(i, 365), 4),
                         "r3": None if fwd(i, 1095) is None else round(fwd(i, 1095), 4)})
            ok = False
        prev = e

    def summ(key):
        a = [s[key] for s in sigs if s[key] is not None]
        return {"mean": round(st.mean(a), 4) if a else None, "win": sum(x > 0 for x in a), "n": len(a)}

    n = len(D) - 1
    e, b = EQ[n], BQ[n]
    per_hist = [x for x in PER if x is not None and x < 100]
    pbr_hist = [x for x in PBR if x is not None]
    pbr_hist2010 = [x for d, x in zip(D, PBR) if x is not None and d >= "2010-01-01"]
    out = {
        "updated": dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).strftime("%Y-%m-%dT%H:%M+09:00"),
        "ready": True,
        "rule": {"per_lo": PER_LO, "per_re": PER_RE, "from": FROM, "pbr_from": PBR_FROM},
        "current": {
            "date": D[n], "close": C[n], "per": PER[n], "pbr": PBR[n],
            "eps": e[2], "eps_q": e[1], "bps": b[2] if b else None, "bps_q": b[1] if b else None,
            "price_lo": round(e[2] * PER_LO, 2), "price_re": round(e[2] * PER_RE, 2),
            "armed": ok,
            "per_rank": round(pct_rank(per_hist, PER[n]), 3),
            "pbr_rank": round(pct_rank(pbr_hist, PBR[n]), 3) if PBR[n] else None,
            "pbr_rank2010": round(pct_rank(pbr_hist2010, PBR[n]), 3) if PBR[n] else None,
            "pbr_min": min(pbr_hist), "pbr_max": max(pbr_hist),
            "pbr_median": round(st.median(pbr_hist), 2), "per_median": round(st.median(per_hist), 2),
        },
        "signals": sigs,
        "stats": {"sig1": summ("r1"), "sig3": summ("r3"), "all1": base(365), "all3": base(1095)},
        "series": {"date": D, "close": C, "per": PER, "pbr": PBR},
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
