(() => {
  "use strict";

  const DATA_URL = "data/analysis.json";
  const SVG = "http://www.w3.org/2000/svg";
  const W = 1000;
  const H = 300;
  const DAY = 86400000;
  const PERIODS = [
    { key: "1y", label: "1年", years: 1 },
    { key: "5y", label: "5年", years: 5 },
    { key: "10y", label: "10年", years: 10 },
    { key: "all", label: "全期間", years: 0 },
  ];
  const ZONE = { buy: "買い時の検討", sell: "売り時の検討", mid: "中立" };
  const STORE = "nikkei-per-settings";

  const state = { data: null, t: [], charts: [], settings: { period: "10y", rel: 5, ev: "fixed_recent" } };
  try {
    Object.assign(state.settings, JSON.parse(localStorage.getItem(STORE) || "{}"));
  } catch (_) { /* 保存できない環境では既定値のまま */ }
  const save = () => {
    try { localStorage.setItem(STORE, JSON.stringify(state.settings)); } catch (_) { /* noop */ }
  };

  const $ = (id) => document.getElementById(id);
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function svgEl(tag, attrs) {
    const e = document.createElementNS(SVG, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  const yen = (v) => (v == null ? "—" : Math.round(v).toLocaleString("ja-JP") + "円");
  const times = (v) => (v == null ? "—" : v.toFixed(2) + "倍");
  const pct = (v, d = 1) => (v == null ? "—" : (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(d) + "%");
  const fmtDate = (s) => s.replace(/-/g, "/");

  // ---------- 今日の判定 ----------
  function renderAdvice() {
    const c = state.data.current;
    $("advice-when").textContent = `${fmtDate(c.date)} の終値での判定`;
    $("advice-per").textContent = `PER ${times(c.per)}`;
    const extra = c.per_index != null && c.per_weighted != null ? `(加重平均 ${times(c.per_weighted)}・指数ベース ${times(c.per_index)})` : "";
    $("advice-reason").textContent = `日経平均 ${yen(c.close)} ・ EPS ${yen(c.eps)} ${extra}`;
    const box = $("verdicts");
    box.textContent = "";
    const add = (title, z, lines) => {
      const v = el("div", "verdict" + (z !== "mid" ? " on-" + z : ""));
      v.append(el("h3", null, title), el("p", "zone " + z, ZONE[z]));
      lines.forEach((l) => v.append(el("p", null, l)));
      box.append(v);
    };
    add("固定 14/16倍", c.fixed.zone, [`14倍の株価 ${yen(c.fixed.price_lo)}`, `16倍の株価 ${yen(c.fixed.price_hi)}`]);
    state.data.settings.rel_years.forEach((n) => {
      const r = c["rel" + n];
      if (!r) return add(`相対 過去${n}年`, "mid", ["データが足りません"]);
      add(`相対 過去${n}年 平均±1σ`, r.zone, [
        `線: ${r.lo.toFixed(1)}〜${r.hi.toFixed(1)}倍(平均 ${r.mean.toFixed(1)}倍)`,
        `株価で ${yen(r.price_lo)}〜${yen(r.price_hi)}`,
      ]);
    });
    const any = [c.fixed.zone, ...state.data.settings.rel_years.map((n) => c["rel" + n] && c["rel" + n].zone)];
    $("advice").classList.toggle("on", any.some((z) => z === "buy" || z === "sell"));
  }

  // ---------- チャート ----------
  function niceTicks(lo, hi, count) {
    const raw = (hi - lo) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((st) => st >= raw);
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }

  function range() {
    const t = state.t;
    const p = PERIODS.find((x) => x.key === state.settings.period) || PERIODS[2];
    const t1 = t[t.length - 1];
    const t0 = p.years ? Math.max(t[0], t1 - p.years * 365.25 * DAY) : t[0];
    let s = 0;
    while (s < t.length - 1 && t[s] < t0) s++;
    return { s, e: t.length - 1, t0, t1 };
  }

  function xLabels(t0, t1) {
    const span = (t1 - t0) / (365.25 * DAY);
    const out = [];
    const d = new Date(t0);
    if (span <= 1.5) {
      d.setUTCDate(1);
      for (d.setUTCMonth(d.getUTCMonth() + 1); d.getTime() <= t1; d.setUTCMonth(d.getUTCMonth() + 1)) {
        const m = d.getUTCMonth() + 1;
        if (span > 0.8 && (m - 1) % 2) continue;
        out.push({ t: d.getTime(), text: m === 1 ? `${d.getUTCFullYear()}` : `${m}月` });
      }
    } else {
      const stepY = span <= 6 ? 1 : span <= 12 ? 2 : 5;
      for (let y = new Date(t0).getUTCFullYear() + 1; Date.UTC(y, 0, 1) <= t1; y++) {
        if (y % stepY) continue;
        out.push({ t: Date.UTC(y, 0, 1), text: String(y) });
      }
    }
    return out;
  }

  function drawChart(box, { s, e, t0, t1, series, bands = [], hlines = [], vlines = [], lo, hi, tickFmt, tipFor, dot }) {
    box.textContent = "";
    const x = (tt) => ((tt - t0) / Math.max(1, t1 - t0)) * W;
    const y = (v) => H - ((v - lo) / (hi - lo)) * H;
    const ticks = niceTicks(lo, hi, 4);
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", "aria-hidden": "true" });
    ticks.forEach((v) => svg.append(svgEl("line", { x1: 0, x2: W, y1: y(v), y2: y(v), class: "grid-line" })));
    bands.forEach((b) => {
      // 上の線を左→右、下の線を右→左でつないで塗る。値が無いところで区切る
      let seg = [];
      const flush = () => {
        if (seg.length > 1) {
          const top = seg.map((i) => `${x(state.t[i]).toFixed(1)},${y(b.hi[i]).toFixed(1)}`);
          const bot = seg.slice().reverse().map((i) => `${x(state.t[i]).toFixed(1)},${y(b.lo[i]).toFixed(1)}`);
          svg.append(svgEl("path", { d: "M" + top.join("L") + "L" + bot.join("L") + "Z", class: b.cls }));
        }
        seg = [];
      };
      for (let i = s; i <= e; i++) (b.hi[i] == null ? flush() : seg.push(i));
      flush();
    });
    vlines.forEach((v) => {
      if (v.t < t0 || v.t > t1) return;
      svg.append(svgEl("line", { x1: x(v.t), x2: x(v.t), y1: 0, y2: H, class: "basis-line" }));
    });
    hlines.forEach((h) => {
      if (h.v < lo || h.v > hi) return;
      svg.append(svgEl("line", { x1: 0, x2: W, y1: y(h.v), y2: y(h.v), class: "th-line", style: `stroke:var(${h.color})` }));
    });
    series.forEach((ser) => {
      let d = "";
      let pen = "M";
      for (let i = s; i <= e; i++) {
        const v = ser.values[i];
        if (v == null) { pen = "M"; continue; }
        d += `${pen}${x(state.t[i]).toFixed(1)},${y(v).toFixed(1)}`;
        pen = "L";
      }
      svg.append(svgEl("path", { d, class: ser.cls }));
    });
    box.append(svg);
    ticks.forEach((v) => {
      const lab = el("span", "tick-label", tickFmt(v));
      lab.style.top = `${(y(v) / H) * 100}%`;
      box.append(lab);
    });
    xLabels(t0, t1).forEach((l) => {
      const lab = el("span", "x-label", l.text);
      lab.style.left = `${(x(l.t) / W) * 100}%`;
      box.append(lab);
    });
    const cross = el("div", "crosshair");
    const dt = el("div", "dot");
    const tip = el("div", "tooltip");
    [cross, dt, tip].forEach((n) => { n.hidden = true; box.append(n); });
    const setHover = (i) => {
      const show = i != null && i >= s && i <= e;
      [cross, dt, tip].forEach((n) => (n.hidden = !show));
      if (!show) return;
      const left = (x(state.t[i]) / W) * 100;
      cross.style.left = dt.style.left = tip.style.left = `${left}%`;
      dt.style.top = `${(y(dot[i]) / H) * 100}%`;
      tip.textContent = tipFor(i);
      tip.classList.toggle("edge-left", left < 15);
      tip.classList.toggle("edge-right", left > 85);
    };
    const onMove = (ev) => {
      const r = box.getBoundingClientRect();
      const px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
      const tt = t0 + (px / r.width) * (t1 - t0);
      // いちばん近い日を二分探索で探す
      let a = s, b = e;
      while (a < b) {
        const m = (a + b) >> 1;
        if (state.t[m] < tt) a = m + 1; else b = m;
      }
      if (a > s && tt - state.t[a - 1] < state.t[a] - tt) a--;
      state.charts.forEach((c) => c(a));
    };
    box.onpointermove = onMove;
    box.onpointerdown = onMove;
    box.onpointerleave = () => state.charts.forEach((c) => c(null));
    return setHover;
  }

  function renderCharts() {
    const S = state.data.series;
    const { s, e, t0, t1 } = range();
    const n = state.settings.rel;
    const m = S["m" + n];
    const sd = S["s" + n];
    const relLo = m.map((v, i) => (v == null ? null : v - sd[i]));
    const relHi = m.map((v, i) => (v == null ? null : v + sd[i]));
    const p14 = S.eps.map((v) => v * 14);
    const p16 = S.eps.map((v) => v * 16);
    const basis = state.data.settings.basis_change;
    const vlines = [{ t: Date.UTC(+basis.slice(0, 4), +basis.slice(5, 7) - 1, 1) }];

    let lo = Infinity, hi = -Infinity;
    for (let i = s; i <= e; i++) {
      [S.per[i], relLo[i], relHi[i]].forEach((v) => { if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
    }
    lo = Math.min(lo, 13); hi = Math.max(hi, 17);
    const pad = (hi - lo) * 0.06;
    state.charts = [];
    const tipPer = (i) => {
      const lines = [`${fmtDate(S.date[i])}${S.freq[i] === "m" ? "(月末)" : ""}`, `PER ${times(S.per[i])}`];
      if (m[i] != null) lines.push(`過去${n}年 ${relLo[i].toFixed(1)}〜${relHi[i].toFixed(1)}倍`);
      return lines.join("\n");
    };
    state.charts.push(drawChart($("chart-per"), {
      s, e, t0, t1, lo: Math.max(0, lo - pad), hi: hi + pad, vlines,
      bands: [{ lo: relLo, hi: relHi, cls: "a-band" }],
      hlines: [{ v: 14, color: "--buy" }, { v: 16, color: "--sell" }],
      series: [{ values: m, cls: "l-mean" }, { values: S.per, cls: "l-main" }],
      tickFmt: (v) => v + "倍", tipFor: tipPer, dot: S.per,
    }));

    lo = Infinity; hi = -Infinity;
    for (let i = s; i <= e; i++) {
      [S.close[i], p14[i], p16[i]].forEach((v) => { lo = Math.min(lo, v); hi = Math.max(hi, v); });
    }
    const pad2 = (hi - lo) * 0.06;
    state.charts.push(drawChart($("chart-price"), {
      s, e, t0, t1, lo: Math.max(0, lo - pad2), hi: hi + pad2, vlines,
      series: [{ values: p14, cls: "l-buy" }, { values: p16, cls: "l-sell" }, { values: S.close, cls: "l-main" }],
      tickFmt: (v) => (v >= 10000 ? (v / 10000).toLocaleString("ja-JP") + "万" : v.toLocaleString("ja-JP")),
      tipFor: (i) => [`${fmtDate(S.date[i])}`, `終値 ${yen(S.close[i])}`, `14倍 ${yen(p14[i])}`, `16倍 ${yen(p16[i])}`].join("\n"),
      dot: S.close,
    }));
    $("chart-note").textContent =
      `点線の縦線は ${basis.replace("-", "年")}月(この頃 PER の計算が単体決算から連結決算に変わりました)。` +
      (state.data.info.monthly_from ? `${state.data.info.daily_from.slice(0, 4)}年より前は月末の値です。` : "") +
      "チャートに触れると、その日の値が出ます。";
  }

  // ---------- 検証の表 ----------
  function statCell(st, side) {
    if (!st) return "—";
    return `${pct(st.median)} ${Math.round(st.win * 100)}%`;
  }

  function renderBacktest() {
    const T = state.data.tests;
    const tb = $("bt-table");
    tb.textContent = "";
    const head = el("tr");
    ["判定の方法", "期間", "", "合図", "1か月後", "3か月後", "1年後"].forEach((h) => head.append(el("th", null, h)));
    tb.append(head);
    const sub = el("tr");
    ["", "", "", "回数", "中央値・当たり", "中央値・当たり", "中央値・当たり"].forEach((h) => sub.append(el("th", "muted", h)));
    tb.append(sub);
    Object.values(T).forEach((t) => {
      if (!t.buy) return;
      const rows = [
        ["buy", "買い", t.buy.events.length, (k) => statCell(t.buy.event_stats[k])],
        ["sell", "売り", t.sell.events.length, (k) => statCell(t.sell.event_stats[k])],
        ["", "いつでも", "毎月", (k) => statCell(t.baseline[k])],
      ];
      rows.forEach((r, j) => {
        const tr = el("tr");
        if (j === 0) {
          const a = el("td", null, t.label);
          a.rowSpan = 3;
          const b = el("td", null, `${t.from.slice(0, 7).replace("-", "/")}〜`);
          b.rowSpan = 3;
          tr.append(a, b);
        }
        tr.append(el("td", r[0], r[1]), el("td", null, String(r[2])));
        ["1m", "3m", "1y"].forEach((k) => tr.append(el("td", null, r[3](k))));
        tb.append(tr);
      });
    });
  }

  function renderEvents() {
    const t = state.data.tests[state.settings.ev];
    const tb = $("ev-table");
    tb.textContent = "";
    if (!t || !t.buy) return;
    const head = el("tr");
    ["日付", "合図", "PER", "線", "終値", "1か月後", "3か月後", "1年後"].forEach((h) => head.append(el("th", null, h)));
    tb.append(head);
    const evs = [...t.buy.events.map((e) => ({ ...e, side: "buy" })), ...t.sell.events.map((e) => ({ ...e, side: "sell" }))]
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    if (!evs.length) {
      const tr = el("tr");
      const td = el("td", "muted", "この期間に合図はありませんでした");
      td.colSpan = 8;
      tr.append(td);
      tb.append(tr);
    }
    evs.forEach((ev) => {
      const tr = el("tr");
      tr.append(
        el("td", null, fmtDate(ev.date)),
        el("td", ev.side, ev.side === "buy" ? "買い検討" : "売り検討"),
        el("td", null, times(ev.per)),
        el("td", "muted", ev.side === "buy" ? `${ev.lo.toFixed(1)}未満` : `${ev.hi.toFixed(1)}超`),
        el("td", null, yen(ev.close)),
      );
      ["1m", "3m", "1y"].forEach((k) => tr.append(el("td", null, pct(ev[k]))));
      tb.append(tr);
    });
  }

  function renderNotes() {
    const d = state.data;
    const i = d.info;
    const ul = $("notes");
    ul.textContent = "";
    const items = [];
    items.push(i.monthly_from
      ? `いま使っているデータ: ${i.monthly_from.replace("-", "年")}月〜${i.daily_from.slice(0, 7).replace("-", "年")}月は月末の値(${i.monthly_months}か月)、それ以降は日次(${i.daily_days.toLocaleString()}日)。`
      : `いま使っているデータ: ${fmtDate(i.daily_from)}〜の日次(${i.daily_days.toLocaleString()}日)。過去40年分にするための月次データはまだ入っていません。`);
    items.push("PERは日経平均プロフィルが公表する「加重平均」の値を使い、無い日は「指数ベース」を使います。計算の方法は日経平均プロフィルの説明のとおりです。");
    items.push("2004年頃に、PERの計算が単体決算から連結決算に変わりました。それより前とあとの数字はそのまま比べられないので、固定の14/16倍は直近10年で見るのが基本です。相対バンドは、その時点までの平均からのずれで判定するので、水準の違いをある程度吸収できます。");
    items.push("バブル期(1989年頃)の日経平均のPERは60倍を超えていました。固定の16倍で見ると昔の期間は「売り検討」ばかりになるのはこのためです。");
    items.push("相対バンドは、その月より前の月末の値だけで作ります(先の値を使っていません)。");
    items.push("検証の数字は過去の結果で、将来の値動きを約束するものではありません。合図の回数が少ない行は、たまたまの結果である可能性が高いです。");
    items.forEach((t) => ul.append(el("li", null, t)));
  }

  function buildToggle(box, options, key, onChange) {
    box.textContent = "";
    options.forEach((o) => {
      const b = el("button", "toggle-btn" + (state.settings[key] === o.key ? " active" : ""), o.label);
      b.type = "button";
      b.setAttribute("aria-pressed", state.settings[key] === o.key);
      b.onclick = () => {
        state.settings[key] = o.key;
        save();
        buildToggle(box, options, key, onChange);
        onChange();
      };
      box.append(b);
    });
  }

  function renderAll() {
    const d = state.data;
    state.t = d.series.date.map((s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
    renderAdvice();
    buildToggle($("period-toggle"), PERIODS, "period", renderCharts);
    buildToggle($("rel-toggle"), d.settings.rel_years.map((n) => ({ key: n, label: `過去${n}年` })), "rel", renderCharts);
    if (!d.tests[state.settings.ev]) state.settings.ev = "fixed_recent";
    buildToggle($("ev-toggle"), Object.entries(d.tests).filter(([, t]) => t.buy).map(([k, t]) => ({ key: k, label: t.label })), "ev", renderEvents);
    renderCharts();
    renderBacktest();
    renderEvents();
    renderNotes();
  }

  async function load(noCache) {
    const st = $("status");
    try {
      const r = await fetch(DATA_URL + (noCache ? `?t=${Date.now()}` : ""), { cache: noCache ? "no-store" : "default" });
      if (!r.ok) throw new Error(r.status);
      state.data = await r.json();
    } catch (e) {
      st.textContent = "データを読み込めませんでした。少し待ってから再読み込みしてください。";
      st.classList.add("error");
      return;
    }
    st.classList.remove("error");
    const d = state.data;
    const up = d.updated ? d.updated.replace("T", " ").slice(0, 16).replace(/-/g, "/") : "";
    if (!d.ready) {
      st.textContent = `${d.message}(確認 ${up})`;
      $("main").hidden = true;
      return;
    }
    st.textContent = `最新データ ${fmtDate(d.current.date)} ・ 分析 ${up}`;
    $("main").hidden = false;
    renderAll();
  }

  $("reload").onclick = async () => {
    $("reload").disabled = true;
    await load(true);
    $("reload").disabled = false;
  };
  window.addEventListener("resize", () => state.data && state.data.ready && renderCharts());
  load(false);
})();
