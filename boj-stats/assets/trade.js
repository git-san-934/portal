(() => {
  const $ = (x) => document.getElementById(x);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const TOP = 5;
  const COLORS = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)"];
  const OTHER = "var(--s-other)";
  const fmtMonth = (d) => `${d.slice(0, 4)}年${+d.slice(5)}月`;
  const fmtVal = (v, m) =>
    v == null || isNaN(v) ? "-" : m === "yoy" ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` : `${v.toLocaleString("ja-JP", { maximumFractionDigits: v < 10 ? 1 : 0 })}億円`;
  const params = new URLSearchParams(location.search);
  const state = { item: params.get("item"), measure: params.get("m") || "value", years: +(params.get("y") || 5), avg: params.get("a") === "3" ? 3 : 1 };
  let feed;

  // 品目 → 表示する系列(上位5か国 + その他)
  function build(it) {
    const months = it.months;
    const last12 = months.slice(-12);
    const all = it.countries.ALL || {};
    const ranks = Object.entries(it.countries)
      .filter(([c]) => c !== "ALL")
      .map(([c, v]) => [c, last12.reduce((s, d) => s + (v[d] || 0), 0)])
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1]);
    const top = ranks.slice(0, TOP).map(([c]) => c);
    const series = top.map((c, i) => ({ key: c, name: feed.names[c] || `国コード${c}`, color: COLORS[i], v: it.countries[c] }));
    const other = {};
    for (const d of months) other[d] = Math.max(0, (all[d] || 0) - top.reduce((s, c) => s + (it.countries[c][d] || 0), 0));
    if (ranks.length > TOP) series.push({ key: "other", name: "その他", color: OTHER, v: other });
    series.push({ key: "ALL", name: "世界計", color: null, v: all });
    return { months, series };
  }

  let calc = () => NaN;
  const value = (s, d, m, n = state.avg) => calc(s.v, d, m === "yoy", n);

  function draw(it) {
    const { months, series } = build(it);
    calc = MultiLine.series(months);
    const m = state.measure;
    const lines = series.filter((s) => s.color);
    let ms = months.filter((d) => isFinite(value(series[series.length - 1], d, m)));
    if (state.years) ms = ms.slice(-12 * state.years);
    MultiLine.draw($("chart"), $("legend"), {
      months: ms,
      lines: lines.map((s) => ({ name: s.name, color: s.color, val: (d) => value(s, d, m) })),
      extra: series.filter((s) => !s.color).map((s) => ({ name: s.name, val: (d) => value(s, d, m) })),
      yoy: m === "yoy",
      label: `${it.name} 国別の${m === "yoy" ? "前年同月比" : "輸出額"}`,
    });
    $("chart-note").textContent =
      (state.avg === 3 ? "直近3か月の平均(前年比は3か月合計どうし)。" : "") +
      (m === "yoy" ? "前年同月比は前年同月の輸出がある月だけ描きます。極端な値は軸の端で切っています(値は表と吹き出しで確認できます)。" : "単位は億円。");

    // 表: 最新月の国別
    const d = months[months.length - 1];
    $("latest-month").textContent = fmtMonth(d);
    const tbl = $("table");
    const head = el("tr");
    ["輸出先", "輸出額", "前年同月比", "構成比"].forEach((t) => head.append(el("th", null, t)));
    tbl.replaceChildren(head);
    const total = (it.countries.ALL || {})[d] || 0;
    for (const s of series) {
      const tr = el("tr");
      const name = el("td", "cname");
      if (s.color) {
        const sw = el("span", "swatch");
        sw.style.background = s.color;
        name.append(sw);
      }
      name.append(s.name);
      const yoy = value(s, d, "yoy", 1);
      const yc = !isFinite(yoy) ? "" : yoy > 0 ? "up" : yoy < 0 ? "down" : "";
      tr.append(
        name,
        el("td", "num", fmtVal(s.v[d] || 0, "value")),
        el("td", `num ${yc}`, fmtVal(yoy, "yoy")),
        el("td", "num", s.key === "ALL" || !total ? "" : `${(((s.v[d] || 0) / total) * 100).toFixed(1)}%`)
      );
      tbl.append(tr);
    }
    $("hs").textContent = `HSコード: ${it.hs.join("、")}`;
  }

  function buttons(nav, opts, cur, onPick) {
    nav.replaceChildren(
      ...opts.map(([label, v]) => {
        const b = el("button", null, label);
        b.type = "button";
        b.setAttribute("aria-pressed", String(v === cur));
        b.addEventListener("click", () => {
          nav.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
          onPick(v);
        });
        return b;
      })
    );
  }

  function render() {
    const it = feed.items.find((x) => x.key === state.item) || feed.items[0];
    state.item = it.key;
    $("item-name").textContent = it.name;
    const q = new URLSearchParams({ item: state.item, m: state.measure, y: state.years, a: state.avg });
    history.replaceState(null, "", `?${q}`);
    draw(it);
  }

  fetch(`pipeline/data/trade_by_country.json?t=${Date.now()}`)
    .then((r) => r.json())
    .then((data) => {
      feed = data;
      const lastMonth = feed.items.map((x) => x.months[x.months.length - 1]).sort().pop();
      $("status").textContent = lastMonth ? `${fmtMonth(lastMonth)}分まで` : "";
      buttons($("items"), feed.items.map((x) => [x.short || x.name, x.key]), state.item || feed.items[0].key, (v) => { state.item = v; render(); });
      buttons($("measures"), [["輸出額", "value"], ["前年同月比", "yoy"]], state.measure, (v) => { state.measure = v; render(); });
      buttons($("ranges"), [["3年", 3], ["5年", 5], ["全期間", 0]], state.years, (v) => { state.years = v; render(); });
      buttons($("avgs"), [["月次", 1], ["3か月平均", 3]], state.avg, (v) => { state.avg = v; render(); });
      render();
    })
    .catch(() => {
      $("status").textContent = "データを読み込めませんでした";
    });
})();
