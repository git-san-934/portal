"""過去最高値ブレイク検証のデータを作る。

1. tse-price-db の latest.json から時価総額上位の銘柄を選ぶ(取得できなければ前回の universe.json を使う)
2. yfinance(Yahoo Finance)から、取得できる最も古い日からの日次終値(株式分割のみ調整)を取得する
3. 「過去最高値ブレイク」を判定し、その後の値動き(騰落率・TOPIX比の超過リターン・最大下落率・推移)を計算する
4. ../data/ に events.json(ブレイク一覧と集計用の値)と stocks/<code>.json(週足チャート用)を書き出す

GitHub Actions(.github/workflows/update-ath-breakout.yml)から定期実行される。
取得できた銘柄が少なすぎるときは既存のデータを上書きせずに終了コード1で終わる。
"""

import json
import math
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

LATEST_URL = "https://git-san-934.github.io/tse-price-db/data/latest.json"
UNIVERSE_SIZE = 500  # 時価総額上位この数の銘柄を対象にする
BENCH = ("1306", "TOPIX連動ETF(1306)")  # 超過リターンの比較対象

# ---- ブレイクの定義 ----
MIN_HISTORY = 60  # 上場(データ開始)からこの営業日数(約3ヶ月)たつまでは判定しない
MIN_GAP = 60  # 前回の最高値からこの営業日数(約3ヶ月)以上あいた更新だけを1回のブレイクとして数える
HORIZONS = [5, 20, 60, 120, 250]  # 1週 / 1ヶ月 / 3ヶ月 / 6ヶ月 / 1年後(営業日)
PATH_OFFSETS = [-60, -40, -20, -10, -5, 0, 5, 10, 20, 40, 60, 90, 120, 150, 180, 210, 250]
DD_WINDOW = 250  # ブレイク後の最大下落率・再更新を見る期間

BATCH = 100
RETRIES = 3
MIN_OK_RATIO = 0.8  # 対象銘柄のうちこの割合以上取得できなければ失敗とみなす
OUTLIER_WINDOW = 11
OUTLIER_RATIO = 2.0
# 東証の値幅制限では1日にこれを超える値動きは起きないので、株式分割の調整漏れ(Yahoo 側の誤データ)とみなす
SPLIT_DOWN = 0.6
SPLIT_UP = 1.67

# ---- 評価マーク(上・中・下)----
# ブレイク後の株価が「ブレイクした日の終値」と「その後の最高値」からどれだけ離れたかで決める
RATE_FAIL = -0.05  # ブレイクした日の終値をこれより下回ったら「下」(ブレイク失敗)
RATE_NEAR = -0.05  # ブレイク価格以上で、その後の最高値からの下落がこれ以内なら「上」
RATE_CHECK = [20, 40, 60]  # 検証: ブレイクから1・2・3ヶ月後に判定し、そこから1年後(250営業日)の成績を見る

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
SALES_RECENT_DAYS = 100  # この日数(暦日)以内にブレイクした銘柄の売上を取る(画面の「いま最高値を更新中」用)
SALES_REFRESH_DAYS = 7  # 取得してからこの日数たつまでは取り直さない
JST = timezone(timedelta(hours=9))

# ---------- 有望度の順位の記録と成績表(PDCA) ----------
# 画面の「いま最高値を更新中の銘柄」の有望度(app.js の promiseRanks)と同じ決め方で毎日の順位を記録し、
# あとから実際の値動き(TOPIX比)と照らし合わせる。決め方を変えたら RANK_RULES に1行足す
RANK_RULES = [
    ["2026-09-26", "営業利益+50%以上の伸びに4点、売上の伸び(20%/10%/5%以上)に6/4/2点、評価マーク 上1・中0.5・下0点。銀行・保険は別に順位"],
]
RECENT_DAYS = 92  # 「いま最高値を更新中」とみなすブレイクからの暦日(app.js と同じ)
REVIEW_TOP = 5  # 成績表で「上位」とする順位
REVIEW_HORIZONS = [20, 60]  # 記録した日から何営業日後(約1ヶ月・3ヶ月)の成績を見るか
RANK_HISTORY_PATH = DATA_DIR / "rank_history.json"


# ---------- 対象銘柄 ----------

def norm_code(code):
    """latest.json は JPX の5桁コード(例: 72030, 285A0)なので、Yahoo で使う4桁(7203, 285A)にそろえる"""
    code = str(code).strip().removesuffix(".T")
    return code[:4] if len(code) == 5 and code.endswith("0") else code


def load_universe():
    cache = DATA_DIR / "universe.json"
    try:
        req = urllib.request.Request(LATEST_URL, headers={"User-Agent": "portal-ath-breakout"})
        with urllib.request.urlopen(req, timeout=60) as res:
            items = json.load(res).get("items", [])
        items = [
            it for it in items
            if it.get("code") and isinstance(it.get("market_cap"), (int, float))
            and it.get("market") != "その他"  # ETF・外国株など
            and not any(k in str(it.get("market", "")) for k in ("ETF", "ETN", "REIT", "インフラ"))
        ]
        items.sort(key=lambda it: it["market_cap"], reverse=True)
        universe = [
            {"code": norm_code(it["code"]), "name": it.get("name", ""),
             "market": it.get("market", ""), "market_cap": it["market_cap"]}
            for it in items[:UNIVERSE_SIZE]
        ]
        if len(universe) < UNIVERSE_SIZE // 2:
            raise RuntimeError(f"too few items in latest.json: {len(universe)}")
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(universe, ensure_ascii=False, indent=0) + "\n", encoding="utf-8")
        return universe
    except Exception as e:  # noqa: BLE001
        print(f"latest.json を取得できませんでした({e})。前回の universe.json を使います", file=sys.stderr)
        universe = json.loads(cache.read_text(encoding="utf-8"))
        for u in universe:
            u["code"] = norm_code(u["code"])
        return universe


# ---------- 株価取得 ----------

def download(codes):
    frames = []
    for i in range(0, len(codes), BATCH):
        tickers = [f"{c}.T" for c in codes[i:i + BATCH]]
        last_err = None
        for attempt in range(1, RETRIES + 1):
            try:
                df = yf.download(
                    tickers, period="max", interval="1d",
                    auto_adjust=False,  # 終値は株式分割のみ調整(配当は調整しない)
                    actions=False, progress=False, threads=True,
                )
                if not df.empty:
                    close = df["Close"]
                    if isinstance(close, pd.Series):
                        close = close.to_frame(tickers[0])
                    frames.append(close)
                    break
                last_err = "empty result"
            except Exception as e:  # noqa: BLE001 — yfinance は色々な例外を投げる
                last_err = e
            print(f"batch {i // BATCH} attempt {attempt} failed: {last_err}", file=sys.stderr)
            time.sleep(10 * attempt)
        time.sleep(2)
    if not frames:
        raise RuntimeError("download failed")
    close = pd.concat(frames, axis=1, sort=True).sort_index()
    close.columns = [str(c).removesuffix(".T") for c in close.columns]
    return close


def drop_outliers(series):
    med = series.rolling(OUTLIER_WINDOW, center=True, min_periods=3).median()
    ratio = series / med
    bad = (ratio > OUTLIER_RATIO) | (ratio < 1 / OUTLIER_RATIO)
    return series[~bad]


def fix_splits(series):
    """分割の調整漏れで値が段差のように飛んでいるところは、それより前の値をまとめて掛け直す
    (例: 1306 の 2014年ごろのデータが分割前の値のまま残っていた)"""
    r = series / series.shift(1)
    factor = pd.Series(1.0, index=series.index)
    for d, v in r[(r < SPLIT_DOWN) | (r > SPLIT_UP)].items():
        factor[factor.index < d] *= v
    return series * factor


def clean(series):
    return fix_splits(drop_outliers(series))


def grade(price, breakout_price, max_since):
    """評価マーク。上=ブレイク価格以上で最高値の近くを保っている / 下=ブレイク価格を5%超下回った / 中=その間"""
    if price / breakout_price - 1 < RATE_FAIL:
        return "下"
    if price >= breakout_price and price / max_since - 1 >= RATE_NEAR:
        return "上"
    return "中"


# ---------- ブレイク判定と、その後の値動き ----------

def r4(v):
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else round(float(v), 4)


def find_events(s, bench, samples):
    """s: 1銘柄の終値(欠損なし、日付昇順)。bench: TOPIX連動ETFの終値(同じ日付に前方補完済み)。"""
    vals = s.to_numpy()
    dates = s.index
    b = bench.reindex(dates).ffill().to_numpy() if bench is not None else None
    n = len(vals)
    events = []
    run_max = vals[0]
    last_high_idx = 0  # 直近で最高値を付けた日
    for t in range(1, n):
        v = vals[t]
        if v <= run_max:
            continue
        gap = t - last_high_idx
        prev_high = run_max
        run_max = v
        last_high_idx = t
        if t < MIN_HISTORY or gap < MIN_GAP:
            if events:
                events[-1]["highs"] += 1  # 直前のブレイクからの上昇局面で最高値を更新した日数
                events[-1]["last_high"] = dates[t].strftime("%Y-%m-%d")
            continue

        ev = {
            "date": dates[t].strftime("%Y-%m-%d"),
            "price": round(float(v), 2),
            "gap": int(gap),  # 前回の最高値から何営業日ぶりの更新か
            "prev_date": dates[t - gap].strftime("%Y-%m-%d"),
            "above": r4(v / prev_high - 1),  # 前回の最高値を何%上抜けたか
            "highs": 1,
            "last_high": dates[t].strftime("%Y-%m-%d"),
        }
        ret, exc = [], []
        for h in HORIZONS:
            if t + h < n:
                r = vals[t + h] / v - 1
                ret.append(r4(r))
                if b is not None and not math.isnan(b[t]) and not math.isnan(b[t + h]):
                    exc.append(r4(r - (b[t + h] / b[t] - 1)))
                else:
                    exc.append(None)
            else:
                ret.append(None)
                exc.append(None)
        ev["ret"] = ret
        ev["exc"] = exc

        window = vals[t + 1:t + 1 + DD_WINDOW]
        complete = len(window) == DD_WINDOW
        ev["mdd"] = r4(window.min() / v - 1) if complete else None  # 1年以内の最大下落率
        ev["mup"] = r4(window.max() / v - 1) if complete else None  # 1年以内の最大上昇率

        # ブレイク日=100 とした推移(株価とTOPIX比)。整数(×10)で持って容量を減らす
        path, rel = [], []
        for off in PATH_OFFSETS:
            j = t + off
            if 0 <= j < n:
                path.append(round(vals[j] / v * 1000))
                if b is not None and not math.isnan(b[j]) and not math.isnan(b[t]):
                    rel.append(round((vals[j] / v) / (b[j] / b[t]) * 1000))
                else:
                    rel.append(None)
            else:
                path.append(None)
                rel.append(None)
        ev["path"] = path
        ev["rel"] = rel
        events.append(ev)

        # 評価マークの検証用: ブレイクから k 日後に判定 → そこから1年後の成績
        for k in RATE_CHECK:
            j = t + k
            if j + DD_WINDOW >= n:
                continue
            fwd = vals[j + DD_WINDOW] / vals[j] - 1
            bx = None
            if b is not None and not math.isnan(b[j]) and not math.isnan(b[j + DD_WINDOW]):
                bx = fwd - (b[j + DD_WINDOW] / b[j] - 1)
            samples.append({"date": ev["date"], "grade": grade(vals[j], v, vals[t:j + 1].max()), "ret": fwd, "exc": bx})
    return events


def weekly(s):
    """週足(金曜締め)の終値。日付は start から7日ずつなので値だけ持つ(取引のない週は null)"""
    w = s.resample("W-FRI").last()
    return w.index[0].strftime("%Y-%m-%d"), [None if math.isnan(v) else round(float(v), 1) for v in w]


def print_summary(events):
    """Actions のログで結果をざっと確認するための集計(画面と同じ中央値・勝率)"""
    for gap in (MIN_GAP, 250, 750):
        evs = [e for e in events if e["gap"] >= gap]
        print(f"-- 前回の最高値から{gap}営業日以上: {len(evs)}件")
        for i, h in enumerate(HORIZONS):
            r = sorted(e["ret"][i] for e in evs if e["ret"][i] is not None)
            x = sorted(e["exc"][i] for e in evs if e["exc"][i] is not None)
            if not r:
                continue
            med = lambda v: v[len(v) // 2] * 100 if v else float("nan")
            win = lambda v: sum(1 for a in v if a > 0) / len(v) * 100 if v else float("nan")
            print(f"   {h:>3}営業日後: 中央値 {med(r):+.1f}% 上昇 {win(r):.0f}% / TOPIX比 中央値 {med(x):+.1f}% 勝ち {win(x):.0f}% ({len(r)}件)")


def summarize_rating(samples):
    """評価マークごとの、判定から1年後の成績(全期間と、前半・後半)"""
    def stats(rows):
        r = sorted(x["ret"] for x in rows)
        e = sorted(x["exc"] for x in rows if x["exc"] is not None)
        if not r:
            return None
        return {
            "n": len(r),
            "median": r4(r[len(r) // 2]),
            "mean": r4(sum(r) / len(r)),
            "win": r4(sum(1 for v in r if v > 0) / len(r)),
            "exc_median": r4(e[len(e) // 2]) if e else None,
            "exc_win": r4(sum(1 for v in e if v > 0) / len(e)) if e else None,
        }

    periods = {"all": lambda d: True, "early": lambda d: d < "2013-01-01", "late": lambda d: d >= "2013-01-01"}
    out = {"check_days": RATE_CHECK, "horizon": DD_WINDOW, "grades": {}}
    for g in ("上", "中", "下"):
        out["grades"][g] = {name: stats([x for x in samples if x["grade"] == g and f(x["date"])]) for name, f in periods.items()}
    print("-- 評価マークの検証(ブレイク1〜3ヶ月後に判定 → 1年後)")
    for g, v in out["grades"].items():
        for name in periods:
            st = v[name]
            if st:
                exc = f"TOPIX比 中央値 {st['exc_median'] * 100:+.1f}% 勝ち {st['exc_win'] * 100:.0f}%" if st["exc_median"] is not None else ""
                print(f"   {g} {name:5}: n{st['n']:5d} 中央値 {st['median'] * 100:+.1f}% 平均 {st['mean'] * 100:+.1f}% 上昇 {st['win'] * 100:.0f}% {exc}")
    return out


def fetch_sales(codes, today):
    """年次の売上高(yfinance の損益計算書、直近4〜5期)。data/sales.json にためて、古いものだけ取り直す"""
    path = DATA_DIR / "sales.json"
    try:
        cache = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        cache = {}
    fetched = 0
    for code in sorted(codes):
        old = cache.get(code)
        if old and old.get("fetched", "") >= (today - timedelta(days=SALES_REFRESH_DAYS)).isoformat():
            continue
        try:
            inc = yf.Ticker(f"{code}.T").income_stmt
            row = inc.loc["Total Revenue"].dropna().sort_index() if "Total Revenue" in inc.index else pd.Series(dtype=float)
            annual = [[d.strftime("%Y-%m"), float(v)] for d, v in row.items() if v > 0]
        except Exception as e:  # noqa: BLE001
            print(f"  売上 {code}: {e}", file=sys.stderr)
            continue
        cache[code] = {"fetched": today.isoformat(), "annual": annual}
        fetched += 1
        time.sleep(0.5)
    path.write_text(
        "{\n" + ",\n".join(f"  {json.dumps(k)}: {json.dumps(v, separators=(',', ':'))}" for k, v in sorted(cache.items())) + "\n}\n",
        encoding="utf-8",
    )
    print(f"売上: {len(codes)} 銘柄中 {fetched} 銘柄を新たに取得")
    return cache


def sales_summary(entry):
    """画面用: 決算期ごとの売上と、直近期の前年比"""
    annual = (entry or {}).get("annual") or []
    if not annual:
        return None
    growth = r4(annual[-1][1] / annual[-2][1] - 1) if len(annual) >= 2 and annual[-2][1] > 0 else None
    return {"annual": annual, "growth": growth}


def load_history():
    """有価証券報告書から集めた決算データ(fetch_sales_history.py が作る)"""
    try:
        return json.loads((DATA_DIR / "sales_history.json").read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def op_summary(rec):
    """画面用: 直近の決算期の営業利益の前年比と、営業利益率(とその前年からの変化)。
    連結と単体を混ぜないよう、比べる数字どうしが同じ種類(連結/単体)のときだけ計算する"""
    op = {p: v for p, v in (rec or {}).get("op", {}).items() if v is not None}
    if not op:
        return None
    op_src = rec.get("op_src", {})
    sales, sales_src = rec.get("annual", {}), rec.get("src", {})
    kind = lambda s: (s or "")[:2]  # "連結" / "単体"
    p = max(op)
    y, m = map(int, p.split("-"))
    q = f"{y - 1:04d}-{m:02d}"

    def margin(x):
        if x in op and sales.get(x) and kind(op_src.get(x)) == kind(sales_src.get(x)):
            return op[x] / sales[x]
        return None

    growth = r4(op[p] / op[q] - 1) if op.get(q, 0) > 0 and kind(op_src.get(p)) == kind(op_src.get(q)) else None
    mp, mq = margin(p), margin(q)
    return {
        "period": p,
        "growth": growth,
        "margin": r4(mp) if mp is not None else None,
        "margin_change": r4(mp - mq) if mp is not None and mq is not None else None,
    }


def is_finance_code(code):
    """証券コード 8300〜8799 は銀行・証券・保険・その他金融(経常収益を使わない損保・生保もここで拾う)"""
    return code.isdigit() and 8300 <= int(code) < 8800


def financial_codes(hist):
    """銀行・保険など、売上高の代わりに「経常収益」を出している会社(有価証券報告書から集めた sales_history.json で判定)。
    金利で売上の伸び方が大きく変わるので、画面の有望度の順位は他の業種と分けて付ける"""
    codes = set()
    for code, rec in hist.items():
        src = rec.get("src") or {}
        if src and "OrdinaryIncome" in (src[max(src)] or ""):
            codes.add(code)
    return codes


def promise_ranks(events, stock_map):
    """app.js の promiseRanks と同じ点数で順位をつける。返り値 [(code, 順位, 銀行・保険か)]"""
    def score(e):
        st = stock_map[e["code"]]
        g = (st.get("sales") or {}).get("growth")
        tier = 0 if g is None else 3 if g >= 0.2 else 2 if g >= 0.1 else 1 if g >= 0.05 else 0
        op = (st.get("op") or {}).get("growth")
        gr = grade(st["last"], e["price"], st["ath"])
        return (4 if op is not None and op >= 0.5 else 0) + tier * 2 + {"上": 1, "中": 0.5, "下": 0}[gr], g if g is not None else -1e9

    out = []
    for fin in (False, True):
        group = [e for e in events if bool(stock_map[e["code"]].get("financial")) == fin]
        group.sort(key=lambda e: (-score(e)[0], -score(e)[1], e["code"]))
        out += [(e["code"], i + 1, fin) for i, e in enumerate(group)]
    return out


def record_ranks(all_events, stocks, series, bench):
    """今日の順位を rank_history.json に足し、過去に記録した順位のその後の成績(TOPIX比)を集計する"""
    stock_map = {st["code"]: st for st in stocks}
    latest = max(st["last_date"] for st in stocks)
    since = (datetime.fromisoformat(latest) - timedelta(days=RECENT_DAYS)).date().isoformat()
    by_code = {}
    for e in sorted(all_events, key=lambda e: e["date"]):
        if e["date"] >= since and e["gap"] >= MIN_GAP and e["code"] in stock_map:
            by_code[e["code"]] = e
    hist = {}
    try:
        hist = json.loads(RANK_HISTORY_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    hist[latest] = {
        "rules": RANK_RULES[-1][0],
        "rows": [[c, r, int(f), stock_map[c]["last"]] for c, r, f in promise_ranks(list(by_code.values()), stock_map)],
    }
    RANK_HISTORY_PATH.write_text(
        "{\n" + ",\n".join(f"  {json.dumps(d)}: {json.dumps(v, ensure_ascii=False, separators=(',', ':'))}"
                            for d, v in sorted(hist.items())) + "\n}\n",
        encoding="utf-8",
    )

    # 成績表: 記録した日の終値から h 営業日後の終値までの騰落率 − 同じ期間のTOPIX
    review = {"start": min(hist), "days": len(hist), "top": REVIEW_TOP, "rules": RANK_RULES, "horizons": {}}
    if bench is None:
        return review
    for h in REVIEW_HORIZONS:
        groups = {"top": [], "rest": [], "fin": []}
        dates = []
        for d, snap in sorted(hist.items()):
            bi = bench.index.searchsorted(datetime.fromisoformat(d))
            if bi + h >= len(bench):
                continue
            b = float(bench.iloc[bi + h] / bench.iloc[bi] - 1)
            end = bench.index[bi + h]
            dates.append(d)
            for code, rank, fin, _ in snap["rows"]:
                s = series.get(code)
                if s is None:
                    continue
                i = s.index.searchsorted(datetime.fromisoformat(d))
                if i >= len(s) or s.index[i] != bench.index[bi] or end not in s.index:
                    continue
                x = float(s[end] / s.iloc[i] - 1) - b
                groups["fin" if fin else "top" if rank <= REVIEW_TOP else "rest"].append(x)
        review["horizons"][str(h)] = {
            "days": len(dates),
            "first": dates[0] if dates else None,
            "last": dates[-1] if dates else None,
            **{k: {"n": len(v), "mean": r4(sum(v) / len(v)) if v else None,
                   "win": r4(sum(x > 0 for x in v) / len(v)) if v else None} for k, v in groups.items()},
        }
    return review


def main():
    universe = load_universe()
    codes = [u["code"] for u in universe]
    close = download(codes + [BENCH[0]])

    bench = close[BENCH[0]].dropna() if BENCH[0] in close.columns else None
    if bench is not None:
        bench = clean(bench)
    else:
        print("TOPIX連動ETFを取得できなかったため、超過リターンは空になります", file=sys.stderr)

    stocks_dir = DATA_DIR / "stocks"
    stocks_dir.mkdir(parents=True, exist_ok=True)

    all_events = []
    samples = []
    stocks = []
    series = {}  # code -> 補正済みの終値(順位の成績表用)
    ok = 0
    for u in universe:
        code = u["code"]
        if code not in close.columns:
            continue
        s = clean(close[code].dropna())
        if len(s) < 50:
            continue
        ok += 1
        series[code] = s
        evs = find_events(s, bench, samples)
        for ev in evs:
            ev["code"] = code
        all_events.extend(evs)

        vals = s.to_numpy()
        ath_idx = int(vals.argmax())
        last = float(vals[-1])
        stocks.append({
            "code": code,
            "name": u["name"],
            "market_cap": u["market_cap"],
            "first_date": s.index[0].strftime("%Y-%m-%d"),
            "last_date": s.index[-1].strftime("%Y-%m-%d"),
            "last": round(last, 2),
            "ath": round(float(vals[ath_idx]), 2),
            "ath_date": s.index[ath_idx].strftime("%Y-%m-%d"),
            "from_ath": r4(last / vals[ath_idx] - 1),  # 最高値から何%下にいるか
            "days": len(s),
            "events": len(evs),
        })
        wk_start, wk = weekly(s)
        (stocks_dir / f"{code}.json").write_text(
            json.dumps({"code": code, "name": u["name"], "start": wk_start, "weekly": wk,
                        "events": [ev["date"] for ev in evs]},
                       ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )

    print(f"{ok}/{len(universe)} 銘柄を取得、ブレイク {len(all_events)} 件")
    print_summary(all_events)

    today = datetime.now(JST).date()
    since = (today - timedelta(days=SALES_RECENT_DAYS)).isoformat()
    recent = {e["code"] for e in all_events if e["date"] >= since}
    try:
        sales = fetch_sales(recent, today)
    except Exception as e:  # noqa: BLE001 — 売上が取れなくても株価のデータは更新する
        print(f"売上を取得できませんでした: {e}", file=sys.stderr)
        sales = {}
    hist = load_history()
    financial = financial_codes(hist)
    for st in stocks:
        if st["code"] in recent:
            st["sales"] = sales_summary(sales.get(st["code"]))
            if st["code"] not in financial and not is_finance_code(st["code"]):
                st["op"] = op_summary(hist.get(st["code"]))
        if st["code"] in financial or "銀行" in st["name"] or is_finance_code(st["code"]):
            st["financial"] = True
    rating = summarize_rating(samples)
    if ok < len(universe) * MIN_OK_RATIO:
        print("取得できた銘柄が少なすぎるため events.json を更新しません", file=sys.stderr)
        sys.exit(1)

    all_events.sort(key=lambda e: (e["date"], e["code"]))
    rank_review = record_ranks(all_events, stocks, series, bench)
    out = {
        "generated_at": datetime.now(JST).isoformat(timespec="minutes"),
        "source": "Yahoo Finance (yfinance)",
        "benchmark": BENCH[1] if bench is not None else None,
        "rules": {"min_history": MIN_HISTORY, "min_gap": MIN_GAP, "universe": len(universe),
                  "rate_fail": RATE_FAIL, "rate_near": RATE_NEAR},
        "rating": rating,
        "rank_review": rank_review,
        "horizons": HORIZONS,
        "path_offsets": PATH_OFFSETS,
        "stocks": stocks,
        "events": all_events,
    }
    # 1件1行にして差分を読みやすくする
    head = {k: v for k, v in out.items() if k not in ("stocks", "events")}
    lines = ["{"]
    lines += [f"  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False, separators=(',', ':'))}," for k, v in head.items()]
    for key in ("stocks", "events"):
        lines.append(f'  "{key}": [')
        lines.append(",\n".join("    " + json.dumps(x, ensure_ascii=False, separators=(",", ":")) for x in out[key]))
        lines.append("  ]," if key == "stocks" else "  ]")
    lines.append("}")
    (DATA_DIR / "events.json").write_text("\n".join(lines) + "\n", encoding="utf-8")

    # 対象から外れた銘柄のチャートファイルを消す
    keep = {f"{s['code']}.json" for s in stocks}
    for f in stocks_dir.glob("*.json"):
        if f.name not in keep:
            f.unlink()
    print(f"wrote {DATA_DIR / 'events.json'}")


if __name__ == "__main__":
    main()
