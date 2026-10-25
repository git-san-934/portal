"""cf/data/cf_raw/<コード>.json(fetch_cf.py の出力)から、投資分析ページの数字 cf/<コード>/data.js を作る。

使い方: python cf/scripts/build_cf.py 7820 8077 ...   (コードを省くと cf_raw の全銘柄)
- 数字は億円(小数1桁)。要素名の候補を順に試し、年ごとに最初に見つかったものを使う
- 連結の数字がない年は単体の数字を使う(singleYears)
- 借入金・社債などの残高も表示する(ページの extra.debt に書き写す)
- ページの文章(index.html)は人が有報の本文(cf_raw の text)を読んで書く
"""

import json
import sys
from pathlib import Path

CF_DIR = Path(__file__).resolve().parent.parent
RAW_DIR = CF_DIR / "data" / "cf_raw"
YEARS = 7

# 候補は "A+B" で合計を表す。上から順に試す
CANDS = {
    "sales": ["NetSales", "RevenueIFRS", "NetSalesIFRS", "OperatingRevenue1", "OperatingRevenue2", "OrdinaryIncomeBNK", "NetSalesOfCompletedConstructionContracts",
              "NetSalesOfCompletedConstructionContractsCNS", "NetSalesAndOperatingRevenue", "OperatingRevenue", "OperatingRevenueSPF", "Revenue"],
    "opinc": ["OperatingIncome", "OperatingProfitLossIFRS", "OrdinaryIncome"],
    "net": ["ProfitLossAttributableToOwnersOfParent", "ProfitLossAttributableToOwnersOfParentIFRS", "ProfitLoss", "NetIncome"],
    "op": ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesIFRS"],
    "inv": ["NetCashProvidedByUsedInInvestmentActivities", "NetCashProvidedByUsedInInvestingActivitiesIFRS"],
    "fin": ["NetCashProvidedByUsedInFinancingActivities", "NetCashProvidedByUsedInFinancingActivitiesIFRS"],
    "ppe": ["PurchaseOfPropertyPlantAndEquipmentInvCF+PurchaseOfIntangibleAssetsInvCF+PurchaseOfSoftwareInvCF",
            "PurchaseOfPropertyPlantAndEquipmentInvCFIFRS+PurchaseOfIntangibleAssetsInvCFIFRS",
            "PurchaseOfPropertyPlantAndEquipmentAndIntangibleAssetsInvCFIFRS",
            "PurchaseOfNoncurrentAssetsInvCF", "PurchaseOfPropertyPlantAndEquipmentAndIntangibleAssetsInvCF"],
    "dep": ["DepreciationAndAmortizationOpeCF", "DepreciationAndAmortizationOpeCFIFRS", "DepreciationOpeCF", "DepreciationAndOtherAmortizationOpeCF"],
    "rd": ["ResearchAndDevelopmentExpensesResearchAndDevelopmentActivities", "ResearchAndDevelopmentExpensesSGA"],
    "div": ["CashDividendsPaidFinCF", "DividendsPaidFinCFIFRS", "DividendsPaidToOwnersOfParentFinCFIFRS"],
    "buy": ["PurchaseOfTreasuryStockFinCF", "PaymentsForPurchaseOfTreasurySharesFinCFIFRS"],
    "cash": ["CashAndCashEquivalents", "CashAndCashEquivalentsIFRS"],
    "acq": ["PurchaseOfInvestmentsInSubsidiariesResultingInChangeInScopeOfConsolidationInvCF+PurchaseOfInvestmentsInCapitalOfSubsidiariesResultingInChangeInScopeOfConsolidationInvCF+PaymentsForTransferOfBusinessInvCF",
            "PaymentsForAcquisitionOfSubsidiariesInvCFIFRS"],
    "imp": ["ImpairmentLossEL", "ImpairmentLossOpeCF", "ImpairmentLossesReversalOfImpairmentLossesOpeCFIFRS"],
    "recv": ["NotesAndAccountsReceivableTrade", "NotesAndAccountsReceivableTradeAndContractAssets", "AccountsReceivableTrade",
             "NotesReceivableAccountsReceivableFromCompletedConstructionContractsAndOtherCNS", "TradeAndOtherReceivablesCAIFRS"],
    "assets": ["Assets", "AssetsIFRS"],
    "equity": ["NetAssets", "EquityIFRS"],
}
DEBT = ["ShortTermLoansPayable", "CurrentPortionOfLongTermLoansPayable", "LongTermLoansPayable", "BondsPayable", "CurrentPortionOfBonds",
        "CommercialPapersLiabilities", "BondsAndBorrowingsCLIFRS", "BondsAndBorrowingsNCLIFRS", "BorrowedMoneyLiabilitiesBNK"]
# 投資CFの支出で、合計して符号を負にそろえるもの(XBRL の値は支出でも負で入っている)
OUTFLOW = {"ppe", "acq", "div", "buy"}


def periods(raw):
    return sorted({d[0] for d in raw["docs"]})[-YEARS:]


def series(tbl, cand, years):
    """候補1つ(合計なら + でつなぐ)の年ごとの値。合計は、どれか1つでも値がある年だけ"""
    parts = cand.split("+")
    out = []
    for y in years:
        vals = [tbl.get(p, {}).get(y) for p in parts]
        out.append(None if all(v is None for v in vals) else sum(v or 0 for v in vals))
    return out


def pick(tbl, key, years):
    vals, used = [None] * len(years), []
    for cand in CANDS[key]:
        s = series(tbl, cand, years)
        hit = False
        for i, v in enumerate(s):
            if vals[i] is None and v is not None:
                vals[i] = v
                hit = True
        if hit:
            used.append(cand)
    return vals, " / ".join(used) or None


def oku(v, dec=1):
    return None if v is None else round(v / 1e8, dec)


def build(code):
    raw = json.loads((RAW_DIR / f"{code}.json").read_text(encoding="utf-8"))
    years = periods(raw)
    cons, sing = raw["num"], raw["single"]
    # 連結の営業CFがない年(連結子会社がなかった年など)は、その年だけ単体の数字を使う
    op_cons = pick(cons, "op", years)[0]
    single_years = [y for y, v in zip(years, op_cons) if v is None]
    tbl = {}
    for elem in set(cons) | set(sing):
        c, s1 = cons.get(elem, {}), sing.get(elem, {})
        tbl[elem] = {y: (s1.get(y, c.get(y)) if y in single_years else c.get(y)) for y in years}
        tbl[elem] = {y: v for y, v in tbl[elem].items() if v is not None}
    single = len(single_years) == len(years)
    sales = pick(tbl, "sales", years)[0][-1] or 0
    dec = 2 if sales < 50e8 else 1  # 小さな会社は小数2桁
    shown = dec if sales < 1000e8 else 0  # グラフ・表に出す小数の桁(CF_DEC)
    cf = {"code": code, "years": years, "src": {}}
    for key in CANDS:
        vals, used = pick(tbl, key, years)
        if key in OUTFLOW:
            vals = [None if v is None else -abs(v) for v in vals]
        cf["src"][key] = used
        cf[key] = [oku(v, dec) for v in vals]
    debt = []
    for y in years:
        vals = [tbl.get(e, {}).get(y) for e in DEBT]
        debt.append(oku(sum(v or 0 for v in vals), dec))
    cf["single"] = single
    cf["singleYears"] = single_years
    js = "window.CF = " + json.dumps(cf, ensure_ascii=False, indent=1) + ";\n"
    if shown:
        js += f"window.CF_DEC = {shown};\n"
    out = CF_DIR / code
    out.mkdir(exist_ok=True)
    (out / "data.js").write_text(js, encoding="utf-8")
    half = out / "half.js"
    if not half.exists():
        # fetch_eps.py の update_half が、次の更新で最新の半期報告書から作り直す
        half.write_text('window.CF_HALF_STUB = {"v": 0, "halfStart": ""};\n', encoding="utf-8")
    return raw, cf, debt


def main():
    codes = sys.argv[1:] or sorted(p.stem for p in RAW_DIR.glob("*.json"))
    for code in codes:
        raw, cf, debt = build(code)
        print(f"{code} {raw['name']} {cf['years'][0]}〜{cf['years'][-1]} 単体の年={cf['singleYears']}")
        for k in ("sales", "opinc", "net", "op", "inv", "fin", "ppe", "dep", "rd", "div", "buy", "cash", "acq", "imp"):
            print(f"  {k:6} {cf[k]}  ({cf['src'][k]})")
        print(f"  debt   {debt}")


if __name__ == "__main__":
    main()
