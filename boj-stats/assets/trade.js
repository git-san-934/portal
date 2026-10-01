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
  // 数量は億・万で縮める。kg はトンで出す
  const compact = (v) => {
    const a = Math.abs(v);
    const n = (x) => x.toLocaleString("ja-JP", { maximumFractionDigits: Math.abs(x) < 10 ? 1 : 0 });
    return a >= 1e8 ? `${n(v / 1e8)}億` : a >= 1e4 ? `${n(v / 1e4)}万` : n(v);
  };
  const qtyScale = (it) => (it.qty_unit === "kg" ? [1e-3, "トン"] : [1, it.qty_unit]);
  const KINDS = { value: "輸出額", qty: "数量", price: "単価" };
  // 表示する指標ごとの書式。v は金額なら億円、数量なら表示単位、単価なら円
  function formats(it, kind) {
    const [, u] = qtyScale(it);
    const pu = it.qty_unit === "kg" ? "円/kg" : "円/個";
    const yoyFmt = (v) => fmtVal(v, "yoy");
    if (kind === "qty") return { unit: u, fmt: (v) => (isFinite(v) ? `${compact(v)}${u}` : "-"), tick: compact, yoyFmt };
    if (kind === "price")
      return {
        unit: pu,
        fmt: (v) => (isFinite(v) ? `${v.toLocaleString("ja-JP", v >= 100 ? { maximumFractionDigits: 0 } : { maximumSignificantDigits: 3 })}${pu}` : "-"),
        tick: (v) => v.toLocaleString("ja-JP", { maximumSignificantDigits: 3 }),
        yoyFmt,
      };
    return { unit: "億円", fmt: (v) => fmtVal(v, "value"), tick: null, yoyFmt };
  }
  const params = new URLSearchParams(location.search);
  const state = {
    item: params.get("item"),
    measure: params.get("m") === "yoy" ? "yoy" : "value",
    kind: KINDS[params.get("k")] ? params.get("k") : "value",
    years: +(params.get("y") || 5),
    avg: params.get("a") === "3" ? 3 : 1,
  };
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
    const qty = it.qty || {};
    const series = top.map((c, i) => ({ key: c, name: feed.names[c] || `国コード${c}`, color: COLORS[i], v: it.countries[c], q: qty[c] || {} }));
    const rest = (src) => {
      const o = {};
      for (const d of months) o[d] = Math.max(0, ((src.ALL || {})[d] || 0) - top.reduce((s, c) => s + ((src[c] || {})[d] || 0), 0));
      return o;
    };
    if (ranks.length > TOP) series.push({ key: "other", name: "その他", color: OTHER, v: rest(it.countries), q: rest(qty) });
    series.push({ key: "ALL", name: "世界計", color: null, v: all, q: qty.ALL || {} });
    return { months, series };
  }

  let calc = () => NaN;
  let kind = "value", scale = 1;
  const prevYear = (d) => `${+d.slice(0, 4) - 1}${d.slice(4)}`;
  // 単価 = 金額÷数量(3か月平均は3か月合計どうしの割り算)。金額は億円 → 円
  const price = (s, d, n) => (calc(s.v, d, false, n) * 1e8) / calc(s.q, d, false, n);
  function value(s, d, m, n = state.avg, k = kind) {
    if (k === "value") return calc(s.v, d, m === "yoy", n);
    if (k === "qty") return m === "yoy" ? calc(s.q, d, true, n) : calc(s.q, d, false, n) * scale;
    const p = price(s, d, n);
    if (m !== "yoy") return p;
    const p0 = price(s, prevYear(d), n);
    return p0 > 0 && isFinite(p0) ? (p / p0 - 1) * 100 : NaN;
  }

  function draw(it) {
    const { months, series } = build(it);
    calc = MultiLine.series(months);
    kind = it.qty_unit ? state.kind : "value";
    scale = qtyScale(it)[0];
    const f = formats(it, kind);
    const m = state.measure;
    const lines = series.filter((s) => s.color);
    let ms = months.filter((d) => isFinite(value(series[series.length - 1], d, m)));
    if (state.years) ms = ms.slice(-12 * state.years);
    MultiLine.draw($("chart"), $("legend"), {
      months: ms,
      lines: lines.map((s) => ({ name: s.name, color: s.color, val: (d) => value(s, d, m) })),
      extra: series.filter((s) => !s.color).map((s) => ({ name: s.name, val: (d) => value(s, d, m) })),
      yoy: m === "yoy",
      fmt: m === "yoy" ? f.yoyFmt : f.fmt,
      tick: m === "yoy" ? null : f.tick,
      label: `${it.name} 国別の${KINDS[kind]}${m === "yoy" ? "の前年同月比" : ""}`,
    });
    $("chart-note").textContent =
      (state.avg === 3 ? (kind === "price" ? "直近3か月の平均(3か月の輸出額合計÷数量合計)。" : "直近3か月の平均(前年比は3か月合計どうし)。") : "") +
      (m === "yoy" ? "前年同月比は前年同月の輸出がある月だけ描きます。極端な値は軸の端で切っています(値は表と吹き出しで確認できます)。" : `単位は${f.unit}。`) +
      (kind === "price" ? "単価は輸出額÷数量で出した平均単価です。品目の中の製品の構成(容量や種類)が変わっても動きます。輸出の少ない国は振れが大きくなります。" : "") +
      (kind === "qty" ? "数量は税関に申告された数量です。" : "");

    // 表: 最新月の国別
    const d = months[months.length - 1];
    $("latest-month").textContent = fmtMonth(d);
    const tbl = $("table");
    const head = el("tr");
    ["輸出先", KINDS[kind], "前年同月比", kind === "price" ? "" : "構成比"].forEach((t) => head.append(el("th", null, t)));
    tbl.replaceChildren(head);
    const base = (s) => (kind === "value" ? s.v[d] || 0 : kind === "qty" ? (s.q[d] || 0) * scale : NaN);
    const total = base(series[series.length - 1]);
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
        el("td", "num", f.fmt(kind === "price" ? value(s, d, "value", 1) : base(s))),
        el("td", `num ${yc}`, fmtVal(yoy, "yoy")),
        el("td", "num", kind === "price" || s.key === "ALL" || !total ? "" : `${((base(s) / total) * 100).toFixed(1)}%`)
      );
      tbl.append(tr);
    }
    $("hs").textContent = `HSコード: ${it.hs.join("、")}` + (it.qty_unit ? `(数量の単位: ${qtyScale(it)[1]})` : "(数量はHSコードごとに単位が違うため出していません)");
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
    $("kinds").hidden = !it.qty_unit;
    const q = new URLSearchParams({ item: state.item, k: state.kind, m: state.measure, y: state.years, a: state.avg });
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
      buttons($("kinds"), Object.entries(KINDS).map(([k, label]) => [label, k]), state.kind, (v) => { state.kind = v; render(); });
      buttons($("measures"), [["実額", "value"], ["前年同月比", "yoy"]], state.measure, (v) => { state.measure = v; render(); });
      buttons($("ranges"), [["3年", 3], ["5年", 5], ["全期間", 0]], state.years, (v) => { state.years = v; render(); });
      buttons($("avgs"), [["月次", 1], ["3か月平均", 3]], state.avg, (v) => { state.avg = v; render(); });
      render();
    })
    .catch(() => {
      $("status").textContent = "データを読み込めませんでした";
    });
})();
