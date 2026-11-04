(() => {
  "use strict";

  // チャートの作りは lev3watch(3倍ブル見張り台)に合わせている。x 軸だけ日付の間隔どおり(月次と日次が混ざるため)
  const DATA_URL = "data/analysis.json";
  const NS = "http://www.w3.org/2000/svg";
  const DAY = 86400000;
  const RANGES = [
    { key: "1y", label: "1年", years: 1 },
    { key: "3y", label: "3年", years: 3 },
    { key: "10y", label: "10年", years: 10 },
    { key: "all", label: "全期間", years: 0 },
  ];
  const STORE = "nikkei-per-settings";
  const state = { data: null, t: [], settings: { range: "3y", method: "fixed" } };
  try { Object.assign(state.settings, JSON.parse(localStorage.getItem(STORE) || "{}")); } catch (_) { /* 既定値のまま */ }
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(state.settings)); } catch (_) { /* noop */ } };

  const $ = (id) => document.getElementById(id);
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const el = (t, a = {}, p) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); if (p) p.appendChild(e); return e; };
  const fmtD = (s) => s.replace(/-/g, "/");
  const pct = (v, d = 1) => (v == null ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v * 100).toFixed(d) + "%");
  const yen = (v) => (v == null ? "—" : Math.round(v).toLocaleString("ja-JP") + "円");
  const times = (v) => (v == null ? "—" : v.toFixed(2) + "倍");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ZONE = { b: "買い時の検討", s: "売り時の検討", m: "中立(何もしない)" };

  // ---------- 判定の方法 ----------
  function methods() {
    const d = state.data;
    const out = [{ key: "fixed", label: "固定 14/16倍", test: "fixed_all" }];
    d.settings.rel_years.forEach((n) => out.push({ key: "rel" + n, label: `相対 過去${n}年`, test: "rel" + n, n }));
    return out;
  }
  const method = () => methods().find((m) => m.key === state.settings.method) || methods()[0];

  // その日の買いの線・売りの線(PER)
  function bands() {
    const S = state.data.series, m = method();
    if (!m.n) return { lo: S.per.map(() => 14), hi: S.per.map(() => 16), mean: null };
    const mean = S["m" + m.n], sd = S["s" + m.n];
    return {
      lo: mean.map((v, i) => (v == null ? null : v - sd[i])),
      hi: mean.map((v, i) => (v == null ? null : v + sd[i])),
      mean,
    };
  }
  const zoneAt = (per, lo, hi) => (lo == null ? null : per < lo ? "b" : per > hi ? "s" : "m");

  // ---------- チャート(lev3watch の lineChart を時間軸にしたもの) ----------
  function niceStep(x) { const p = Math.pow(10, Math.floor(Math.log10(x))), f = x / p; return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p; }

  function lineChart(host, o) {
    host.innerHTML = "";
    const W = host.clientWidth || 640, H = o.h || 260, m = { l: 52, r: 12, t: 10, b: 24 };
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": o.label || "" }, host);
    const t = o.t, n = t.length, iw = W - m.l - m.r, ih = H - m.t - m.b;
    const t0 = t[0], t1 = t[n - 1];
    const X = (i) => m.l + (t1 === t0 ? 0 : ((t[i] - t0) / (t1 - t0)) * iw);
    let lo = Infinity, hi = -Infinity;
    for (const s of o.series.concat(o.extent || [])) for (const v of s.v) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
    if (o.ymin != null) lo = Math.max(lo, o.ymin);
    // 上限を超える値(2009年春の PER 100倍超など)は上端に貼りつけて描く
    const clipped = o.ymax != null && hi > o.ymax;
    if (clipped) hi = o.ymax;
    const Y = (v) => Math.max(m.t, m.t + ih - ((v - lo) / (hi - lo)) * ih);
    // 買い時・売り時の期間の塗り
    if (o.zones) {
      let s = -1, z = null;
      const flush = (end) => {
        if (s >= 0 && z !== "m" && z != null) {
          const x1 = X(s), x2 = end < n ? X(end) : X(n - 1);
          el("rect", { x: x1, y: m.t, width: Math.max(1, x2 - x1), height: ih, fill: css(z === "b" ? "--shade-b" : "--shade-s") }, svg);
        }
      };
      for (let i = 0; i <= n; i++) { const zi = i < n ? o.zones[i] : "end"; if (zi !== z) { flush(i); s = i; z = zi; } }
    }
    // 目盛り
    const st = niceStep((hi - lo) / 4);
    for (let v = Math.ceil(lo / st) * st; v <= hi; v += st) {
      el("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: css("--grid"), "stroke-width": 1 }, svg);
      el("text", { x: m.l - 6, y: Y(v) + 4, "text-anchor": "end" }, svg).textContent = o.yfmt(v);
    }
    // x の目盛り
    const span = (t1 - t0) / (365.25 * DAY);
    const xk = span > 2.5 ? (i) => o.d[i].slice(0, 4) : (i) => o.d[i].slice(0, 7);
    const xf = span > 2.5 ? (i) => o.d[i].slice(0, 4) : (i) => (+o.d[i].slice(5, 7) === 1 ? o.d[i].slice(0, 4) : +o.d[i].slice(5, 7) + "月");
    let last = xk(0), lastX = -1e9;
    for (let i = 1; i < n; i++) {
      const k = xk(i); if (k === last) continue; last = k;
      if (X(i) - lastX < 46) continue; lastX = X(i);
      el("line", { x1: X(i), x2: X(i), y1: m.t + ih, y2: m.t + ih + 4, stroke: css("--border") }, svg);
      el("text", { x: X(i), y: H - 6, "text-anchor": "middle" }, svg).textContent = xf(i);
    }
    // 中立のあいだ(買いの線〜売りの線)の帯
    if (o.band) {
      let seg = [];
      const flush = () => {
        if (seg.length > 1) {
          let p = seg.map((i, k) => (k ? "L" : "M") + X(i).toFixed(1) + "," + Y(o.band.hi[i]).toFixed(1)).join("");
          for (let k = seg.length - 1; k >= 0; k--) p += "L" + X(seg[k]).toFixed(1) + "," + Y(o.band.lo[seg[k]]).toFixed(1);
          el("path", { d: p + "Z", fill: css("--neutral") }, svg);
        }
        seg = [];
      };
      for (let i = 0; i < n; i++) (o.band.hi[i] == null ? flush() : seg.push(i));
      flush();
    }
    // 線
    for (const s of o.series) {
      let p = "", pen = false;
      s.v.forEach((v, i) => { if (v == null) { pen = false; return; } p += (pen ? "L" : "M") + X(i).toFixed(1) + "," + Y(v).toFixed(1); pen = true; });
      el("path", { d: p, fill: "none", stroke: css(s.c), "stroke-width": s.w || 2, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": s.dash || "" }, svg);
    }
    // 線の名前(右端)
    for (const s of o.series) {
      if (!s.end) continue;
      let i = n - 1; while (i > 0 && s.v[i] == null) i--;
      if (s.v[i] == null) continue;
      el("text", { x: W - m.r, y: Y(s.v[i]) + (s.dy || -5), "text-anchor": "end", style: `fill:${css(s.c)};font-weight:600` }, svg).textContent = s.end;
    }
    // 買・売の印
    const markAt = {};
    for (const mk of o.marks || []) {
      markAt[mk.i] = mk;
      const x = X(mk.i), y = Y(mk.y), b = mk.k === "b", col = css(b ? "--in" : "--out");
      if (o.marks.length > 24) {
        // 合図が多いときは lev3watch の答え合わせのチャートと同じ小さな ▲▼ にする(重なって読めなくなるため)
        const sz = 5, ty = b ? y + 5 : y - 5, dir = b ? 1 : -1;
        el("path", { d: `M${x},${ty} L${x - sz},${ty + dir * sz * 1.6} L${x + sz},${ty + dir * sz * 1.6} Z`, fill: col, stroke: css("--card"), "stroke-width": 1, "stroke-linejoin": "round" }, svg);
        continue;
      }
      const cy = Math.min(m.t + ih - 10, Math.max(m.t + 10, b ? y + 20 : y - 20));
      el("line", { x1: x, x2: x, y1: y, y2: cy, stroke: col, "stroke-width": 1.5 }, svg);
      el("circle", { cx: x, cy: y, r: 3.5, fill: col, stroke: css("--card"), "stroke-width": 1.5 }, svg);
      el("circle", { cx: x, cy, r: 10, fill: col, stroke: css("--card"), "stroke-width": 2 }, svg);
      el("text", { x, y: cy + 4, "text-anchor": "middle", style: "fill:#fff;font-weight:700;font-size:11px" }, svg).textContent = b ? "買" : "売";
    }
    // ホバー
    const cross = el("line", { y1: m.t, y2: m.t + ih, stroke: css("--sub"), "stroke-width": 1, opacity: 0 }, svg);
    const dots = o.series.map((s) => el("circle", { r: 4, fill: css(s.c), stroke: css("--card"), "stroke-width": 2, opacity: 0 }, svg));
    const tip = document.createElement("div"); tip.className = "tip"; tip.hidden = true; host.appendChild(tip);
    const hit = el("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" }, svg);
    const move = (ev) => {
      const r = svg.getBoundingClientRect(), sx = ((ev.clientX - r.left) * W) / r.width;
      const tt = t0 + ((sx - m.l) / iw) * (t1 - t0);
      let a = 0, b = n - 1;
      while (a < b) { const c = (a + b) >> 1; if (t[c] < tt) a = c + 1; else b = c; }
      if (a > 0 && tt - t[a - 1] < t[a] - tt) a--;
      const i = a;
      cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("opacity", 0.5);
      o.series.forEach((s, k) => { const v = s.v[i]; if (v == null) { dots[k].setAttribute("opacity", 0); return; } dots[k].setAttribute("cx", X(i)); dots[k].setAttribute("cy", Y(v)); dots[k].setAttribute("opacity", 1); });
      const mk = markAt[i];
      tip.innerHTML = `<div class="d">${fmtD(o.d[i])}${o.tipExtra ? " · " + o.tipExtra(i) : ""}</div>` +
        (mk ? `<div><b style="color:${css(mk.k === "b" ? "--in" : "--out")}">${mk.k === "b" ? "▲ " : "▼ "}${esc(mk.t)}</b></div>` : "") +
        o.series.filter((s) => !s.noTip).map((s) => `<div><i style="background:${css(s.c)}"></i>${s.n}　<b>${s.v[i] == null ? "—" : o.tfmt(s.v[i])}</b></div>`).join("");
      tip.hidden = false;
      const px = (X(i) * r.width) / W, hw = r.width;
      tip.style.left = Math.min(Math.max(0, px + 12), hw - tip.offsetWidth) + "px";
      if (px + 12 + tip.offsetWidth > hw) tip.style.left = Math.max(0, px - 12 - tip.offsetWidth) + "px";
      tip.style.top = "8px";
    };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerdown", move);
    if (clipped) el("text", { x: m.l + 4, y: m.t + 12, style: "font-size:10px" }, svg).textContent = `${o.yfmt(o.ymax)}より上は上端に表示`;
    hit.addEventListener("pointerleave", () => { tip.hidden = true; cross.setAttribute("opacity", 0); dots.forEach((d) => d.setAttribute("opacity", 0)); });
  }

  // ---------- いまの判定 ----------
  function renderStatus() {
    const d = state.data, S = d.series, c = d.current, m = method(), B = bands();
    const N = S.per.length, last = N - 1;
    const lo = B.lo[last], hi = B.hi[last];
    const z = zoneAt(c.per, lo, hi) || "m";
    $("lead").textContent = m.n
      ? `その月より前の${m.n}年間の PER の平均から1σ下(いまは${lo.toFixed(1)}倍)を下回ったら買い時、1σ上(${hi.toFixed(1)}倍)を超えたら売り時の検討。時代ごとの水準の違いを吸収できます。`
      : "日経平均の PER が14倍を下回ったら買い時、16倍を超えたら売り時の検討。直近10年ほどの水準に合わせた線です。";
    const pill = $("pill");
    pill.classList.toggle("out", z === "s");
    pill.classList.toggle("mid", z === "m");
    $("pillv").textContent = ZONE[z];
    // いまの状態がいつから続いているか
    let since = last;
    while (since > 0 && zoneAt(S.per[since - 1], B.lo[since - 1], B.hi[since - 1]) === z) since--;
    $("pills").textContent = `${fmtD(S.date[since])} から(${fmtD(c.date)} の終値)`;
    const pLo = c.eps * lo, pHi = c.eps * hi;
    $("stats").innerHTML = `
      <div class="stat"><div class="k">PER</div><div class="v">${times(c.per)}</div><div class="s">日経平均 ${yen(c.close)}・EPS ${yen(c.eps)}</div></div>
      <div class="stat"><div class="k">買いの線(${lo.toFixed(1)}倍)の株価</div><div class="v zone-b">${yen(pLo)}</div><div class="s">${z === "b" ? "いまは線より下(買い時)" : `あと ${pct(pLo / c.close - 1)} 下がると買い時`}</div></div>
      <div class="stat"><div class="k">売りの線(${hi.toFixed(1)}倍)の株価</div><div class="v zone-s">${yen(pHi)}</div><div class="s">${z === "s" ? "いまは線より上(売り時)" : `あと ${pct(pHi / c.close - 1)} 上がると売り時`}</div></div>`;
    $("lead2").textContent = `買いの線・売りの線は「EPS × ${m.n ? "その時の線の倍率" : "14倍・16倍"}」で計算した理論株価です。日経平均(黒い線)が赤い線より下なら買い時、青い線より上なら売り時の検討です。`;
  }

  // ---------- チャート ----------
  function renderCharts() {
    const d = state.data, S = d.series, m = method(), B = bands();
    const N = S.date.length;
    const r = RANGES.find((x) => x.key === state.settings.range) || RANGES[1];
    const tEnd = state.t[N - 1];
    let s = 0;
    if (r.years) while (s < N - 1 && state.t[s] < tEnd - r.years * 365.25 * DAY) s++;
    const sl = (a) => a.slice(s);
    const zones = S.per.map((p, i) => zoneAt(p, B.lo[i], B.hi[i]));
    const pLo = S.eps.map((e, i) => (B.lo[i] == null ? null : e * B.lo[i]));
    const pHi = S.eps.map((e, i) => (B.hi[i] == null ? null : e * B.hi[i]));
    const idx = {}; S.date.forEach((dd, i) => (idx[dd] = i));
    const test = d.tests[m.test];
    const evs = test && test.buy ? [...test.buy.events.map((e) => ({ ...e, k: "b" })), ...test.sell.events.map((e) => ({ ...e, k: "s" }))] : [];
    const marks = (valOf) => evs.filter((e) => idx[e.date] >= s).map((e) => ({
      i: idx[e.date] - s, y: valOf(idx[e.date]), k: e.k,
      t: `${e.k === "b" ? "買い時の検討" : "売り時の検討"}(PER ${e.per.toFixed(1)}倍)`,
    }));
    const zoneTip = (i) => { const z = zones[s + i]; return z ? `<span class="zone-${z}">${ZONE[z]}</span>` : ""; };
    const common = { d: sl(S.date), t: sl(state.t), zones: sl(zones), tipExtra: zoneTip };
    lineChart($("ch1"), {
      ...common, h: 280, label: "日経平均と買いの線・売りの線",
      band: { lo: sl(pLo), hi: sl(pHi) },
      series: [
        { n: "売りの線", v: sl(pHi), c: "--out", w: 1.5, dash: "5 4", end: "売りの線" },
        { n: "買いの線", v: sl(pLo), c: "--in", w: 1.5, dash: "5 4", end: "買いの線", dy: 14 },
        { n: "日経平均", v: sl(S.close), c: "--line", w: 1.75 },
      ],
      marks: marks((i) => S.close[i]), ymin: 0,
      yfmt: (v) => (v >= 10000 ? (v / 10000).toLocaleString("ja-JP") + "万" : v.toLocaleString("ja-JP")),
      tfmt: (v) => yen(v),
    });
    const perSeries = [
      { n: "売りの線", v: sl(B.hi), c: "--out", w: 1.5, dash: "5 4", end: m.n ? "売りの線" : "16倍 売り" },
      { n: "買いの線", v: sl(B.lo), c: "--in", w: 1.5, dash: "5 4", end: m.n ? "買いの線" : "14倍 買い", dy: 14 },
    ];
    if (B.mean) perSeries.push({ n: `過去${m.n}年の平均`, v: sl(B.mean), c: "--muted", w: 1.2, dash: "2 3" });
    perSeries.push({ n: "PER", v: sl(S.per), c: "--line", w: 1.75 });
    lineChart($("ch2"), {
      ...common, h: 220, label: "PERの推移",
      band: { lo: sl(B.lo), hi: sl(B.hi) },
      series: perSeries, marks: marks((i) => Math.min(S.per[i], 40)), ymin: 0, ymax: 40,
      yfmt: (v) => v + "倍", tfmt: (v) => v.toFixed(2) + "倍",
    });
    const info = d.info;
    $("chnote").textContent =
      (info.monthly_from && info.daily_from ? `${info.daily_from.slice(0, 4)}年より前は月末の値です。` : "") +
      `${d.settings.basis_change.slice(0, 4)}年頃に PER の計算が単体決算から連結決算に変わりました。` +
      "2009年春はリーマン・ショック後に利益が大きく減り、PER が100倍を超えました(株価は安かったのに PER では「売り時」になる、PER の弱いところです)。" +
      (m.n ? `相対バンドの平均・σには、PER が${d.settings.rel_exclude_above || 50}倍を超えた月を入れていません。` : "");
    // 合図の一覧(新しい順、最大12件)
    const recent = evs.filter((e) => idx[e.date] >= s).sort((a, b) => (a.date < b.date ? 1 : -1));
    $("trtag").textContent = `合図の出た日(${r.label}・${m.label})`;
    $("trades").innerHTML = recent.length
      ? recent.slice(0, 12).map((e) => `<li><span class="mk ${e.k}">${e.k === "b" ? "買" : "売"}</span>${fmtD(e.date)}　PER ${e.per.toFixed(1)}倍・${yen(e.close)}</li>`).join("") +
        (recent.length > 12 ? `<li class="muted">ほか ${recent.length - 12} 回</li>` : "")
      : "<li>この期間は合図なし</li>";
  }

  // ---------- 売買ルール(PER・PBR) ----------
  const toT = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const mult = (v) => "×" + v.toFixed(2);
  function renderTrade() {
    const T = state.data.trade;
    if (!T) return;
    const R = T.rule, now = T.now, S = state.data.series, st = T.stats;
    $("t-lead").textContent = `現金のときは PBR が${R.buy_pbr.toFixed(1)}倍を下回ったら買い、持っているときは PBR が${R.sell_pbr.toFixed(1)}倍を超え、しかも PER が${R.sell_per}倍を超えたら売り。合図は終値で判定し、次の営業日に売買します。持っている間は売りの合図だけ、現金の間は買いの合図だけが出るので、買いと売りは必ず交互になります。`;
    const pill = $("t-pill");
    pill.classList.toggle("out", !now.holding);
    pill.classList.remove("mid");
    const pend = now.pending === "sell" ? "(売りの合図:次の営業日に売る)" : now.pending === "buy" ? "(買いの合図:次の営業日に買う)" : "";
    $("t-pillv").textContent = (now.holding ? "持つ" : "現金で待つ") + pend;
    $("t-pills").textContent = `${fmtD(now.since)} から`;
    const next = now.holding
      ? `<div class="stat"><div class="k">売りの線の株価(PBR ${R.sell_pbr}倍・PER ${R.sell_per}倍の両方を超える)</div><div class="v zone-s">${yen(now.sell_price)}</div><div class="s">あと ${pct(now.sell_price / now.close - 1)} 上がると売り</div></div>`
      : `<div class="stat"><div class="k">買いの線の株価(PBR ${R.buy_pbr}倍)</div><div class="v zone-b">${yen(now.buy_price)}</div><div class="s">あと ${pct(now.buy_price / now.close - 1)} 下がると買い</div></div>`;
    $("t-stats").innerHTML = `
      <div class="stat"><div class="k">PBR / PER</div><div class="v">${now.pbr.toFixed(2)}倍 / ${now.per.toFixed(1)}倍</div><div class="s">日経平均 ${yen(now.close)}(${fmtD(T.to)})</div></div>
      ${next}`;
    // PBR のチャート
    const idx = S.date.map((d, i) => i).filter((i) => S.pbr[i] != null && S.date[i] >= T.from);
    const tr = T.trades, cashAt = (d) => { let h = true; for (const t of tr) { if (t.date > d) break; h = t.side === "buy"; } return h ? "m" : "s"; };
    const dd = idx.map((i) => S.date[i]);
    const pos = {}; dd.forEach((d, k) => (pos[d] = k));
    const marks = tr.filter((t) => pos[t.date] != null).map((t) => ({ i: pos[t.date], y: t.pbr, k: t.side === "buy" ? "b" : "s", t: `${t.side === "buy" ? "買い" : "売り"}(PBR ${t.pbr}倍・PER ${t.per}倍)` }));
    lineChart($("t-ch1"), {
      d: dd, t: dd.map(toT), zones: dd.map(cashAt), h: 240, label: "PBRと売買の線",
      series: [
        { n: "売りの線", v: dd.map(() => R.sell_pbr), c: "--out", w: 1.5, dash: "5 4", end: `${R.sell_pbr}倍 売り` },
        { n: "買いの線", v: dd.map(() => R.buy_pbr), c: "--in", w: 1.5, dash: "5 4", end: `${R.buy_pbr}倍 買い`, dy: 14 },
        { n: "PBR", v: idx.map((i) => S.pbr[i]), c: "--line", w: 1.75 },
      ],
      marks, ymin: 0, yfmt: (v) => v.toFixed(1) + "倍", tfmt: (v) => v.toFixed(2) + "倍",
      tipExtra: (k) => (cashAt(dd[k]) === "s" ? '<b class="zone-s">現金</b>' : '<b class="zone-b">持つ</b>'),
    });
    // 資産の推移
    const C = T.curve;
    lineChart($("t-ch2"), {
      d: C.date, t: C.date.map(toT), zones: C.date.map(cashAt), h: 220, label: "資産の推移",
      series: [
        { n: "持ち続け", v: C.hold, c: "--muted", w: 1.5 },
        { n: "このルール", v: C.rule, c: "--line", w: 2 },
      ],
      ymin: 0, yfmt: (v) => "×" + v, tfmt: (v) => mult(v),
      tipExtra: (k) => (cashAt(C.date[k]) === "s" ? '<b class="zone-s">現金</b>' : '<b class="zone-b">持つ</b>'),
    });
    $("t-trades").innerHTML = tr.map((t) => `<li><span class="mk ${t.side === "buy" ? "b" : "s"}">${t.side === "buy" ? "買" : "売"}</span>${fmtD(t.date)}　${yen(t.close)}(売買した日の PBR ${t.pbr}倍・PER ${t.per}倍)${t.ret != null ? `(${fmtD(t.from)}から ${pct(t.ret)})` : ""}</li>`).join("") || "<li>売買なし</li>";
    const ro = T.rolling, rr = (k) => ro[k] ? `${Math.round(ro[k].win * 100)}%で勝ち・${Math.round(ro[k].same * 100)}%で同じ・${Math.round(ro[k].lose * 100)}%で負け(${ro[k].n}回、いちばん勝った回 ${pct(ro[k].best, 0)})` : "—";
    $("t-table").innerHTML = `
      <tr><th>${fmtD(T.from)}〜${fmtD(T.to)}</th><th>このルール</th><th>持ち続けた場合</th></tr>
      <tr><td>資産(はじめを1として)</td><td>${mult(st.rule.eq)}</td><td>${mult(st.hold.eq)}</td></tr>
      <tr><td>年あたり</td><td>${pct(st.rule.cagr)}</td><td>${pct(st.hold.cagr)}</td></tr>
      <tr><td>途中のいちばん大きな下げ</td><td>${pct(st.rule.mdd, 0)}</td><td>${pct(st.hold.mdd, 0)}</td></tr>
      <tr><td>売買の回数</td><td>${st.rule.n}回</td><td>—</td></tr>
      <tr><td>勝率(買ってから売るまで、今の持ち分も含む)</td><td>${st.rule.win == null ? "—" : Math.round(st.rule.win * 100) + "%"}(${st.rule.rounds}回)</td><td>—</td></tr>
      <tr><td>持っていた期間</td><td>${Math.round(st.rule.in_market * 100)}%</td><td>100%</td></tr>
      <tr><td>始める日を3か月ずつずらして5年続けた場合</td><td colspan="2">${rr("5y")}</td></tr>
      <tr><td>　〃 10年続けた場合</td><td colspan="2">${rr("10y")}</td></tr>`;
    const notes = [
      "なぜこの線か: PBR 1倍は、株価が1株あたりの純資産(会社を解散したときの価値)と同じ水準です。2008年10月・2012年・2016年・2020年3月の底はどれも PBR 1倍前後でした。PBR 2倍超は2005〜2007年の上げ相場の天井付近だけで、2013〜2024年の高値は1.4〜1.6倍でした。",
      "売りに PER も使う理由: リーマン・ショック後(2009年)のように利益が大きく減ると、PER だけが何十倍にも跳ね上がります。そこは底だったので、PBR も高いときだけ売るようにしています。反対に、PER が高いだけ・PER が低いだけの線(例: PER 14倍で買い・16倍で売り)では、上がり続ける相場で早く売りすぎて、持ち続けた場合の×5.83に対して×1.81と大きく負けました(売買12回)。",
      "線の決め方: 買い0.9〜1.2倍・売り1.6〜2.4倍・PER の条件あり/なしなど約500通りを比べ、成績が近い中からキリのよい数字を選びました。売りの線を1.6倍まで下げると売買は増えますが、5年続けた回でいちばん負けた回が −31% になりました。",
      "限界: この期間に売りが出たのは2005年9月の1回だけで、2008年10月に買ったあとは今まで持ち続けています。つまり成績の差は、2005〜2008年の1回の山と谷でほぼ決まっています。2008年以降に始めた人には「持ち続け」と同じ結果です。データは2004年9月からしかなく、それより前(バブル期など)では確かめられていません。",
      `いまの PBR は${now.pbr.toFixed(2)}倍で、売りの線(2倍)に近づいています。PBR 2倍・PER 16倍を両方超えると、次の営業日に売りの合図が出ます。`,
      "計算の前提: 売買のたびに0.1%のコスト、現金の利息は0、税金は考えていません。配当も入れていない(日経平均の値だけ)ので、持ち続けた場合の実際の成績はもう少し良くなります。",
    ];
    $("t-notes").innerHTML = notes.map((t) => `<li>${esc(t)}</li>`).join("");
  }

  // ---------- 持ち方のくらべ ----------
  const PCOL = { all: "--line", half: "--p-b", cash_half: "--p-d", per_all: "--p-h" };
  function renderPatterns() {
    const P = state.data.patterns;
    if (!P) return;
    const items = P.items.slice().sort((a, b) => b.eq - a.eq), H = P.hold_stats;
    const max = Math.max(H.eq, ...items.map((x) => x.eq)), W = (v) => (v / max) * 82 + "%";
    $("c-lead").textContent = `同じ PBR・PER の線を使って、売り買いを「全部」「半分ずつ」「1/3ずつ」「現金の半分だけ」などに変えたら、${fmtD(P.from)}〜${fmtD(P.to)}にどうなったかを比べました。売買は合図の次の営業日の終値、コストは動かした金額の0.1%です。`;
    $("c-hold").textContent = mult(H.eq);
    const held = (w) => (w >= 0.999 ? "全部持つ" : w <= 0.001 ? "全部現金" : `${Math.round(w * 100)}%持つ`);
    $("c-bars").innerHTML = items.map((x) => {
      const better = x.eq > H.eq * 1.005, worse = x.eq < H.eq * 0.995;
      return `<li class="${x.key === "all" ? "main" : ""}" title="${esc(x.desc)}">
        <div class="nm">${esc(x.name)}<small>${esc(x.desc)}</small></div>
        <div>
          <div class="tr"><div class="bar" style="width:${W(x.eq)}"></div><span class="val" style="left:${W(x.eq)}">${mult(x.eq)}</span><div class="ref" style="left:${W(H.eq)}"></div></div>
          <div class="meta"><span class="${better ? "up" : worse ? "dn" : ""}">${better ? "持ち続けより良い" : worse ? "持ち続けより悪い" : "持ち続けと同じ"}</span> · いちばん大きな下げ <b>${pct(x.mdd, 0)}</b> · 売買 <b>${x.n}回</b> · いま <b>${held(x.w)}</b></div>
        </div></li>`;
    }).join("");
    // 資産の推移
    const pick = ["all", "half", "cash_half", "per_all"].map((k) => P.items.find((x) => x.key === k)).filter(Boolean);
    $("c-legend").innerHTML = `<span><i class="dash" style="border-color:var(--muted)"></i>持ち続け ${mult(H.eq)}</span>` +
      pick.map((x) => `<span><i style="background:var(${PCOL[x.key]})"></i>${esc(x.name)} ${mult(x.eq)}</span>`).join("");
    lineChart($("c-ch"), {
      d: P.date, t: P.date.map(toT), h: 260, label: "持ち方ごとの資産の推移",
      series: [{ n: "持ち続け", v: P.hold, c: "--muted", w: 1.5, dash: "5 4" }]
        .concat(pick.map((x) => ({ n: x.name, v: x.curve, c: PCOL[x.key], w: x.key === "all" ? 2.25 : 1.75 }))),
      ymin: 0, yfmt: (v) => "×" + v, tfmt: (v) => mult(v),
    });
    $("c-table").innerHTML = `<tr><th>持ち方</th><th>資産</th><th>年あたり</th><th>いちばん大きな下げ</th><th>売買</th><th>平均の持ち分</th><th>5年続けて持ち続けに負けた回</th><th>いま</th></tr>
      <tr><td>持ち続け</td><td>${mult(H.eq)}</td><td>${pct(H.cagr)}</td><td>${pct(H.mdd, 0)}</td><td>—</td><td>100%</td><td>—</td><td>全部持つ</td></tr>` +
      items.map((x) => `<tr><td>${esc(x.name)}</td><td>${mult(x.eq)}</td><td>${pct(x.cagr)}</td><td>${pct(x.mdd, 0)}</td><td>${x.n}回</td><td>${Math.round(x.in_market * 100)}%</td><td>${x.lose5 == null ? "—" : Math.round(x.lose5 * 100) + "%"}</td><td>${held(x.w)}</td></tr>`).join("");
    const notes = [
      "PBR で決める持ち方は、全部でも半分ずつでも結果はほぼ同じです。2005年に売って2008年のリーマン・ショック後に買い戻した1回の往復で、成績のほとんどが決まっています。",
      "半分ずつ・1/3ずつにすると売買が増え、少しだけ成績が下がります。PBR 1.8倍で一部を売る持ち方は、2026年1月(日経平均 約54,000円)に一部を手放し、そのあとの上昇を取り逃しています。",
      "「現金の半分だけ買う」は、2008年の底で半分しか買い戻さず、そのあとずっと半分が現金のままになるので大きく負けます。下げはいちばん小さくなります。",
      "PER だけで決める持ち方は、全部でも半分ずつでも大きく負けます。景気が悪いときは利益が減って PER が上がるので、底で売ってしまうためです。",
    ];
    $("c-notes").innerHTML = notes.map((t) => `<li>${esc(t)}</li>`).join("");
  }

  // ---------- 答え合わせ ----------
  const cell = (st) => (st ? `${pct(st.median)} <span class="muted">${Math.round(st.win * 100)}%</span>` : "—");
  function renderBacktest() {
    const T = state.data.tests;
    let h = `<tr><th>判定の方法</th><th></th><th>合図</th><th>1か月後</th><th>3か月後</th><th>1年後</th></tr>
      <tr><th class="muted" colspan="3"></th><th class="muted" colspan="3" style="text-align:center">中央値と当たりの割合</th></tr>`;
    Object.values(T).forEach((t) => {
      if (!t.buy) return;
      const rows = [
        ["b", "買い", t.buy.events.length + "回", t.buy.event_stats],
        ["s", "売り", t.sell.events.length + "回", t.sell.event_stats],
        ["", "いつでも", "毎月", t.baseline],
      ];
      rows.forEach((r, j) => {
        h += "<tr>";
        if (j === 0) h += `<td rowspan="3">${esc(t.label)}<br><span class="muted">${t.from.slice(0, 7).replace("-", "/")}〜</span></td>`;
        h += `<td class="${r[0] || "lbl"}">${r[1]}</td><td>${r[2]}</td>` + ["1m", "3m", "1y"].map((k) => `<td>${cell(r[3][k])}</td>`).join("") + "</tr>";
      });
    });
    $("bt").innerHTML = h;
    renderEvents();
  }

  function renderEvents() {
    const t = state.data.tests[method().test];
    if (!t || !t.buy) { $("ev").innerHTML = ""; return; }
    const evs = [...t.buy.events.map((e) => ({ ...e, k: "b" })), ...t.sell.events.map((e) => ({ ...e, k: "s" }))].sort((a, b) => (a.date < b.date ? 1 : -1));
    $("ev").innerHTML = `<tr><th>日付(${esc(t.label)})</th><th>合図</th><th>PER</th><th>終値</th><th>1か月後</th><th>3か月後</th><th>1年後</th></tr>` +
      (evs.length ? evs.map((e) => `<tr><td>${fmtD(e.date)}</td><td class="${e.k}">${e.k === "b" ? "買い時" : "売り時"}</td><td>${times(e.per)}</td><td>${yen(e.close)}</td>${["1m", "3m", "1y"].map((k) => `<td>${pct(e[k])}</td>`).join("")}</tr>`).join("")
        : `<tr><td colspan="7" class="muted">合図はありませんでした</td></tr>`);
  }

  function renderNotes() {
    const i = state.data.info;
    const items = [
      i.monthly_from
        ? `いま使っているデータ: ${i.monthly_from.replace("-", "年")}月〜は月末の値(${i.monthly_months}か月)、${i.daily_from.slice(0, 7).replace("-", "年")}月〜は日次(${i.daily_days.toLocaleString()}日)。`
        : `いま使っているデータ: ${fmtD(i.daily_from)}〜の日次(${i.daily_days.toLocaleString()}日)。`,
      "PER は日経平均プロフィルが公表する「加重平均」の値を使い、無い日は「指数ベース」を使います(指数ベースは加重平均より高めに出ます)。",
      "2004年頃に PER の計算が単体決算から連結決算に変わり、それより前とあとの数字はそのまま比べられません。固定の14/16倍は直近10年で、相対バンドは全期間で見るのが基本です。",
      "相対バンドは、その月より前の月末の値だけで作ります(先の値は使っていません)。",
      "検証の数字は過去の結果で、将来の値動きを約束するものではありません。合図の回数が少ないものは、たまたまの結果である可能性が高いです。",
    ];
    $("notes").innerHTML = items.map((t) => `<li>${esc(t)}</li>`).join("");
  }

  function seg(box, options, key, onChange) {
    box.innerHTML = "";
    options.forEach((o) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = o.label;
      b.setAttribute("aria-pressed", String(state.settings[key] === o.key));
      b.onclick = () => { state.settings[key] = o.key; save(); seg(box, options, key, onChange); onChange(); };
      box.appendChild(b);
    });
  }

  function renderAll() {
    const d = state.data;
    state.t = d.series.date.map((s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
    if (!methods().some((m) => m.key === state.settings.method)) state.settings.method = "fixed";
    seg($("method"), methods(), "method", () => { renderStatus(); renderCharts(); renderEvents(); });
    seg($("rng"), RANGES, "range", renderCharts);
    renderTrade();
    renderPatterns();
    renderStatus();
    renderCharts();
    renderBacktest();
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
      $("main").style.display = "none";
      return;
    }
    st.textContent = `最新データ ${fmtD(d.current.date)} ・ 分析 ${up}`;
    $("main").style.display = "contents";
    renderAll();
  }

  $("reload").onclick = async () => { $("reload").disabled = true; await load(true); $("reload").disabled = false; };
  // 「今すぐ更新」: 更新依頼の Issue を作る画面を開く。所有者が作ると Actions が PER を取り直して分析し直す
  // (.github/workflows/request-nikkei-per-update.yml)。トークンはページに置かない
  const q = new URLSearchParams({
    title: "日経平均PERを更新",
    body: "日経平均PER 買い時・売り時の「今すぐ更新」から作成。\n\nこのまま「Create」(または「Submit new issue」)を押すと、2〜5分で PER の取得・再分析とページの更新が行われます。反映後にページの「最新データを読み込む」を押してください。",
  });
  $("refresh").href = `https://github.com/git-san-934/portal/issues/new?${q}`;

  let rt;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => state.data && state.data.ready && (renderTrade(), renderPatterns(), renderCharts()), 150); });
  load(false);
})();
