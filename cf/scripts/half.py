"""半期報告書の XBRL の数字から、投資分析ページの「最新の半期」の節の数字(cf/<コード>/half.js)を作る。
fetch_eps.py から使う。金額は億円(小数1桁)、1株あたりの数字は円。

rows は (要素名, コンテキスト, 値, 単位) の並び。今期上期と前年上期は InterimDuration / Prior1InterimDuration、
上期末と前期末の残高は InterimInstant / Prior1YearInstant から取る。
"""

import re

FLOW = ("InterimDuration", "Prior1InterimDuration")
STOCK = ("InterimInstant", "Prior1YearInstant")
# 四半期報告書の形で出している会社(累計期間の名前が違う)
ALIAS = {"CurrentYTDDuration": "InterimDuration", "Prior1YTDDuration": "Prior1InterimDuration", "CurrentQuarterInstant": "InterimInstant"}

# 項目ごとの候補。上から順に、値がある最初の要素を使う。タプルは合計する要素の組
FIELDS = {
    "sales": ("flow", ["NetSales", "NetSalesIFRS", "RevenueIFRS", "Revenue2IFRS", "NetSalesAndOperatingRevenueIFRS",
                       "OperatingRevenue1", "OperatingRevenue2", "TotalNetRevenuesIFRS", "InsuranceRevenueIFRS", "NetSalesOfCompletedConstructionContractsCNS",
                       "RevenuesUSGAAPSummaryOfBusinessResults", "NetSalesSummaryOfBusinessResults",
                       "RevenueIFRSSummaryOfBusinessResults", "OperatingRevenue1SummaryOfBusinessResults"]),
    "opinc": ("flow", ["OperatingIncome", "OperatingProfitLossIFRS", "OperatingIncomeLossUSGAAPSummaryOfBusinessResults",
                       "OperatingProfitLossIFRSSummaryOfBusinessResults", "OperatingProfitIFRSSummaryOfBusinessResults",
                       "ProfitLossBeforeTaxIFRS"]),
    "net": ("flow", ["ProfitLossAttributableToOwnersOfParent", "ProfitLossAttributableToOwnersOfParentIFRS",
                     "ProfitLossAttributableToOwnersOfParentIFRSSummaryOfBusinessResults",
                     "NetIncomeLossAttributableToOwnersOfParentUSGAAPSummaryOfBusinessResults",
                     "ProfitLossAttributableToOwnersOfParentSummaryOfBusinessResults", "ProfitLoss", "NetIncomeLoss"]),
    "op": ("flow", ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesIFRS",
                    "CashFlowsFromUsedInOperatingActivitiesIFRSSummaryOfBusinessResults",
                    "CashFlowsFromUsedInOperatingActivitiesUSGAAPSummaryOfBusinessResults",
                    "NetCashProvidedByUsedInOperatingActivitiesSummaryOfBusinessResults"]),
    "inv": ("flow", ["NetCashProvidedByUsedInInvestmentActivities", "NetCashProvidedByUsedInInvestingActivitiesIFRS",
                     "CashFlowsFromUsedInInvestingActivitiesIFRSSummaryOfBusinessResults",
                     "CashFlowsFromUsedInInvestingActivitiesUSGAAPSummaryOfBusinessResults",
                     "NetCashProvidedByUsedInInvestingActivitiesSummaryOfBusinessResults"]),
    "fin": ("flow", ["NetCashProvidedByUsedInFinancingActivities", "NetCashProvidedByUsedInFinancingActivitiesIFRS",
                     "CashFlowsFromUsedInFinancingActivitiesIFRSSummaryOfBusinessResults",
                     "CashFlowsFromUsedInFinancingActivitiesUSGAAPSummaryOfBusinessResults",
                     "NetCashProvidedByUsedInFinancingActivitiesSummaryOfBusinessResults"]),
    "ppe": ("flow", [("PurchaseOfPropertyPlantAndEquipmentInvCF", "PurchaseOfIntangibleAssetsInvCF", "PurchaseOfSoftwareInvCF"),
                     ("PurchaseOfPropertyPlantAndEquipmentInvCFIFRS", "PurchaseOfIntangibleAssetsInvCFIFRS"),
                     "PurchaseOfPropertyPlantAndEquipmentAndIntangibleAssetsInvCF",
                     "PurchaseOfPropertyPlantAndEquipmentAndIntangibleAssetsInvCFIFRS",
                     "PurchaseOfNoncurrentAssetsInvCF", "CapitalExpendituresInvCFIFRS",
                     ("AdditionsToFixedAssetsExcludingEquipmentLeasedToOthersInvCFIFRS", "AdditionsToIntangibleAssetsInvCFIFRS")]),
    "dep": ("flow", ["DepreciationAndAmortizationOpeCF", "DepreciationAndAmortizationOpeCFIFRS", "DepreciationAndOtherAmortizationOpeCF", "DepreciationOpeCF"]),
    "div": ("flow", ["CashDividendsPaidFinCF", "DividendsPaidFinCFIFRS", "DividendsPaidToOwnersOfParentFinCFIFRS"]),
    "buy": ("flow", ["PurchaseOfTreasuryStockFinCF", "PaymentsForPurchaseOfTreasurySharesFinCFIFRS",
                    "ReissuanceRepurchaseOfTreasuryStockFinCFIFRS"]),
    "acq": ("flow", ["PurchaseOfInvestmentsInSubsidiariesResultingInChangeInScopeOfConsolidationInvCF",
                     "PaymentsForAcquisitionOfSubsidiariesInvCFIFRS"]),
    "cash": ("stock", ["CashAndCashEquivalents", "CashAndCashEquivalentsIFRS",
                       "CashAndCashEquivalentsIFRSSummaryOfBusinessResults", "CashAndCashEquivalentsSummaryOfBusinessResults"]),
    "recv": ("stock", ["NotesAndAccountsReceivableTradeAndContractAssets", "NotesAndAccountsReceivableTrade",
                       "AccountsReceivableTradeAndContractAssets", "AccountsReceivableTrade", "TradeAndOtherReceivablesCAIFRS"]),
    "inventory": ("stock", ["Inventories", "InventoriesCAIFRS",
                            ("MerchandiseAndFinishedGoods", "Merchandise", "FinishedGoods", "WorkInProcess",
                             "RawMaterialsAndSupplies", "RawMaterials", "Supplies")]),
    "assets": ("stock", ["Assets", "AssetsIFRS", "TotalAssetsIFRSSummaryOfBusinessResults", "TotalAssetsSummaryOfBusinessResults"]),
    "equity": ("stock", ["NetAssets", "EquityIFRS", "EquityAttributableToOwnersOfParentIFRS",
                         "NetAssetsSummaryOfBusinessResults"]),
    "debt": ("stock", [("ShortTermLoansPayable", "CurrentPortionOfLongTermLoansPayable", "LongTermLoansPayable",
                        "CommercialPapersLiabilities", "CurrentPortionOfBonds", "BondsPayable"),
                       ("BondsAndBorrowingsCLIFRS", "BondsAndBorrowingsNCLIFRS", "BorrowingsCLIFRS", "BorrowingsNCLIFRS",
                        "BondsPayableNCLIFRS", "BondsPayableCLIFRS")]),
}
# 銀行は売上高・営業利益の代わりに経常収益・経常利益を出す
BANK = {
    "sales": ("flow", ["OrdinaryIncomeBNK", "OrdinaryIncomeSummaryOfBusinessResults"]),
    "opinc": ("flow", ["OrdinaryProfit", "OrdinaryIncome", "OrdinaryIncomeLossSummaryOfBusinessResults"]),
}
EPS = ["BasicEarningsLossPerShareSummaryOfBusinessResults", "BasicEarningsLossPerShareIFRSSummaryOfBusinessResults",
       "BasicEarningsLossPerShareUSGAAPSummaryOfBusinessResults", "BasicEarningsLossPerShareIFRS", "BasicAndDilutedEarningsLossPerShareIFRS"]


def table(rows):
    """{(要素名, コンテキスト): 値}。連結の数字があれば単体は使わない"""
    cons, single = {}, {}
    for elem, ctx, val, unit in rows:
        try:
            v = float(str(val).replace(",", ""))
        except ValueError:
            continue
        name = elem.split(":")[-1]
        base, sep, member = ctx.partition("_")
        ctx = ALIAS.get(base, base) + sep + member
        if ctx in FLOW + STOCK:
            cons[(name, ctx)] = v
        elif ctx.endswith("_NonConsolidatedMember") and ctx[:-22] in FLOW + STOCK:
            single[(name, ctx[:-22])] = v
    stmt = any(n in ("NetSales", "NetAssets", "Assets", "AssetsIFRS", "OrdinaryIncome") for n, _ in cons)
    return cons if stmt or not single else {**single, **cons}


def value(t, cands, ctx):
    for c in cands:
        if isinstance(c, tuple):
            vs = [t.get((n, ctx)) for n in c]
            if any(v is not None for v in vs):
                return sum(v for v in vs if v is not None)
        elif (c, ctx) in t:
            return t[(c, ctx)]
    return None


def oku(v):
    return None if v is None else round(v / 1e8, 1)


def months(period_start, n):
    y, m = int(period_start[:4]), int(period_start[5:7]) + n
    return f"{y + (m - 1) // 12:04d}-{(m - 1) % 12 + 1:02d}"


def periods(period_start):
    """期首の日付から、決算期・上期末・次の半期報告書の時期を年月で返す。
    20日締めなど月の途中で始まる会社は、期末を翌年の同じ月とする(有報の決算期の表し方に合わせる)"""
    off = 1 if int(period_start[8:10]) > 1 else 0
    return {"fyEnd": months(period_start, 11 + off), "halfStart": period_start[:7], "halfEnd": months(period_start, 5 + off),
            "next": {"halfStart": months(period_start, 12), "halfEnd": months(period_start, 17 + off), "fileBy": months(period_start, 19 + off)}}


def extract(rows, period_start, bank=False):
    """半期報告書の rows から half.js の数字を作る(code・annualEnd・newer・next は呼ぶ側で足す)"""
    t = table(rows)
    p = periods(period_start)
    out = {"fyEnd": p["fyEnd"], "halfStart": p["halfStart"], "halfEnd": p["halfEnd"], "bank": bank}
    for k, (kind, cands) in FIELDS.items():
        if bank and k in BANK:
            kind, cands = BANK[k]
        ctxs = FLOW if kind == "flow" else STOCK
        cur, prev = (value(t, cands, c) for c in ctxs)
        # 前の期の候補が今期と違う要素から取られることがないように、今期に値がある候補で前期も取る
        out[k] = [oku(cur), oku(prev)]
    if bank:
        for k in ("op", "inv", "fin", "ppe", "dep", "recv", "inventory", "debt"):
            out[k] = [None, None]
    # 1株あたり: EPS は報告書の数字。BPS は親会社の株主の持分 ÷ (発行済株式数 − 自己株式数)
    out["eps"] = [value(t, EPS, c) for c in FLOW]
    owners = []
    for c in STOCK:
        v = value(t, ["EquityAttributableToOwnersOfParentIFRS", "EquityAttributableToOwnersOfParentIFRSSummaryOfBusinessResults"], c)
        if v is None and (("NetAssets", c) in t):
            v = t[("NetAssets", c)] - (t.get(("NonControllingInterests", c)) or 0) - (t.get(("SubscriptionRightsToShares", c)) or 0)
        owners.append(v)
    issued = t.get(("NumberOfSharesIssuedSharesVotingRights", "InterimInstant")) or t.get(("TotalNumberOfIssuedSharesSummaryOfBusinessResults", "InterimInstant"))
    treasury = t.get(("TotalNumberOfSharesHeldTreasurySharesEtc", "InterimInstant")) or 0
    shares = issued - treasury if issued else None
    out["bps"] = [round(owners[0] / shares, 2) if owners[0] is not None and shares else None]
    return out


def is_bank(rows):
    return any(re.search(r"BNK$", e.split(":")[-1]) for e, *_ in rows)
