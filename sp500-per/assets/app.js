(() => {
  "use strict";

  // チャートの作りは lev3watch(3倍ブル見張り台)に合わせている。x 軸だけ日付の間隔どおり(日経平均PERのページと同じ)
  const DATA_URL = "data/analysis.json";
  const NS = "http://www.w3.org/2000/svg";
  const DAY = 86400000;
  const RANGES = [
    { key: "1y", label: "1年", years: 1 },
    { key: "3y", label: "3年", years: 3 },
    { key: "10y", label: "10年", years: 10 },
    { key: "all", label: "全期間", years: 0 },
  ];
  const STORE = "sp500-per-settings";
  const state = { data: null, t: [], settings: { range2: "all" } };
  try { Object.assign(state.settings, JSON.parse(localStorage.getItem(STORE) || "{}")); } catch (_) { /* 既定値のまま */ }
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(state.settings)); } catch (_) { /* noop */ } };

  const $ = (id) => document.getElementById(id);
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const el = (t, a = {}, p) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); if (p) p.appendChild(e); return e; };
  const fmtD = (s) => s.replace(/-/g, "/");
  const pct = (v, d = 1) => (v == null ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v * 100).toFixed(d) + "%");
  const pt = (v) => (v == null ? "—" : Math.round(v).toLocaleString("en-US") + "pt");
  const times = (v) => (v == null ? "—" : v.toFixed(2) + "倍");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

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

  // ---------- いまの状態 ----------
  // ---------- 合図の種類 ----------
  // per20: PER の水準(赤い丸) / perma: PER が移動平均より下(オレンジの丸) / pbrma: PBR が移動平均より下(緑の四角)。線は analyze.py が毎日選び直す
  const STYLE = {
    per20: { c: "--in", tc: "#fff", sq: false },
    perma: { c: "--perma", tc: "#fff", sq: false },
    pbrma: { c: "--pbr-b", tc: "#1a1a1a", sq: true },
  };
  const devS = (v) => (v == null ? "—" : (v < 0 ? "−" : "+") + Math.abs(v * 100).toFixed(1) + "%");

  // ---------- いまの状態 ----------
  function renderNow() {
    const d = state.data, c = d.current, R = d.rule, sg = d.signals, K = d.kinds;
    const thPer = Math.round((1 - R.per_ma_th) * 100), thPbr = Math.round((1 - R.pbr_ma_th) * 100);
    $("t-lead").textContent = `買いの合図は3種類です(終値で判定、売りの合図は出しません)。①PER が${R.per_lo}倍を上から下に割った日(次は一度${R.per_re}倍を超えてから)。②PER が${R.per_ma_span}(${R.per_ma}日)の移動平均より${thPer}%以上低くなった日。③PBR が${R.pbr_ma_span}(${R.pbr_ma}日)の移動平均より${thPbr}%以上低くなった日(②③の次の合図は、移動平均の上に戻ってから)。②③は「割高なりに、ふだんより下がった日」を拾うので、好調な相場でも出ます。線(倍率・平均の長さ・下がり方)は毎日の更新で過去のデータから選び直しています。`;
    document.querySelectorAll(".sp-per").forEach((x) => (x.textContent = R.per_ma_span));
    document.querySelectorAll(".sp-pbr").forEach((x) => (x.textContent = R.pbr_ma_span));
    document.querySelectorAll(".lg-per20").forEach((x) => (x.textContent = K.per20.label));
    document.querySelectorAll(".lg-perma").forEach((x) => (x.textContent = K.perma.label));
    document.querySelectorAll(".lg-pbrma").forEach((x) => (x.textContent = K.pbrma.label));
    const last = sg[sg.length - 1];
    const end = d.series.date.length - 1;
    const recent = last && d.series.date.indexOf(last.date) >= end - 5;
    const pill = $("t-pill");
    pill.classList.toggle("out", !recent);
    $("t-pillv").textContent = recent ? `買いの合図(${K[last.kind].short})` : "合図はまだ";
    $("t-pills").textContent = last ? `最後の合図 ${fmtD(last.date)}(${K[last.kind].label})` : "";
    const left = (p) => `あと ${pct(1 - p / c.close).replace("+", "")} 下がったら買いの合図`;
    const perS = !c.armed ? `前の合図のあと PER が${R.per_re}倍を超えていないので、次の合図はまだ出ません`
      : c.per < R.per_lo ? `いま${R.per_lo}倍より下です。一度${R.per_lo}倍を超えてから割ると合図`
      : left(c.price_lo) + "(利益が同じなら)";
    const maS = (armed, p, dev, th) => !armed ? "前の合図のあと移動平均の上に戻っていないので、次の合図はまだ出ません"
      : dev <= -th ? "いま線より下です。移動平均の上に戻ってから、また線を割ると合図"
      : left(p) + "(移動平均がいまのままなら)";
    $("t-stats").innerHTML = `
      <div class="stat"><div class="k">PER / PBR</div><div class="v">${c.per.toFixed(1)}倍 / ${c.pbr == null ? "—" : c.pbr.toFixed(2) + "倍"}</div><div class="s">S&amp;P 500 ${pt(c.close)}(${fmtD(c.date)})</div></div>
      <div class="stat"><div class="k">① PER ${R.per_lo}倍の株価</div><div class="v zone-b">${pt(c.price_lo)}</div><div class="s">${perS}</div></div>
      <div class="stat"><div class="k">② PER の${R.per_ma_span}平均との差</div><div class="v" style="color:var(--perma)">${devS(c.per_dev)}</div><div class="s">${R.per_ma_span}平均 ${c.per_ma.toFixed(1)}倍。−${thPer}%の株価は ${pt(c.price_perma)}。${maS(c.perma_armed, c.price_perma, c.per_dev, 1 - R.per_ma_th)}</div></div>
      <div class="stat"><div class="k">③ PBR の${R.pbr_ma_span}平均との差</div><div class="v">${devS(c.pbr_dev)}</div><div class="s">${R.pbr_ma_span}平均 ${c.pbr_ma == null ? "—" : c.pbr_ma.toFixed(2) + "倍"}。−${thPbr}%の株価は ${pt(c.price_pbrma)}。${maS(c.pbrma_armed, c.price_pbrma, c.pbr_dev, 1 - R.pbr_ma_th)}</div></div>`;
  }

  // ---------- 3つのチャート ----------
  function renderCharts() {
    const d = state.data, S = d.series, R = d.rule, c = d.current, K = d.kinds;
    const all = S.date.map((x, i) => i);
    const r = RANGES.find((x) => x.key === state.settings.range2) || RANGES[RANGES.length - 1];
    const tEnd = state.t[all[all.length - 1]];
    const idx = r.years ? all.filter((i) => state.t[i] >= tEnd - r.years * 365.25 * DAY) : all;
    const dd = idx.map((i) => S.date[i]), tt = idx.map((i) => state.t[i]);
    const pos = {}; dd.forEach((x, k) => (pos[x] = k));
    const v = (key) => idx.map((i) => S[key][i]);
    const sg = d.signals.filter((s) => pos[s.date] != null);
    const mark = (y) => (s) => {
      const z = STYLE[s.kind];
      return { i: pos[s.date], y: y(s), k: "b", big: true, c: z.c, tc: z.tc, sq: z.sq,
        t: `${K[s.kind].label}(PER ${s.per.toFixed(1)}倍${s.pbr == null ? "" : " · PBR " + s.pbr.toFixed(2) + "倍"}${s.dev == null ? "" : " · 平均との差 " + devS(s.dev)})` };
    };
    const tip = (k) => `PER ${S.per[idx[k]] == null ? "—" : S.per[idx[k]].toFixed(1) + "倍"} · PBR ${S.pbr[idx[k]] == null ? "—" : S.pbr[idx[k]].toFixed(2) + "倍"}`;
    // 同じ日に2つの合図が出たら、後のほうを少しずらさず重ねる(ホバーでは最後の1つを表示)
    lineChart($("ch-n"), {
      d: dd, t: tt, h: 300, label: "S&P 500 と買いの合図",
      series: [{ n: "S&P 500", v: v("close"), c: "--line", w: 1.75 }],
      marks: sg.map(mark((s) => s.close)), ymin: 0,
      yfmt: (x) => x.toLocaleString("en-US"), tfmt: (x) => pt(x), tipExtra: tip,
    });
    $("per-lo").textContent = `${R.per_lo}倍`;
    $("per-re").textContent = `${R.per_re}倍`;
    $("per-ma-th").textContent = `−${Math.round((1 - R.per_ma_th) * 100)}%`;
    const pm = v("per_ma");
    lineChart($("ch-per"), {
      d: dd, t: tt, h: 240, label: "PER",
      series: [
        { n: "準備の線", v: dd.map(() => R.per_re), c: "--muted", w: 1.25, dash: "3 4", noTip: true },
        { n: "買いの線", v: dd.map(() => R.per_lo), c: "--in", w: 1.5, dash: "5 4", noTip: true },
        { n: "平均", v: pm, c: "--perma", w: 1.5 },
        { n: "平均の線", v: pm.map((x) => (x == null ? null : x * R.per_ma_th)), c: "--perma", w: 1.25, dash: "5 4" },
        { n: "PER", v: v("per"), c: "--line", w: 1.75 },
      ],
      marks: sg.filter((s) => s.kind !== "pbrma").map(mark((s) => Math.min(s.per, 45))), ymin: 0, ymax: 45,
      yfmt: (x) => x + "倍", tfmt: (x) => x.toFixed(1) + "倍",
    });
    const pb = v("pbr"), has = pb.some((x) => x != null), bm = v("pbr_ma");
    $("pbr-ma-th").textContent = `−${Math.round((1 - R.pbr_ma_th) * 100)}%`;
    if (has) {
      lineChart($("ch-pbr"), {
        d: dd, t: tt, h: 220, label: "PBR",
        series: [
          { n: "平均", v: bm, c: "--pbr-line", w: 1.5 },
          { n: "平均の線", v: bm.map((x) => (x == null ? null : x * R.pbr_ma_th)), c: "--pbr-line", w: 1.25, dash: "5 4" },
          { n: "PBR", v: pb, c: "--line", w: 1.75 },
        ],
        marks: sg.filter((s) => s.kind === "pbrma").map(mark((s) => s.pbr)),
        ymin: 0, yfmt: (x) => x.toFixed(1) + "倍", tfmt: (x) => x.toFixed(2) + "倍",
      });
    } else $("ch-pbr").innerHTML = '<p class="note">この期間は PBR のデータがありません(2000年から)</p>';
    $("chnote").textContent = `PER は45倍より上を上端に貼りつけて表示しています(2009年はリーマン・ショックで利益が大きく減り、PER が100倍を超えました)。PER は${fmtD(c.eps_q)}期までの1年間の利益(as reported)、PBR は${fmtD(c.bps_q)}末の1株純資産で計算しています。四半期の数字は、期末の3か月後(先に公表されたらその日)から使います。移動平均は営業日で数えています(1年はおよそ250日)。`;
  }

  // ---------- 答え合わせ ----------
  function renderResult() {
    const d = state.data, ST = d.stats, K = d.kinds;
    const kinds = Object.keys(K);
    const box = $("r-kind");
    if (!state.settings.kind || !K[state.settings.kind]) state.settings.kind = "all";
    seg(box, [{ key: "all", label: "すべて" }, ...kinds.map((k) => ({ key: k, label: K[k].short }))], "kind", renderResult);
    const sel = state.settings.kind;
    $("r-lead").innerHTML = kinds.map((k) => {
      const s = ST[k];
      return `<b>${esc(K[k].label)}</b>(${s.from.slice(0, 4)}年〜、${s.n}回): 1年後 平均 ${pct(s.sig1.mean)}(${s.sig1.n}回中${s.sig1.win}回上昇、毎日買うと ${pct(s.all1.mean)})・3年後 平均 ${pct(s.sig3.mean)}(${s.sig3.n}回中${s.sig3.win}回上昇、毎日買うと ${pct(s.all3.mean)})`;
    }).join("<br>");
    const list = d.signals.filter((s) => sel === "all" || s.kind === sel).slice().reverse();
    const cls = (x) => (x == null ? "" : x > 0 ? "zone-b" : "zone-s");
    const rows = list.map((s) => {
      const z = STYLE[s.kind];
      return `<tr><td>${fmtD(s.date)}</td><td><span class="mk${z.sq ? " sq" : ""}" style="background:var(${z.c});color:${z.tc}">買</span>${esc(K[s.kind].short)}</td><td>${pt(s.close)}</td><td>${s.per.toFixed(1)}倍</td><td>${s.pbr == null ? "—" : s.pbr.toFixed(2) + "倍"}</td><td class="${cls(s.r1)}">${s.r1 == null ? "まだ" : pct(s.r1)}</td><td class="${cls(s.r3)}">${s.r3 == null ? "まだ" : pct(s.r3)}</td></tr>`;
    }).join("");
    $("r-tbl").innerHTML = `<thead><tr><th>合図の日</th><th>種類</th><th>終値</th><th>PER</th><th>PBR</th><th>1年後</th><th>3年後</th></tr></thead><tbody>${rows}</tbody>`;
    $("r-note").textContent = `値動きは終値の変化だけで、配当(年1〜2%ほど)は含めていません。「毎日買うと」は、その合図が出うる期間のすべての日について、その日に買って1年後・3年後に見た変化率の平均です(毎日買って1年後に上がった割合は約8割)。合図の回数が少ないので、たまたまの部分もあります。`;
  }

  function renderWhy() {
    const d = state.data, K = d.kinds, TU = d.tune, P = d.params;
    const fmtP = (k, p) => (k === "per20" ? `${p.lo}倍割れ(次は${p.lo + p.gap}倍超のあと)` : `${p.n}日平均の${devS(p.th - 1)}`);
    const pts = (v) => (v == null ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1));
    const tbl = (k) => {
      const t = TU[k], cur = (r) => Object.keys(P[k]).every((a) => r[a] === P[k][a]);
      const rows = t.top.map((r) => `<tr${cur(r) ? ' style="font-weight:700"' : ""}><td>${esc(fmtP(k, r))}${cur(r) ? "(使用中)" : ""}</td><td>${r.cnt}</td><td>${pts(r.e1)}</td><td>${pts(r.e3)}</td><td>${pts(r.smooth)}</td></tr>`).join("");
      return `<div class="tw"><table><thead><tr><th>候補の線</th><th>回数</th><th>1年後の超過</th><th>3年後の超過</th><th>点数</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    };
    const walk = (k) => TU[k].walk.periods.map((w) => `${w.from}年〜: ${w.n}回、1年後の平均 ${pct(w.mean1)}(${w.n1}回中${w.win1}回上昇、毎日買うと ${pct(w.all1)})`).join(" / ");
    const hist = (d.tune_history || []).slice().reverse().map((h) => `<li>${fmtD(h.date)} ${esc(K[h.kind].short)}: ${esc(fmtP(h.kind, h.from))} → <b>${esc(fmtP(h.kind, h.to))}</b></li>`).join("");
    const G = d.grid;
    $("why").innerHTML = `
      <p>毎日の更新のたびに、3種類の合図それぞれで候補の線をすべて試し、合図のあと1年・3年の値動きが「毎日買った平均」をどれだけ上回ったかで点数をつけて、いちばん良い線を使います(点数 = 1年後の超過 + 3年後の超過 ÷ 3、単位はポイント)。</p>
      <ul class="note">
        <li>候補: ① PER ${G.per20.lo[0]}〜${G.per20.lo[G.per20.lo.length - 1]}倍 × 次の合図まで +${G.per20.gap.join("・")}倍、②③ 移動平均 ${G.perma.n.join("・")}日 × ${G.perma.th.map((x) => devS(x - 1)).join("・")}</li>
        <li>たまたま1つだけ良い線を選ばないように、線を1段ずらした隣の候補との平均で比べます。合図が5回未満の候補は選びません</li>
        <li>毎日ころころ変わらないように、いまの線との差が1ポイントより小さいうちは変えません</li>
      </ul>
      ${Object.keys(K).map((k) => `<h3>${k === "per20" ? "①" : k === "perma" ? "②" : "③"} ${esc(K[k].label)}</h3>${tbl(k)}<p class="note">年に1回、その時点までのデータだけで線を選び直していたら: ${walk(k)}</p>`).join("")}
      <p class="note"><b>注意</b>: 上の表の成績は、選んだ線で過去をふり返ったものなので、実際より良く見えます。「年に1回選び直していたら」は、その時に分かっていたことだけで選んだ場合の成績です。データが少なかった2000年代は、選んだ線がはずれて毎日買うより悪い年がありました(2007〜08年の下げの途中で何度も合図が出たため)。</p>
      ${hist ? `<h3>線を変えた記録</h3><ul class="note">${hist}</ul>` : ""}
      <p class="note">日経平均のルール(PER 14倍・PBR 1.2倍)は、水準が違いすぎて S&amp;P 500 には使えません。PBR の水準そのもの(固定の倍率)は、自社株買いなどで2009年の約1.4倍から約6倍まで上がり続けていて成績が安定しないので、線を置いていません。PER や株価の移動平均のゴールデンクロス、PER で売り買いを切り替えるルールは、試したうえで使っていません(毎日買う・持ち続けるより悪かったため)。</p>
      <p class="note">EPS は S&amp;P が公表する as reported(一時的な損益を含む)の12か月合計で、不況で利益が落ちると PER が跳ね上がります(2009年など)。1株純資産は公表が遅く、1年以上前の値で計算していることがあります。投資助言ではありません。売買の判断はご自身の責任で行ってください。</p>`;
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
    seg($("rng"), RANGES, "range2", renderCharts);
    renderNow();
    renderCharts();
    renderResult();
    renderWhy();
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
    st.textContent = `最新データ ${fmtD(d.current.date)}(米国の日付) ・ 分析 ${up}`;
    $("main").style.display = "contents";
    renderAll();
  }

  $("reload").onclick = async () => { $("reload").disabled = true; await load(true); $("reload").disabled = false; };
  // 「今すぐ更新」: 更新依頼の Issue を作る画面を開く。所有者が作ると Actions がデータを取り直して分析し直す
  // (.github/workflows/request-sp500-per-update.yml)。トークンはページに置かない
  const q = new URLSearchParams({
    title: "S&P500 PERを更新",
    body: "S&P 500 PER・PBR 買いの合図の「今すぐ更新」から作成。\n\nこのまま「Create」(または「Submit new issue」)を押すと、2〜5分でデータの取得・再分析とページの更新が行われます。反映後にページの「最新データを読み込む」を押してください。",
  });
  $("refresh").href = `https://github.com/git-san-934/portal/issues/new?${q}`;

  let rt;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => state.data && renderCharts(), 150); });
  load(false);
})();
