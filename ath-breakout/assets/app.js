(() => {
  "use strict";

  const DATA_URL = "data/events.json";
  const STOCK_URL = (code) => `data/stocks/${encodeURIComponent(code)}.json`;
  const YAHOO_URL = (code) => `https://finance.yahoo.co.jp/quote/${encodeURIComponent(code)}.T`;

  const GAP_OPTIONS = [
    { key: 60, label: "3ヶ月以上" },
    { key: 250, label: "1年以上" },
    { key: 750, label: "3年以上" },
  ];
  const ERA_OPTIONS = [
    { key: "all", label: "全期間" },
    { key: "2013", label: "2013年以降" },
    { key: "5y", label: "直近5年" },
  ];
  const SIZE_OPTIONS = [
    { key: 0, label: "時価総額上位500" },
    { key: 100, label: "上位100" },
  ];
  const PATH_OPTIONS = [
    { key: "path", label: "株価" },
    { key: "rel", label: "TOPIX比" },
  ];
  const PATH_NOTES = {
    path: "ブレイク日の終値を100として、前後の株価を並べています。1年後まで値がそろっているブレイクだけで集計しています。",
    rel: "ブレイク日を100として、TOPIX連動ETF(1306)に比べてどれだけ強かったか(株価÷TOPIX)を並べています。100より上ならTOPIXより強かったことになります。",
  };
  const HORIZON_LABELS = { 5: "1週後", 20: "1ヶ月後", 60: "3ヶ月後", 120: "6ヶ月後", 250: "1年後" };
  const PAGE = 50;
  const RECENT_DAYS = 92; // 「いま最高値を更新中」とみなすブレイクからの日数(暦日)

  // チャート座標(SVG viewBox)。preserveAspectRatio="none" で横幅いっぱいに伸ばす
  const W = 1000;
  const H = 500;
  const PAD_Y = 16;

  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");
  const mainEl = $("main");

  const state = {
    data: null,
    stockMap: new Map(), // code -> stock
    rankMap: new Map(), // code -> 時価総額順位(1〜)
    gap: 60,
    era: "all",
    size: 0,
    pathKind: "path",
    filtered: [],
    shown: PAGE,
  };

  const numFmt = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 });
  const priceFmt = (v) => (v == null ? "—" : `${numFmt.format(v)}円`);
  const pctText = (v, digits = 1) => {
    if (v == null || Number.isNaN(v)) return "—";
    const s = Math.abs(v * 100).toLocaleString("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return v > 0 ? `+${s}%` : v < 0 ? `−${s}%` : `${s}%`;
  };
  const rateText = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);
  const pctClass = (v) => (v == null || v === 0 ? "pct" : v > 0 ? "pct up" : "pct down");
  const dateFmt = (iso) => iso.replace(/-/g, "/");
  const gapText = (g) => (g >= 250 ? `${numFmt.format(Math.round((g / 250) * 10) / 10)}年ぶり` : `${Math.max(1, Math.round(g / 21))}ヶ月ぶり`);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function pctCell(v) {
    return el("td", pctClass(v), pctText(v));
  }

  // ---------- 集計 ----------

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  function summarize(values) {
    const v = values.filter((x) => x != null).sort((a, b) => a - b);
    if (!v.length) return { n: 0, mean: null, median: null, win: null };
    return {
      n: v.length,
      mean: v.reduce((s, x) => s + x, 0) / v.length,
      median: quantile(v, 0.5),
      win: v.filter((x) => x > 0).length / v.length,
    };
  }

  function eraStart() {
    if (state.era === "2013") return "2013-01-01";
    if (state.era === "5y") {
      const d = new Date(state.data.generated_at.slice(0, 10));
      d.setFullYear(d.getFullYear() - 5);
      return d.toISOString().slice(0, 10);
    }
    return "";
  }

  function applyFilter() {
    const from = eraStart();
    state.filtered = state.data.events
      .filter((e) => e.gap >= state.gap)
      .filter((e) => !from || e.date >= from)
      .filter((e) => !state.size || (state.rankMap.get(e.code) || Infinity) <= state.size);
    state.shown = PAGE;
  }

  // ---------- 描画: 要約・表 ----------

  function renderTiles() {
    const tiles = $("tiles");
    tiles.textContent = "";
    const hIdx = state.data.horizons.indexOf(250);
    const ret = summarize(state.filtered.map((e) => e.ret[hIdx]));
    const exc = summarize(state.filtered.map((e) => e.exc[hIdx]));
    const codes = new Set(state.filtered.map((e) => e.code));
    const items = [
      ["ブレイクの件数", `${state.filtered.length.toLocaleString("ja-JP")}件`, `${codes.size}銘柄`],
      ["1年後に上がっていた割合", rateText(ret.win), `中央値 ${pctText(ret.median)}(${ret.n}件)`],
      ["1年後にTOPIXに勝った割合", rateText(exc.win), `TOPIX比の中央値 ${pctText(exc.median)}`],
    ];
    for (const [label, value, sub] of items) {
      const dl = el("dl", "tile");
      dl.append(el("dt", null, label));
      dl.append(el("dd", null, value));
      dl.append(el("div", "sub", sub));
      tiles.append(dl);
    }
  }

  function renderStats() {
    const table = $("stats");
    table.textContent = "";
    const thead = el("thead");
    const r1 = el("tr");
    r1.append(el("th", null, ""));
    const g1 = el("th", null, "株価の騰落率");
    g1.colSpan = 3;
    const g2 = el("th", "group", "TOPIX比(超過リターン)");
    g2.colSpan = 3;
    r1.append(g1, g2);
    const r2 = el("tr");
    r2.append(el("th", null, "期間"));
    ["平均", "中央値", "上昇した割合"].forEach((t) => r2.append(el("th", null, t)));
    ["平均", "中央値", "勝った割合"].forEach((t, i) => r2.append(el("th", i === 0 ? "group" : null, t)));
    thead.append(r1, r2);

    const tbody = el("tbody");
    state.data.horizons.forEach((h, i) => {
      const r = summarize(state.filtered.map((e) => e.ret[i]));
      const x = summarize(state.filtered.map((e) => e.exc[i]));
      const tr = el("tr");
      const th = el("th", null, HORIZON_LABELS[h] || `${h}営業日後`);
      th.append(el("span", "code", `${r.n}件`));
      tr.append(th, pctCell(r.mean), pctCell(r.median), el("td", null, rateText(r.win)));
      const xm = pctCell(x.mean);
      xm.classList.add("group");
      tr.append(xm, pctCell(x.median), el("td", null, rateText(x.win)));
      tbody.append(tr);
    });
    table.append(thead, tbody);
  }

  function stockCell(code) {
    const s = state.stockMap.get(code);
    const td = el("td", "name", s ? s.name : code);
    td.append(el("span", "code", code));
    return td;
  }
  function clickableRow(tr, code) {
    tr.tabIndex = 0;
    tr.addEventListener("click", () => openStock(code));
    tr.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        openStock(code);
      }
    });
  }
  function headRow(labels) {
    const thead = el("thead");
    const tr = el("tr");
    labels.forEach((t) => tr.append(el("th", t === "銘柄" ? "name" : null, t)));
    thead.append(tr);
    return thead;
  }
  function emptyRow(tbody, cols, text) {
    const tr = el("tr");
    const td = el("td", "empty", text);
    td.colSpan = cols;
    tr.append(td);
    tbody.append(tr);
  }

  function renderRecent() {
    const table = $("recent");
    table.textContent = "";
    const latest = state.data.stocks.reduce((m, s) => (s.last_date > m ? s.last_date : m), "");
    const since = new Date(latest);
    since.setDate(since.getDate() - RECENT_DAYS);
    const from = since.toISOString().slice(0, 10);
    // 条件(空白期間・対象)にあうブレイクのうち、各銘柄の最新1件
    const byCode = new Map();
    for (const e of state.data.events) {
      if (e.date < from || e.gap < state.gap) continue;
      if (state.size && (state.rankMap.get(e.code) || Infinity) > state.size) continue;
      byCode.set(e.code, e);
    }
    const rows = [...byCode.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
    table.append(headRow(["銘柄", "ブレイク日", "前回の最高値から", "ブレイク後", "最高値から"]));
    const tbody = el("tbody");
    for (const e of rows) {
      const s = state.stockMap.get(e.code);
      const tr = el("tr");
      tr.append(stockCell(e.code), el("td", null, dateFmt(e.date)), el("td", null, gapText(e.gap)));
      tr.append(pctCell(s ? s.last / e.price - 1 : null), pctCell(s ? s.from_ath : null));
      clickableRow(tr, e.code);
      tbody.append(tr);
    }
    if (!rows.length) emptyRow(tbody, 5, "この条件にあう最近のブレイクはありません");
    table.append(tbody);
  }

  function renderEvents() {
    const table = $("events");
    table.textContent = "";
    const hs = state.data.horizons;
    const i1m = hs.indexOf(20);
    const i3m = hs.indexOf(60);
    const i1y = hs.indexOf(250);
    table.append(headRow(["ブレイク日", "銘柄", "前回の最高値から", "1ヶ月後", "3ヶ月後", "1年後", "1年後のTOPIX比"]));
    const tbody = el("tbody");
    const rows = [...state.filtered].reverse().slice(0, state.shown);
    for (const e of rows) {
      const tr = el("tr");
      tr.append(el("td", null, dateFmt(e.date)), stockCell(e.code), el("td", null, gapText(e.gap)));
      tr.append(pctCell(e.ret[i1m]), pctCell(e.ret[i3m]), pctCell(e.ret[i1y]), pctCell(e.exc[i1y]));
      clickableRow(tr, e.code);
      tbody.append(tr);
    }
    if (!rows.length) emptyRow(tbody, 7, "この条件にあうブレイクはありません");
    table.append(tbody);
    $("more").hidden = state.shown >= state.filtered.length;
  }

  // ---------- 描画: チャート共通 ----------

  function niceTicks(min, max, targetCount) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [];
    const roughStep = (max - min) / targetCount;
    const mag = Math.pow(10, Math.floor(Math.log10(roughStep)));
    const norm = roughStep / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) ticks.push(Math.round(v * 100) / 100);
    return ticks;
  }
  // 対数目盛り用: 1・2・5 × 10^k のうち範囲内のもの
  function logTicks(min, max) {
    const ticks = [];
    for (let k = Math.floor(Math.log10(min)); k <= Math.ceil(Math.log10(max)); k++) {
      for (const m of [1, 2, 5]) {
        const v = m * Math.pow(10, k);
        if (v >= min && v <= max) ticks.push(v);
      }
    }
    return ticks.length > 8 ? ticks.filter((v) => String(v)[0] === "1") : ticks;
  }

  function svgEl(tag, attrs) {
    const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }

  // box にチャートを描き、ホバー時に tooltipFor(i) を呼ぶ共通の枠組み
  // xs: 0〜1 の横位置、ys: 0〜1 の縦位置(上が0)
  function mountChart(box, { paths, hLines, xLabels, dots, hoverXs, hoverYs, tooltipFor }) {
    box.textContent = "";
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" });
    for (const { y, cls } of hLines) svg.append(svgEl("line", { x1: 0, x2: W, y1: y * H, y2: y * H, class: cls }));
    for (const p of paths) svg.append(p);
    box.append(svg);
    for (const { y, text } of hLines) {
      if (!text) continue;
      const lab = el("span", "tick-label", text);
      lab.style.top = `${y * 100}%`;
      box.append(lab);
    }
    xLabels.forEach(({ x, text }, i) => {
      const lab = el("span", i === 0 && x < 0.05 ? "x-label first" : "x-label", text);
      lab.style.left = `${x * 100}%`;
      box.append(lab);
    });
    for (const { x, y } of dots) {
      const d = el("span", "event-dot");
      d.style.left = `${x * 100}%`;
      d.style.top = `${y * 100}%`;
      box.append(d);
    }

    const cross = el("div", "crosshair");
    const dot = el("div", "dot");
    const tip = el("div", "tooltip");
    [cross, dot, tip].forEach((n) => (n.hidden = true));
    box.append(cross, dot, tip);

    function show(clientX) {
      const rect = box.getBoundingClientRect();
      const fx = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      let best = -1;
      let bestDist = Infinity;
      hoverXs.forEach((x, i) => {
        if (hoverYs[i] == null) return;
        const d = Math.abs(x - fx);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
      if (best < 0) return;
      const x = hoverXs[best];
      cross.style.left = `${x * 100}%`;
      dot.style.left = `${x * 100}%`;
      dot.style.top = `${hoverYs[best] * 100}%`;
      tip.style.left = `${x * 100}%`;
      tip.textContent = tooltipFor(best);
      tip.classList.toggle("edge-left", x < 0.15);
      tip.classList.toggle("edge-right", x > 0.85);
      [cross, dot, tip].forEach((n) => (n.hidden = false));
    }
    function hide() {
      [cross, dot, tip].forEach((n) => (n.hidden = true));
    }
    box.onpointermove = (ev) => show(ev.clientX);
    box.onpointerdown = (ev) => show(ev.clientX);
    box.onpointerleave = hide;
  }

  function linePath(xs, ys) {
    let d = "";
    let pen = false;
    xs.forEach((x, i) => {
      if (ys[i] == null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${(x * W).toFixed(1)},${(ys[i] * H).toFixed(1)}`;
      pen = true;
    });
    return d;
  }

  // ---------- 描画: ブレイク前後の平均的な値動き ----------

  function offsetLabel(off) {
    if (off === 0) return "ブレイク日";
    const a = Math.abs(off);
    const t = a >= 250 ? "1年" : a >= 21 ? `${Math.round(a / 21)}ヶ月` : `${a}営業日`;
    return off < 0 ? `${t}前` : `${t}後`;
  }

  function renderPath() {
    const kind = state.pathKind;
    $("path-note").textContent = PATH_NOTES[kind];
    const offs = state.data.path_offsets;
    const last = offs.length - 1;
    const evs = state.filtered.filter((e) => e[kind][last] != null && e[kind][0] != null);
    const q = offs.map((_, i) => {
      const v = evs.map((e) => e[kind][i]).filter((x) => x != null).map((x) => x / 10).sort((a, b) => a - b);
      return { lo: quantile(v, 0.25), mid: quantile(v, 0.5), hi: quantile(v, 0.75), n: v.length };
    });
    const box = $("path-chart");
    if (!evs.length) {
      box.textContent = "";
      box.append(el("p", "empty", "1年後まで値がそろっているブレイクがありません"));
      return;
    }
    let min = Math.min(100, ...q.map((d) => d.lo));
    let max = Math.max(100, ...q.map((d) => d.hi));
    const pad = (max - min) * 0.08 || 1;
    min -= pad;
    max += pad;
    const toY = (v) => (v == null ? null : (PAD_Y + ((max - v) / (max - min)) * (H - 2 * PAD_Y)) / H);
    const x0 = offs[0];
    const xs = offs.map((o) => (o - x0) / (offs[last] - x0));

    const band = svgEl("path", {
      class: "chart-band",
      d:
        xs.map((x, i) => `${i ? "L" : "M"}${(x * W).toFixed(1)},${(toY(q[i].hi) * H).toFixed(1)}`).join("") +
        xs.map((x, i) => i).reverse().map((i) => `L${(xs[i] * W).toFixed(1)},${(toY(q[i].lo) * H).toFixed(1)}`).join("") +
        "Z",
    });
    const mids = q.map((d) => toY(d.mid));
    const line = svgEl("path", { class: "chart-line", d: linePath(xs, mids) });
    const zeroX = xs[offs.indexOf(0)];
    const vline = svgEl("line", { x1: zeroX * W, x2: zeroX * W, y1: 0, y2: H, class: "base-line" });

    const hLines = niceTicks(min, max, 5).map((v) => ({ y: toY(v), cls: v === 100 ? "base-line" : "grid-line", text: numFmt.format(v) }));
    if (!hLines.some((h) => h.cls === "base-line")) hLines.push({ y: toY(100), cls: "base-line", text: "" });
    const labelOffs = [-60, 0, 60, 120, 250];
    const xLabels = labelOffs.filter((o) => offs.includes(o)).map((o) => ({ x: xs[offs.indexOf(o)], text: offsetLabel(o) }));

    mountChart(box, {
      paths: [band, vline, line],
      hLines,
      xLabels,
      dots: [],
      hoverXs: xs,
      hoverYs: mids,
      tooltipFor: (i) => {
        const d = q[i];
        const f = (v) => numFmt.format(Math.round(v * 10) / 10);
        return `${offsetLabel(offs[i])}\n中央値 ${f(d.mid)}(25〜75%: ${f(d.lo)}〜${f(d.hi)})\n${d.n}件`;
      },
    });
  }

  // ---------- 描画: 銘柄チャート ----------

  const dialog = $("stock-dialog");
  $("dialog-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (ev) => {
    if (ev.target === dialog) dialog.close();
  });

  async function openStock(code) {
    const s = state.stockMap.get(code);
    $("dialog-title").textContent = `${s ? s.name : ""} ${code}`;
    const sub = $("dialog-sub");
    sub.textContent = s
      ? `最高値 ${priceFmt(s.ath)}(${dateFmt(s.ath_date)}) ・ 直近 ${priceFmt(s.last)}(最高値から ${pctText(s.from_ath)}) ・ データ開始 ${dateFmt(s.first_date)} ・ `
      : "";
    const a = el("a", null, "Yahoo!ファイナンス");
    a.href = YAHOO_URL(code);
    a.target = "_blank";
    a.rel = "noopener";
    sub.append(a);
    const box = $("stock-chart");
    box.textContent = "";
    box.append(el("p", "empty", "読み込み中..."));
    renderStockEvents(code);
    if (!dialog.open) dialog.showModal();
    try {
      const res = await fetch(STOCK_URL(code));
      if (!res.ok) throw new Error(res.status);
      drawStock(box, await res.json());
    } catch (err) {
      console.error(err);
      box.textContent = "";
      box.append(el("p", "empty", "チャートを読み込めませんでした"));
    }
  }

  function drawStock(box, d) {
    const vals = d.weekly;
    const start = new Date(`${d.start}T00:00:00Z`).getTime();
    const weekDate = (i) => new Date(start + i * 7 * 864e5).toISOString().slice(0, 10);
    const present = vals.filter((v) => v != null && v > 0);
    const min = Math.min(...present) * 0.9;
    const max = Math.max(...present) * 1.1;
    const lmin = Math.log(min);
    const lmax = Math.log(max);
    // 長い期間を見るので縦軸は対数(同じ上昇率が同じ高さになる)
    const toY = (v) => (v == null || v <= 0 ? null : (PAD_Y + ((lmax - Math.log(v)) / (lmax - lmin)) * (H - 2 * PAD_Y)) / H);
    const n = vals.length;
    const xs = vals.map((_, i) => (n > 1 ? i / (n - 1) : 0));
    const ys = vals.map(toY);
    const line = svgEl("path", { class: "chart-line", d: linePath(xs, ys) });

    const hLines = logTicks(min, max).map((v) => ({ y: toY(v), cls: "grid-line", text: numFmt.format(v) }));
    const xLabels = [];
    const firstYear = Number(d.start.slice(0, 4));
    const lastYear = Number(weekDate(n - 1).slice(0, 4));
    const step = Math.max(1, Math.ceil((lastYear - firstYear) / 6));
    for (let y = firstYear + 1; y <= lastYear; y += step) {
      const i = Math.ceil((Date.UTC(y, 0, 1) - start) / (7 * 864e5));
      if (i > 0 && i < n) xLabels.push({ x: xs[i], text: String(y) });
    }
    const dots = (d.events || [])
      .map((date) => Math.ceil((new Date(`${date}T00:00:00Z`).getTime() - start) / (7 * 864e5)))
      .filter((i) => i >= 0 && i < n && ys[i] != null)
      .map((i) => ({ x: xs[i], y: ys[i] }));

    mountChart(box, {
      paths: [line],
      hLines,
      xLabels,
      dots,
      hoverXs: xs,
      hoverYs: ys,
      tooltipFor: (i) => `${dateFmt(weekDate(i))}の週\n${priceFmt(vals[i])}`,
    });
  }

  function renderStockEvents(code) {
    const table = $("stock-events");
    table.textContent = "";
    const hs = state.data.horizons;
    const i3m = hs.indexOf(60);
    const i1y = hs.indexOf(250);
    table.append(headRow(["ブレイク日", "前回の最高値から", "3ヶ月後", "1年後", "1年後のTOPIX比", "1年以内の最大下落"]));
    const tbody = el("tbody");
    const evs = state.data.events.filter((e) => e.code === code).reverse();
    for (const e of evs) {
      const tr = el("tr");
      tr.append(el("td", null, dateFmt(e.date)), el("td", null, gapText(e.gap)));
      tr.append(pctCell(e.ret[i3m]), pctCell(e.ret[i1y]), pctCell(e.exc[i1y]), pctCell(e.mdd));
      tbody.append(tr);
    }
    if (!evs.length) emptyRow(tbody, 6, "ブレイクはありません");
    table.append(tbody);
  }

  // ---------- 操作 ----------

  function renderToggle(container, options, getKey, setKey) {
    container.textContent = "";
    for (const opt of options) {
      const btn = el("button", "toggle-btn", opt.label);
      btn.type = "button";
      const active = getKey() === opt.key;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
      btn.addEventListener("click", () => {
        setKey(opt.key);
        renderToggle(container, options, getKey, setKey);
      });
      container.append(btn);
    }
  }

  function renderAll() {
    applyFilter();
    renderTiles();
    renderStats();
    renderPath();
    renderRecent();
    renderEvents();
  }

  function setupControls() {
    renderToggle($("gap-toggle"), GAP_OPTIONS, () => state.gap, (k) => ((state.gap = k), renderAll()));
    renderToggle($("era-toggle"), ERA_OPTIONS, () => state.era, (k) => ((state.era = k), renderAll()));
    renderToggle($("size-toggle"), SIZE_OPTIONS, () => state.size, (k) => ((state.size = k), renderAll()));
    renderToggle($("path-toggle"), PATH_OPTIONS, () => state.pathKind, (k) => ((state.pathKind = k), renderPath()));
    $("more").addEventListener("click", () => {
      state.shown += PAGE;
      renderEvents();
    });
  }

  async function init() {
    try {
      const res = await fetch(DATA_URL, { cache: "no-cache" });
      if (!res.ok) throw new Error(res.status);
      state.data = await res.json();
    } catch (err) {
      console.error(err);
      statusEl.textContent = "データを読み込めませんでした。初回はデータの自動作成が終わるまでお待ちください。";
      statusEl.classList.add("error");
      return;
    }
    const d = state.data;
    [...d.stocks].sort((a, b) => b.market_cap - a.market_cap).forEach((s, i) => {
      state.stockMap.set(s.code, s);
      state.rankMap.set(s.code, i + 1);
    });
    statusEl.textContent = `${d.stocks.length}銘柄 ・ ブレイク ${d.events.length.toLocaleString("ja-JP")}件 ・ データ更新: ${d.generated_at.replace("T", " ")}`;
    setupControls();
    renderAll();
    mainEl.hidden = false;
  }

  init();
})();
