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
  const prevYear = (d) => `${+d.slice(0, 4) - 1}${d.slice(4)}`;
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

  // n か月の合計(n=1 は単月)。月の並びは items.months
  let monthIdx = {}, monthList = [];
  const sumN = (s, d, n) => {
    const i = monthIdx[d];
    if (i == null || i - n + 1 < 0) return NaN;
    let t = 0;
    for (let k = i - n + 1; k <= i; k++) t += s.v[monthList[k]] || 0;
    return t;
  };
  const value = (s, d, m, n = state.avg) => {
    const x = sumN(s, d, n);
    if (m !== "yoy") return x / n;
    const p = sumN(s, prevYear(d), n);
    return p > 0 ? (x / p - 1) * 100 : NaN;
  };

  function draw(it) {
    const { months, series } = build(it);
    monthList = months;
    monthIdx = Object.fromEntries(months.map((d, i) => [d, i]));
    const m = state.measure;
    const lines = series.filter((s) => s.color);
    let ms = months.filter((d) => isFinite(value(series[series.length - 1], d, m)));
    if (state.years) ms = ms.slice(-12 * state.years);
    const box = $("chart");
    $("legend").replaceChildren(
      ...lines.map((s) => {
        const sp = el("span");
        const i = el("i");
        i.style.background = s.color;
        sp.append(i, s.name);
        return sp;
      })
    );
    if (ms.length < 2) {
      box.replaceChildren(el("p", "empty", "チャートを描くだけの値がありません"));
      return;
    }
    const W = 440, H = 260, L = 58, R = 12, T = 12, B = 26;
    const vals = lines.flatMap((s) => ms.map((d) => value(s, d, m))).filter((v) => isFinite(v));
    let lo = m === "yoy" ? Math.min(0, ...vals) : 0, hi = Math.max(...vals, 1);
    if (m === "yoy") {
      // 前年が小さい月の極端な伸び率で軸がつぶれないよう、上下1%を切る
      const sorted = [...vals].sort((a, b) => a - b);
      lo = Math.min(0, sorted[Math.floor(sorted.length * 0.01)]);
      hi = Math.max(0, sorted[Math.ceil(sorted.length * 0.99) - 1]);
    }
    const pad = (hi - lo) * 0.06;
    if (m === "yoy") lo -= pad;
    hi += pad;
    const sx = (i) => L + (i / (ms.length - 1)) * (W - L - R);
    const sy = (v) => T + (1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (H - T - B);
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `${it.name} 国別の${m === "yoy" ? "前年同月比" : "輸出額"}`);
    const add = (tag, attrs, text, parent = svg) => {
      const e = document.createElementNS(ns, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      if (text != null) e.textContent = text;
      parent.append(e);
      return e;
    };
    for (let i = 0; i <= 4; i++) {
      const v = lo + ((hi - lo) * i) / 4;
      add("line", { class: "grid", x1: L, x2: W - R, y1: sy(v), y2: sy(v) });
      add("text", { x: L - 6, y: sy(v) + 4, "text-anchor": "end" }, m === "yoy" ? `${Math.round(v)}%` : Math.round(v).toLocaleString("ja-JP"));
    }
    if (lo < 0 && hi > 0) add("line", { class: "grid", x1: L, x2: W - R, y1: sy(0), y2: sy(0), "stroke-dasharray": "4 3" });
    add("text", { x: L, y: H - 6 }, fmtMonth(ms[0]));
    add("text", { x: W - R, y: H - 6, "text-anchor": "end" }, fmtMonth(ms[ms.length - 1]));
    for (const s of [...lines].reverse()) {
      let d = "", pen = false;
      ms.forEach((mo, i) => {
        const v = value(s, mo, m);
        if (!isFinite(v)) { pen = false; return; }
        d += `${pen ? "L" : "M"}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`;
        pen = true;
      });
      add("path", { class: "line", d }).style.stroke = s.color;
    }
    const cross = add("line", { class: "cross", y1: T, y2: H - B, visibility: "hidden" });
    const hit = add("rect", { x: L, y: T, width: W - L - R, height: H - T - B, fill: "transparent" });
    const tip = el("div", "tip");
    tip.hidden = true;
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(ms.length - 1, Math.round(((px - L) / (W - L - R)) * (ms.length - 1))));
      const d = ms[i];
      cross.setAttribute("x1", sx(i));
      cross.setAttribute("x2", sx(i));
      cross.setAttribute("visibility", "visible");
      tip.replaceChildren(el("b", null, fmtMonth(d)));
      for (const s of series) {
        const row = el("div");
        if (s.color) {
          const sw = el("i");
          sw.style.background = s.color;
          row.append(sw);
        }
        row.append(`${s.name} ${fmtVal(value(s, d, m), m)}`);
        tip.append(row);
      }
      tip.hidden = false;
      const x = (sx(i) / W) * r.width;
      tip.style.left = `${x > r.width / 2 ? x - tip.offsetWidth - 10 : x + 10}px`;
      tip.style.top = "8px";
    };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerdown", move);
    hit.addEventListener("pointerleave", () => {
      tip.hidden = true;
      cross.setAttribute("visibility", "hidden");
    });
    box.replaceChildren(svg, tip);
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
