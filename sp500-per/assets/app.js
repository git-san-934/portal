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
  function renderNow() {
    const d = state.data, c = d.current, R = d.rule, sg = d.signals;
    $("t-lead").textContent = `PER が${R.per_lo}倍を上から下に割った日が買いの合図です(終値で判定)。次の合図は、PER が一度${R.per_re}倍を超えてから。売りの合図は出しません。PBR は参考に表示しています。`;
    const last = sg[sg.length - 1];
    const end = d.series.date.length - 1;
    const recent = last && d.series.date.indexOf(last.date) >= end - 5;
    const pill = $("t-pill");
    pill.classList.toggle("out", !recent);
    $("t-pillv").textContent = recent ? "買いの合図(PER)" : "合図はまだ";
    $("t-pills").textContent = last ? `最後の合図 ${fmtD(last.date)}` : "";
    const perS = !c.armed ? `前の合図のあと PER が${R.per_re}倍を超えていないので、次の合図はまだ出ません`
      : c.per < R.per_lo ? `いま${R.per_lo}倍より下です。一度${R.per_lo}倍を超えてから割ると合図`
      : `あと ${pct(1 - c.price_lo / c.close).replace("+", "")} 下がって${R.per_lo}倍を割ったら買いの合図(利益が同じなら)`;
    $("t-stats").innerHTML = `
      <div class="stat"><div class="k">PER / PBR</div><div class="v">${c.per.toFixed(1)}倍 / ${c.pbr == null ? "—" : c.pbr.toFixed(2) + "倍"}</div><div class="s">S&amp;P 500 ${pt(c.close)}(${fmtD(c.date)})</div></div>
      <div class="stat"><div class="k">PER の買いの線(${R.per_lo}倍)の株価</div><div class="v zone-b">${pt(c.price_lo)}</div><div class="s">${perS}</div></div>
      <div class="stat"><div class="k">PER の位置</div><div class="v">${Math.round(c.per_rank * 100)}%</div><div class="s">${R.from.slice(0, 4)}年以降で、いまより低かった日の割合(中央値 ${c.per_median.toFixed(1)}倍)</div></div>
      <div class="stat"><div class="k">PBR の位置(参考)</div><div class="v">${c.pbr_rank == null ? "—" : Math.round(c.pbr_rank * 100) + "%"}</div><div class="s">2000年以降で、いまより低かった日の割合(中央値 ${c.pbr_median.toFixed(2)}倍、最高 ${c.pbr_max.toFixed(2)}倍)</div></div>`;
  }

  // ---------- 3つのチャート ----------
  function renderCharts() {
    const d = state.data, S = d.series, R = d.rule, c = d.current;
    const all = S.date.map((x, i) => i);
    const r = RANGES.find((x) => x.key === state.settings.range2) || RANGES[RANGES.length - 1];
    const tEnd = state.t[all[all.length - 1]];
    const idx = r.years ? all.filter((i) => state.t[i] >= tEnd - r.years * 365.25 * DAY) : all;
    const dd = idx.map((i) => S.date[i]), tt = idx.map((i) => state.t[i]);
    const pos = {}; dd.forEach((x, k) => (pos[x] = k));
    const v = (key) => idx.map((i) => S[key][i]);
    const sg = d.signals.filter((s) => pos[s.date] != null);
    const mark = (y) => (s) => ({ i: pos[s.date], y: y(s), k: "b", big: true, t: `PER の買いの合図(PER ${s.per.toFixed(1)}倍)` });
    const tip = (k) => `PER ${S.per[idx[k]] == null ? "—" : S.per[idx[k]].toFixed(1) + "倍"} · PBR ${S.pbr[idx[k]] == null ? "—" : S.pbr[idx[k]].toFixed(2) + "倍"}`;
    lineChart($("ch-n"), {
      d: dd, t: tt, h: 300, label: "S&P 500 と買いの合図",
      series: [{ n: "S&P 500", v: v("close"), c: "--line", w: 1.75 }],
      marks: sg.map(mark((s) => s.close)), ymin: 0,
      yfmt: (x) => x.toLocaleString("en-US"), tfmt: (x) => pt(x), tipExtra: tip,
    });
    $("per-lo").textContent = `${R.per_lo}倍`;
    $("per-re").textContent = `${R.per_re}倍`;
    lineChart($("ch-per"), {
      d: dd, t: tt, h: 220, label: "PER",
      series: [
        { n: "準備の線", v: dd.map(() => R.per_re), c: "--muted", w: 1.25, dash: "3 4", noTip: true },
        { n: "買いの線", v: dd.map(() => R.per_lo), c: "--in", w: 1.5, dash: "5 4", noTip: true },
        { n: "PER", v: v("per"), c: "--line", w: 1.75 },
      ],
      marks: sg.map(mark((s) => s.per)), ymin: 0, ymax: 45,
      yfmt: (x) => x + "倍", tfmt: (x) => x.toFixed(1) + "倍",
    });
    const pb = v("pbr"), has = pb.some((x) => x != null);
    $("pbr-md").textContent = `${c.pbr_median.toFixed(2)}倍`;
    if (has) {
      lineChart($("ch-pbr"), {
        d: dd, t: tt, h: 220, label: "PBR",
        series: [
          { n: "中央値", v: dd.map((x) => (x >= R.pbr_from ? c.pbr_median : null)), c: "--muted", w: 1.25, dash: "3 4", noTip: true },
          { n: "PBR", v: pb, c: "--line", w: 1.75 },
        ],
        ymin: 0, yfmt: (x) => x.toFixed(1) + "倍", tfmt: (x) => x.toFixed(2) + "倍",
      });
    } else $("ch-pbr").innerHTML = '<p class="note">この期間は PBR のデータがありません(2000年から)</p>';
    $("chnote").textContent = `PER は${45}倍より上を上端に貼りつけて表示しています(2009年はリーマン・ショックで利益が大きく減り、PER が100倍を超えました)。PER は${fmtD(c.eps_q)}期までの1年間の利益(as reported)、PBR は${fmtD(c.bps_q)}末の1株純資産で計算しています。四半期の数字は、期末の3か月後(先に公表されたらその日)から使います。`;
  }

  // ---------- 答え合わせ ----------
  function renderResult() {
    const d = state.data, st = d.stats, R = d.rule;
    const yr = R.from.slice(0, 4);
    $("r-lead").textContent = `${yr}年以降の合図は${d.signals.length}回。合図の1年後は平均 ${pct(st.sig1.mean)}(上がったのは${st.sig1.n}回中${st.sig1.win}回)、3年後は平均 ${pct(st.sig3.mean)}(${st.sig3.n}回中${st.sig3.win}回)。同じ期間に毎日買った場合の平均は、1年後 ${pct(st.all1.mean)}・3年後 ${pct(st.all3.mean)} です。`;
    const rows = d.signals.map((s) => `<tr><td>${fmtD(s.date)}</td><td>${pt(s.close)}</td><td>${s.per.toFixed(1)}倍</td><td>${s.pbr == null ? "—" : s.pbr.toFixed(2) + "倍"}</td><td class="${s.r1 == null ? "" : s.r1 > 0 ? "zone-b" : "zone-s"}">${s.r1 == null ? "まだ" : pct(s.r1)}</td><td class="${s.r3 == null ? "" : s.r3 > 0 ? "zone-b" : "zone-s"}">${s.r3 == null ? "まだ" : pct(s.r3)}</td></tr>`).join("");
    $("r-tbl").innerHTML = `<thead><tr><th>合図の日</th><th>終値</th><th>PER</th><th>PBR</th><th>1年後</th><th>3年後</th></tr></thead><tbody>${rows}</tbody>
      <tfoot><tr><td>合図の平均</td><td></td><td></td><td></td><td>${pct(st.sig1.mean)}</td><td>${pct(st.sig3.mean)}</td></tr>
      <tr><td>毎日買った平均</td><td></td><td></td><td></td><td>${pct(st.all1.mean)}</td><td>${pct(st.all3.mean)}</td></tr></tfoot>`;
    $("r-note").textContent = `値動きは終値の変化だけで、配当(年1〜2%ほど)は含めていません。「毎日買った平均」は${yr}年以降のすべての日について、その日に買って1年後・3年後に見た変化率の平均です(毎日買って上がった割合は1年後 ${Math.round(st.all1.win * 100)}%、3年後 ${Math.round(st.all3.win * 100)}%)。合図の回数が少ないので、たまたまの部分もあります。`;
  }

  function renderWhy() {
    $("why").innerHTML = `
      <p>日経平均のルール(PER 14倍割れ・PBR 1.2倍上抜け)は、S&amp;P 500 にはそのまま使えません。S&amp;P 500 は PER も PBR もずっと高い水準にあるためです(2000年以降の PER の中央値は約23倍、PBR は約3倍で、日経平均の15.7倍・1.28倍とは別物)。そこで、2000年以降の S&amp;P 500 のデータで線を決め直しました。</p>
      <p><b>PER</b>: 買いの線を17〜24倍、準備の線を「買いの線+2〜4倍」で試しました。17〜21倍あたりなら、どれも合図のあとの1年・3年が「毎日買った平均」を上回り、結果が安定していました。その真ん中の<b>20倍(準備の線23倍)</b>にしています。20倍は2000年以降の PER の下から3割ほどの水準で、日経平均の14倍(下から2割強)と近い位置です。線を決めるのに使わなかった1990年代も、2回の合図はどちらも1年後・3年後に上がっていました。</p>
      <p><b>PBR</b>: 2.0〜4.5倍の固定の線と、過去3・5・10年の平均からの離れ方(−1.5σ〜−0.5σ)を試しましたが、線を少し動かすだけで成績が良くなったり悪くなったりして、安定しませんでした。S&amp;P 500 の PBR は、自社株買いやIT企業の比重が増えたことで2000年代の2倍前後から今は6倍前後まで上がり続けていて、「何倍なら割安」が時代とともに変わってしまうためです(たとえば4.5倍は2000年には天井でしたが、2025年には安いほうでした)。日経平均の PBR 1倍のような「解散価値」の目安も働きません。そのため PBR には買いの線を置かず、いまの位置を参考に表示しています。</p>
      <p class="note">EPS は S&amp;P が公表する as reported(一時的な損益を含む)の12か月合計で、不況で利益が落ちると PER が跳ね上がります(2009年など)。そのため不況のどん底では PER の合図が出ず、利益が戻る途中で出ることがあります。投資助言ではありません。売買の判断はご自身の責任で行ってください。</p>`;
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
