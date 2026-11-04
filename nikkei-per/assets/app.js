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
          el("rect", { x: x1, y: m.t, width: Math.max(1, x2 - x1), height: ih, fill: css(z === "b" ? "--shade-b" : z === "h" ? "--heat" : "--shade-s") }, svg);
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
      const x = X(mk.i), y = Y(mk.y), b = mk.k === "b", col = css(mk.c || (b ? "--in" : "--out"));
      if (mk.tri || (o.marks.length > 24 && !mk.big)) {
        // 合図が多いときは lev3watch の答え合わせのチャートと同じ小さな ▲▼ にする(重なって読めなくなるため)
        const sz = 5, ty = b ? y + 5 : y - 5, dir = b ? 1 : -1;
        el("path", { d: `M${x},${ty} L${x - sz},${ty + dir * sz * 1.6} L${x + sz},${ty + dir * sz * 1.6} Z`, fill: col, stroke: css("--card"), "stroke-width": 1, "stroke-linejoin": "round" }, svg);
        continue;
      }
      const cy = Math.min(m.t + ih - 10, Math.max(m.t + 10, b ? y + 20 : y - 20));
      el("line", { x1: x, x2: x, y1: y, y2: cy, stroke: col, "stroke-width": 1.5 }, svg);
      el("circle", { cx: x, cy: y, r: 3.5, fill: col, stroke: css("--card"), "stroke-width": 1.5 }, svg);
      if (mk.sq) el("rect", { x: x - 10, y: cy - 10, width: 20, height: 20, rx: 3, fill: col, stroke: css("--card"), "stroke-width": 2 }, svg);
      else el("circle", { cx: x, cy, r: 10, fill: col, stroke: css("--card"), "stroke-width": 2 }, svg);
      el("text", { x, y: cy + 4, "text-anchor": "middle", style: `fill:${mk.tc || "#fff"};font-weight:700;font-size:11px` }, svg).textContent = b ? "買" : "売";
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
        (mk ? `<div><b style="color:${css(mk.c || (mk.k === "b" ? "--in" : "--out"))}">${mk.k === "b" ? "▲ " : "▼ "}${esc(mk.t)}</b></div>` : "") +
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

  // ---------- 買いの合図(PER・PBR) ----------
  // 売りの合図は出さない(売り時は見ない)。買いの合図だけを出し、そのあとの値動きを確かめる
  const toT = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const PER_LO = 14, PER_RE = 16, PBR_RE = 1.3;
  // PBR: 買いの線を下回ったあと、下から上に抜けた日が買い。次の合図は PBR が一度 1.3倍を超えてから(線の近くで何度も出ないように)
  // PER: 14倍を上から下に割った日が買い。次の合図は PER が一度 16倍を超えてから
  function buySignals(S, from, buyPbr) {
    const pbr = [], per = [];
    let armed = false, okB = true, okE = true, prev = null;
    for (let i = 0; i < S.date.length; i++) {
      if (S.date[i] < from || S.pbr[i] == null) continue;
      const b = S.pbr[i], e = S.per[i];
      if (b > PBR_RE) okB = true;
      if (b < buyPbr && okB) armed = true;
      else if (armed && b >= buyPbr) { pbr.push({ i, date: S.date[i], close: S.close[i], pbr: b, per: e }); armed = false; okB = false; }
      if (e > PER_RE) okE = true;
      if (okE && prev != null && prev >= PER_LO && e < PER_LO) { per.push({ i, date: S.date[i], close: S.close[i], pbr: b, per: e }); okE = false; }
      prev = e;
    }
    return { pbr, per, armed, okB, okE };
  }
  const sigs = () => { const T = state.data.trade; return buySignals(state.data.series, T.from, T.rule.buy_pbr); };

  function heatStat() {
    const H = state.data.heat;
    if (!H || !H.now) return "";
    const n = H.now, on = !!n[4];
    let since = null;
    for (let k = H.weeks.length - 1; k >= 0 && !!H.weeks[k][4] === on; k--) since = H.weeks[k][0];
    return `<div class="stat"><div class="k">過熱のサイン(信用の買い残)</div><div class="v ${on ? "zone-h" : ""}">${on ? "点灯中" : "消えている"}</div><div class="s">買い残が1年前より ${pct(n[2], 0)}(過去${H.rule.years}年で上位${Math.max(1, Math.round((1 - n[3]) * 100))}%)・${fmtD(n[0])}の週${since && since !== n[0] ? `・${fmtD(since)}の週から` : ""}</div></div>`;
  }

  function renderTrade() {
    const T = state.data.trade;
    if (!T) return;
    const R = T.rule, now = T.now, S = state.data.series, G = sigs();
    $("t-lead").textContent = `売りの合図は出さず、買いの合図だけを出します。PBR は${R.buy_pbr.toFixed(1)}倍を下回ったあと、下から上に${R.buy_pbr.toFixed(1)}倍を抜けた日、PER は${PER_LO}倍を上から下に割った日が買いの合図です。合図は終値で判定します。`;
    const last = [...G.pbr.map((x) => ({ ...x, k: "PBR" })), ...G.per.map((x) => ({ ...x, k: "PER" }))].sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const end = S.date.length - 1, recent = last && end - last.i <= 5;
    const pill = $("t-pill");
    pill.classList.toggle("out", !recent);
    pill.classList.remove("mid");
    $("t-pillv").textContent = recent ? `買いの合図(${last.k})` : "合図はまだ";
    $("t-pills").textContent = last ? `最後の合図 ${fmtD(last.date)}(${last.k})` : "";
    const bp = now.buy_price;
    const pbrS = G.armed ? `線を割っています。${yen(bp)}を上に抜けたら買いの合図`
      : !G.okB ? `前の合図のあと PBR が${PBR_RE}倍を超えていないので、次の合図はまだ出ません`
      : `あと ${pct(1 - bp / now.close).replace("+", "")} 下がって線を割り、そのあと上に抜けたら買いの合図`;
    const perS = !G.okE ? `前の合図のあと PER が${PER_RE}倍を超えていないので、次の合図はまだ出ません`
      : now.per < PER_LO ? `いま${PER_LO}倍より下です。一度${PER_LO}倍を超えてから割ると合図`
      : `あと ${pct(1 - PER_LO / now.per).replace("+", "")} 下がって${PER_LO}倍を割ったら買いの合図(利益が同じなら)`;
    $("t-stats").innerHTML = `
      <div class="stat"><div class="k">PBR / PER</div><div class="v">${now.pbr.toFixed(2)}倍 / ${now.per.toFixed(1)}倍</div><div class="s">日経平均 ${yen(now.close)}(${fmtD(T.to)})</div></div>
      <div class="stat"><div class="k">PBR の買いの線の株価(${R.buy_pbr}倍)</div><div class="v zone-b">${yen(bp)}</div><div class="s">${pbrS}</div></div>
      ${heatStat()}
      <div class="stat"><div class="k">PER の買いの線(${PER_LO}倍)の株価</div><div class="v zone-b">${yen(now.close * PER_LO / now.per)}</div><div class="s">${perS}</div></div>`;

  }

  // ---------- 3つのチャート ----------
  function renderCharts() {
    const d = state.data, S = d.series, T = d.trade;
    if (!T) return;
    const R = T.rule, G = sigs();
    const all = S.date.map((x, i) => i).filter((i) => S.pbr[i] != null && S.date[i] >= T.from);
    const r = RANGES.find((x) => x.key === state.settings.range2) || RANGES[RANGES.length - 1];
    const tEnd = state.t[all[all.length - 1]];
    const idx = r.years ? all.filter((i) => state.t[i] >= tEnd - r.years * 365.25 * DAY) : all;
    const dd = idx.map((i) => S.date[i]), tt = idx.map((i) => state.t[i]);
    const pos = {}; dd.forEach((x, k) => (pos[x] = k));
    const v = (key, f = (x) => x) => idx.map((i) => (S[key][i] == null ? null : f(S[key][i])));
    const pbrT = G.pbr.filter((t) => pos[t.date] != null), perT = G.per.filter((t) => pos[t.date] != null);
    const pbrMark = (y) => (t) => ({ i: pos[t.date], y: y(t), k: "b", c: "--pbr-b", tc: "#1a1a1a", sq: true, big: true, t: `PBR の買いの合図(PBR ${t.pbr.toFixed(2)}倍)` });
    const perMark = (y) => (t) => ({ i: pos[t.date], y: y(t), k: "b", big: true, t: `PER の買いの合図(PER ${t.per.toFixed(1)}倍)` });
    const tip = (k) => `PER ${S.per[idx[k]].toFixed(1)}倍 · PBR ${S.pbr[idx[k]].toFixed(2)}倍`;
    const yenAx = (x) => (x >= 10000 ? (x / 10000).toLocaleString("ja-JP") + "万" : x.toLocaleString("ja-JP"));
    // 過熱のサイン(信用取引の買い残)が点灯していた期間を塗る
    const H = d.heat;
    let zones = null;
    if (H && H.weeks.length) {
      let w = 0, on = 0;
      zones = dd.map((x) => { while (w < H.weeks.length && H.weeks[w][1] <= x) { on = H.weeks[w][4]; w++; } return on ? "h" : "m"; });
    }
    $("heat-lg").hidden = !zones;
    // ① 日経平均
    lineChart($("ch-n"), {
      zones,
      d: dd, t: tt, h: 300, label: "日経平均と買いの合図",
      series: [{ n: "日経平均", v: v("close"), c: "--line", w: 1.75 }],
      marks: [...perT.map(perMark((t) => t.close)), ...pbrT.map(pbrMark((t) => t.close))],
      ymin: 0, yfmt: yenAx, tfmt: (x) => yen(x), tipExtra: tip,
    });
    // ② PER
    $("per-lo").textContent = `${PER_LO}倍`;
    lineChart($("ch-per"), {
      d: dd, t: tt, h: 220, label: "PER",
      series: [
        { n: "買いの線", v: dd.map(() => PER_LO), c: "--in", w: 1.5, dash: "5 4", noTip: true },
        { n: "PER", v: v("per"), c: "--line", w: 1.75 },
      ],
      marks: perT.map(perMark((t) => Math.min(t.per, 30))), ymin: 0, ymax: 30,
      yfmt: (x) => x + "倍", tfmt: (x) => x.toFixed(2) + "倍",
    });
    // ③ PBR
    $("pbr-lo").textContent = `${R.buy_pbr}倍`;
    lineChart($("ch-pbr"), {
      d: dd, t: tt, h: 220, label: "PBR",
      series: [
        { n: "買いの線", v: dd.map(() => R.buy_pbr), c: "--in", w: 1.5, dash: "5 4", noTip: true },
        { n: "PBR", v: v("pbr"), c: "--line", w: 1.75 },
      ],
      marks: pbrT.map(pbrMark((t) => t.pbr)), ymin: 0,
      yfmt: (x) => x.toFixed(1) + "倍", tfmt: (x) => x.toFixed(2) + "倍",
    });
    $("chnote").textContent = "PER は30倍より上を上端に貼りつけて表示しています(2009年春はリーマン・ショック後に利益が大きく減り、PER が100倍を超えました)。売りの合図は出していません。" +
      (zones ? ` ①の薄い色の期間は「過熱のサイン」の点灯中です。信用取引の買い残(金額)が1年前からどれだけ増えたかが、過去${H.rule.years}年の中で上位${Math.round(H.rule.top * 100)}%に入った週(公表を待つため申込日の${H.rule.lag_days}日後から)に点灯します。` : "");
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
    state.t = d.series.date.map((x) => Date.UTC(+x.slice(0, 4), +x.slice(5, 7) - 1, +x.slice(8, 10)));
    if (!state.settings.range2) state.settings.range2 = "all";
    seg($("rng"), RANGES, "range2", renderCharts);
    renderTrade();
    renderCharts();
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
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => state.data && state.data.ready && renderCharts(), 150); });
  load(false);
})();
