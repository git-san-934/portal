(() => {
  "use strict";

  const FLOW_URL = "data/flow.json";
  const WATCH_KEY = "foreign-flow-watch"; // このページで追加した銘柄コード(ブラウザに保存)
  const EDIT_WATCHLIST_URL = "https://github.com/git-san-934/portal/edit/main/foreign-flow/data/watchlist.json";
  const YAHOO_URL = (code) => `https://finance.yahoo.co.jp/quote/${encodeURIComponent(code)}.T`;

  // チャート座標(SVG viewBox)。preserveAspectRatio="none" で横幅いっぱいに伸ばす
  const W = 1000;
  const H = 100;
  const PAD_Y = 8;

  const $ = (id) => document.getElementById(id);
  const numFmt = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 });
  const intFmt = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });
  const signed = (v, digits = 1, unit = "") => {
    if (v == null) return "—";
    const s = Math.abs(v).toLocaleString("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return `${v > 0 ? "+" : v < 0 ? "−" : "±"}${s}${unit}`;
  };
  const pctClass = (v) => (v == null || v === 0 ? "pct" : v > 0 ? "pct up" : "pct down");
  const dateFmt = (iso) => (iso ? iso.replace(/-/g, "/") : "—");
  const shortDate = (iso) => {
    const [, m, d] = iso.split("-").map(Number);
    return `${m}/${d}`;
  };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---------- 追加した銘柄(localStorage) ----------

  function getAdded() {
    try {
      const v = JSON.parse(localStorage.getItem(WATCH_KEY) || "[]");
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return [];
    }
  }

  function setAdded(codes) {
    try {
      localStorage.setItem(WATCH_KEY, JSON.stringify([...new Set(codes)]));
    } catch {
      /* 保存できない環境(プライベートモードなど)では、この表示中だけ有効 */
    }
  }

  // ---------- 判定 ----------

  const TONE = { 買い優勢: "buy2", やや買い優勢: "buy", 中立: "", やや売り優勢: "sell", 売り優勢: "sell2" };
  const PART_LABEL = { short: "売りの圧力(空売り)", trend: "買いの圧力(株価・出来高)", holders: "買いの圧力(大量保有)", squeeze: "踏み上げ" };

  function badge(score) {
    if (!score) return el("span", "badge", "データ不足");
    return el("span", `badge ${TONE[score.label] || ""}`, score.label);
  }

  function reasonsList(score) {
    const ul = el("ul", "reasons");
    for (const r of (score && score.reasons) || []) ul.appendChild(el("li", r.tone, r.text));
    return ul;
  }

  // ---------- 市場全体(投資部門別) ----------

  function renderMarket(market) {
    const weeks = (market && market.weeks) || [];
    if (!weeks.length) return;
    const recent = weeks.slice(-26);
    const last4 = recent.slice(-4).reduce((a, w) => a + w.net, 0);
    const last13 = recent.slice(-13).reduce((a, w) => a + w.net, 0);
    const lastW = recent[recent.length - 1];
    const word = (v) => (v >= 0 ? "買い越し" : "売り越し");
    $("market-lead").textContent =
      `最新週(${lastW.label})は ${intFmt.format(Math.abs(lastW.net))}億円の${word(lastW.net)}。` +
      `直近4週の累計は ${intFmt.format(Math.abs(last4))}億円の${word(last4)}` +
      (recent.length >= 13 ? `、13週では ${intFmt.format(Math.abs(last13))}億円の${word(last13)}です。` : "です。");

    const wrap = $("market-chart");
    const legend = el("div", "legend");
    legend.append(el("span", "pos", "買い越し"), el("span", "neg", "売り越し"));
    const box = el("div", "bars-box");
    box.setAttribute("role", "img");
    box.setAttribute("aria-label", `海外投資家の週ごとの差引き(直近${recent.length}週)`);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "none");
    const labels = el("div");
    const tooltip = el("div", "tooltip");
    tooltip.hidden = true;
    box.append(svg, labels, tooltip);

    const maxAbs = Math.max(...recent.map((w) => Math.abs(w.net)), 1);
    const zero = H / 2;
    const n = recent.length;
    const slot = W / n;
    const bw = Math.max(2, slot - 6);
    let body = `<line class="zero-line" x1="0" x2="${W}" y1="${zero}" y2="${zero}" />`;
    recent.forEach((w, i) => {
      const h = (Math.abs(w.net) / maxAbs) * (H / 2 - 2);
      const x = i * slot + (slot - bw) / 2;
      const y = w.net >= 0 ? zero - h : zero;
      body += `<rect class="bar-hit" data-i="${i}" x="${i * slot}" y="0" width="${slot}" height="${H}" />`;
      body += `<rect class="${w.net >= 0 ? "bar-pos" : "bar-neg"}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, h).toFixed(1)}" rx="1.5" />`;
    });
    svg.innerHTML = body;
    const step = Math.ceil(n / 6);
    recent.forEach((w, i) => {
      if (i % step !== 0 && i !== n - 1) return;
      if (i !== n - 1 && n - 1 - i < step / 2) return;
      const lab = el("span", `x-label${i === 0 ? " first" : i === n - 1 ? " last" : ""}`, shortDate(w.end));
      lab.style.left = `${((i + 0.5) / n) * 100}%`;
      labels.appendChild(lab);
    });
    const top = el("span", "tick-label", `+${intFmt.format(maxAbs)}億円`);
    top.style.top = "12%";
    labels.appendChild(top);

    const show = (i) => {
      const w = recent[i];
      tooltip.textContent = `${w.label}\n${word(w.net)} ${intFmt.format(Math.abs(w.net))}億円\n買い ${intFmt.format(w.buy)} / 売り ${intFmt.format(w.sell)}億円`;
      const x = ((i + 0.5) / n) * 100;
      tooltip.style.left = `${x}%`;
      tooltip.classList.toggle("edge-left", x < 20);
      tooltip.classList.toggle("edge-right", x > 80);
      tooltip.hidden = false;
    };
    box.addEventListener("pointermove", (ev) => {
      const rect = box.getBoundingClientRect();
      const i = Math.min(n - 1, Math.max(0, Math.floor(((ev.clientX - rect.left) / rect.width) * n)));
      show(i);
    });
    box.addEventListener("pointerleave", () => (tooltip.hidden = true));
    wrap.append(legend, box);

    const months = (market.months || []).slice(-6);
    $("market-note").textContent =
      (months.length ? `月次: ${months.map((m) => `${Number(m.month.slice(5))}月 ${signed(m.net, 0)}億円`).join(" / ")}。` : "") +
      "海外投資家は東証の売買代金の約7割を占めます。市場全体の流れなので、銘柄ごとの判定には直接は使っていません。";
    $("market-panel").hidden = false;
  }

  // ---------- 折れ線チャート(週次) ----------

  function niceTicks(min, max, count) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [];
    const rough = (max - min) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const r = rough / mag;
    const step = (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * mag;
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) ticks.push(Math.round(v * 1000) / 1000);
    return ticks;
  }

  function lineChart(title, dates, values, fmt, { floorZero = false, ariaName = "" } = {}) {
    const wrap = el("div", "chart");
    wrap.appendChild(el("p", "chart-title", title));
    const box = el("div", "chart-box");
    box.setAttribute("role", "img");
    box.setAttribute("aria-label", ariaName || title);
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
    wrap.appendChild(box);

    const vals = values.map((v) => (v == null ? null : Number(v)));
    const present = vals.filter((v) => v != null);
    if (present.length < 2) {
      wrap.appendChild(el("p", "caveat", "データ不足"));
      return wrap;
    }
    let min = Math.min(...present);
    let max = Math.max(...present);
    if (floorZero) min = 0;
    if (max === min) max = min + (Math.abs(min) * 0.1 || 1);
    const range = max - min;
    const n = vals.length;
    const xPct = (i) => (n <= 1 ? 50 : (i / (n - 1)) * 100);
    const yOf = (v) => PAD_Y + (1 - (v - min) / range) * (H - PAD_Y * 2);
    let d = "";
    let first = -1;
    let lastI = -1;
    vals.forEach((v, i) => {
      if (v == null) return;
      if (first < 0) first = i;
      lastI = i;
      d += `${d ? "L" : "M"}${((xPct(i) / 100) * W).toFixed(1)},${yOf(v).toFixed(1)}`;
    });
    const area = floorZero ? `<path class="chart-area" d="${d}L${((xPct(lastI) / 100) * W).toFixed(1)},${yOf(min)}L${((xPct(first) / 100) * W).toFixed(1)},${yOf(min)}Z" />` : "";
    const ticks = niceTicks(min, max, 3);
    const grid = ticks.map((t) => `<line class="grid-line" x1="0" x2="${W}" y1="${yOf(t).toFixed(1)}" y2="${yOf(t).toFixed(1)}" />`).join("");
    svg.innerHTML = `${grid}${area}<path class="chart-line" d="${d}" />`;
    for (const t of ticks) {
      const lab = el("span", "tick-label", fmt(t, true));
      lab.style.top = `${(yOf(t) / H) * 100}%`;
      labels.appendChild(lab);
    }
    [0, Math.floor((n - 1) / 2), n - 1].forEach((i, k) => {
      if (!dates[i]) return;
      const lab = el("span", `x-label${k === 0 ? " first" : k === 2 ? " last" : ""}`, shortDate(dates[i]));
      lab.style.left = `${xPct(i)}%`;
      labels.appendChild(lab);
    });

    const nearest = (idx) => {
      for (let off = 0; off < n; off++) {
        if (idx - off >= 0 && vals[idx - off] != null) return idx - off;
        if (idx + off < n && vals[idx + off] != null) return idx + off;
      }
      return -1;
    };
    const onMove = (ev) => {
      const rect = box.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
      const i = nearest(Math.round(frac * (n - 1)));
      if (i < 0) return;
      crosshair.style.left = dot.style.left = tooltip.style.left = `${xPct(i)}%`;
      dot.style.top = `${(yOf(vals[i]) / H) * 100}%`;
      tooltip.textContent = `${dates[i] ? dateFmt(dates[i]) + "の週" : ""}\n${fmt(vals[i])}`;
      tooltip.classList.toggle("edge-left", xPct(i) < 20);
      tooltip.classList.toggle("edge-right", xPct(i) > 80);
      crosshair.hidden = dot.hidden = tooltip.hidden = false;
    };
    const onLeave = () => (crosshair.hidden = dot.hidden = tooltip.hidden = true);
    box.addEventListener("pointermove", onMove);
    box.addEventListener("pointerdown", onMove);
    box.addEventListener("pointerleave", onLeave);
    box.addEventListener("pointercancel", onLeave);
    return wrap;
  }

  // ---------- ベスト5 ----------

  function renderTop5(flow, onAdd) {
    const ol = $("top5");
    ol.textContent = "";
    for (const code of flow.top5 || []) {
      const s = flow.stocks[code];
      if (!s) continue;
      const li = el("li");
      const head = el("div", "top5-head");
      const name = el("p", "top5-name", s.name);
      const c = el("span", "code");
      const a = el("a", null, code);
      a.href = YAHOO_URL(code);
      a.target = "_blank";
      a.rel = "noopener";
      c.appendChild(a);
      name.appendChild(c);
      const right = el("div", "verdict");
      right.append(el("span", "total", `スコア ${signed(s.score.total, 2)}`), badge(s.score));
      head.append(name, right);
      const p = s.price || {};
      const sh = s.short || {};
      const meta = el(
        "p",
        "top5-meta",
        `${s.sector || ""}${s.cls ? `・${s.cls}` : ""} / 13週 ${signed(p.r13)}%(TOPIX比 ${signed(p.rel13)}) / 空売り残高 ${(sh.now || 0).toFixed(1)}%(13週 ${signed(sh.d13, 2)})`,
      );
      li.append(head, meta, reasonsList(s.score));
      const actions = el("div", "top5-actions");
      const btn = el("button", "link-btn", "詳しく見る(一覧に追加)");
      btn.type = "button";
      const tracked = () => [...flow.holdings, ...flow.watch, ...getAdded()].includes(code);
      if (tracked()) {
        btn.textContent = "一覧に表示中";
        btn.disabled = true;
      }
      btn.addEventListener("click", () => {
        onAdd(code);
        btn.textContent = "一覧に表示中";
        btn.disabled = true;
      });
      actions.appendChild(btn);
      li.appendChild(actions);
      ol.appendChild(li);
    }
    if (!ol.children.length) {
      ol.appendChild(el("li", null, "今日は条件に合う銘柄がありませんでした。"));
    }
    $("top5-panel").hidden = false;
  }

  // ---------- 銘柄一覧とカード ----------

  function trackedCodes(flow) {
    return [...new Set([...flow.holdings, ...flow.watch, ...getAdded()])];
  }

  function originTag(flow, code) {
    if (flow.holdings.includes(code)) return "持ち株";
    if (flow.watch.includes(code)) return "ウォッチ";
    return "追加";
  }

  function buildRow(flow, code) {
    const s = flow.stocks[code] || { name: "" };
    const tr = el("tr");
    const td0 = el("td");
    const a = el("a", null, s.name || code);
    a.href = `#s-${code}`;
    td0.appendChild(a);
    td0.appendChild(el("span", "code", code));
    td0.appendChild(el("span", "tag", originTag(flow, code)));
    const sh = s.short;
    const td1 = el("td");
    if (sh) {
      td1.append(document.createTextNode(`${numFmt.format(sh.now)}%`));
      td1.appendChild(el("span", `sub ${pctClass(sh.d13 == null ? null : -sh.d13)}`, signed(sh.d13, 2)));
    } else td1.textContent = "—";
    const rel = s.price && s.price.rel13;
    const td2 = el("td", pctClass(rel), rel == null ? "—" : `${signed(rel)}`);
    const td3 = el("td", null, s.score ? signed(s.score.total, 2) : "—");
    const td4 = el("td");
    td4.appendChild(badge(s.score));
    tr.append(td0, td1, td2, td3, td4);
    return tr;
  }

  function partsBlock(score) {
    const box = el("div", "parts");
    for (const [key, v] of Object.entries(score.parts)) {
      const p = el("div", "part");
      p.appendChild(el("span", "part-label", PART_LABEL[key] || key));
      const bar = el("div", "part-bar");
      const fill = el("span", `part-fill ${v >= 0 ? "pos" : "neg"}`);
      const w = (Math.min(2, Math.abs(v)) / 2) * 50;
      fill.style.left = v >= 0 ? "50%" : `${50 - w}%`;
      fill.style.width = `${w}%`;
      bar.appendChild(fill);
      p.append(bar, el("span", "part-value", signed(v, 2)));
      box.appendChild(p);
    }
    return box;
  }

  function stat(label, value, cls, small) {
    const d = el("div");
    d.appendChild(el("dt", null, label));
    const dd = el("dd", cls, value);
    if (small) dd.appendChild(el("small", null, small));
    d.appendChild(dd);
    return d;
  }

  function buildCard(flow, code, onRemove) {
    const s = flow.stocks[code];
    const card = el("article", "card");
    card.id = `s-${code}`;
    const head = el("div", "card-head");
    const name = el("h2", "card-name", s ? s.name : code);
    const c = el("span", "code");
    const a = el("a", null, code);
    a.href = YAHOO_URL(code);
    a.target = "_blank";
    a.rel = "noopener";
    c.appendChild(a);
    name.appendChild(c);
    name.appendChild(el("span", "tag", originTag(flow, code)));
    const right = el("div", "verdict");
    if (s && s.score) right.appendChild(el("span", "total", `スコア ${signed(s.score.total, 2)}`));
    right.appendChild(badge(s && s.score));
    head.append(name, right);
    card.appendChild(head);

    if (!s) {
      card.appendChild(el("p", "caveat", "この銘柄のデータがまだありません。"));
    } else {
      const p = s.price || {};
      const sh = s.short;
      const stats = el("dl", "stats");
      stats.append(
        stat("空売り残高(0.5%以上の合計)", sh ? `${numFmt.format(sh.now)}%` : "—", null, sh && sh.n ? `${sh.n}社` : ""),
        stat("空売り 4週 / 13週の増減", sh ? `${signed(sh.d4, 2)} / ${signed(sh.d13, 2)}` : "—", sh ? pctClass(-(sh.d13 || 0)) : ""),
        stat("13週 騰落率(TOPIX比)", p.r13 == null ? "—" : `${signed(p.r13)}%`, pctClass(p.r13), p.rel13 == null ? "" : `${signed(p.rel13)}`),
        stat("出来高(普段比)", p.vol_ratio == null ? "—" : `${numFmt.format(p.vol_ratio)}倍`, null, "20日÷120日"),
      );
      card.appendChild(stats);
      if (s.score) {
        card.appendChild(partsBlock(s.score));
        if (s.score.reasons.length) card.appendChild(reasonsList(s.score));
      }
      if (s.weeks && flow.week_dates.length) {
        const dates = flow.week_dates.slice(-s.weeks.close.length);
        const charts = el("div", "charts");
        charts.append(
          lineChart("株価(週足・26週)", dates, s.weeks.close, (v) => `${numFmt.format(v)}円`, { ariaName: `${s.name}の株価` }),
          lineChart("空売り残高の合計(%)", dates, s.weeks.short, (v, tick) => (tick ? `${numFmt.format(v)}%` : `空売り残高 ${v.toFixed(2)}%`), {
            floorZero: true,
            ariaName: `${s.name}の空売り残高`,
          }),
        );
        card.appendChild(charts);
      }
      if (s.positions && s.positions.length) {
        const det = el("details", "memo");
        det.appendChild(el("summary", null, `空売りしている機関(${s.positions.length}社)`));
        const t = el("table", "mini-table");
        t.innerHTML = "<thead><tr><th>機関</th><th>割合</th><th>報告日</th></tr></thead>";
        const tb = el("tbody");
        for (const x of s.positions) {
          const tr = el("tr");
          const who = el("td", null, x.who);
          if (x.via) who.appendChild(el("span", "via", `${x.via} 経由`));
          if (x.foreign) who.appendChild(el("span", "tag", "海外"));
          tr.append(who, el("td", "num", `${x.pct.toFixed(2)}%`), el("td", "num", dateFmt(x.date)));
          tb.appendChild(tr);
        }
        t.appendChild(tb);
        det.appendChild(t);
        card.appendChild(det);
      }
      if (flow.edinet && s.holders && s.holders.length) {
        const det = el("details", "memo");
        det.appendChild(el("summary", null, `大量保有報告書(直近${s.holders.length}件)`));
        const t = el("table", "mini-table");
        t.innerHTML = "<thead><tr><th>提出者</th><th>保有割合</th><th>提出日</th></tr></thead>";
        const tb = el("tbody");
        for (const x of s.holders) {
          const tr = el("tr");
          const who = el("td", null, x.filer);
          who.appendChild(el("span", "tag", x.type));
          if (x.foreign) who.appendChild(el("span", "tag", "海外"));
          const pct = x.pct == null ? "—" : x.prev == null ? `${x.pct.toFixed(2)}%` : `${x.prev.toFixed(2)}→${x.pct.toFixed(2)}%`;
          tr.append(who, el("td", "num", pct), el("td", "num", dateFmt(x.date)));
          tb.appendChild(tr);
        }
        t.appendChild(tb);
        det.appendChild(t);
        card.appendChild(det);
      }
    }
    if (getAdded().includes(code) && !flow.holdings.includes(code) && !flow.watch.includes(code)) {
      const foot = el("div", "card-foot");
      const btn = el("button", "link-btn", "一覧から外す");
      btn.type = "button";
      btn.addEventListener("click", () => onRemove(code));
      foot.appendChild(btn);
      card.appendChild(foot);
    }
    return card;
  }

  function renderTracked(flow, onRemove) {
    const codes = trackedCodes(flow);
    const score = (c) => (flow.stocks[c] && flow.stocks[c].score ? flow.stocks[c].score.total : -99);
    codes.sort((a, b) => score(b) - score(a));
    const tbody = $("overview");
    tbody.textContent = "";
    for (const c of codes) tbody.appendChild(buildRow(flow, c));
    const cards = $("cards");
    cards.textContent = "";
    for (const c of codes) cards.appendChild(buildCard(flow, c, onRemove));
    $("list-panel").hidden = false;
    cards.hidden = !codes.length;
  }

  // ---------- 読み込み ----------

  async function load() {
    const status = $("status");
    let flow;
    try {
      const res = await fetch(`${FLOW_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      flow = await res.json();
    } catch (e) {
      status.textContent = "データはまだ準備中です(平日の夜に自動で更新されます)。";
      status.classList.add("error");
      return;
    }
    flow.holdings = flow.holdings || [];
    flow.watch = flow.watch || [];
    flow.week_dates = flow.week_dates || [];
    status.textContent = `空売り残高 ${dateFmt(flow.asof)}時点 / 株価 ${dateFmt(flow.price_date)}終値 / 更新 ${dateFmt((flow.generated_at || "").slice(0, 10))}` + (flow.edinet ? "" : "(大量保有報告書は未使用)");

    const rerender = () => {
      renderTracked(flow, onRemove);
      renderTop5(flow, onAdd);
    };
    function onAdd(code) {
      setAdded([...getAdded(), code]);
      rerender();
      const card = $(`s-${code}`);
      if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    function onRemove(code) {
      setAdded(getAdded().filter((c) => c !== code));
      rerender();
    }

    $("add-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const input = $("add-code");
      const msg = $("add-status");
      const code = input.value.normalize("NFKC").trim().toUpperCase();
      msg.className = "add-status";
      msg.textContent = "";
      if (!/^[0-9][0-9A-Z]{3}$/.test(code)) {
        msg.classList.add("error");
        msg.textContent = "4けたの銘柄コードを入れてください(例: 2201、285A)。";
        return;
      }
      if (trackedCodes(flow).includes(code)) {
        msg.textContent = "すでに一覧にあります。";
        $(`s-${code}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      const s = flow.stocks[code];
      if (!s) {
        msg.classList.add("error");
        msg.innerHTML = "";
        msg.append(
          "この銘柄のデータがありません(TOPIX 500 以外で、0.5%以上の空売りの報告もない銘柄)。毎日追跡するには ",
          Object.assign(el("a", null, "watchlist.json"), { href: EDIT_WATCHLIST_URL, target: "_blank", rel: "noopener" }),
          " に追加してください。翌日の更新から表示されます。",
        );
        return;
      }
      input.value = "";
      msg.classList.add("ok");
      msg.textContent = `${s.name}(${code})を追加しました。${s.price ? "" : "株価データはないため、空売り残高だけで判定します。"}このブラウザにだけ保存されます。`;
      onAdd(code);
    });

    renderMarket(flow.market);
    rerender();
    if (location.hash) $(location.hash.slice(1))?.scrollIntoView();
  }

  load();
})();
