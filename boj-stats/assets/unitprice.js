// 台湾向けの品目別輸出(品別国別表)の系列ページに、数量と単価(輸出額÷数量)の推移を出す。データは trade.html と共用
(() => {
  const id = new URLSearchParams(location.search).get("id") || "";
  const hit = id.match(/^ESTAT_TRADE_EX_TW_([A-Z_]+?)(_YOY)?$/);
  if (!hit) return;
  const COUNTRY = "106";
  const { el, fmtMonth, fmtVal } = MultiLine;
  const $ = (x) => document.getElementById(x);
  const state = { yoy: !!hit[2], avg: 1 };
  const compact = (v) => {
    const a = Math.abs(v);
    const n = (x) => x.toLocaleString("ja-JP", { maximumFractionDigits: Math.abs(x) < 10 ? 1 : 0 });
    return a >= 1e8 ? `${n(v / 1e8)}億` : a >= 1e4 ? `${n(v / 1e4)}万` : n(v);
  };
  const prevYear = (d) => `${+d.slice(0, 4) - 1}${d.slice(4)}`;

  fetch(`pipeline/data/trade_by_country.json?t=${Date.now()}`)
    .then((r) => r.json())
    .then((data) => {
      const it = data.items.find((x) => x.key === hit[1]);
      if (!it) return;
      $("qp-panel").hidden = false;
      $("qp-link").href = `trade.html?item=${it.key}&k=price&m=value&y=5&a=1`;
      if (!it.qty_unit) {
        $("qp-body").hidden = true;
        $("qp-sub").textContent = "";
        $("qp-note").textContent = "この品目はHSコードによって数量の単位(個とkg)が違い、足し合わせられないため、数量と単価は出していません。";
        return;
      }
      const months = it.months;
      const calc = MultiLine.series(months);
      const [scale, unit] = it.qty_unit === "kg" ? [1e-3, "トン"] : [1, it.qty_unit];
      const pu = it.qty_unit === "kg" ? "円/kg" : "円/個";
      const cname = data.names[COUNTRY] || COUNTRY;
      const src = (c) => ({ v: it.countries[c] || {}, q: (it.qty || {})[c] || {} });
      const tw = src(COUNTRY), all = src("ALL");
      const price = (s, d, n) => (calc(s.v, d, false, n) * 1e8) / calc(s.q, d, false, n);
      const qty = (s, d, n = state.avg, yoy = state.yoy) => (yoy ? calc(s.q, d, true, n) : calc(s.q, d, false, n) * scale);
      const unitPrice = (s, d, n = state.avg, yoy = state.yoy) => {
        const p = price(s, d, n);
        if (!yoy) return p;
        const p0 = price(s, prevYear(d), n);
        return p0 > 0 && isFinite(p0) ? (p / p0 - 1) * 100 : NaN;
      };
      const fmtPrice = (v) =>
        isFinite(v) ? `${v.toLocaleString("ja-JP", v >= 100 ? { maximumFractionDigits: 0 } : { maximumSignificantDigits: 3 })}${pu}` : "-";
      const fmtQty = (v) => (isFinite(v) ? `${compact(v)}${unit}` : "-");
      const yoyFmt = (v) => fmtVal(v, true);
      $("qp-sub").textContent = `${cname}向け・${it.short}`;

      const render = () => {
        const { yoy } = state;
        const ms = months.filter((d) => isFinite(qty(tw, d)) || isFinite(unitPrice(tw, d))).slice(-60);
        MultiLine.draw($("qp-qty"), null, {
          months: ms,
          lines: [{ name: cname, color: "var(--s1)", val: (d) => qty(tw, d) }],
          yoy,
          fmt: yoy ? yoyFmt : fmtQty,
          tick: yoy ? null : compact,
          label: `${cname}向け${it.short}の輸出数量`,
        });
        MultiLine.draw($("qp-price"), $("qp-price-legend"), {
          months: ms,
          lines: [
            { name: cname, color: "var(--s1)", val: (d) => unitPrice(tw, d) },
            { name: "世界計", color: "var(--s-other)", val: (d) => unitPrice(all, d) },
          ],
          yoy,
          fmt: yoy ? yoyFmt : fmtPrice,
          tick: yoy ? null : (v) => v.toLocaleString("ja-JP", { maximumSignificantDigits: 3 }),
          label: `${cname}向け${it.short}の輸出単価`,
        });
        $("qp-qty-head").textContent = `数量${yoy ? "(前年同月比)" : `(${unit})`}`;
        $("qp-price-head").textContent = `単価${yoy ? "(前年同月比)" : `(${pu})`}`;
        $("qp-note").textContent =
          `直近5年。${state.avg === 3 ? "3か月の平均(単価は3か月の輸出額合計÷数量合計)。" : ""}` +
          "単価は輸出額÷数量で出した平均単価で、容量や種類など中身の構成が変わっても動きます。" +
          (yoy ? "極端な値は軸の端で切っています。" : "") +
          "出典: 財務省 貿易統計 品別国別表(e-Stat)。";

        const tbl = $("qp-table");
        const head = el("tr");
        ["月", "輸出額", "数量", "単価", "単価前年比"].forEach((t) => head.append(el("th", null, t)));
        tbl.replaceChildren(head);
        for (const d of months.slice(-6).reverse()) {
          const py = unitPrice(tw, d, 1, true);
          const tr = el("tr");
          tr.append(
            el("td", null, `${d.slice(2, 4)}年${+d.slice(5)}月`),
            el("td", "num", fmtVal(tw.v[d] || 0, false)),
            el("td", "num", fmtQty(qty(tw, d, 1, false))),
            el("td", "num", fmtPrice(unitPrice(tw, d, 1, false))),
            el("td", `num ${!isFinite(py) ? "" : py > 0 ? "up" : py < 0 ? "down" : ""}`, fmtVal(py, true))
          );
          tbl.append(tr);
        }
      };

      const toggle = (nav, opts, key) => {
        opts.forEach(([label, v]) => {
          const b = el("button", null, label);
          b.type = "button";
          b.setAttribute("aria-pressed", String(v === state[key]));
          b.addEventListener("click", () => {
            nav.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
            state[key] = v;
            render();
          });
          nav.append(b);
        });
      };
      toggle($("qp-mode"), [["実額", false], ["前年同月比", true]], "yoy");
      toggle($("qp-avg"), [["月次", 1], ["3か月平均", 3]], "avg");
      render();
    })
    .catch((e) => console.error(e));
})();
