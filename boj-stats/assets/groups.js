// 一つのグラフにまとめて表示する系列の組と、このサイトに出さない系列。
// 組の系列は新着ページの分類表では1行にまとめ、系列ページでは重ねた折れ線で描く(取得と個別の値は残す)。
window.SeriesGroups = (() => {
  const GROUPS = [
    {
      name: "資金循環 家計の現金・預金と株式等・投資信託",
      ids: ["FF_FOF_FFAS430A100", "FF_FOF_FFAS430A334"],
      scale: 10000, // 億円 → 兆円
      unit: "兆円",
      // 系列の断層: その期の手前で線を切って注記する
      breaks: {
        "2005Q1": "2004年10-12月期以前は旧基準(93SNA)、2005年1-3月期以降は現行基準(08SNA)の計数で、連続しない(特に株式等・投資信託)",
      },
      from: "四半期の計数は1997年10-12月期から",
    },
    {
      name: "短観 業況判断DI 大企業(製造業・非製造業)",
      ids: ["CO_TK99F1000601GCQ01000", "CO_TK99F2000601GCQ01000"],
      scale: 1,
      unit: "%pt",
      signed: true,
      breaks: {
        "2004Q1": "2004年3月調査で調査対象企業と規模の区分(常用雇用者数から資本金へ)を見直したため、2003年12月調査以前とは連続しない",
      },
    },
    // ---- 日銀の資金供給 ----
    {
      name: "日銀のバランスシート 主な項目(営業毎旬報告)",
      ids: ["ACM_TOTAL", "ACM_JGB", "ACM_CURRENT_DEP", "ACM_BANKNOTES", "ACM_LOANS", "ACM_LSF"],
      labels: ["総資産", "国債(資産)", "当座預金(負債)", "銀行券(負債)", "貸付金(資産)", "うち貸出支援基金"],
      dash: ["ACM_LSF"],
      scale: 10000,
      unit: "兆円",
    },
    {
      name: "日銀の資産 国債・貸付金以外(営業毎旬報告)",
      ids: ["ACM_ETF", "ACM_TBILL", "ACM_FX", "ACM_CORP_BOND", "ACM_REIT"],
      labels: ["ETF", "国庫短期証券", "外国為替", "社債", "J-REIT"],
      scale: 10000,
      unit: "兆円",
      digits: 1,
    },
    {
      name: "日銀の負債・引当金 当座預金・銀行券以外(営業毎旬報告)",
      ids: ["ACM_GOV_DEP", "ACM_OTHER_DEP", "ACM_REPO", "ACM_PROVISIONS"],
      labels: ["政府預金", "その他預金(海外中銀等)", "売現先勘定", "引当金勘定"],
      scale: 10000,
      unit: "兆円",
      digits: 1,
    },
    {
      name: "マネタリーベースと日銀当座預金・日銀保有長期国債(月次)",
      ids: ["MD01_MABS1AN11", "MD01_MABS1AN113", "MD06_MASDM_at_07", "BS01_MABJMA5B"],
      labels: ["マネタリーベース(平残)", "うち日銀当座預金(平残)", "日銀当座預金(増減要因の表)", "日銀保有 長期国債(月末)"],
      dash: ["MD06_MASDM_at_07"],
      scale: 10000,
      unit: "兆円",
    },
    {
      name: "金融調節の国債買入と資金過不足(月次)",
      ids: ["MD06_MASDM58", "MD06_MASDM4"],
      labels: ["国債買入", "資金過不足"],
      scale: 10000,
      unit: "兆円",
      digits: 1,
      signed: true,
    },
    // ---- 物価 ----
    {
      name: "企業の物価 前年比(国内企業物価・輸入物価・企業向けサービス価格)",
      ids: ["PR01_PRCG20_2200000000%", "PR01_PRCG20_2600000000%", "PR02_PRCS20_5200000000%"],
      labels: ["国内企業物価", "輸入物価(円ベース)", "企業向けサービス価格"],
      unit: "%",
      digits: 1,
      signed: true,
    },
    {
      name: "消費者物価 前年比(全国・東京都区部)",
      ids: ["CPI_CPI_ALL_YOY", "CPI_CPI_CORE_YOY", "CPI_CPI_CORECORE_YOY", "STAT_CPI_TKY_ALL_YOY", "STAT_CPI_TKY_CORE_YOY", "STAT_CPI_TKY_CORECORE_YOY"],
      labels: ["全国 総合", "全国 生鮮除く", "全国 生鮮・エネルギー除く", "東京 総合", "東京 生鮮除く", "東京 生鮮・エネルギー除く"],
      // 東京都区部は全国と同じ色の点線(全国より1か月早く出る)
      colors: [1, 2, 3, 1, 2, 3],
      dash: ["STAT_CPI_TKY_ALL_YOY", "STAT_CPI_TKY_CORE_YOY", "STAT_CPI_TKY_CORECORE_YOY"],
      unit: "%",
      digits: 1,
      signed: true,
      note: "実線は全国、点線は東京都区部(全国より1か月早く公表)",
    },
    // ---- お金の量・貸出 ----
    {
      name: "マネーストックと銀行貸出 前年比",
      ids: ["MD02_MAM1YAM2M2MO", "MD02_MAM1YAM3M3MO", "MD13_FAAPOBAL1_at_"],
      labels: ["M2", "M3", "銀行貸出(総貸出平残)"],
      unit: "%",
      digits: 1,
    },
    {
      name: "貸出約定平均金利 国内銀行(新規・残高)",
      ids: ["IR04_DLLR2CIDBNL1", "IR04_DLLR2CIDBST1"],
      labels: ["新規", "残高"],
      unit: "%",
      digits: 2,
    },
    {
      name: "資金需要判断DI 主要銀行アンケート(企業向け・個人向け)",
      ids: ["LA05_DLLSDLPB", "LA05_DLLSDLPH"],
      labels: ["企業向け", "個人向け"],
      unit: "%pt",
      signed: true,
    },
    // ---- 貿易(国別・品目別) ----
    {
      name: "貿易統計 国・地域別の輸出額",
      ids: ["ESTAT_TRADE_EX_USA", "ESTAT_TRADE_EX_CHINA", "ESTAT_TRADE_EX_ASEAN", "ESTAT_TRADE_EX_EU", "ESTAT_TRADE_EX_TAIWAN"],
      labels: ["米国", "中国", "ASEAN", "EU", "台湾"],
      unit: "億円",
      digits: 0,
    },
    {
      name: "貿易統計 国・地域別の輸入額",
      ids: ["ESTAT_TRADE_IM_USA", "ESTAT_TRADE_IM_CHINA", "ESTAT_TRADE_IM_ASEAN", "ESTAT_TRADE_IM_EU"],
      labels: ["米国", "中国", "ASEAN", "EU"],
      unit: "億円",
      digits: 0,
    },
    {
      name: "貿易統計 国・地域別の輸出 前年同月比",
      ids: ["ESTAT_TRADE_EX_USA_YOY", "ESTAT_TRADE_EX_CHINA_YOY", "ESTAT_TRADE_EX_ASEAN_YOY", "ESTAT_TRADE_EX_EU_YOY", "ESTAT_TRADE_EX_TAIWAN_YOY"],
      labels: ["米国", "中国", "ASEAN", "EU", "台湾"],
      unit: "%",
      digits: 1,
      signed: true,
      years: 3, // 月々の振れが大きいので初期表示は3年
    },
    {
      name: "貿易統計 国・地域別の輸入 前年同月比",
      ids: ["ESTAT_TRADE_IM_USA_YOY", "ESTAT_TRADE_IM_CHINA_YOY", "ESTAT_TRADE_IM_ASEAN_YOY", "ESTAT_TRADE_IM_EU_YOY"],
      labels: ["米国", "中国", "ASEAN", "EU"],
      unit: "%",
      digits: 1,
      signed: true,
      years: 3, // 月々の振れが大きいので初期表示は3年
    },
    {
      name: "貿易統計 台湾向け半導体関連の輸出額",
      ids: ["ESTAT_TRADE_EX_TW_IC", "ESTAT_TRADE_EX_TW_MEM_DIE", "ESTAT_TRADE_EX_TW_SEMI_EQUIP", "ESTAT_TRADE_EX_TW_NAND", "ESTAT_TRADE_EX_TW_MLCC", "ESTAT_TRADE_EX_TW_DRAM"],
      labels: ["集積回路 計", "メモリ(未組立)", "半導体等製造装置", "フラッシュメモリ", "MLCC", "DRAM"],
      dash: ["ESTAT_TRADE_EX_TW_MEM_DIE"],
      unit: "億円",
      digits: 0,
      note: "メモリ(未組立、点線)は集積回路 計の内数",
    },
    {
      name: "貿易統計 台湾向け半導体関連の輸出 前年同月比",
      ids: ["ESTAT_TRADE_EX_TW_IC_YOY", "ESTAT_TRADE_EX_TW_MEM_DIE_YOY", "ESTAT_TRADE_EX_TW_SEMI_EQUIP_YOY", "ESTAT_TRADE_EX_TW_NAND_YOY", "ESTAT_TRADE_EX_TW_MLCC_YOY"],
      labels: ["集積回路 計", "メモリ(未組立)", "半導体等製造装置", "フラッシュメモリ", "MLCC"],
      dash: ["ESTAT_TRADE_EX_TW_MEM_DIE_YOY"],
      unit: "%",
      digits: 1,
      signed: true,
      years: 3, // 月々の振れが大きいので初期表示は3年
      note: "DRAMは金額が小さく前年比が数千%に振れるため、この図には入れていません",
    },
  ];
  // 表示しない系列(取得は続ける)
  const HIDDEN = new Set(["FF_FOF_FFAS430A900"]);
  for (const g of GROUPS) if (g.scale == null) g.scale = 1;
  const of = (id) => GROUPS.find((g) => g.ids.includes(id)) || null;
  // 組の中での短い名前: 共通の頭を除く(「資金循環 家計の」「短観 業況判断DI 大企業」など)
  const labels = (names) => {
    let n = 0;
    while (names.every((x) => x[n] && x[n] === names[0][n])) n++;
    return names.map((x) => x.slice(n) || x);
  };
  // 組の各系列の短い名前(labels の指定があればそれ)
  const names = (g, series) => g.labels || labels(g.ids.map((x) => series[x].name));
  return { GROUPS, HIDDEN, of, labels, names };
})();
