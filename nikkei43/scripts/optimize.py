#!/usr/bin/env python3
"""日経4.3ブルの「買い時・売り時」の条件を、最新の基準価額で毎日見直す。

data/nav.json(実際の基準価額)と data/nikkei_1996-2017.json(それより前の仮の基準価額を作るための日経平均)から
1996年〜今日までの基準価額を作り、追加買い(暴落買い)と売りの条件をいくつも試して、今のルールと比べる。
結果は data/optimize.json に書き、ページの「条件の毎日見直し」に出す。ページの実際のルールは変えない。

たまたま当たった条件を選ばないための工夫:
  1. 開始日を少しずつずらした多数の期間(3年・5年)で比べ、中央値と勝った割合で見る
  2. その条件のまわり(隣の条件)も平均した「なだらかな成績」で選ぶ(1点だけ飛び抜けた条件は選ばれにくい)
  3. 追加買いは、今のルールより多くの現金が要る条件は選ばない(現金を多く入れれば成績が上がるのは当たり前なので)
  4. ウォークフォワード: 各年について「その年より前のデータだけで選んだ条件」が、その年から3年で今のルールに勝ったかを確かめる
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
CUR_BUY = {"w": 20, "t1": -0.30, "cap": 2000000}
CUR_SELL = {"mult": 3.0, "frac": 0.25, "rebuy": -0.20}
BIG_FALLBACK = 100000
EPISODE_GAP = 60
SELL_GAP = 20
REBUY_FRAC = 0.1
MA_DAYS = 200

# ---------- 試す条件 ----------
# 追加買い: 何日の高値から測るか × 最初の段階の下落率(残りの段階は −10・−20・−40ポイント下に同じ間隔で並べる) × 大口買いの上限
BUY_GRID = {
    "w": [10, 15, 20, 30, 40],
    "t1": [-0.20, -0.25, -0.30, -0.35, -0.40],
    "cap": [1000000, 2000000, 3000000],
}
TIER_AMOUNTS = [(0.0, 30000, False), (-0.10, 60000, False), (-0.20, 300000, True), (-0.40, 500000, True)]
# 売り: 1年前の何倍で売るか × 売る割合 × 200日平均から何%安い日に買い戻すか
SELL_GRID = {
    "mult": [2.0, 2.5, 3.0, 3.5, 4.0],
    "frac": [0.2, 0.25, 1 / 3],
    "rebuy": [-0.10, -0.20, -0.30],
}

# 見直し候補にする基準
BUY_MIN_GAIN = 0.02  # 5年の差(中央値)が +2% 以上
BUY_MIN_WIN5 = 0.60
BUY_MIN_WIN3 = 0.55
BUY_CASH_TOL = 1.10  # 1年で要る追加の現金は今のルールの1.1倍まで
SELL_MIN_GAIN = 0.03  # 「売らない」との差(5年の中央値)が今のルールより +3ポイント以上
SELL_MAX_WORST = -0.10  # 5年でいちばん負けた回が −10% より悪いものは選ばない
MIN_SMOOTH_GAIN = 0.015  # まわりの条件も含めた成績でも、今のルールより +1.5ポイント以上
WF_MIN_WIN = 0.50  # ウォークフォワードで、選び直した条件が今のルールに勝った割合(引き分けを除く)


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


def rolling_dd(nav, w):
    out = [0.0] * len(nav)
    from collections import deque

    q = deque()
    for i, v in enumerate(nav):
        while q and nav[q[-1]] <= v:
            q.pop()
        q.append(i)
        if q[0] <= i - w:
            q.popleft()
        out[i] = v / nav[q[0]] - 1
    return out


def neighbors(key, grid):
    names = list(grid)
    idx = [grid[n].index(key[i]) for i, n in enumerate(names)]
    out = [key]
    for d in range(len(names)):
        for step in (-1, 1):
            j = idx[d] + step
            if 0 <= j < len(grid[names[d]]):
                k = list(key)
                k[d] = grid[names[d]][j]
                out.append(tuple(k))
    return out


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


class Market:
    def __init__(self):
        self.dates, self.nav, self.real0 = load()
        self.N = len(self.nav)
        nav = self.nav
        self.P = [0.0] * (self.N + 1)  # 1口あたりの逆数の累積(毎日の積立の口数を一気に出す)
        for i, v in enumerate(nav):
            self.P[i + 1] = self.P[i] + 1 / v
        self.dd = {w: rolling_dd(nav, w) for w in BUY_GRID["w"]}
        self.ma = [None] * self.N
        s = 0.0
        for i, v in enumerate(nav):
            s += v
            if i >= MA_DAYS:
                s -= nav[i - MA_DAYS]
            if i >= MA_DAYS - 1:
                self.ma[i] = s / MA_DAYS
        self.yr = [nav[i] / nav[i - Y1] if i >= Y1 else 0.0 for i in range(self.N)]
        self.year_start = {}
        for i, d in enumerate(self.dates):
            self.year_start.setdefault(int(d[:4]), i)

    # ---------- 追加買い ----------
    def signals(self, p):
        """その条件で合図が出る日と段階の一覧(日付順)"""
        dd = self.dd[p["w"]]
        ths = [p["t1"] + off for off, _, _ in TIER_AMOUNTS]
        days, tiers = [], []
        for j, x in enumerate(dd):
            if x <= ths[0]:
                t = 0
                for k in range(1, len(ths)):
                    if x <= ths[k]:
                        t = k
                days.append(j)
                tiers.append(t)
        return days, tiers

    def plan(self, sig, cap, s, e):
        """s〜e-1 の合図から、翌営業日の追加額 {買う日: 金額} を作る(大口は1回の暴落で cap まで)"""
        days, tiers = sig
        ex = {}
        used, last = 0, -(10**9)
        for n in range(bisect.bisect_left(days, s), bisect.bisect_left(days, e)):
            j, t = days[n], tiers[n]
            _, a, big = TIER_AMOUNTS[t]
            if big:
                if j - last > EPISODE_GAP:
                    used = 0
                last = j
                b = min(a, max(0, cap - used))
                used += b
                a = max(b, BIG_FALLBACK)
            ex[j + 1] = a
        return ex

    def buy_mult(self, sig, cap, s, e):
        ex = self.plan(sig, cap, s, e)
        units = DAILY * (self.P[e + 1] - self.P[s])
        inv = DAILY * (e - s + 1)
        nav = self.nav
        for i, a in ex.items():
            units += a / nav[i]
            inv += a
        return units * nav[e] / inv

    def cash_need(self, sig, cap):
        """全期間で合図どおりに買ったときの、1年(245営業日)で要った追加の現金の最大と、年平均"""
        ex = self.plan(sig, cap, 0, self.N - 1)
        arr = [0.0] * self.N
        for i, a in ex.items():
            arr[i] = a
        best = run = 0.0
        peak_by_day = [0.0] * self.N  # その日までの最大(ウォークフォワード用)
        for i in range(self.N):
            run += arr[i]
            if i >= Y1:
                run -= arr[i - Y1]
            best = max(best, run)
            peak_by_day[i] = best
        return best, sum(arr) / (self.N / Y1), peak_by_day

    # ---------- 売り ----------
    def sell_mult(self, sp, s, e, ex):
        """app.js の simulateSell と同じ動き。最後に全部売ったときの税引後の資産 ÷ 自分で入れたお金"""
        nav, yr, ma = self.nav, self.yr, self.ma
        mult, frac, rb = sp["mult"], sp["frac"], sp["rebuy"]
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
            if cash > 0 and i > s:
                m = ma[i - 1]
                if m is not None and nav[i - 1] < m * (1 + rb):
                    r = cash * REBUY_FRAC
                    cash -= r
                    units += r / p
                    cost += r
            if last == i - 1 and units > 0:
                u, c = units * frac, cost * frac
                cash += u * p - max(0.0, u * p - c) * TAX
                units -= u
                cost -= c
            if mult and yr[i] >= mult and units * p >= cost and i - last > SELL_GAP:
                last = i
        val = units * nav[e]
        return (val - max(0.0, val - cost) * TAX + cash) / inv


def keyname(p, grid):
    return tuple(p[k] for k in grid)


def buy_label(p):
    t = [round((p["t1"] + off) * 100) for off, _, _ in TIER_AMOUNTS]
    return f"{p['w']}日高値から {t[0]}%/{t[1]}%/{t[2]}%/{t[3]}%・大口の上限 {p['cap'] // 10000}万円"


def sell_label(p):
    f = {0.2: "1/5", 0.25: "1/4", 1 / 3: "1/3"}.get(p["frac"], f"{p['frac']:.2f}")
    return f"1年前の{p['mult']:g}倍で{f}を売る・200日平均{round(p['rebuy'] * 100)}%で買い戻す"


def optimize_buy(M):
    grid = BUY_GRID
    cands = [dict(w=w, t1=t1, cap=cap) for w in grid["w"] for t1 in grid["t1"] for cap in grid["cap"]]
    starts = {L: list(range(Y1, M.N - L, 21)) for L in (Y3, Y5)}
    sigcache = {}
    res = {}
    for p in cands:
        sk = (p["w"], p["t1"])
        if sk not in sigcache:
            sigcache[sk] = M.signals(p)
        sig = sigcache[sk]
        mult = {L: [M.buy_mult(sig, p["cap"], s, s + L) for s in starts[L]] for L in starts}
        peak, avg, peak_by_day = M.cash_need(sig, p["cap"])
        real_s = M.real0 + 10  # 2018年1月〜(実際の基準価額だけ)
        res[keyname(p, grid)] = dict(p=p, mult=mult, peak=peak, avg=avg, peak_by_day=peak_by_day, real=M.buy_mult(sig, p["cap"], real_s, M.N - 1))
    cur = res[keyname(CUR_BUY, grid)]

    def ratios(r, L, idx=None):
        ix = range(len(starts[L])) if idx is None else idx
        return [r["mult"][L][i] / cur["mult"][L][i] for i in ix]

    def score(r, idx5=None):
        rs = ratios(r, Y5, idx5)
        return st.median(rs) - 1 if rs else 0.0

    for k, r in res.items():
        r["m3"] = summarize(ratios(r, Y3))
        r["m5"] = summarize(ratios(r, Y5))
        r["score"] = r["m5"]["med"]
    for k, r in res.items():
        r["smooth"] = st.mean(res[n]["score"] for n in neighbors(k, grid))
    tol = cur["peak"] * BUY_CASH_TOL
    elig = [k for k, r in res.items() if r["peak"] <= tol]
    best_k = max(elig, key=lambda k: (res[k]["smooth"], res[k]["score"]))
    best = res[best_k]

    # ウォークフォワード: 年ごとに、その年より前に終わる期間だけで同じ選び方をして、その年に始まる3年で今のルールと比べる
    wf = []
    for y in sorted(M.year_start):
        y0 = M.year_start[y]
        test = [i for i, s in enumerate(starts[Y3]) if M.year_start[y] <= s < M.year_start.get(y + 1, M.N)]
        train5 = [i for i, s in enumerate(starts[Y5]) if s + Y5 < y0]
        if len(train5) < 24 or not test:
            continue
        sc = {k: score(r, train5) for k, r in res.items()}
        sm = {k: st.mean(sc[n] for n in neighbors(k, grid)) for k in res}
        tol_y = cur["peak_by_day"][y0 - 1] * BUY_CASH_TOL
        el = [k for k in res if res[k]["peak_by_day"][y0 - 1] <= tol_y]
        ck = max(el, key=lambda k: (sm[k], sc[k]))
        rs = ratios(res[ck], Y3, test)
        wf.append({"year": y, "choice": buy_label(res[ck]["p"]), "same": ck == best_k, "is_current": ck == keyname(CUR_BUY, grid), "med": round(st.median(rs) - 1, 4)})
    changed_years = [x for x in wf if not x["is_current"]]
    wf_win = sum(x["med"] > 0.0001 for x in changed_years)
    wf_lose = sum(x["med"] < -0.0001 for x in changed_years)
    walk = {
        "years": wf,
        "n": len(wf),
        "changed": len(changed_years),
        "win": wf_win,
        "lose": wf_lose,
        "med": round(st.median([x["med"] for x in wf]), 4) if wf else 0,
    }

    reasons = []
    ok = best_k != keyname(CUR_BUY, grid)
    if not ok:
        reasons.append("試した条件の中で、今のルールがいちばん良い(まわりの条件も含めた成績)")
    else:
        if best["m5"]["med"] < BUY_MIN_GAIN:
            ok = False
            reasons.append(f"5年の差が中央値 {best['m5']['med'] * 100:+.1f}% で、+{BUY_MIN_GAIN * 100:.0f}% に届かない")
        if best["smooth"] - cur["smooth"] < MIN_SMOOTH_GAIN:
            ok = False
            reasons.append(f"まわりの条件も含めた成績では、今のルールとの差が {(best['smooth'] - cur['smooth']) * 100:+.1f}%しかない(たまたま良かった可能性)")
        if best["m5"]["win"] < BUY_MIN_WIN5:
            ok = False
            reasons.append(f"5年で勝ったのが {best['m5']['win'] * 100:.0f}% で、{BUY_MIN_WIN5 * 100:.0f}% に届かない")
        if best["m3"]["win"] < BUY_MIN_WIN3:
            ok = False
            reasons.append(f"3年で勝ったのが {best['m3']['win'] * 100:.0f}% で、{BUY_MIN_WIN3 * 100:.0f}% に届かない")
        decided = wf_win + wf_lose
        if decided and wf_win / decided < WF_MIN_WIN:
            ok = False
            reasons.append(f"過去の確かめ(下)で、選び直した条件が今のルールに {wf_win}勝{wf_lose}敗と負け越した。いま良く見えるのは、たまたまの可能性がある")
        if ok:
            reasons.append("今のルールより成績が良く、必要な現金も今のルール並みで、過去のデータだけで選び直す確認でも勝ち越した")

    def pack(r):
        return {
            "label": buy_label(r["p"]),
            "params": r["p"],
            "y3": r["m3"],
            "y5": r["m5"],
            "smooth": round(r["smooth"], 4),
            "cash_peak": round(r["peak"]),
            "cash_avg": round(r["avg"]),
            "real_mult": round(r["real"], 3),
        }

    top = sorted(elig, key=lambda k: (res[k]["smooth"], res[k]["score"]), reverse=True)[:5]
    big = sorted(res, key=lambda k: res[k]["score"], reverse=True)[0]
    return {
        "current": pack(cur),
        "best": pack(best),
        "top": [pack(res[k]) for k in top],
        "most_cash": pack(res[big]) if big not in elig else None,
        "tested": len(res),
        "eligible": len(elig),
        "verdict": "change" if ok else "keep",
        "reasons": reasons,
        "walk": walk,
        "windows": {"y3": len(starts[Y3]), "y5": len(starts[Y5]), "step_days": 21},
    }


def optimize_sell(M):
    grid = SELL_GRID
    cands = [dict(mult=m, frac=f, rebuy=r) for m in grid["mult"] for f in grid["frac"] for r in grid["rebuy"]]
    starts = {L: list(range(Y1, M.N - L, 61)) for L in (Y3, Y5)}
    sig = M.signals(CUR_BUY)
    ex = {(L, s): M.plan(sig, CUR_BUY["cap"], s, s + L) for L in starts for s in starts[L]}
    never = {L: [M.sell_mult({"mult": 0, "frac": 0, "rebuy": -1}, s, s + L, ex[(L, s)]) for s in starts[L]] for L in starts}
    real_s = M.real0 + 10
    real_ex = M.plan(sig, CUR_BUY["cap"], real_s, M.N - 1)
    real_never = M.sell_mult({"mult": 0, "frac": 0, "rebuy": -1}, real_s, M.N - 1, real_ex)
    res = {}
    for p in cands:
        mult = {L: [M.sell_mult(p, s, s + L, ex[(L, s)]) for s in starts[L]] for L in starts}
        r = dict(p=p, mult=mult, real=M.sell_mult(p, real_s, M.N - 1, real_ex))
        r["m3"] = summarize([a / b for a, b in zip(mult[Y3], never[Y3])])
        r["m5"] = summarize([a / b for a, b in zip(mult[Y5], never[Y5])])
        r["score"] = r["m5"]["med"]
        res[keyname(p, grid)] = r
    for k, r in res.items():
        r["smooth"] = st.mean(res[n]["score"] for n in neighbors(k, grid))
    ck = keyname(CUR_SELL, grid)
    cur = res[ck]
    elig = [k for k, r in res.items() if r["m5"]["worst"] >= SELL_MAX_WORST]
    if ck not in elig:
        elig.append(ck)
    best_k = max(elig, key=lambda k: (res[k]["smooth"], res[k]["score"]))
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
        sm = {k: st.mean(s1[n] for n in neighbors(k, grid)) for k in res}
        wk = [k for k in res if min(rel[k]) - 1 >= SELL_MAX_WORST]
        if ck not in wk:
            wk.append(ck)
        choice = max(wk, key=lambda k: (sm[k], s1[k]))
        d = st.median([res[choice]["mult"][Y3][i] / cur["mult"][Y3][i] for i in test]) - 1
        wf.append({"year": y, "choice": sell_label(res[choice]["p"]), "same": choice == best_k, "is_current": choice == ck, "med": round(d, 4)})
    ch = [x for x in wf if not x["is_current"]]
    wf_win = sum(x["med"] > 0.0001 for x in ch)
    wf_lose = sum(x["med"] < -0.0001 for x in ch)
    walk = {"years": wf, "n": len(wf), "changed": len(ch), "win": wf_win, "lose": wf_lose, "med": round(st.median([x["med"] for x in wf]), 4) if wf else 0}

    reasons = []
    ok = best_k != ck
    gain = best["m5"]["med"] - cur["m5"]["med"]
    if not ok:
        reasons.append("試した条件の中で、今のルールがいちばん良い(まわりの条件も含めた成績)")
    else:
        if gain < SELL_MIN_GAIN:
            ok = False
            reasons.append(f"「売らない」との差(5年の中央値)が今のルールより {gain * 100:+.1f}ポイントで、+{SELL_MIN_GAIN * 100:.0f}ポイントに届かない")
        if best["smooth"] - cur["smooth"] < MIN_SMOOTH_GAIN:
            ok = False
            reasons.append(f"まわりの条件も含めた成績では、今のルールとの差が {(best['smooth'] - cur['smooth']) * 100:+.1f}ポイントしかない(たまたま良かった可能性)")
        lose_b = 1 - best["m5"]["win"] - best["m5"]["tie"]
        lose_c = 1 - cur["m5"]["win"] - cur["m5"]["tie"]
        if lose_b > lose_c + 0.05:
            ok = False
            reasons.append(f"5年で「売らない」に負けた回が {lose_b * 100:.0f}% で、今のルール({lose_c * 100:.0f}%)より増える")
        decided = wf_win + wf_lose
        if decided and wf_win / decided < WF_MIN_WIN:
            ok = False
            reasons.append(f"過去の確かめ(下)で、選び直した条件が今のルールに {wf_win}勝{wf_lose}敗と負け越した。いま良く見えるのは、たまたまの可能性がある")
        if ok:
            reasons.append("今のルールより成績が良く、負けた回の負け方も大きくなく、過去のデータだけで選び直す確認でも勝ち越した")

    def pack(r):
        return {"label": sell_label(r["p"]), "params": {**r["p"], "frac": round(r["p"]["frac"], 4)}, "y3": r["m3"], "y5": r["m5"], "smooth": round(r["smooth"], 4), "real_mult": round(r["real"], 3)}

    top = sorted(elig, key=lambda k: (res[k]["smooth"], res[k]["score"]), reverse=True)[:5]
    return {
        "current": pack(cur),
        "best": pack(best),
        "top": [pack(res[k]) for k in top],
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

    history = (prev or {}).get("history", [])
    history = [h for h in history if h.get("data_end") != data_end]
    entry = {"data_end": data_end, "buy": buy["best"]["label"], "buy_verdict": buy["verdict"], "sell": sell["best"]["label"], "sell_verdict": sell["verdict"]}
    history.append(entry)
    history = history[-120:]
    last_change = (prev or {}).get("best_since", {})
    since = {}
    for key in ("buy", "sell"):
        old = last_change.get(key)
        cur_label = entry[key]
        since[key] = old if old and old.get("label") == cur_label else {"label": cur_label, "date": data_end}
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
