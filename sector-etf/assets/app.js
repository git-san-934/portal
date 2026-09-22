(() => {
  "use strict";

  const DATA_URL = "data/etf.json";
  const YAHOO_URL = (code) => `https://finance.yahoo.co.jp/quote/${encodeURIComponent(code)}.T`;

  const SORT_OPTIONS = [
    { key: "default", label: "業種順" },
    { key: "m1", label: "1ヶ月" },
    { key: "y1", label: "1年" },
    { key: "y5", label: "5年" },
  ];
  const SCALE_OPTIONS = [
    { key: "own", label: "銘柄ごと" },
    { key: "index", label: "共通(5年前=100)" },
  ];
  const SCALE_NOTES = {
    own: "縦軸は銘柄ごとに最安値〜最高値で合わせています。形は比べやすいですが、上げ幅の大きさは銘柄間で比べられません。",
    index: "5年前の終値を100として全銘柄を同じ縦軸で描いています。上げ幅・下げ幅をそのまま比べられます。",
  };

  // チャート座標(SVG viewBox)。preserveAspectRatio="none" で横幅いっぱいに伸ばす
  const W = 1000;
  const H = 100;
  const PAD_Y = 6;

  const statusEl = document.getElementById("status");
  const tableEl = document.getElementById("etf-table");
  const bodyEl = document.getElementById("etf-body");
  const sortToggleEl = document.getElementById("sort-toggle");
  const scaleToggleEl = document.getElementById("scale-toggle");
  const scaleNoteEl = document.getElementById("scale-note");

  const state = {
    dates: [],
    etfs: [], // { code, sector, name, close, last, lastIdx, firstIdx, m1, y1, y5 }
    sortKey: "default",
    sortDir: "desc",
    scale: "own",
    rows: new Map(), // code -> { tr, box, crosshair, dot, tooltip, ... }
    hoverIdx: null,
    hoverCode: null,
  };

  const numFmt = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 });
  const priceFmt = (v) => (v == null ? "—" : `${numFmt.format(v)}円`);
  const pctText = (v) => {
    if (v == null) return "—";
    const s = Math.abs(v).toLocaleString("ja-JP", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return v > 0 ? `+${s}%` : v < 0 ? `−${s}%` : `${s}%`;
  };
  const pctClass = (v) => (v == null || v === 0 ? "pct" : v > 0 ? "pct up" : "pct down");
  const dateFmt = (iso) => iso.replace(/-/g, "/");

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---------- 計算 ----------

  function firstNonNull(close) {
    for (let i = 0; i < close.length; i++) if (close[i] != null) return i;
    return -1;
  }
  function lastNonNull(close) {
    for (let i = close.length - 1; i >= 0; i--) if (close[i] != null) return i;
    return -1;
  }

  // 基準日(最終日からmonthsヶ月前)以降で最初に値がある日の終値と比べた騰落率
  function changeSince(etf, months) {
    if (etf.lastIdx < 0) return null;
    let startIdx = etf.firstIdx;
    if (months != null) {
      const [y, m, day] = state.dates[etf.lastIdx].split("-").map(Number);
      const target = new Date(Date.UTC(y, m - 1 - months, day)).toISOString().slice(0, 10);
      const i = state.dates.findIndex((x, j) => x >= target && etf.close[j] != null);
      if (i < 0) return null;
      startIdx = i;
    }
    const base = etf.close[startIdx];
    if (base == null || base === 0 || startIdx >= etf.lastIdx) return null;
    return (etf.last / base - 1) * 100;
  }

  function niceTicks(min, max, count) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [];
    const rough = (max - min) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const n = rough / mag;
    const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) {
      ticks.push(Math.round(v * 1000) / 1000);
    }
    return ticks;
  }

  // 表示モードに応じた系列(銘柄ごと=終値そのまま / 共通=5年前を100に指数化)
  function seriesFor(etf) {
    if (state.scale === "own") return etf.close;
    const base = etf.close[etf.firstIdx];
    return etf.close.map((v) => (v == null || !base ? null : (v / base) * 100));
  }

  function extent(values) {
    let min = Infinity;
    let max = -Infinity;
    for (const v of values) {
      if (v == null) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return [min, max];
  }

  // ---------- 描画 ----------

  function yearStarts() {
    const out = [];
    let prevYear = null;
    state.dates.forEach((d, i) => {
      const y = d.slice(0, 4);
      if (y !== prevYear) {
        if (prevYear !== null) out.push({ i, label: y });
        prevYear = y;
      }
    });
    return out;
  }

  const xPct = (i) => (state.dates.length <= 1 ? 50 : (i / (state.dates.length - 1)) * 100);

  function renderChart(row, etf, sharedExtent) {
    const values = seriesFor(etf);
    const [min, max] = sharedExtent || extent(values);
    const range = max - min || 1;
    const yOf = (v) => PAD_Y + (1 - (v - min) / range) * (H - PAD_Y * 2);
    row.yOf = yOf;
    row.values = values;

    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v == null) return; // 取引のない日は前後を線でつなぐ
      d += `${pen ? "L" : "M"}${((xPct(i) / 100) * W).toFixed(1)},${yOf(v).toFixed(1)}`;
      pen = true;
    });

    const ticks = niceTicks(min, max, 3);
    const grid = ticks
      .map((t) => `<line class="grid-line" x1="0" x2="${W}" y1="${yOf(t).toFixed(1)}" y2="${yOf(t).toFixed(1)}" />`)
      .join("");
    const years = yearStarts()
      .map(({ i }) => {
        const x = ((xPct(i) / 100) * W).toFixed(1);
        return `<line class="grid-line" x1="${x}" x2="${x}" y1="0" y2="${H}" />`;
      })
      .join("");
    const base =
      state.scale === "index" && min < 100 && max > 100
        ? `<line class="base-line" x1="0" x2="${W}" y1="${yOf(100).toFixed(1)}" y2="${yOf(100).toFixed(1)}" />`
        : "";

    row.svg.innerHTML = `${years}${grid}${base}<path class="chart-line" d="${d}" />`;

    row.labels.replaceChildren();
    for (const t of ticks) {
      const lab = el("span", "tick-label", numFmt.format(t));
      lab.style.top = `${(yOf(t) / H) * 100}%`;
      row.labels.appendChild(lab);
    }
    for (const { i, label } of yearStarts()) {
      const lab = el("span", "year-label", label);
      lab.style.left = `${xPct(i)}%`;
      row.labels.appendChild(lab);
    }
  }

  function buildRow(etf) {
    const tr = el("tr");
    tr.dataset.code = etf.code;

    const nameTd = el("td", "cell-name");
    nameTd.appendChild(el("div", "sector", etf.sector));
    const codeDiv = el("div", "code");
    const link = el("a", null, etf.code);
    link.href = YAHOO_URL(etf.code);
    link.target = "_blank";
    link.rel = "noopener";
    link.title = `${etf.name}(Yahoo!ファイナンス)`;
    codeDiv.appendChild(link);
    nameTd.appendChild(codeDiv);

    const chartTd = el("td", "cell-chart");
    const box = el("div", "chart-box");
    box.setAttribute("role", "img");
    box.setAttribute(
      "aria-label",
      `${etf.sector}(${etf.code})の5年チャート。5年騰落率 ${pctText(etf.y5)}、直近終値 ${priceFmt(etf.last)}`
    );
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    const labels = el("div");
    const crosshair = el("div", "crosshair");
    const dot = el("div", "dot");
    const tooltip = el("div", "tooltip");
    crosshair.hidden = dot.hidden = tooltip.hidden = true;
    box.append(svg, labels, crosshair, dot, tooltip);
    chartTd.appendChild(box);

    const numTd = (cls, label, text, textCls) => {
      const td = el("td", `col-num ${cls}`);
      td.appendChild(el("span", "num-label", label));
      td.appendChild(el("span", textCls, text));
      return td;
    };

    tr.append(
      nameTd,
      chartTd,
      numTd("cell-price", "終値", priceFmt(etf.last), "num"),
      numTd("cell-m1", "1ヶ月", pctText(etf.m1), `num ${pctClass(etf.m1)}`),
      numTd("cell-y1", "1年", pctText(etf.y1), `num ${pctClass(etf.y1)}`),
      numTd("cell-y5", "5年", pctText(etf.y5), `num ${pctClass(etf.y5)}`)
    );

    const row = { tr, box, svg, labels, crosshair, dot, tooltip, etf };
    attachHover(row);
    return row;
  }

  function renderAllCharts() {
    let shared = null;
    if (state.scale === "index") {
      let min = Infinity;
      let max = -Infinity;
      for (const etf of state.etfs) {
        const [a, b] = extent(seriesFor(etf));
        min = Math.min(min, a);
        max = Math.max(max, b);
      }
      shared = [min, max];
    }
    for (const etf of state.etfs) renderChart(state.rows.get(etf.code), etf, shared);
    scaleNoteEl.textContent = SCALE_NOTES[state.scale];
    updateHover();
  }

  function sortedEtfs() {
    const list = [...state.etfs];
    if (state.sortKey === "default") return list;
    const k = state.sortKey;
    const sign = state.sortDir === "desc" ? -1 : 1;
    return list.sort((a, b) => {
      if (a[k] == null) return 1;
      if (b[k] == null) return -1;
      return sign * (a[k] - b[k]);
    });
  }

  function renderOrder() {
    bodyEl.replaceChildren(...sortedEtfs().map((etf) => state.rows.get(etf.code).tr));
  }

  function renderToggles() {
    sortToggleEl.replaceChildren(
      ...SORT_OPTIONS.map((opt) => {
        const active = opt.key === state.sortKey;
        const arrow = active && opt.key !== "default" ? (state.sortDir === "desc" ? " ↓" : " ↑") : "";
        const btn = el("button", `toggle-btn${active ? " active" : ""}`, opt.label + arrow);
        btn.type = "button";
        btn.setAttribute("aria-pressed", String(active));
        if (opt.key !== "default") {
          btn.title = active
            ? "もう一度押すと並び順が逆になります"
            : `${opt.label}の騰落率が高い順に並べます`;
        }
        btn.addEventListener("click", () => {
          if (state.sortKey === opt.key && opt.key !== "default") {
            state.sortDir = state.sortDir === "desc" ? "asc" : "desc";
          } else {
            state.sortKey = opt.key;
            state.sortDir = "desc";
          }
          renderToggles();
          renderOrder();
        });
        return btn;
      })
    );

    scaleToggleEl.replaceChildren(
      ...SCALE_OPTIONS.map((opt) => {
        const active = opt.key === state.scale;
        const btn = el("button", `toggle-btn${active ? " active" : ""}`, opt.label);
        btn.type = "button";
        btn.setAttribute("aria-pressed", String(active));
        btn.addEventListener("click", () => {
          if (state.scale === opt.key) return;
          state.scale = opt.key;
          renderToggles();
          renderAllCharts();
        });
        return btn;
      })
    );
  }

  // ---------- ホバー(全銘柄の同じ日付に縦線) ----------

  function attachHover(row) {
    const onMove = (ev) => {
      const rect = row.box.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
      state.hoverIdx = Math.round(frac * (state.dates.length - 1));
      state.hoverCode = row.etf.code;
      updateHover();
    };
    const onLeave = () => {
      state.hoverIdx = null;
      state.hoverCode = null;
      updateHover();
    };
    row.box.addEventListener("pointermove", onMove);
    row.box.addEventListener("pointerdown", onMove);
    row.box.addEventListener("pointerleave", onLeave);
    row.box.addEventListener("pointercancel", onLeave);
  }

  // 指定位置に一番近い、値がある日のインデックス
  function nearestWithValue(values, idx) {
    for (let off = 0; off < values.length; off++) {
      if (values[idx - off] != null) return idx - off;
      if (values[idx + off] != null) return idx + off;
    }
    return -1;
  }

  function updateHover() {
    for (const row of state.rows.values()) {
      const active = state.hoverIdx != null;
      row.crosshair.hidden = !active;
      row.tr.classList.toggle("hovered", active && row.etf.code === state.hoverCode);
      const isSource = active && row.etf.code === state.hoverCode;
      row.dot.hidden = !active;
      row.tooltip.hidden = !isSource;
      if (!active) continue;

      const i = nearestWithValue(row.values, state.hoverIdx);
      const left = `${xPct(state.hoverIdx)}%`;
      row.crosshair.style.left = left;
      if (i < 0) {
        row.dot.hidden = true;
        continue;
      }
      row.dot.style.left = `${xPct(i)}%`;
      row.dot.style.top = `${(row.yOf(row.values[i]) / H) * 100}%`;

      if (isSource) {
        const close = row.etf.close[i];
        const toNow = close ? (row.etf.last / close - 1) * 100 : null;
        row.tooltip.textContent = `${dateFmt(state.dates[i])}  ${priceFmt(close)}(現在まで ${pctText(toNow)})`;
        row.tooltip.style.left = left;
        const frac = xPct(state.hoverIdx);
        row.tooltip.classList.toggle("edge-left", frac < 20);
        row.tooltip.classList.toggle("edge-right", frac > 80);
      }
    }
  }

  // ---------- 読み込み ----------

  async function load() {
    try {
      const res = await fetch(DATA_URL, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.dates = data.dates;
      state.etfs = data.etfs.map((e) => {
        const firstIdx = firstNonNull(e.close);
        const lastIdx = lastNonNull(e.close);
        return { ...e, firstIdx, lastIdx, last: lastIdx >= 0 ? e.close[lastIdx] : null };
      });
      for (const etf of state.etfs) {
        etf.m1 = changeSince(etf, 1);
        etf.y1 = changeSince(etf, 12);
        etf.y5 = changeSince(etf, null);
      }

      const lastDate = state.dates[state.dates.length - 1];
      const generated = data.generated_at ? data.generated_at.slice(0, 16).replace("T", " ") : "—";
      statusEl.textContent = `${dateFmt(state.dates[0])}〜${dateFmt(lastDate)} の終値(データ更新: ${generated.replace(/-/g, "/")})`;

      for (const etf of state.etfs) state.rows.set(etf.code, buildRow(etf));
      renderToggles();
      renderOrder();
      tableEl.hidden = false;
      renderAllCharts();
    } catch (err) {
      console.error(err);
      statusEl.textContent =
        "データを読み込めませんでした。まだデータが作られていない場合は、GitHub の Actions タブで「業種別ETFデータ更新」を実行してください。";
      statusEl.classList.add("error");
    }
  }

  load();
})();
