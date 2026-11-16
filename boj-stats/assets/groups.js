// 一つのグラフにまとめて表示する系列の組と、このサイトに出さない系列。
// 組の系列は新着ページの分類表では1行にまとめ、系列ページでは重ねた折れ線で描く(取得と個別の値は残す)。
window.SeriesGroups = (() => {
  const GROUPS = [
    {
      name: "資金循環 家計の現金・預金と株式等・投資信託",
      ids: ["FF_FOF_FFAS430A100", "FF_FOF_FFAS430A334"],
      scale: 10000, // 億円 → 兆円
      unit: "兆円",
    },
    {
      name: "短観 業況判断DI 大企業(製造業・非製造業)",
      ids: ["CO_TK99F1000601GCQ01000", "CO_TK99F2000601GCQ01000"],
      scale: 1,
      unit: "%pt",
      signed: true,
    },
  ];
  // 表示しない系列(取得は続ける)
  const HIDDEN = new Set(["FF_FOF_FFAS430A900"]);
  const of = (id) => GROUPS.find((g) => g.ids.includes(id)) || null;
  // 組の中での短い名前: 共通の頭を除く(「資金循環 家計の」「短観 業況判断DI 大企業」など)
  const labels = (names) => {
    let n = 0;
    while (names.every((x) => x[n] && x[n] === names[0][n])) n++;
    return names.map((x) => x.slice(n) || x);
  };
  return { GROUPS, HIDDEN, of, labels };
})();
