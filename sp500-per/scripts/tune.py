"""買いの合図の線を、過去のデータから選び直す(analyze.py から毎日呼ぶ)。

3種類の合図それぞれで、候補の線を全部ためし、合図のあと1年・3年の値動きが
「毎日買った平均」をどれだけ上回ったかで点数をつけ、いちばん良いものを選ぶ。

- 点数 = 1年後の超過(pt) + 3年後の超過(pt) ÷ 3(3年を1年あたりにならす)
- たまたま1つだけ良い線を選ばないように、隣の候補(線を1段ずらしたもの)との平均で比べる。
  合図が5回未満の候補は点数なし(平均するときは0点として数える)
- 毎日ころころ変わらないように、いま使っている線との差が CHANGE_MARGIN 点より小さければ変えない
- as_of を渡すと、その日までに分かっていたデータだけで選ぶ(後から分かる値動きは使わない)
"""
import bisect

MIN_SIGNALS = 5
CHANGE_MARGIN = 1.0  # pt

GRID = {
    # PER の水準: lo 倍を下に割ったら買い、次は lo+gap 倍を超えてから
    "per20": {"axes": [("lo", [16, 17, 18, 19, 20, 21, 22, 23, 24]), ("gap", [2, 3, 4])]},
    # PER ÷ PER の n 日移動平均 が th を下に割ったら買い、次は移動平均の上に戻ってから
    "perma": {"axes": [("n", [100, 150, 200, 250, 350, 500]), ("th", [0.95, 0.9, 0.85, 0.8])]},
    "pbrma": {"axes": [("n", [100, 150, 200, 250, 350, 500]), ("th", [0.95, 0.9, 0.85, 0.8])]},
}


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


def cross_down(vals, lo, re, end=None):
    """vals が lo を上から下に割った日の番号。次は vals が一度 re を超えてから。end の手前まで"""
    out, ok, prev = [], True, None
    for i in range(len(vals) if end is None else end):
        v = vals[i]
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


class Tuner:
    def __init__(self, D, C, PER, PBR, start):
        self.D, self.C, self.N, self.start = D, C, len(D), start
        self.series = {"per": PER, "pbr": PBR}
        self._ratio = {}
        # 365日後・1095日後の番号(D の範囲外なら N)
        self.j1 = self._ahead(365)
        self.j3 = self._ahead(1095)

    def _ahead(self, days):
        import datetime as dt
        out = []
        for d in self.D:
            t = (dt.date.fromisoformat(d) + dt.timedelta(days=days)).isoformat()
            out.append(bisect.bisect_left(self.D, t))
        return out

    def ratio(self, key, n):
        if (key, n) not in self._ratio:
            x = self.series[key]
            m = sma(x, n)
            self._ratio[(key, n)] = [None if a is None or b is None else a / b for a, b in zip(x, m)]
        return self._ratio[(key, n)]

    def signals(self, kind, p, end=None):
        """候補 p の合図の番号(と、次の合図を出せる状態か)"""
        if kind == "per20":
            return cross_down(self.series["per"], p["lo"], p["lo"] + p["gap"], end)
        key = "per" if kind == "perma" else "pbr"
        return cross_down(self.ratio(key, p["n"]), p["th"], 1.0, end)

    def _first(self, kind, p):
        vals = self.series["per"] if kind == "per20" else self.ratio("per" if kind == "perma" else "pbr", p["n"])
        return max(self.start, next((i for i, v in enumerate(vals) if v is not None), self.N))

    def _mean_fwd(self, idx, j, end):
        """idx の日に買って j の日に見た変化率の平均(j が end 以降=まだ分からないものは除く)"""
        C = self.C
        a = [C[j[i]] / C[i] - 1 for i in idx if j[i] < end]
        return (sum(a) / len(a), len(a)) if a else (None, 0)

    def raw_score(self, kind, p, end=None):
        end = self.N if end is None else end
        idx = [i for i in self.signals(kind, p, end)[0] if i >= self.start]
        a = self._first(kind, p)
        base = range(a, end)
        m1, n1 = self._mean_fwd(idx, self.j1, end)
        m3, n3 = self._mean_fwd(idx, self.j3, end)
        b1, _ = self._mean_fwd(base, self.j1, end)
        b3, _ = self._mean_fwd(base, self.j3, end)
        r = {"cnt": len(idx), "n1": n1, "n3": n3,
             "e1": None if m1 is None or b1 is None else (m1 - b1) * 100,
             "e3": None if m3 is None or b3 is None else (m3 - b3) * 100}
        if n1 < MIN_SIGNALS or r["e1"] is None:
            r["score"] = None
        else:
            r["score"] = r["e1"] + (r["e3"] / 3 if r["e3"] is not None and n3 >= 3 else 0)
        return r

    def tune(self, kind, current=None, end=None):
        """候補を全部ためし、隣との平均点がいちばん良い候補を返す"""
        axes = GRID[kind]["axes"]
        names = [a[0] for a in axes]
        vals = [a[1] for a in axes]
        cells = {}
        for i0, v0 in enumerate(vals[0]):
            for i1, v1 in enumerate(vals[1]):
                p = {names[0]: v0, names[1]: v1}
                cells[(i0, i1)] = (p, self.raw_score(kind, p, end))
        rows = []
        for (i0, i1), (p, r) in cells.items():
            nb = [(i0 + a, i1 + b) for a, b in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)) if (i0 + a, i1 + b) in cells]
            sc = [cells[k][1]["score"] or 0.0 for k in nb]
            rows.append({**p, **{k: (round(v, 2) if isinstance(v, float) else v) for k, v in r.items()},
                         "smooth": None if r["score"] is None else round(sum(sc) / len(sc), 2)})
        valid = [r for r in rows if r["smooth"] is not None]
        if not valid:
            return current, rows, False
        best = max(valid, key=lambda r: r["smooth"])
        pick = {k: best[k] for k in names}
        if current:
            cur = next((r for r in valid if all(r[k] == current.get(k) for k in names)), None)
            if cur is not None and cur["smooth"] >= best["smooth"] - CHANGE_MARGIN:
                return {k: current[k] for k in names}, rows, False
        return pick, rows, bool(current) and pick != {k: current.get(k) for k in names}
