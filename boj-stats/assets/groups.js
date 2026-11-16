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
      // 営業毎旬報告は2016年分から。それより前は日銀勘定の月末残高(BS01、1998年4月〜)を pipeline/data/history/ に置いて足す
      history: ["ACM_TOTAL", "ACM_JGB", "ACM_CURRENT_DEP", "ACM_BANKNOTES", "ACM_LOANS"],
      note: "2015年以前は日銀勘定の月末残高(1998年4月から)。貸出支援基金は2016年から",
    },
    {
      name: "日銀の資産 国債・貸付金以外(営業毎旬報告)",
      ids: ["ACM_ETF", "ACM_TBILL", "ACM_FX", "ACM_CORP_BOND", "ACM_REIT"],
      labels: ["ETF", "国庫短期証券", "外国為替", "社債", "J-REIT"],
      scale: 10000,
      unit: "兆円",
      digits: 1,
      history: ["ACM_ETF", "ACM_TBILL", "ACM_FX", "ACM_CORP_BOND", "ACM_REIT"],
      note: "2015年以前は日銀勘定の月末残高。国庫短期証券は2001年4月、社債は2009年3月、ETF・J-REITは2010年12月から",
    },
    {
      name: "日銀の負債・引当金 当座預金・銀行券以外(営業毎旬報告)",
      ids: ["ACM_GOV_DEP", "ACM_OTHER_DEP", "ACM_REPO", "ACM_PROVISIONS"],
      labels: ["政府預金", "その他預金(海外中銀等)", "売現先勘定", "引当金勘定"],
      scale: 10000,
      unit: "兆円",
      digits: 1,
      history: ["ACM_GOV_DEP", "ACM_OTHER_DEP", "ACM_REPO", "ACM_PROVISIONS"],
      note: "2015年以前は日銀勘定の月末残高(1998年4月から)。売現先勘定は2001年4月から",
    },
    {
      name: "マネタリーベースと日銀当座預金・日銀保有長期国債(月次)",
      ids: ["MD01_MABS1AN11", "MD01_MABS1AN113", "MD06_MASDM_at_07", "BS01_MABJMA5B"],
      labels: ["マネタリーベース(平残)", "うち日銀当座預金(平残)", "日銀当座預金(増減要因の表)", "日銀保有 長期国債(月末)"],
      dash: ["MD06_MASDM_at_07"],
      scale: 10000,
      unit: "兆円",
      note: "日銀当座預金(増減要因の表)は1998年4月、日銀保有 長期国債は2001年4月から",
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
      note: "実線は全国、点線は東京都区部(全国より1か月早く公表)。2020年以前(東京は2025年以前)は2020年基準の長期時系列の指数から計算した前年比で、公表値と0.1ほど違うことがある",
    },
    // ---- お金の量・貸出 ----
    {
      name: "マネーストックと銀行貸出 前年比",
      ids: ["MD02_MAM1YAM2M2MO", "MD02_MAM1YAM3M3MO", "MD13_FAAPOBAL1_at_"],
      labels: ["M2", "M3", "銀行貸出(総貸出平残)"],
      unit: "%",
      digits: 1,
      signed: true, // 銀行貸出は1998〜2005年などにマイナス
      // 系列の断層: ids を付けるとその系列だけ線を切る
      breaks: {
        "2004-04": { text: "M2・M3は2004年3月以前はマネーサプライ統計(M2+CD・M3+CD)で、マネーストック統計とは連続しない", ids: ["MD02_MAM1YAM2M2MO", "MD02_MAM1YAM3M3MO"] },
      },
      note: "M3は1997年1月から",
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
      from: "調査は2000年4-6月期から",
    },
    // ---- 国際収支・貿易 ----
    {
      name: "貿易統計 輸出額・輸入額と差引(財務省・通関ベース)",
      ids: ["ESTAT_TRADE_EXPORTS", "ESTAT_TRADE_IMPORTS", "ESTAT_TRADE_BALANCE"],
      labels: ["輸出", "輸入", "差引(輸出−輸入)"],
      unit: "億円",
      digits: 0,
      signed: true,
      note: "2008年11月以前は税関「輸出入額の推移」の世界計(月次)",
    },
    {
      name: "貿易統計 輸出額・輸入額 前年同月比(財務省・通関ベース)",
      ids: ["ESTAT_TRADE_EXPORTS_YOY", "ESTAT_TRADE_IMPORTS_YOY"],
      labels: ["輸出", "輸入"],
      unit: "%",
      digits: 1,
      signed: true,
      years: 10, // 月々の振れが大きいので初期表示は10年
      note: "2008年11月以前は税関「輸出入額の推移」の世界計から計算",
    },
    // ---- 貿易(国別・品目別) ----
    // 国・地域ごとに輸出と輸入を重ねる(輸出は青、輸入は橙)
    {
      name: "貿易統計 米国との輸出入額",
      ids: ["ESTAT_TRADE_EX_USA", "ESTAT_TRADE_IM_USA"],
      labels: ["輸出", "輸入"],
      unit: "億円",
      digits: 0,
      note: "2008年11月以前は税関「輸出入額の推移」の地域別月次",
    },
    {
      name: "貿易統計 米国との輸出入 前年同月比",
      ids: ["ESTAT_TRADE_EX_USA_YOY", "ESTAT_TRADE_IM_USA_YOY"],
      labels: ["輸出", "輸入"],
      unit: "%",
      digits: 1,
      signed: true,
      years: 10, // 月々の振れが大きいので初期表示は10年
      note: "2008年11月以前は税関「輸出入額の推移」の地域別月次",
    },
    {
      name: "貿易統計 中国との輸出入額",
      ids: ["ESTAT_TRADE_EX_CHINA", "ESTAT_TRADE_IM_CHINA"],
      labels: ["輸出", "輸入"],
      unit: "億円",
      digits: 0,
      note: "2008年11月以前は税関「輸出入額の推移」の地域別月次",
    },
    {
      name: "貿易統計 中国との輸出入 前年同月比",
      ids: ["ESTAT_TRADE_EX_CHINA_YOY", "ESTAT_TRADE_IM_CHINA_YOY"],
      labels: ["輸出", "輸入"],
      unit: "%",
      digits: 1,
      signed: true,
      years: 10, // 月々の振れが大きいので初期表示は10年
      note: "2008年11月以前は税関「輸出入額の推移」の地域別月次",
    },
    {
      name: "貿易統計 EUとの輸出入額",
      ids: ["ESTAT_TRADE_EX_EU", "ESTAT_TRADE_IM_EU"],
      labels: ["輸出", "輸入"],
      unit: "億円",
      digits: 0,
      note: "2008年11月以前は税関「輸出入額の推移」の地域別月次。EUは各時点の加盟国の合計(2004年5月・2007年1月・2013年7月に拡大、2020年2月から英国を除く)",
    },
    {
      name: "貿易統計 EUとの輸出入 前年同月比",
      ids: ["ESTAT_TRADE_EX_EU_YOY", "ESTAT_TRADE_IM_EU_YOY"],
      labels: ["輸出", "輸入"],
      unit: "%",
      digits: 1,
      signed: true,
      years: 10, // 月々の振れが大きいので初期表示は10年
      note: "2008年11月以前は税関「輸出入額の推移」の地域別月次。EUは各時点の加盟国の合計(2004年5月・2007年1月・2013年7月に拡大、2020年2月から英国を除く)",
    },
    {
      name: "貿易統計 ASEANとの輸出入額",
      ids: ["ESTAT_TRADE_EX_ASEAN", "ESTAT_TRADE_IM_ASEAN"],
      labels: ["輸出", "輸入"],
      unit: "億円",
      digits: 0,
      note: "2008年11月以前は税関「輸出入額の推移」の地域別月次。ASEANは各時点の加盟国の合計",
    },
    {
      name: "貿易統計 ASEANとの輸出入 前年同月比",
      ids: ["ESTAT_TRADE_EX_ASEAN_YOY", "ESTAT_TRADE_IM_ASEAN_YOY"],
      labels: ["輸出", "輸入"],
      unit: "%",
      digits: 1,
      signed: true,
      years: 10, // 月々の振れが大きいので初期表示は10年
      note: "2008年11月以前は税関「輸出入額の推移」の地域別月次。ASEANは各時点の加盟国の合計",
    },
    {
      name: "貿易統計 台湾向け半導体関連の輸出額",
      ids: ["ESTAT_TRADE_EX_TW_IC", "ESTAT_TRADE_EX_TW_MEM_DIE", "ESTAT_TRADE_EX_TW_SEMI_EQUIP", "ESTAT_TRADE_EX_TW_NAND", "ESTAT_TRADE_EX_TW_MLCC", "ESTAT_TRADE_EX_TW_DRAM"],
      labels: ["集積回路 計", "メモリ(未組立)", "半導体等製造装置", "フラッシュメモリ", "MLCC", "DRAM"],
      dash: ["ESTAT_TRADE_EX_TW_MEM_DIE"],
      unit: "億円",
      digits: 0,
      note: "メモリ(未組立、点線)は集積回路 計の内数。半導体等製造装置とメモリ3品目は2007年の品目番号(HS)改正で新設された番号のため2007年から",
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
      note: "DRAMは金額が小さく前年比が数千%に振れるため、この図には入れていません。半導体等製造装置とメモリは2008年から(品目番号の新設が2007年)",
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
