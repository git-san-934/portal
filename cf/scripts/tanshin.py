"""決算短信のサマリーの数字(fetch_tanshin.py が読んだ (要素名, コンテキスト, 値) の並び)から、
投資分析ページの「最新の決算短信」の節の数字を作る。金額は億円(小数1桁)、1株あたりは円、比率は％。
"""

import re
import unicodedata

VERSION = 1  # tanshin.json の作り方の版。上げると手元の短信から作り直す

# 会計基準ごとに末尾が IFRS・US などと変わるので、末尾を外した名前で探す
SUFFIX_RE = re.compile(r"(IFRS|US|JMIS)$")
FIELDS = {
    "sales": ["NetSales", "Sales", "OperatingRevenues", "Revenues", "Revenue", "OrdinaryRevenues", "NetSalesAndOperatingRevenues"],
    "opinc": ["OperatingIncome", "OperatingProfit"],
    "ord": ["OrdinaryIncome"],
    "pretax": ["ProfitBeforeTax", "IncomeBeforeIncomeTaxes"],
    "net": ["ProfitAttributableToOwnersOfParent", "NetIncomeAttributableToOwnersOfParent", "NetIncome", "Profit"],
    "eps": ["NetIncomePerShare", "BasicEarningsPerShare", "BasicEarningsPerShareAttributableToOwnersOfParent"],
}
STOCKS = {
    "assets": ["TotalAssets"],
    "equity": ["OwnersEquity", "EquityAttributableToOwnersOfParent"],
    "eqr": ["CapitalAdequacyRatio", "EquityAttributableToOwnersOfParentToTotalAssetsRatio"],
    "bps": ["NetAssetsPerShare", "EquityAttributableToOwnersOfParentPerShare"],
}
YEN_FIELDS = ("eps", "bps", "dps")


def zen2han(s):
    return unicodedata.normalize("NFKC", s or "")


def table(facts):
    """{(要素名から会計基準を外したもの, コンテキスト): (値, 会計基準)}"""
    t = {}
    for name, ctx, v in facts:
        short = name.split(":")[-1]
        m = SUFFIX_RE.search(short)
        base = short[: m.start()] if m else short
        std = m.group(1) if m else "JGAAP"
        # 同じ名前が日本基準と IFRS の両方にあれば、IFRS などを優先する
        if (base, ctx) not in t or (std != "JGAAP" and t[(base, ctx)][1] == "JGAAP"):
            t[(base, ctx)] = (v, std)
    return t


def text(facts, key):
    for name, _, v in facts:
        if name.split(":")[-1] == key and isinstance(v, str) and v:
            return v
    return None


def period_of(facts, title):
    """(決算期 'YYYY-MM', 四半期 1〜3 か通期 4)"""
    q = text(facts, "QuarterlyPeriod")
    quarter = int(float(q)) if q else 4
    fy = text(facts, "FiscalYearEnd")
    if fy and re.match(r"\d{4}-\d{2}", fy):
        fy = fy[:7]
    else:
        m = re.search(r"(\d{4})年(\d{1,2})月期", zen2han(title))
        fy = f"{m.group(1)}-{int(m.group(2)):02d}" if m else None
    if not q:
        t = zen2han(title)
        m = re.search(r"第(\d)四半期", t)
        if m:
            quarter = int(m.group(1))
    return fy, quarter


def pick(t, bases, ctxs):
    """候補の名前を順に、どれかのコンテキストで値がある最初のものを返す"""
    for b in bases:
        for c in ctxs:
            if (b, c) in t and t[(b, c)][0] is not None:
                return t[(b, c)]
    return (None, None)


def oku(v):
    return None if v is None else round(v / 1e8, 1)


def fmt(k, v):
    if v is None:
        return None
    if k in YEN_FIELDS:
        return round(v, 2)
    if k == "eqr":
        return round(v * 100, 1)
    return oku(v)


def extract(facts, title):
    fy, quarter = period_of(facts, title)
    t = table(facts)
    cons = any(c.split("_")[1:2] == ["ConsolidatedMember"] for _, c in t)
    member = "ConsolidatedMember" if cons else "NonConsolidatedMember"
    dur = "CurrentYearDuration" if quarter == 4 else f"CurrentAccumulatedQ{quarter}Duration"
    prior = "PriorYearDuration" if quarter == 4 else f"PriorAccumulatedQ{quarter}Duration"
    inst = "CurrentYearInstant" if quarter == 4 else f"CurrentAccumulatedQ{quarter}Instant"
    # 通期の短信は来期の予想、四半期の短信は今期の予想を載せる
    fc = "NextYearDuration" if quarter == 4 else "CurrentYearDuration"
    out = {"fyEnd": fy, "quarter": quarter, "cons": cons, "std": None, "actual": {}, "prior": {}, "forecast": {}, "range": {}}
    for k, bases in FIELDS.items():
        v, std = pick(t, bases, [f"{dur}_{member}_ResultMember"])
        out["actual"][k] = fmt(k, v)
        if v is not None and out["std"] is None and k in ("sales", "opinc", "net"):
            out["std"] = std
        out["prior"][k] = fmt(k, pick(t, bases, [f"{prior}_{member}_ResultMember"])[0])
        out["forecast"][k] = fmt(k, pick(t, bases, [f"{fc}_{member}_ForecastMember"])[0])
        lo = pick(t, bases, [f"{fc}_{member}_LowerMember"])[0]
        hi = pick(t, bases, [f"{fc}_{member}_UpperMember"])[0]
        if lo is not None or hi is not None:
            out["range"][k] = [fmt(k, lo), fmt(k, hi)]
    for k, bases in STOCKS.items():
        out["actual"][k] = fmt(k, pick(t, bases, [f"{inst}_{member}_ResultMember"])[0])
    # 1株あたり純資産が載っていなければ、親会社の株主の持分 ÷ (発行済株式数 − 自己株式数) で出す
    if out["actual"]["bps"] is None:
        eq = pick(t, STOCKS["equity"], [f"{inst}_{member}_ResultMember"])[0]
        sh = pick(t, ["NumberOfIssuedAndOutstandingSharesAtTheEndOfFiscalYearIncludingTreasuryStock"], [f"{inst}_NonConsolidatedMember_ResultMember"])[0]
        tr = pick(t, ["NumberOfTreasuryStockAtTheEndOfFiscalYear"], [f"{inst}_NonConsolidatedMember_ResultMember"])[0] or 0
        if eq is not None and sh:
            out["actual"]["bps"] = round(eq / (sh - tr), 2)
            out["bpsCalc"] = True
    # 年間配当: 今期(実績か予想)と、通期の短信なら来期の予想
    dps = lambda ctx: pick(t, ["DividendPerShare"], [f"{ctx}_AnnualMember_NonConsolidatedMember_ResultMember",
                                                     f"{ctx}_AnnualMember_NonConsolidatedMember_ForecastMember"])[0]
    out["dps"] = {"prior": dps("PriorYearDuration"), "current": dps("CurrentYearDuration"),
                  "next": dps("NextYearDuration") if quarter == 4 else None}
    if quarter == 4:
        lo = pick(t, ["DividendPerShare"], ["NextYearDuration_AnnualMember_NonConsolidatedMember_LowerMember"])[0]
        hi = pick(t, ["DividendPerShare"], ["NextYearDuration_AnnualMember_NonConsolidatedMember_UpperMember"])[0]
    else:
        lo = pick(t, ["DividendPerShare"], ["CurrentYearDuration_AnnualMember_NonConsolidatedMember_LowerMember"])[0]
        hi = pick(t, ["DividendPerShare"], ["CurrentYearDuration_AnnualMember_NonConsolidatedMember_UpperMember"])[0]
    if lo is not None or hi is not None:
        out["range"]["dps"] = [lo, hi]
    return out


def usable(rec):
    return rec["fyEnd"] is not None and (rec["actual"]["sales"] is not None or rec["actual"]["net"] is not None)


def order(rec):
    """どの短信が新しいか: 決算期・四半期・発表日の順"""
    return (rec["fyEnd"] or "", rec["quarter"], rec.get("date", ""), rec.get("time", ""))
