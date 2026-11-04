#!/usr/bin/env python3
"""日経4.3ブルの「買い時・売り時」のルールを、最新の基準価額で毎日見直す。

data/nav.json(実際の基準価額)と data/nikkei_1996-2017.json(それより前の仮の基準価額を作るための日経平均)から
1996年〜今日までの基準価額を作り、いろいろな種類のルールを試して、今のルールと比べる。
結果は data/optimize.json に書き、ページの「条件の毎日見直し」に出す。ページの実際のルールは変えない。

試すルールの種類(毎日1万円の積立に足す「追加買い」と、持ち分の一部を売る「売り」):
  追加買い: 20日高値からの下落(今のルールの仲間) / 移動平均からの下落 / RSI(売られすぎ) /
            変動率で割った下落(いつもより大きい下げ) / 1年高値からの下落に比例 / 大きな下げからの反発
  売り:     1年前の何倍(今のルールの仲間) / 200日平均からの上昇 / RSI(買われすぎ) /
            大きく上がったあとの下げはじめ / 自分の持ち分の含み益。売る割合は 1/5・1/4・1/3・半分・全部

たまたま当たったルールを選ばないための工夫:
  1. 開始日を少しずつずらした多数の期間(3年・5年)で比べ、中央値と勝った割合で見る
  2. そのルールのまわり(同じ種類の隣の条件)も平均した「なだらかな成績」で選ぶ
  3. 追加買いは、今のルールより多くの現金が要るルールは選ばない(現金を多く入れれば成績が上がるのは当たり前なので)
  4. ウォークフォワード: 各年について「その年より前のデータだけで選んだルール」が、その年から3年で今のルールに勝ったかを確かめる
  5. 今のルールより十分に良く、上の確認も通ったときだけ「見直し候補」とする

標準ライブラリだけで動く。使い方:
  python nikkei43/scripts/optimize.py            # 新しい基準価額があれば計算して optimize.json を書く
  python nikkei43/scripts/optimize.py --force    # データが同じでも計算し直す
  python nikkei43/scripts/optimize.py --check    # 計算だけして書かない(PR での確認用)
"""
import bisect
import hashlib
import json
import math
import statistics as st
import sys
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NAV_PATH = ROOT / "data" / "nav.json"
NK_PATH = ROOT / "data" / "nikkei_1996-2017.json"
OUT_PATH = ROOT / "data" / "optimize.json"
JST = timezone(timedelta(hours=9))

DAILY = 10000
TAX = 0.20315
Y1, Y3, Y5 = 245, 735, 1225
DRIFT = 0.0339 / 245  # 仮の基準価額の年3.39%の上乗せ(2018年以降の実際の基準価額に合わせた値)

# ---------- 今のルール(ページの app.js と同じ) ----------
CUR_BUY = ("dd", 20, -0.30, 2000000)
CUR_SELL = ("yr", 3.0, 0.25, -0.20)
BIG_FALLBACK = 100000
EPISODE_GAP = 60
SELL_GAP = 20
REBUY_FRAC = 0.1
MA_DAYS = 200
DD_TIERS = [(0.0, 30000, False), (-0.10, 60000, False), (-0.20, 300000, True), (-0.40, 500000, True)]
FRACS = [0.2, 0.25, 1 / 3, 0.5, 1.0]  # 1.0 = 全部売る
REBUYS = [-0.10, -0.20, -0.30]

# ---------- 試すルール(種類ごとの条件の組み合わせ。隣どうしの条件で成績をならす) ----------
BUY_FAMILIES = {
    # 今のルールの仲間: N日高値からの下落で段階的に(−10・−20・−40ポイント下に段階)。大口は1回の暴落で cap まで
    "dd": {"name": "N日高値からの下落", "grid": {"w": [10, 15, 20, 30, 40], "t1": [-0.20, -0.25, -0.30, -0.35, -0.40], "cap": [1000000, 2000000, 3000000]}},
    # N日移動平均からの下落で段階的に(3万・6万・15万・30万円 × 大きさ)
    "ma": {"name": "移動平均からの下落", "grid": {"n": [50, 100, 200], "x": [-0.20, -0.30, -0.40, -0.50], "s": [0.5, 1, 2]}},
    # RSI(14日)が r 以下の日に a 円
    "rsi": {"name": "RSI(売られすぎ)", "grid": {"r": [15, 20, 25, 30], "a": [30000, 60000, 100000, 200000]}},
    # 20日の騰落が、ふだんの値動き(60日の日次変動×√20)の k 倍より大きく下げた日に a 円
    "z": {"name": "いつもより大きい下げ(変動率で割る)", "grid": {"k": [1.5, 2.0, 2.5, 3.0], "a": [30000, 100000, 300000]}},
    # 1年高値からの下落が d0 を超えた分、10ポイントごとに a 円(1日50万円まで)
    "lin": {"name": "1年高値からの下落に比例", "grid": {"d0": [0.3, 0.5, 0.7], "a": [10000, 30000, 60000]}},
    # 1年高値から y 以上下げたあと、20日安値から u 以上戻った日に a 円
    "rb": {"name": "大きな下げからの反発", "grid": {"u": [0.1, 0.2, 0.3], "y": [0.5, 0.7], "a": [50000, 100000, 300000]}},
}
SELL_FAMILIES = {
    "yr": {"name": "1年前の何倍", "grid": {"m": [2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0], "f": FRACS, "rb": REBUYS}},
    "ma": {"name": "200日平均からの上昇", "grid": {"x": [0.5, 0.8, 1.0, 1.5, 2.0], "f": FRACS, "rb": REBUYS}},
    "rsi": {"name": "RSI(買われすぎ)", "grid": {"r": [75, 80, 85, 90], "f": FRACS, "rb": REBUYS}},
    "tr": {"name": "大きく上がったあとの下げはじめ", "grid": {"m": [2.0, 2.5, 3.0], "y": [0.10, 0.20, 0.30], "f": FRACS, "rb": REBUYS}},
    "gain": {"name": "自分の持ち分の含み益", "grid": {"k": [1.5, 2.0, 3.0, 4.0], "f": FRACS, "rb": REBUYS}},
}

# 見直し候補にする基準
BUY_MIN_GAIN = 0.02  # 5年の差(中央値)が +2% 以上
BUY_MIN_WIN5 = 0.60
BUY_MIN_WIN3 = 0.55
BUY_CASH_TOL = 1.10  # 1年で要る追加の現金は今のルールの1.1倍まで
BUY_MAX_WORST = -0.15  # 5年で今のルールにいちばん負けた回が −15% より悪いものは選ばない(当たり外れが大きすぎる)
SELL_MIN_GAIN = 0.03  # 「売らない」との差(5年の中央値)が今のルールより +3ポイント以上
SELL_MAX_WORST = -0.10  # 5年でいちばん負けた回が −10% より悪いものは選ばない
SELL_NEIGHBOR_WORST = -0.20  # 隣の条件のどれかが5年で −20% より大きく負けるなら、尖った(たまたまの)結果とみて候補にしない
BUY_NEIGHBOR_WORST = -0.25
MIN_SMOOTH_GAIN = 0.015  # まわりの条件も含めた成績でも、今のルールより +1.5ポイント以上
WF_MIN_WIN = 0.50  # ウォークフォワードで、選び直したルールが今のルールに勝った割合(引き分けを除く)


def load():
    J = json.loads(NAV_PATH.read_text())
    K = json.loads(NK_PATH.read_text())
    nd, nv = J["dates"], [float(x) for x in J["nav"]]
    kd, kc = K["dates"], K["close"]
    k = kd.index(nd[0])
    syn = [0.0] * (k + 1)
    syn[k] = nv[0]
    for j in range(k, 0, -1):
        syn[j - 1] = syn[j] / (1 + 4.3 * (kc[j] / kc[j - 1] - 1) + DRIFT)
    return kd[:k] + nd, syn[:k] + nv, k


def rolling_ext(nav, w, hi=True):
    """直近 w 日の最高値(hi)または最安値"""
    out = [0.0] * len(nav)
    q = deque()
    for i, v in enumerate(nav):
        while q and (nav[q[-1]] <= v if hi else nav[q[-1]] >= v):
            q.pop()
        q.append(i)
        if q[0] <= i - w:
            q.popleft()
        out[i] = nav[q[0]]
    return out


def sma(nav, n):
    out = [None] * len(nav)
    s = 0.0
    for i, v in enumerate(nav):
        s += v
        if i >= n:
            s -= nav[i - n]
        if i >= n - 1:
            out[i] = s / n
    return out


def rsi(nav, n=14):
    out = [50.0] * len(nav)
    g = l = 0.0
    for i in range(1, len(nav)):
        d = nav[i] - nav[i - 1]
        up, dn = max(d, 0.0), max(-d, 0.0)
        if i <= n:
            g += up / n
            l += dn / n
        else:
            g = (g * (n - 1) + up) / n
            l = (l * (n - 1) + dn) / n
        if i >= n:
            out[i] = 100.0 if l == 0 else 100 - 100 / (1 + g / l)
    return out


def neighbors(key, families):
    fam = key[0]
    grid = families[fam]["grid"]
    names = list(grid)
    vals = key[1:]
    out = [key]
    for d, nm in enumerate(names):
        j = grid[nm].index(vals[d])
        for step in (-1, 1):
            if 0 <= j + step < len(grid[nm]):
                v = list(vals)
                v[d] = grid[nm][j + step]
                out.append((fam, *v))
    return out


def all_keys(families):
    keys = []
    for fam, spec in families.items():
        combos = [()]
        for vals in spec["grid"].values():
            combos = [c + (v,) for c in combos for v in vals]
        keys += [(fam, *c) for c in combos]
    return keys


def summarize(ratios):
    if not ratios:
        return None
    srt = sorted(ratios)
    return {
        "n": len(ratios),
        "med": round(st.median(ratios) - 1, 4),
        "win": round(sum(r > 1.0001 for r in ratios) / len(ratios), 3),
        "tie": round(sum(abs(r - 1) <= 1e-4 for r in ratios) / len(ratios), 3),
        "worst": round(srt[0] - 1, 4),
        "q10": round(srt[len(srt) // 10] - 1, 4),
    }


def frac_ja(f):
    return {0.2: "1/5", 0.25: "1/4", 1 / 3: "1/3", 0.5: "半分", 1.0: "全部"}.get(f, f"{f:.2f}")


def pct(x):
    return f"{round(x * 100):+d}%".replace("+-", "−").replace("-", "−")


def buy_label(k):
    f = k[0]
    if f == "dd":
        _, w, t1, cap = k
        t = [round((t1 + off) * 100) for off, _, _ in DD_TIERS]
        return f"{w}日高値から {t[0]}%/{t[1]}%/{t[2]}%/{t[3]}%で段階的に(3万〜50万円)・大口の上限 {cap // 10000}万円".replace("-", "−")
    if f == "ma":
        _, n, x, s = k
        return f"{n}日平均から{pct(x)}以下で段階的に({3 * s:g}万〜{30 * s:g}万円)"
    if f == "rsi":
        return f"RSI(14日)が{k[1]}以下の日に{k[2] // 10000}万円"
    if f == "z":
        return f"20日の下げが、ふだんの値動きの{k[1]:g}倍を超えた日に{k[2] // 10000}万円"
    if f == "lin":
        return f"1年高値から{round(k[1] * 100)}%を超えて下げた分、10ポイントごとに{k[2] // 10000}万円"
    if f == "rb":
        return f"1年高値から{round(k[2] * 100)}%以上下げたあと、20日安値から{round(k[1] * 100)}%戻った日に{k[3] // 10000}万円"
    return str(k)


def sell_label(k):
    f, *v = k
    fr, rb = frac_ja(v[-2]), f"200日平均{round(v[-1] * 100)}%で買い戻す".replace("-", "−")
    sv = "全部売る" if v[-2] == 1.0 else f"{fr}を売る"
    if f == "yr":
        return f"1年前の{v[0]:g}倍で{sv}・{rb}"
    if f == "ma":
        return f"200日平均の{1 + v[0]:g}倍で{sv}・{rb}"
    if f == "rsi":
        return f"RSI(14日)が{v[0]}以上で{sv}・{rb}"
    if f == "tr":
        return f"1年前の{v[0]:g}倍以上から20日高値で{round(v[1] * 100)}%下げたら{sv}・{rb}"
    if f == "gain":
        return f"自分の持ち分が買値の{v[0]:g}倍で{sv}・{rb}"
    return str(k)


class Market:
    def __init__(self):
        self.dates, self.nav, self.real0 = load()
        self.N = N = len(self.nav)
        nav = self.nav
        self.P = [0.0] * (N + 1)  # 1口あたりの逆数の累積(毎日の積立の口数を一気に出す)
        for i, v in enumerate(nav):
            self.P[i + 1] = self.P[i] + 1 / v
        self.dd = {w: [v / h - 1 for v, h in zip(nav, rolling_ext(nav, w))] for w in BUY_FAMILIES["dd"]["grid"]["w"]}
        self.dd250 = [v / h - 1 for v, h in zip(nav, rolling_ext(nav, Y1))]
        self.low20 = rolling_ext(nav, 20, hi=False)
        self.mas = {n: sma(nav, n) for n in (50, 100, 200)}
        self.ma = self.mas[MA_DAYS]
        self.rsi = rsi(nav)
        self.yr = [nav[i] / nav[i - Y1] if i >= Y1 else 0.0 for i in range(N)]
        # 20日の騰落 ÷ (60日の日次変動 × √20)
        lr = [0.0] + [math.log(nav[i] / nav[i - 1]) for i in range(1, N)]
        self.z = [0.0] * N
        for i in range(80, N):
            xs = lr[i - 59 : i + 1]
            m = sum(xs) / 60
            sd = math.sqrt(sum((x - m) ** 2 for x in xs) / 59)
            self.z[i] = math.log(nav[i] / nav[i - 20]) / (sd * math.sqrt(20)) if sd > 0 else 0.0
        self.rebuy = {rb: [m is not None and v < m * (1 + rb) for v, m in zip(nav, self.ma)] for rb in REBUYS}
        self.year_start = {}
        for i, d in enumerate(self.dates):
            self.year_start.setdefault(int(d[:4]), i)

    # ---------- 追加買い ----------
    def buy_rule(self, k):
        """合図の出る日と、その日の(上限をかける前の)追加額。dd は段階番号"""
        f = k[0]
        N, nav = self.N, self.nav
        days, amts = [], []
        if f == "dd":
            _, w, t1, cap = k
            dd = self.dd[w]
            ths = [t1 + off for off, _, _ in DD_TIERS]
            for j, x in enumerate(dd):
                if x <= ths[0]:
                    t = max(n for n, th in enumerate(ths) if x <= th)
                    days.append(j)
                    amts.append(t)
            return {"days": days, "amts": amts, "cap": cap}
        for j in range(N):
            a = 0
            if f == "ma":
                _, n, x, s = k
                m = self.mas[n][j]
                if m is not None:
                    d = nav[j] / m - 1
                    for off, base in ((0.0, 30000), (-0.1, 60000), (-0.2, 150000), (-0.3, 300000)):
                        if d <= x + off:
                            a = base * s
            elif f == "rsi":
                if j >= 14 and self.rsi[j] <= k[1]:
                    a = k[2]
            elif f == "z":
                if self.z[j] <= -k[1]:
                    a = k[2]
            elif f == "lin":
                over = -self.dd250[j] - k[1]
                if over > 0:
                    a = min(500000, k[2] * over / 0.1)
            elif f == "rb":
                _, u, y, amt = k
                if self.dd250[j] <= -y and nav[j] >= self.low20[j] * (1 + u):
                    a = amt
            if a:
                days.append(j)
                amts.append(a)
        return {"days": days, "amts": amts, "cap": None}

    def plan(self, rule, s, e):
        """s〜e-1 の合図から、翌営業日の追加額 {買う日: 金額} を作る"""
        days, amts, cap = rule["days"], rule["amts"], rule["cap"]
        lo, hi = bisect.bisect_left(days, s), bisect.bisect_left(days, e)
        if cap is None:
            return {days[n] + 1: amts[n] for n in range(lo, hi)}
        ex = {}
        used, last = 0, -(10**9)
        for n in range(lo, hi):
            j = days[n]
            _, a, big = DD_TIERS[amts[n]]
            if big:
                if j - last > EPISODE_GAP:
                    used = 0
                last = j
                b = min(a, max(0, cap - used))
                used += b
                a = max(b, BIG_FALLBACK)
            ex[j + 1] = a
        return ex

    def buy_mult(self, rule, s, e):
        ex = self.plan(rule, s, e)
        units = DAILY * (self.P[e + 1] - self.P[s])
        inv = DAILY * (e - s + 1)
        nav = self.nav
        for i, a in ex.items():
            units += a / nav[i]
            inv += a
        return units * nav[e] / inv

    def cash_need(self, rule):
        """全期間で合図どおりに買ったときの、1年(245営業日)で要った追加の現金の最大(日ごとの累積最大)と、年平均"""
        ex = self.plan(rule, 0, self.N - 1)
        arr = [0.0] * self.N
        for i, a in ex.items():
            arr[i] = a
        best = run = 0.0
        peak_by_day = [0.0] * self.N
        for i in range(self.N):
            run += arr[i]
            if i >= Y1:
                run -= arr[i - Y1]
            best = max(best, run)
            peak_by_day[i] = best
        return best, sum(arr) / (self.N / Y1), peak_by_day

    # ---------- 売り ----------
    def sell_cond(self, k):
        """相場の条件(自分の持ち分に関係ない部分)が満たされる日。gain は毎日 True(含み益で判定)"""
        f, *v = k
        nav, N = self.nav, self.N
        if f == "yr":
            return [self.yr[i] >= v[0] for i in range(N)]
        if f == "ma":
            return [self.ma[i] is not None and nav[i] >= self.ma[i] * (1 + v[0]) for i in range(N)]
        if f == "rsi":
            return [i >= 14 and self.rsi[i] >= v[0] for i in range(N)]
        if f == "tr":
            # 直近20日のどこかで1年前の m 倍以上になっていて、そこから20日高値比で y 以上下げた日
            hit = [self.yr[i] >= v[0] for i in range(N)]
            dd = self.dd[20]
            out, last_hit = [False] * N, -(10**9)
            for i in range(N):
                if hit[i]:
                    last_hit = i
                out[i] = i - last_hit <= 20 and dd[i] <= -v[1]
            return out
        return [True] * N

    def sell_mult(self, cond, gain_k, frac, rb, s, e, ex):
        """app.js の simulateSell と同じ動き。最後に全部売ったときの税引後の資産 ÷ 自分で入れたお金"""
        nav = self.nav
        rebuy = self.rebuy[rb] if rb else None
        units = cost = cash = inv = 0.0
        last = -(10**9)
        for i in range(s, e + 1):
            p = nav[i]
            a = ex.get(i, 0)
            fc = cash if cash < a else a
            cash -= fc
            inv += DAILY + a - fc
            units += (DAILY + a) / p
            cost += DAILY + a
            if cash > 0 and i > s and rebuy[i - 1]:
                r = cash * REBUY_FRAC
                cash -= r
                units += r / p
                cost += r
            if last == i - 1 and units > 0:
                u, c = units * frac, cost * frac
                cash += u * p - max(0.0, u * p - c) * TAX
                units -= u
                cost -= c
            if cond is not None and cond[i] and units * p >= cost * gain_k and i - last > SELL_GAP:
                last = i
        val = units * nav[e]
        return (val - max(0.0, val - cost) * TAX + cash) / inv


def pick(keys, score, smooth, families):
    return max(keys, key=lambda k: (smooth[k], score[k]))


def smooth_of(score, families):
    return {k: st.mean(score[n] for n in neighbors(k, families) if n in score) for k in score}


def family_rows(res, elig, families, pack, why_out):
    """種類ごとのいちばん良い条件。選べる条件がない種類は、選ばなかった中でいちばん良いものと、その理由を出す"""
    rows = []
    for fam, spec in families.items():
        ks = [k for k in elig if k[0] == fam]
        tested = sum(1 for k in res if k[0] == fam)
        pool = ks or [k for k in res if k[0] == fam]
        b = max(pool, key=lambda k: (res[k]["smooth"], res[k]["score"]))
        rows.append({"family": fam, "name": spec["name"], "best": pack(res[b]), "excluded": None if ks else why_out(res[b]), "tested": tested})
    rows.sort(key=lambda r: (r["excluded"] is not None, -r["best"]["smooth"]))
    return rows


def walk_summary(wf):
    ch = [x for x in wf if not x["is_current"]]
    win = sum(x["med"] > 0.0001 for x in ch)
    lose = sum(x["med"] < -0.0001 for x in ch)
    return {"years": wf, "n": len(wf), "changed": len(ch), "win": win, "lose": lose, "med": round(st.median([x["med"] for x in wf]), 4) if wf else 0}


def optimize_buy(M):
    fams = BUY_FAMILIES
    starts = {L: list(range(Y1, M.N - L, 21)) for L in (Y3, Y5)}
    real_s = M.real0 + 10  # 2018年1月〜(実際の基準価額だけ)
    res = {}
    for k in all_keys(fams):
        rule = M.buy_rule(k)
        mult = {L: [M.buy_mult(rule, s, s + L) for s in starts[L]] for L in starts}
        peak, avg, peak_by_day = M.cash_need(rule)
        res[k] = dict(k=k, mult=mult, peak=peak, avg=avg, peak_by_day=peak_by_day, real=M.buy_mult(rule, real_s, M.N - 1), signals=len(rule["days"]))
    ck = CUR_BUY
    cur = res[ck]

    def ratios(r, L, idx=None):
        ix = range(len(starts[L])) if idx is None else idx
        return [r["mult"][L][i] / cur["mult"][L][i] for i in ix]

    for r in res.values():
        r["m3"] = summarize(ratios(r, Y3))
        r["m5"] = summarize(ratios(r, Y5))
        r["score"] = r["m5"]["med"]
    sm = smooth_of({k: r["score"] for k, r in res.items()}, fams)
    for k, r in res.items():
        r["smooth"] = sm[k]
    tol = cur["peak"] * BUY_CASH_TOL
    elig = [k for k, r in res.items() if r["peak"] <= tol and r["m5"]["worst"] >= BUY_MAX_WORST]
    best_k = pick(elig, {k: res[k]["score"] for k in res}, sm, fams)
    best = res[best_k]

    # ウォークフォワード: 年ごとに、その年より前に終わる期間だけで同じ選び方をして、その年に始まる3年で今のルールと比べる
    wf = []
    for y in sorted(M.year_start):
        y0 = M.year_start[y]
        test = [i for i, s in enumerate(starts[Y3]) if y0 <= s < M.year_start.get(y + 1, M.N)]
        train5 = [i for i, s in enumerate(starts[Y5]) if s + Y5 < y0]
        if len(train5) < 24 or not test:
            continue
        sc = {k: st.median(ratios(r, Y5, train5)) - 1 for k, r in res.items()}
        smy = smooth_of(sc, fams)
        tol_y = cur["peak_by_day"][y0 - 1] * BUY_CASH_TOL
        el = [k for k in res if res[k]["peak_by_day"][y0 - 1] <= tol_y and min(ratios(res[k], Y5, train5)) - 1 >= BUY_MAX_WORST]
        c = pick(el, sc, smy, fams)
        rs = ratios(res[c], Y3, test)
        wf.append({"year": y, "choice": buy_label(c), "family": c[0], "same": c == best_k, "is_current": c == ck, "med": round(st.median(rs) - 1, 4)})
    walk = walk_summary(wf)

    reasons = []
    ok = best_k != ck
    if not ok:
        reasons.append("試したルールの中で、今のルールがいちばん良い(まわりの条件も含めた成績)")
    else:
        nb_worst = min(res[n]["m5"]["worst"] for n in neighbors(best_k, fams))
        checks = [
            (best["m5"]["med"] >= BUY_MIN_GAIN, f"5年の差が中央値 {best['m5']['med'] * 100:+.1f}% で、+{BUY_MIN_GAIN * 100:.0f}% に届かない"),
            (best["smooth"] - cur["smooth"] >= MIN_SMOOTH_GAIN, f"まわりの条件も含めた成績では、今のルールとの差が {(best['smooth'] - cur['smooth']) * 100:+.1f}%しかない(たまたま良かった可能性)"),
            (nb_worst >= BUY_NEIGHBOR_WORST, f"条件を少し変えると(隣の条件のどれか)5年で今のルールにいちばん負けた回が {nb_worst * 100:+.0f}% になる。とがった結果で、たまたまの可能性がある"),
            (best["m5"]["win"] >= BUY_MIN_WIN5, f"5年で勝ったのが {best['m5']['win'] * 100:.0f}% で、{BUY_MIN_WIN5 * 100:.0f}% に届かない"),
            (best["m3"]["win"] >= BUY_MIN_WIN3, f"3年で勝ったのが {best['m3']['win'] * 100:.0f}% で、{BUY_MIN_WIN3 * 100:.0f}% に届かない"),
            (not (walk["win"] + walk["lose"]) or walk["win"] / (walk["win"] + walk["lose"]) >= WF_MIN_WIN, f"過去の確かめ(下)で、選び直したルールが今のルールに {walk['win']}勝{walk['lose']}敗と負け越した。いま良く見えるのは、たまたまの可能性がある"),
        ]
        for passed, msg in checks:
            if not passed:
                ok = False
                reasons.append(msg)
        if ok:
            reasons.append("今のルールより成績が良く、必要な現金も今のルール並みで、過去のデータだけで選び直す確認でも勝ち越した")

    def pack(r):
        return {
            "label": buy_label(r["k"]),
            "family": r["k"][0],
            "key": list(r["k"]),
            "y3": r["m3"],
            "y5": r["m5"],
            "smooth": round(r["smooth"], 4),
            "cash_peak": round(r["peak"]),
            "cash_avg": round(r["avg"]),
            "real_mult": round(r["real"], 3),
            "signals": r["signals"],
        }

    top = sorted(elig, key=lambda k: (res[k]["smooth"], res[k]["score"]), reverse=True)[:5]
    return {
        "current": pack(cur),
        "best": pack(best),
        "top": [pack(res[k]) for k in top],
        "families": family_rows(res, elig, fams, pack, lambda r: "現金が要りすぎる" if r["peak"] > tol else "負けた回の負け方が大きい"),
        "tested": len(res),
        "eligible": len(elig),
        "verdict": "change" if ok else "keep",
        "reasons": reasons,
        "walk": walk,
        "windows": {"y3": len(starts[Y3]), "y5": len(starts[Y5]), "step_days": 21},
    }


def optimize_sell(M):
    fams = SELL_FAMILIES
    starts = {L: list(range(Y1, M.N - L, 61)) for L in (Y3, Y5)}
    brule = M.buy_rule(CUR_BUY)
    ex = {(L, s): M.plan(brule, s, s + L) for L in starts for s in starts[L]}
    never = {L: [M.sell_mult(None, 1, 0, None, s, s + L, ex[(L, s)]) for s in starts[L]] for L in starts}
    real_s = M.real0 + 10
    real_ex = M.plan(brule, real_s, M.N - 1)
    real_never = M.sell_mult(None, 1, 0, None, real_s, M.N - 1, real_ex)
    res = {}
    condcache = {}
    for k in all_keys(fams):
        f, *v = k
        frac, rb = v[-2], v[-1]
        ckey = (f, *v[:-2])
        if ckey not in condcache:
            condcache[ckey] = M.sell_cond(k)
        cond = condcache[ckey]
        gk = v[0] if f == "gain" else 1.0
        mult = {L: [M.sell_mult(cond, gk, frac, rb, s, s + L, ex[(L, s)]) for s in starts[L]] for L in starts}
        r = dict(k=k, mult=mult, real=M.sell_mult(cond, gk, frac, rb, real_s, M.N - 1, real_ex))
        r["m3"] = summarize([a / b for a, b in zip(mult[Y3], never[Y3])])
        r["m5"] = summarize([a / b for a, b in zip(mult[Y5], never[Y5])])
        r["score"] = r["m5"]["med"]
        res[k] = r
    sm = smooth_of({k: r["score"] for k, r in res.items()}, fams)
    for k, r in res.items():
        r["smooth"] = sm[k]
    ck = CUR_SELL
    cur = res[ck]
    elig = [k for k, r in res.items() if r["m5"]["worst"] >= SELL_MAX_WORST]
    if ck not in elig:
        elig.append(ck)
    best_k = pick(elig, {k: res[k]["score"] for k in res}, sm, fams)
    best = res[best_k]

    # ウォークフォワード: その年より前に終わる5年の期間だけで同じ選び方をして、その年に始まる3年で今のルールと比べる
    wf = []
    for y in sorted(M.year_start):
        y0 = M.year_start[y]
        train = [i for i, s in enumerate(starts[Y5]) if s + Y5 < y0]
        test = [i for i, s in enumerate(starts[Y3]) if y0 <= s < M.year_start.get(y + 1, M.N)]
        if len(train) < 8 or not test:
            continue
        rel = {k: [r["mult"][Y5][i] / never[Y5][i] for i in train] for k, r in res.items()}
        s1 = {k: st.median(v) - 1 for k, v in rel.items()}
        smy = smooth_of(s1, fams)
        wk = [k for k in res if min(rel[k]) - 1 >= SELL_MAX_WORST]
        if ck not in wk:
            wk.append(ck)
        c = pick(wk, s1, smy, fams)
        d = st.median([res[c]["mult"][Y3][i] / cur["mult"][Y3][i] for i in test]) - 1
        wf.append({"year": y, "choice": sell_label(c), "family": c[0], "same": c == best_k, "is_current": c == ck, "med": round(d, 4)})
    walk = walk_summary(wf)

    reasons = []
    ok = best_k != ck
    gain = best["m5"]["med"] - cur["m5"]["med"]
    if not ok:
        reasons.append("試したルールの中で、今のルールがいちばん良い(まわりの条件も含めた成績)")
    else:
        nb_worst = min(res[n]["m5"]["worst"] for n in neighbors(best_k, fams))
        lose_b = 1 - best["m5"]["win"] - best["m5"]["tie"]
        lose_c = 1 - cur["m5"]["win"] - cur["m5"]["tie"]
        checks = [
            (gain >= SELL_MIN_GAIN, f"「売らない」との差(5年の中央値)が今のルールより {gain * 100:+.1f}ポイントで、+{SELL_MIN_GAIN * 100:.0f}ポイントに届かない"),
            (best["smooth"] - cur["smooth"] >= MIN_SMOOTH_GAIN, f"まわりの条件も含めた成績では、今のルールとの差が {(best['smooth'] - cur['smooth']) * 100:+.1f}ポイントしかない(たまたま良かった可能性)"),
            (nb_worst >= SELL_NEIGHBOR_WORST, f"条件を少し変えると(隣の条件のどれか)5年でいちばん負けた回が {nb_worst * 100:+.0f}% になる。とがった結果で、たまたまの可能性がある"),
            (lose_b <= lose_c + 0.05, f"5年で「売らない」に負けた回が {lose_b * 100:.0f}% で、今のルール({lose_c * 100:.0f}%)より増える"),
            (not (walk["win"] + walk["lose"]) or walk["win"] / (walk["win"] + walk["lose"]) >= WF_MIN_WIN, f"過去の確かめ(下)で、選び直したルールが今のルールに {walk['win']}勝{walk['lose']}敗と負け越した。いま良く見えるのは、たまたまの可能性がある"),
        ]
        for passed, msg in checks:
            if not passed:
                ok = False
                reasons.append(msg)
        if ok:
            reasons.append("今のルールより成績が良く、負けた回の負け方も大きくなく、過去のデータだけで選び直す確認でも勝ち越した")

    def pack(r):
        return {"label": sell_label(r["k"]), "family": r["k"][0], "key": [round(x, 4) if isinstance(x, float) else x for x in r["k"]], "y3": r["m3"], "y5": r["m5"], "smooth": round(r["smooth"], 4), "real_mult": round(r["real"], 3)}

    top = sorted(elig, key=lambda k: (res[k]["smooth"], res[k]["score"]), reverse=True)[:5]
    return {
        "current": pack(cur),
        "best": pack(best),
        "top": [pack(res[k]) for k in top],
        "families": family_rows(res, elig, fams, pack, lambda r: "負けた回の負け方が大きい"),
        "never_real_mult": round(real_never, 3),
        "tested": len(res),
        "eligible": len(elig),
        "verdict": "change" if ok else "keep",
        "reasons": reasons,
        "walk": walk,
        "windows": {"y3": len(starts[Y3]), "y5": len(starts[Y5]), "step_days": 61},
    }


def script_hash():
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()[:12]


def main():
    args = set(sys.argv[1:])
    check, force = "--check" in args, "--force" in args
    M = Market()
    data_end = M.dates[-1]
    ver = script_hash()
    prev = None
    if OUT_PATH.exists():
        try:
            prev = json.loads(OUT_PATH.read_text())
        except ValueError:
            prev = None
    if prev and not force and not check and prev.get("data_end") == data_end and prev.get("script") == ver:
        print(f"{data_end} の基準価額では計算済みです(変更なし)")
        return
    t0 = time.time()
    buy = optimize_buy(M)
    t1 = time.time()
    sell = optimize_sell(M)
    t2 = time.time()
    print(f"追加買い {buy['tested']}通り {t1 - t0:.0f}秒 / 売り {sell['tested']}通り {t2 - t1:.0f}秒")
    for name, r in (("追加買い", buy), ("売り", sell)):
        print(f"[{name}] 今のルール: {r['current']['label']}  5年 {r['current']['y5']}")
        print(f"[{name}] いちばん良い: {r['best']['label']}  5年 {r['best']['y5']}  なだらか {r['best']['smooth']}")
        print(f"[{name}] 判定: {r['verdict']} — {' / '.join(r['reasons'])}")
        print(f"[{name}] ウォークフォワード: 選び直した {r['walk']['changed']}/{r['walk']['n']}年, 勝ち {r['walk']['win']} 負け {r['walk']['lose']}")
        for fr in r["families"]:
            b = fr["best"]
            print(f"   {fr['name']:24} {b['label']}  3年{b['y3']['med']:+.3f} 5年{b['y5']['med']:+.3f} 勝{b['y5']['win']:.2f} 最悪{b['y5']['worst']:+.3f} なだらか{b['smooth']:+.3f} 実{b['real_mult']}" + (f"  ※選ばない: {fr['excluded']}" if fr["excluded"] else ""))

    history = (prev or {}).get("history", [])
    history = [h for h in history if h.get("data_end") != data_end]
    entry = {"data_end": data_end, "buy": buy["best"]["label"], "buy_verdict": buy["verdict"], "sell": sell["best"]["label"], "sell_verdict": sell["verdict"]}
    history.append(entry)
    history = history[-120:]
    last_change = (prev or {}).get("best_since", {})
    since = {}
    for key in ("buy", "sell"):
        old = last_change.get(key)
        since[key] = old if old and old.get("label") == entry[key] else {"label": entry[key], "date": data_end}
    out = {
        "fund": "SBI日本株4.3ブル",
        "data_start": M.dates[0],
        "real_start": M.dates[M.real0],
        "data_end": data_end,
        "computed": datetime.now(JST).strftime("%Y-%m-%dT%H:%M+09:00"),
        "script": ver,
        "seconds": round(t2 - t0),
        "buy": buy,
        "sell": sell,
        "best_since": since,
        "history": history,
    }
    if check:
        print("確認のみ: optimize.json は書きません")
        return
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"{OUT_PATH} を書きました")


if __name__ == "__main__":
    main()
