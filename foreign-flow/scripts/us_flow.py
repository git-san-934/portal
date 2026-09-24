"""米国株の需給(fetch_flow.py から呼ぶ)。

米国には日本の「投資部門別売買状況」や「空売り残高報告(0.5%以上)」にあたる公表がないので、無料で取れる次のデータで代わりに判定する。
- 空売り残高(FINRA、月2回): 全米の空売り残高(株数)。浮動株数で割って割合にする。直近 SHORT_PERIODS 回分の推移。
- 浮動株数・機関投資家の保有(Yahoo Finance、yfinance 経由): 浮動株数は us_shares.json にためて月1回だけ取り直す。
- 株価・出来高(Yahoo Finance): S&P 500(SPY)比の騰落率。
- 貸株料(Interactive Brokers の公開FTP、usa.txt): 日本株と同じく参考値。
- 海外投資家の米国株の売買(米財務省 TIC の SLT Table 1、月次・約7週遅れ): 市場全体。

対象は、持ち株(holdings/data/check.json の米ドル建て)、watchlist.json の英字のティッカー、S&P 500。
「米国株ベスト5」は S&P 500 から選ぶ。
"""

import json
import re
import time
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf

SP500_CSV = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv"
FINRA_SHORT = "https://cdn.finra.org/equity/otcmarket/biweekly/shrt{}.csv"
TIC_URL = "https://ticdata.treasury.gov/Publish/slt_table1.txt"
SPX_ETF = "SPY"  # S&P 500 連動ETF。S&P 500 比の騰落率に使う
SHORT_PERIODS = 14  # 空売り残高を遡る回数(月2回 × 7か月。26週チャートと13週の変化に足りる)
SHARES_MAX_AGE = 30  # 浮動株数を取り直すまでの日数
SHARES_PER_RUN = 600  # 1回の実行で浮動株数を取りに行く銘柄数の上限(S&P 500 が1回で埋まる。以後は月1回の取り直しだけ)
INST_MAX = 8  # 表示する機関投資家の数

# 米国外の主な運用会社・政府系ファンド(機関投資家の一覧で「海外」と表示するため)
FOREIGN_INST = [
    "NORGES", "UBS", "BARCLAYS", "HSBC", "DEUTSCHE", "DWS", "AMUNDI", "BNP", "CREDIT AGRICOLE", "SOCIETE GENERALE",
    "ROYAL BANK OF CANADA", "RBC", "TORONTO-DOMINION", "BANK OF MONTREAL", "CANADA PENSION", "CPP INVESTMENT", "BRITISH COLUMBIA",
    "MITSUBISHI", "NOMURA", "SUMITOMO", "MIZUHO", "LEGAL & GENERAL", "BAILLIE GIFFORD", "SCHRODER", "ABRDN", "AVIVA",
    "GOVERNMENT OF SINGAPORE", "GIC", "TEMASEK", "ABU DHABI", "SAUDI", "QATAR", "PICTET", "ALLIANZ", "AXA", "NATIXIS",
    "MANULIFE", "SUN LIFE", "MACQUARIE", "ROBECO", "NORDEA", "SWEDBANK", "HANDELSBANKEN", "ZURCHER", "ZÜRCHER",
    "SWISS NATIONAL", "BANK OF NOVA SCOTIA", "CIBC", "CAISSE DE DEPOT", "APG", "PGGM", "OPTIVER",
]


def us_key(sym):
    """ティッカーの表記ゆれ(BRK-B / BRK.B / BRK B / BRK/B)をそろえる"""
    return re.sub(r"[\s\-/]+", ".", str(sym or "").strip().upper())


def is_us_code(code):
    return bool(re.fullmatch(r"[A-Z][A-Z0-9.]{0,7}", code or ""))


def yf_symbol(key):
    return key.replace(".", "-")


# ---------------------------------------------------------------------------
# 対象銘柄
# ---------------------------------------------------------------------------


def load_us_targets(holdings_path, watch_path, log):
    holdings, watch = {}, {}
    try:
        check = json.loads(Path(holdings_path).read_text(encoding="utf-8"))
        for s in check.get("stocks", []):
            if (s.get("currency") or "JPY") == "USD":
                holdings[us_key(s["code"])] = s.get("name") or ""
    except (OSError, ValueError) as e:
        log(f"持ち株リストを読めませんでした: {e}")
    try:
        wl = json.loads(Path(watch_path).read_text(encoding="utf-8"))
        for s in wl.get("stocks", []):
            k = us_key(s.get("code"))
            if is_us_code(k):
                watch[k] = s.get("name") or ""
    except (OSError, ValueError) as e:
        log(f"watchlist.json を読めませんでした: {e}")
    return holdings, watch


def fetch_sp500(get, log):
    """S&P 500 の構成銘柄 {key: {name, sector}}"""
    import io

    df = pd.read_csv(io.StringIO(get(SP500_CSV).text), dtype=str)
    out = {us_key(r["Symbol"]): {"name": str(r.get("Security") or ""), "sector": str(r.get("GICS Sector") or "")} for _, r in df.iterrows()}
    log(f"S&P 500: {len(out)} 銘柄")
    return out


# ---------------------------------------------------------------------------
# 空売り残高(FINRA)
# ---------------------------------------------------------------------------


def settlement_candidates(today, n):
    """FINRA の空売り残高の基準日(15日と月末。休日なら前の営業日)を新しい順に、候補日のリストで返す"""
    out = []
    y, m = today.year, today.month
    while len(out) < n + 2:
        last = (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1))
        for base in (last, date(y, m, 15)):
            if base <= today:
                out.append([base - timedelta(days=k) for k in range(5) if (base - timedelta(days=k)).weekday() < 5])
        y, m = (y, m - 1) if m > 1 else (y - 1, 12)
    return out


def load_finra_file(get, cache_dir, d):
    """1回分の空売り残高 {key: (株数, 平均出来高, 空売り日数)}。まだ公表されていなければ None"""
    ds = d.strftime("%Y%m%d")
    path = Path(cache_dir) / f"finra_shrt{ds}.csv"
    if path.exists() and path.stat().st_size > 0:
        text = path.read_text(encoding="utf-8")
    else:
        try:
            r = get(FINRA_SHORT.format(ds), retries=1)
        except RuntimeError:
            return None
        text = r.text
        if not text.startswith("accountingYearMonthNumber"):
            return None
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    out = {}
    lines = text.splitlines()
    cols = {name: j for j, name in enumerate(lines[0].split("|"))}
    for line in lines[1:]:
        c = line.split("|")
        if len(c) < len(cols) or c[cols["marketClassCode"]] == "OTC":
            continue
        try:
            qty = float(c[cols["currentShortPositionQuantity"]] or 0)
        except ValueError:
            continue
        try:
            adv = float(c[cols["averageDailyVolumeQuantity"]] or 0)
        except ValueError:
            adv = 0.0
        try:
            dtc = float(c[cols["daysToCoverQuantity"]] or 0)
        except ValueError:
            dtc = None
        out[us_key(c[cols["symbolCode"]])] = (qty, adv, dtc)
    return out


def fetch_us_shorts(get, cache_dir, today, log):
    """直近 SHORT_PERIODS 回分の空売り残高 [(基準日, {key: (株数, 平均出来高, 空売り日数)})](古い順)"""
    periods = []
    for cands in settlement_candidates(today, SHORT_PERIODS):
        for d in cands:
            data = load_finra_file(get, cache_dir, d)
            if data:
                periods.append((d, data))
                break
        if len(periods) >= SHORT_PERIODS:
            break
    periods.sort(key=lambda p: p[0])
    if not periods:
        raise RuntimeError("FINRA の空売り残高を1回分も取得できませんでした")
    log(f"FINRA 空売り残高: {len(periods)} 回分 ({periods[0][0]} 〜 {periods[-1][0]})")
    return periods


# ---------------------------------------------------------------------------
# 浮動株数・機関投資家(Yahoo Finance)
# ---------------------------------------------------------------------------


def update_shares(path, keys, detail_keys, log):
    """浮動株数などを path(us_shares.json)にため、{key: {...}} を返す。detail_keys は機関投資家の一覧も取る銘柄"""
    try:
        cache = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cache = {}
    today = date.today()
    stale = lambda k: k not in cache or (today - date.fromisoformat(cache[k].get("date", "2000-01-01"))).days >= SHARES_MAX_AGE  # noqa: E731
    order = [k for k in keys if k in detail_keys] + [k for k in keys if k not in detail_keys and stale(k)]
    order = list(dict.fromkeys(order))
    fetched, failed = 0, 0
    for k in order:
        if k not in detail_keys and fetched >= SHARES_PER_RUN:
            continue
        need_info = stale(k)
        if not need_info and k not in detail_keys:
            continue
        try:
            t = yf.Ticker(yf_symbol(k))
            v = dict(cache.get(k, {}))
            if need_info:
                info = t.info or {}
                out_sh, fl = info.get("sharesOutstanding"), info.get("floatShares")
                # 浮動株数が発行済株式数の5%未満など、明らかにおかしいときは発行済株式数を使う
                if not fl or (out_sh and fl < out_sh * 0.05):
                    fl = out_sh
                v.update({"float": fl, "inst": info.get("heldPercentInstitutions"), "name": info.get("shortName") or "", "date": today.isoformat()})
                fetched += 1
            if k in detail_keys:
                v["holders"] = institutional(t)
            cache[k] = v
        except Exception as e:  # noqa: BLE001 — yfinance は色々な例外を投げる
            failed += 1
            log(f"  {k}: 浮動株数を取得できませんでした ({e})")
        time.sleep(0.15)
    keep = set(keys)
    cache = {k: v for k, v in sorted(cache.items()) if k in keep}
    Path(path).write_text(
        "{\n" + ",\n".join(f"{json.dumps(k)}:{json.dumps(v, ensure_ascii=False, separators=(',', ':'))}" for k, v in cache.items()) + "\n}\n",
        encoding="utf-8",
    )
    log(f"浮動株数: {len(cache)} 銘柄(今回 {fetched} 件取得、失敗 {failed} 件)")
    return cache


def institutional(t):
    """機関投資家の上位(13F、四半期)。[{who, pct, chg, date, foreign}]"""
    try:
        df = t.institutional_holders
    except Exception:  # noqa: BLE001
        return []
    if df is None or df.empty:
        return []
    out = []
    for _, r in df.head(INST_MAX).iterrows():
        who = str(r.get("Holder") or "")
        pct, chg = r.get("pctHeld"), r.get("pctChange")
        d = r.get("Date Reported")
        out.append(
            {
                "who": who,
                "pct": round(float(pct) * 100, 2) if pct is not None and pct == pct else None,
                "chg": round(float(chg) * 100, 1) if chg is not None and chg == chg else None,
                "date": pd.Timestamp(d).strftime("%Y-%m-%d") if d is not None and d == d else None,
                "foreign": any(f in who.upper() for f in FOREIGN_INST),
            }
        )
    return out


# ---------------------------------------------------------------------------
# 海外投資家の米国株の売買(米財務省 TIC、月次)
# ---------------------------------------------------------------------------


def fetch_tic(get, log, previous=None):
    """海外投資家による米国株の月次の買い越し(+)・売り越し(−)と保有額(億ドル)。[{month, net, hold, jp}]

    TIC の SLT Table 1 の「U.S. Corp. Equity」の Net U.S. Sales(米国居住者から海外への売却 = 海外の買い越し)。
    jp は日本の投資家の分。
    """
    months = {m["month"]: m for m in (previous or [])}
    cols = None
    rows = {}
    for line in get(TIC_URL).text.splitlines():
        c = [x.strip().strip('"') for x in line.split("\t")]
        if c and c[0] == "country":
            cols = {name: j for j, name in enumerate(c)}
            continue
        if cols is None or len(c) < len(cols) or not re.fullmatch(r"\d{4}-\d{2}", c[cols["date"]]):
            continue
        if c[cols["country_code"]] not in ("99996", "42609"):  # 全体、日本
            continue
        try:
            net, hold = float(c[cols["for_lt_eqty_net"]]), float(c[cols["for_lt_eqty_pos"]])
        except ValueError:
            continue
        rows.setdefault(c[cols["date"]], {})[c[cols["country_code"]]] = (net, hold)
    if cols is None:
        raise RuntimeError("TIC の見出し行が見つかりません")
    for m, v in rows.items():
        if "99996" not in v:
            continue
        net, hold = v["99996"]
        months[m] = {"month": m, "net": round(net / 100, 1), "hold": round(hold / 100)}
        if "42609" in v:
            months[m]["jp"] = round(v["42609"][0] / 100, 1)
    out = sorted(months.values(), key=lambda x: x["month"])[-36:]
    log(f"TIC: 月次 {len(out)} 件" + (f"、最新 {out[-1]['month']} {out[-1]['net']}億ドル" if out else ""))
    return out
