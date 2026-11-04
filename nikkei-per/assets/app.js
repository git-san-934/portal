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

  // ---------- 売買ルール(PER・PBR) ----------
  const toT = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const mult = (v) => "×" + v.toFixed(2);
  function renderTrade() {
    const T = state.data.trade;
    if (!T) return;
    const R = T.rule, now = T.now, S = state.data.series, st = T.stats;
    $("t-lead").textContent = `現金のときは PBR が${R.buy_pbr.toFixed(1)}倍を下回ったあと、下から上に${R.buy_pbr.toFixed(1)}倍を抜けたら買い、持っているときは PBR が${R.sell_pbr.toFixed(1)}倍を上回ったあと、上から下に${R.sell_pbr.toFixed(1)}倍を抜けたら売り。合図は終値で判定し、次の営業日に売買します。持っている間は売りの合図だけ、現金の間は買いの合図だけが出るので、買いと売りは必ず交互になります。`;
    const pill = $("t-pill");
    pill.classList.toggle("out", !now.holding);
    pill.classList.remove("mid");
    const pend = now.pending === "sell" ? "(売りの合図:次の営業日に売る)" : now.pending === "buy" ? "(買いの合図:次の営業日に買う)" : "";
    $("t-pillv").textContent = (now.holding ? "持つ" : "現金で待つ") + pend;
    $("t-pills").textContent = `${fmtD(now.since)} から`;
    const next = now.holding
      ? `<div class="stat"><div class="k">売りの線の株価(PBR ${R.sell_pbr}倍)</div><div class="v zone-s">${yen(now.sell_price)}</div><div class="s">${now.top ? `線を上回っています。${yen(now.sell_price)}を下に抜けたら売り` : `あと ${pct(now.sell_price / now.close - 1)} 上がって線を超え、そのあと下に抜けたら売り`}</div></div>`
      : `<div class="stat"><div class="k">買いの線の株価(PBR ${R.buy_pbr}倍)</div><div class="v zone-b">${yen(now.buy_price)}</div><div class="s">${now.armed ? `線を割っています。${yen(now.buy_price)}を上に抜けたら買い` : `あと ${pct(now.buy_price / now.close - 1)} 下がって線を割り、そのあと上に抜けたら買い`}</div></div>`;
    $("t-stats").innerHTML = `
      <div class="stat"><div class="k">PBR / PER</div><div class="v">${now.pbr.toFixed(2)}倍 / ${now.per.toFixed(1)}倍</div><div class="s">日経平均 ${yen(now.close)}(${fmtD(T.to)})</div></div>
      ${next}
      ${(() => { const q = perTrades(S, T.from), lt = q.trades[q.trades.length - 1];
        return `<div class="stat"><div class="k">参考: PER のルール(14倍割れで買い・16倍超で売り)</div><div class="v">${q.holding ? "持つ" : "現金で待つ"}</div><div class="s">${lt ? fmtD(lt.date) + " から" : ""}</div></div>`; })()}`;
    const tr = T.trades;
    $("t-trades").innerHTML = tr.map((t) => `<li><span class="mk sq ${t.side === "buy" ? "b" : "s"}">${t.side === "buy" ? "買" : "売"}</span>${fmtD(t.date)}　${yen(t.close)}(売買した日の PBR ${t.pbr}倍・PER ${t.per}倍)${t.ret != null ? `(${fmtD(t.from)}から ${pct(t.ret)})` : ""}</li>`).join("") || "<li>売買なし</li>";
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
      "なぜこの線か: PBR 1倍は、株価が1株あたりの純資産(会社を解散したときの価値)と同じ水準です。2008年10月・2012年・2016年・2020年3月の底はどれも PBR 1倍前後でした。ただ1倍割れは2004年以降22年のうち5つの年にしかなく、売ったあと何年も買えなくなるので、少し上の1.1倍(10の年で起きた)を買いの線にしています。線を割った日ではなく、割ったあと下から上に抜けた日に買うので、下げの途中で買うのを避けられます(そのぶん買値は少し高くなります)。PBR 2倍超は2005〜2007年の上げ相場の天井付近だけで、2013〜2024年の高値は1.4〜1.6倍でした。",
      "PER について: PER が高いだけ・PER が低いだけの線(例: PER 14倍で買い・16倍で売り)では、上がり続ける相場で早く売りすぎて、持ち続けた場合の×5.83に対して×1.81と大きく負けました(売買23回)。",
      "売りの線を変えた場合(1.1倍を割ったあと上に抜けたら買い、の場合): 1.5倍を上から下に抜けたら売り ×5.44、1.8倍 ×5.94、1.9倍 ×9.24、2.0倍 ×8.19、2.2倍 ×9.84。持ち続けは ×5.83 です。1.5倍の売りは2024年3月(38,798円)に売ったあと買い直せず、そのあとの上昇を取り逃しています。",
      "限界: 売買の回数が少なく(2004年9月から5回)、成績は数回の山と谷で決まっています。データは2004年9月からしかなく、それより前(バブル期など)では確かめられていません。",
      "計算の前提: 売買のたびに0.1%のコスト、現金の利息は0、税金は考えていません。配当も入れていない(日経平均の値だけ)ので、持ち続けた場合の実際の成績はもう少し良くなります。",
    ];
    $("t-notes").innerHTML = notes.map((t) => `<li>${esc(t)}</li>`).join("");
  }

  // ---------- 持ち方のくらべ(表だけ) ----------
  function renderPatterns() {
    const P = state.data.patterns;
    if (!P) return;
    const items = P.items.slice().sort((a, b) => b.eq - a.eq), H = P.hold_stats;
    const held = (w) => (w >= 0.999 ? "全部持つ" : w <= 0.001 ? "全部現金" : `${Math.round(w * 100)}%持つ`);
    $("c-table").innerHTML = `<tr><th>持ち方</th><th>資産</th><th>いちばん大きな下げ</th><th>売買</th><th>いま</th></tr>
      <tr><td>持ち続け</td><td>${mult(H.eq)}</td><td>${pct(H.mdd, 0)}</td><td>—</td><td>全部持つ</td></tr>` +
      items.map((x) => `<tr><td title="${esc(x.desc)}">${esc(x.name)}<br><span class="muted">${esc(x.desc)}</span></td><td>${mult(x.eq)}</td><td>${pct(x.mdd, 0)}</td><td>${x.n}回</td><td>${held(x.w)}</td></tr>`).join("");
  }

  // ---------- 3つのチャート ----------
  const PER_LO = 14, PER_HI = 16;
  // PER のルール: 持っているときは PER 16倍超で売り、現金のときは PER 14倍割れで買い(合図の次の営業日の終値)。PBR のルールと同じく2004年9月に持っている状態から始める
  function perTrades(S, from) {
    let holding = true, pend = null;
    const out = [];
    for (let i = 0; i < S.date.length; i++) {
      if (S.date[i] < from || S.pbr[i] == null) continue;
      if (pend) { holding = pend === "buy"; out.push({ i, date: S.date[i], side: pend, close: S.close[i], per: S.per[i] }); pend = null; }
      const p = S.per[i];
      if (!holding && p < PER_LO) pend = "buy";
      else if (holding && p > PER_HI && p <= 50) pend = "sell";
    }
    return { trades: out, holding, pending: pend };
  }

  function renderCharts() {
    const d = state.data, S = d.series, T = d.trade;
    if (!T) return;
    const R = T.rule;
    const all = S.date.map((x, i) => i).filter((i) => S.pbr[i] != null && S.date[i] >= T.from);
    const r = RANGES.find((x) => x.key === state.settings.range2) || RANGES[RANGES.length - 1];
    const tEnd = state.t[all[all.length - 1]];
    const idx = r.years ? all.filter((i) => state.t[i] >= tEnd - r.years * 365.25 * DAY) : all;
    const dd = idx.map((i) => S.date[i]), tt = idx.map((i) => state.t[i]);
    const pos = {}; dd.forEach((x, k) => (pos[x] = k));
    const v = (key, f = (x) => x) => idx.map((i) => (S[key][i] == null ? null : f(S[key][i])));
    const pbrT = T.trades.filter((t) => pos[t.date] != null);
    const perT = perTrades(S, T.from).trades.filter((t) => pos[t.date] != null);
    const pbrMark = (y) => (t) => ({ i: pos[t.date], y: y(t), k: t.side === "buy" ? "b" : "s", c: t.side === "buy" ? "--pbr-b" : "--pbr-s", tc: "#1a1a1a", sq: true, big: true, t: `PBR のルールで${t.side === "buy" ? "買い" : "売り"}(PBR ${t.pbr}倍)` });
    const perMark = (y) => (t) => ({ i: pos[t.date], y: y(t), k: t.side === "buy" ? "b" : "s", big: true, t: `PER のルールで${t.side === "buy" ? "買い" : "売り"}(PER ${t.per.toFixed(1)}倍)` });
    const tip = (k) => `PER ${S.per[idx[k]].toFixed(1)}倍 · PBR ${S.pbr[idx[k]].toFixed(2)}倍`;
    const yenAx = (x) => (x >= 10000 ? (x / 10000).toLocaleString("ja-JP") + "万" : x.toLocaleString("ja-JP"));
    // ① 日経平均
    lineChart($("ch-n"), {
      d: dd, t: tt, h: 300, label: "日経平均と売買のポイント",
      series: [{ n: "日経平均", v: v("close"), c: "--line", w: 1.75 }],
      marks: [...perT.map(perMark((t) => t.close)), ...pbrT.map(pbrMark((t) => t.close))],
      ymin: 0, yfmt: yenAx, tfmt: (x) => yen(x), tipExtra: tip,
    });
    // ② PER
    $("per-lo").textContent = `${PER_LO}倍`; $("per-hi").textContent = `${PER_HI}倍`;
    lineChart($("ch-per"), {
      d: dd, t: tt, h: 220, label: "PER",
      series: [
        { n: "売りの線", v: dd.map(() => PER_HI), c: "--out", w: 1.5, dash: "5 4", noTip: true },
        { n: "買いの線", v: dd.map(() => PER_LO), c: "--in", w: 1.5, dash: "5 4", noTip: true },
        { n: "PER", v: v("per"), c: "--line", w: 1.75 },
      ],
      marks: perT.map(perMark((t) => Math.min(t.per, 30))), ymin: 0, ymax: 30,
      yfmt: (x) => x + "倍", tfmt: (x) => x.toFixed(2) + "倍",
    });
    // ③ PBR
    $("pbr-lo").textContent = `${R.buy_pbr}倍`; $("pbr-hi").textContent = `${R.sell_pbr}倍`;
    lineChart($("ch-pbr"), {
      d: dd, t: tt, h: 220, label: "PBR",
      series: [
        { n: "売りの線", v: dd.map(() => R.sell_pbr), c: "--out", w: 1.5, dash: "5 4", noTip: true },
        { n: "買いの線", v: dd.map(() => R.buy_pbr), c: "--in", w: 1.5, dash: "5 4", noTip: true },
        { n: "PBR", v: v("pbr"), c: "--line", w: 1.75 },
      ],
      marks: pbrT.map(pbrMark((t) => t.pbr)), ymin: 0,
      yfmt: (x) => x.toFixed(1) + "倍", tfmt: (x) => x.toFixed(2) + "倍",
    });
    $("chnote").textContent = "PER は30倍より上を上端に貼りつけて表示しています(2009年春はリーマン・ショック後に利益が大きく減り、PER が100倍を超えました)。PER のルールは PER 14倍割れで買い・16倍超で売りを、PBR のルールと同じく持つ/現金を交互にして当てはめたものです。";
    const pt = perTrades(S, T.from).trades.slice().reverse();
    $("per-trades").innerHTML = pt.slice(0, 12).map((t) => `<li><span class="mk ${t.side === "buy" ? "b" : "s"}">${t.side === "buy" ? "買" : "売"}</span>${fmtD(t.date)}　${yen(t.close)}(PER ${t.per.toFixed(1)}倍)</li>`).join("") +
      (pt.length > 12 ? `<li class="muted">ほか ${pt.length - 12} 回</li>` : "") || "<li>売買なし</li>";
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
      "PBR も日経平均プロフィルの「加重平均」の値です。PBR の日次データは2004年9月からなので、チャートと成績はそこから始めています。",
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
    state.t = d.series.date.map((x) => Date.UTC(+x.slice(0, 4), +x.slice(5, 7) - 1, +x.slice(8, 10)));
    if (!state.settings.range2) state.settings.range2 = "all";
    seg($("rng"), RANGES, "range2", renderCharts);
    renderTrade();
    renderCharts();
    renderPatterns();
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
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => state.data && state.data.ready && renderCharts(), 150); });
  load(false);
})();
