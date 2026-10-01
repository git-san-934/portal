// 国別の輸出系列のページに、その国向けの主な品目(直近12か月の輸出額が大きい順に5つ)の推移を出す
(() => {
  const id = new URLSearchParams(location.search).get("id") || "";
  const hit = id.match(/^ESTAT_TRADE_EX_(USA|CHINA|TAIWAN)(_YOY)?$/);
  if (!hit) return;
  const country = { USA: "304", CHINA: "105", TAIWAN: "106" }[hit[1]];
  const yoy = !!hit[2];
  const { el, fmtMonth, fmtVal } = MultiLine;
  const $ = (x) => document.getElementById(x);
  const COLORS = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)"];
  let avg = 1;

  fetch(`pipeline/data/trade_goods_by_country.json?t=${Date.now()}`)
    .then((r) => r.json())
    .then((data) => {
      const goods = data.countries[country] || {};
      const months = data.months;
      const last12 = months.slice(-12);
      const top = Object.keys(goods)
        .map((g) => [g, last12.reduce((t, d) => t + (goods[g][d] || 0), 0)])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([g]) => g);
      if (!top.length) return;
      const calc = MultiLine.series(months);
      const cname = data.country_names[country] || country;
      $("goods-sub").textContent = `${cname}向け輸出の上位5品目(直近12か月の金額順)・${yoy ? "前年同月比" : "輸出額"}`;
      $("goods-panel").hidden = false;

      const d = months[months.length - 1];
      const render = () => {
        const val = (g, d, asYoy = yoy, n = avg) => calc(goods[g], d, asYoy, n);
        const ms = months.filter((d) => top.some((g) => isFinite(val(g, d)))).slice(-60);
        MultiLine.draw($("goods-chart"), $("goods-legend"), {
          months: ms,
          lines: top.map((g, i) => ({ name: data.names[g] || g, color: COLORS[i], val: (d) => val(g, d) })),
          yoy,
          label: `${cname}向け輸出の主な品目`,
        });
        $("goods-note").textContent =
          `直近5年。${avg === 3 ? "3か月の平均(前年比は3か月合計どうし)。" : ""}` +
          (yoy ? "極端な値は軸の端で切っています。" : "単位は億円。") +
          `表は${fmtMonth(d)}の輸出額と前年同月比、「3か月」は直近3か月合計の前年比。出典: 財務省 貿易統計 国別概況品別表(e-Stat)。`;

        const tbl = $("goods-table");
        const head = el("tr");
        ["品目", `${+d.slice(5)}月`, "前年比", "3か月"].forEach((t) => head.append(el("th", null, t)));
        tbl.replaceChildren(head);
        top.forEach((g, i) => {
          const tr = el("tr");
          const name = el("td", "cname");
          const sw = el("span", "swatch");
          sw.style.background = COLORS[i];
          name.append(sw, data.names[g] || g);
          const y1 = val(g, d, true, 1), y3 = val(g, d, true, 3);
          const cls = (v) => (!isFinite(v) ? "" : v > 0 ? "up" : v < 0 ? "down" : "");
          tr.append(
            name,
            el("td", "num", fmtVal(goods[g][d] || 0, false)),
            el("td", `num ${cls(y1)}`, fmtVal(y1, true)),
            el("td", `num ${cls(y3)}`, fmtVal(y3, true))
          );
          tbl.append(tr);
        });
      };

      const nav = $("goods-avg");
      [["月次", 1], ["3か月平均", 3]].forEach(([label, n]) => {
        const b = el("button", null, label);
        b.type = "button";
        b.setAttribute("aria-pressed", String(n === avg));
        b.addEventListener("click", () => {
          nav.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
          avg = n;
          render();
        });
        nav.append(b);
      });
      render();
    })
    .catch((e) => console.error(e));
})();
