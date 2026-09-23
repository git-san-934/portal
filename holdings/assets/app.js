(() => {
  "use strict";

  const CHECK_URL = "data/check.json";
  const PRICES_URL = "data/prices.json";
  // 日本株は "<code>.T"、米国株などは check.json の ticker(例: ORCL)
  const YAHOO_URL = (stock) =>
    `https://finance.yahoo.co.jp/quote/${encodeURIComponent(stock.currency && stock.currency !== "JPY" ? stock.ticker || stock.code : `${stock.code}.T`)}`;

  // チャート座標(SVG viewBox)。preserveAspectRatio="none" で横幅いっぱいに伸ばす
  const W = 1000;
  const H = 100;
  const PAD_Y = 8;

  const $ = (id) => document.getElementById(id);

  const numFmt = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 });
  const usdFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const curOf = (stock) => (stock && stock.currency) || "JPY";
  const priceFmt = (v, cur = "JPY") =>
    v == null ? "—" : cur === "USD" ? `$${usdFmt.format(v)}` : cur === "JPY" ? `${numFmt.format(v)}円` : `${numFmt.format(v)} ${cur}`;
  const signedPrice = (v, cur = "JPY") => `${v > 0 ? "+" : v < 0 ? "−" : ""}${priceFmt(Math.abs(v), cur)}`;
  const pctText = (v, digits = 1) => {
    if (v == null) return "—";
    const s = Math.abs(v).toLocaleString("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return v > 0 ? `+${s}%` : v < 0 ? `−${s}%` : `${s}%`;
  };
  const pctClass = (v) => (v == null || v === 0 ? "pct" : v > 0 ? "pct up" : "pct down");
  const scoreText = (v) => (v == null ? "—" : v < 0 ? `−${Math.abs(v).toFixed(2)}` : v.toFixed(2));
  const dateFmt = (iso) => iso.replace(/-/g, "/");
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

  // ---------- LocalStorage 保有データ管理 ----------

  const POSITIONS_KEY = "holdings-positions";

  function getPositions() {
    try {
      const data = localStorage.getItem(POSITIONS_KEY);
      return data ? JSON.parse(data) : {};
    } catch (e) {
      console.error("Failed to parse positions from localStorage", e);
      return {};
    }
  }

  function setPosition(code, price, quantity) {
    const positions = getPositions();
    if (price > 0 && quantity > 0) {
      positions[code] = { price: parseFloat(price), quantity: parseFloat(quantity) };
    } else {
      delete positions[code];
    }
    try {
      localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
    } catch (e) {
      console.error("Failed to save positions to localStorage", e);
    }
  }

  function calcPnl(currentPrice, acquiredPrice, quantity) {
    if (!acquiredPrice || !quantity || acquiredPrice <= 0) return null;
    const totalCost = acquiredPrice * quantity;
    const currentValue = currentPrice * quantity;
    const gain = currentValue - totalCost;
    const gainPct = (gain / totalCost) * 100;
    return { totalCost, currentValue, gain, gainPct };
  }

  // 円以外の銘柄の円換算レート(prices.json の fx)。なければ null
  function fxRate(cur) {
    if (cur === "JPY") return 1;
    const fx = book.fx[`${cur}JPY`];
    return fx && fx.rate ? fx.rate : null;
  }

  function renderPnl(code, slot = $(`pnl-${code}`)) {
    if (!slot) return;
    slot.replaceChildren();
    const position = getPositions()[code];
    const currentPrice = Number(slot.dataset.price);
    if (!position || !currentPrice) return;
    const pnl = calcPnl(currentPrice, position.price, position.quantity);
    if (!pnl) return;
    const cur = slot.dataset.currency || "JPY";
    const rate = fxRate(cur);
    const pnlStats = el("dl", "stats pnl");
    for (const [dt, dd, cls] of [
      ["取得単価", priceFmt(position.price, cur), "pct"],
      ["保有株数", `${numFmt.format(position.quantity)}株`, "pct"],
      ["評価額", priceFmt(pnl.currentValue, cur), "pct"],
      ["損益", signedPrice(pnl.gain, cur), pctClass(pnl.gain)],
      ...(cur !== "JPY" && rate
        ? [
            ["評価額(円換算)", priceFmt(Math.round(pnl.currentValue * rate)), "pct"],
            ["損益(円換算)", signedPrice(Math.round(pnl.gain * rate)), pctClass(pnl.gain)],
          ]
        : []),
      ["損益率", pctText(pnl.gainPct), pctClass(pnl.gainPct)],
      ...(book.weights.has(code) ? [["保有比率", `${(book.weights.get(code) * 100).toFixed(1)}%`, "pct"]] : []),
    ]) {
      const item = el("div");
      item.append(el("dt", null, dt), el("dd", cls, dd));
      pnlStats.appendChild(item);
    }
    slot.appendChild(pnlStats);
    if (cur !== "JPY") {
      const fx = book.fx[`${cur}JPY`];
      slot.appendChild(
        el(
          "p",
          "risk-note",
          fx
            ? `損益はドル建て。円換算は1ドル=${fx.rate.toFixed(2)}円(${dateFmt(fx.date)})で、買ったときからの為替の損益は含みません。`
            : "損益はドル建て。為替レートがまだ取れていないため円換算は出していません。"
        )
      );
    }
  }

  // ---------- 保有状況を基準にしたリスク・リターン ----------

  // 1銘柄の比率の目安(既定値)。超えたら買い増しは見送り、さらに超えたら一部売却を検討
  const WEIGHT_CAP = 25;
  const WEIGHT_TRIM = 35;

  const book = { stocks: [], series: new Map(), fx: {}, weights: new Map() };

  // 2銘柄がどちらも取引した日だけで、直近20日分の日次対数リターンの組を作る
  // (東証と米国市場は休場日が違うため。米国の終値は日本時間では翌朝に付く点は近似)
  function pairReturns(ca, cb, days = 20) {
    const idx = [];
    for (let i = 0; i < Math.min(ca.length, cb.length); i++) if (ca[i] != null && cb[i] != null) idx.push(i);
    const use = idx.slice(-(days + 1));
    const ra = [];
    const rb = [];
    for (let k = 1; k < use.length; k++) {
      ra.push(Math.log(ca[use[k]] / ca[use[k - 1]]));
      rb.push(Math.log(cb[use[k]] / cb[use[k - 1]]));
    }
    return [ra, rb];
  }

  function correlation(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 5) return null;
    const x = a.slice(-n);
    const y = b.slice(-n);
    const mx = x.reduce((t, v) => t + v, 0) / n;
    const my = y.reduce((t, v) => t + v, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      sxy += (x[i] - mx) * (y[i] - my);
      sxx += (x[i] - mx) ** 2;
      syy += (y[i] - my) ** 2;
    }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
  }

  // 保有銘柄の比率・比率加重の期待リターン・相関込みのリスク・各銘柄のリスク寄与
  function portfolioStats() {
    const positions = getPositions();
    const held = [];
    const skipped = [];
    for (const stock of book.stocks) {
      const pos = positions[stock.code];
      const slot = $(`pnl-${stock.code}`);
      const price = slot ? Number(slot.dataset.price) : stock.close;
      if (!pos) continue;
      // 比率は円換算の評価額で出す(外国株の取得額も今のレートで換算)
      const rate = fxRate(curOf(stock));
      if (!price || !rate) {
        skipped.push(stock.name);
        continue;
      }
      held.push({ stock, pos, price, value: price * pos.quantity * rate, cost: pos.price * pos.quantity * rate });
    }
    if (!held.length) return null;
    const total = held.reduce((t, h) => t + h.value, 0);
    const cost = held.reduce((t, h) => t + h.cost, 0);
    for (const h of held) h.weight = h.value / total;

    const valid = held.filter((h) => h.stock.expected_return_pct != null && h.stock.risk_pct != null);
    const vw = valid.reduce((t, h) => t + h.weight, 0);
    let expRet = null, risk = null, avgRisk = null, corrOk = true;
    if (valid.length && vw > 0) {
      expRet = valid.reduce((t, h) => t + h.weight * h.stock.expected_return_pct, 0) / vw;
      avgRisk = valid.reduce((t, h) => t + h.weight * h.stock.risk_pct, 0) / vw;
      // 共分散 = 相関 × リスク × リスク(リスクは判定と同じ年率ボラ、相関は直近20営業日)
      const w = valid.map((h) => h.weight / vw);
      const sd = valid.map((h) => h.stock.risk_pct / 100);
      const cov = valid.map((hi, i) =>
        valid.map((hj, j) => {
          if (i === j) return sd[i] * sd[i];
          const rho = correlation(...pairReturns(book.series.get(hi.stock.code) || [], book.series.get(hj.stock.code) || []));
          if (rho == null) corrOk = false;
          return (rho == null ? 0.5 : rho) * sd[i] * sd[j];
        })
      );
      const covW = cov.map((row) => row.reduce((t, c, j) => t + c * w[j], 0));
      const variance = w.reduce((t, wi, i) => t + wi * covW[i], 0);
      risk = Math.sqrt(variance) * 100;
      valid.forEach((h, i) => (h.riskShare = variance > 0 ? (w[i] * covW[i]) / variance : null));
    }
    const unjudged = held.filter((h) => !valid.includes(h)).map((h) => h.stock.name);
    return { held, skipped, unjudged, total, cost, expRet, risk, avgRisk, score: expRet != null && risk ? expRet / risk : null, corrOk };
  }

  // 銘柄ごとの判定を、保有比率で調整する
  function verdictForHolding(h) {
    const pct = h.weight * 100;
    const base = h.stock.verdict;
    if (pct > WEIGHT_TRIM && h.stock.tone !== "sell") {
      return { text: "一部売却を検討", tone: "trim", why: `比率${pct.toFixed(0)}%が目安${WEIGHT_TRIM}%を超えて集中` };
    }
    if (h.stock.tone === "add" && pct > WEIGHT_CAP) {
      return { text: "保有継続", tone: "hold", why: `判定は買い増しだが、比率${pct.toFixed(0)}%が目安${WEIGHT_CAP}%を超えるため見送り` };
    }
    return { text: base, tone: h.stock.tone || "hold", why: "" };
  }

  function renderPortfolio() {
    const panel = $("portfolio-panel");
    if (!panel) return;
    const pf = portfolioStats();
    book.weights = new Map(pf ? pf.held.map((h) => [h.stock.code, h.weight]) : []);
    for (const stock of book.stocks) renderPnl(stock.code);
    if (!pf) {
      panel.hidden = true;
      return;
    }

    const gain = pf.total - pf.cost;
    const signed = (v) => signedPrice(v);
    const figures = el("dl", "stats pf-figures");
    for (const [dt, dd, cls] of [
      ["評価額合計", priceFmt(Math.round(pf.total)), "pct"],
      ["含み損益", signed(Math.round(gain)), pctClass(gain)],
      ["損益率", pctText((gain / pf.cost) * 100), pctClass(gain)],
      ["期待リターン", pctText(pf.expRet, 0), pctClass(pf.expRet)],
      ["リスク(年率)", pf.risk == null ? "—" : `${pf.risk.toFixed(0)}%`, "pct"],
      ["R/Rスコア", scoreText(pf.score == null ? null : Math.round(pf.score * 100) / 100), "pct"],
    ]) {
      const item = el("div");
      item.append(el("dt", null, dt), el("dd", cls, dd));
      figures.appendChild(item);
    }

    const rows = pf.held.slice().sort((a, b) => b.weight - a.weight);
    const table = el("table", "overview pf-table");
    const thead = el("thead");
    const hr = el("tr");
    for (const h of ["銘柄", "比率", "リスク<br />寄与", "保有基準の判定"]) {
      const th = el("th");
      th.scope = "col";
      th.innerHTML = h;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    const tbody = el("tbody");
    const notes = [];
    for (const h of rows) {
      const v = verdictForHolding(h);
      const tr = el("tr");
      const nameTd = el("td");
      const a = el("a", null, h.stock.name);
      a.href = `#s-${h.stock.code}`;
      nameTd.append(a, el("span", "code", h.stock.code));
      const vTd = el("td");
      vTd.appendChild(el("span", `badge ${v.tone}`, v.text));
      if (v.text !== h.stock.verdict) vTd.appendChild(el("span", "badge-sub", `(今日の判定: ${h.stock.verdict})`));
      tr.append(
        nameTd,
        el("td", null, `${(h.weight * 100).toFixed(1)}%`),
        el("td", null, h.riskShare == null ? "—" : `${h.riskShare < -0.005 ? "−" : ""}${Math.abs(h.riskShare * 100).toFixed(0)}%`),
        vTd
      );
      tbody.appendChild(tr);
      if (v.why) notes.push(`${h.stock.name}: ${v.why}。`);
      if (h.riskShare != null && h.riskShare >= 0.4) notes.push(`${h.stock.name}だけで全体リスクの${(h.riskShare * 100).toFixed(0)}%を占めています。`);
    }
    table.append(thead, tbody);

    // 全体のまとめ
    const lead = [];
    if (pf.score != null) {
      const judge = pf.expRet >= 15 && pf.score >= 0.5 ? "リスクに見合うリターンが見込める水準" : pf.expRet < 0 ? "期待リターンがマイナス" : "リスクに対してリターンは控えめ";
      lead.push(`保有全体の期待リターンは${pctText(pf.expRet, 0)}、リスクは年率${pf.risk.toFixed(0)}%で、スコア${pf.score.toFixed(2)}(${judge})。`);
    }
    if (pf.avgRisk != null && pf.risk != null && pf.avgRisk > 0) {
      lead.push(`銘柄を組み合わせた分散効果で、リスクは各銘柄の加重平均${pf.avgRisk.toFixed(0)}%から${pf.risk.toFixed(0)}%に下がっています。`);
    }
    if (pf.held.length < book.stocks.length) {
      lead.push(`登録済みの${pf.held.length}銘柄だけで計算しています。`);
    }
    if (pf.unjudged.length) {
      lead.push(`${pf.unjudged.join("、")}は判定がまだないため、比率には入れ、期待リターンとリスクの計算からは外しています。`);
    }
    if (pf.skipped.length) {
      lead.push(`${pf.skipped.join("、")}は株価か為替レートがまだ取れていないため、計算から外しています。`);
    }

    $("pf-lead").textContent = lead.join("");
    $("pf-figures").replaceChildren(figures);
    $("pf-table").replaceChildren(table);
    fillList($("pf-notes"), notes);
    $("pf-notes").hidden = !notes.length;
    $("pf-caveat").textContent =
      `期待リターンとリスクは今日のチェック値を保有比率で加重し、リスクは直近20営業日の銘柄間の相関を反映しています${pf.corrOk ? "" : "(相関が取れない組み合わせは0.5と仮定)"}。` +
      `リスク寄与は全体のリスクのうちその銘柄が生む割合で、マイナスはほかの銘柄と逆に動いてリスクを打ち消していることを示します。比率の目安: ${WEIGHT_CAP}%超は買い増し見送り、${WEIGHT_TRIM}%超は一部売却を検討。取得単価は損益の表示だけに使い、判定には使いません(買値はこの先のリターンを左右しないため)。` +
      (pf.held.some((h) => curOf(h.stock) !== "JPY") ? "外国株は今の為替レートで円に換算しています。" : "");
    panel.hidden = false;
  }

  // ---------- 株価データからの計算 ----------

  // prices.json の終値から、直近終値・前日比・年初来高値比・1ヶ月/1年騰落率を出す
  function statsFromPrices(dates, close) {
    const idx = [];
    close.forEach((v, i) => v != null && idx.push(i));
    if (idx.length < 2) return null;
    const lastIdx = idx[idx.length - 1];
    const last = close[lastIdx];
    const prev = close[idx[idx.length - 2]];
    const year = dates[lastIdx].slice(0, 4);
    let ytdHigh = -Infinity;
    for (const i of idx) if (dates[i].startsWith(year) && close[i] > ytdHigh) ytdHigh = close[i];
    const since = (months) => {
      const [y, m, d] = dates[lastIdx].split("-").map(Number);
      const target = new Date(Date.UTC(y, m - 1 - months, d)).toISOString().slice(0, 10);
      const i = idx.find((j) => dates[j] >= target);
      return i == null || i >= lastIdx ? null : (last / close[i] - 1) * 100;
    };
    return {
      last,
      lastDate: dates[lastIdx],
      change: (last / prev - 1) * 100,
      fromHigh: (last / ytdHigh - 1) * 100,
      m1: since(1),
      y1: since(12),
    };
  }

  function niceTicks(min, max, count) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [];
    const rough = (max - min) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const n = rough / mag;
    const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) ticks.push(Math.round(v * 1000) / 1000);
    return ticks;
  }

  // ---------- チャート ----------

  function buildChart(dates, close, lines, name, cur = "JPY") {
    const wrap = el("div", "chart-wrap");
    const box = el("div", "chart-box");
    box.setAttribute("role", "img");
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

    let min = Infinity;
    let max = -Infinity;
    for (const v of close) {
      if (v == null) continue;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    // 見直しラインが近ければ(値幅の半分以内)縦軸に含めて、どれだけ離れているかを見えるようにする
    const range0 = max - min || max * 0.1 || 1;
    const shown = lines.filter((l) => l.price > min - range0 * 0.5 && l.price < max + range0 * 0.5);
    for (const l of shown) {
      min = Math.min(min, l.price);
      max = Math.max(max, l.price);
    }
    const range = max - min || 1;
    const n = dates.length;
    const xPct = (i) => (n <= 1 ? 50 : (i / (n - 1)) * 100);
    const yOf = (v) => PAD_Y + (1 - (v - min) / range) * (H - PAD_Y * 2);

    let d = "";
    close.forEach((v, i) => {
      if (v == null) return; // 取引のない日は前後を線でつなぐ
      d += `${d ? "L" : "M"}${((xPct(i) / 100) * W).toFixed(1)},${yOf(v).toFixed(1)}`;
    });
    const ticks = niceTicks(min, max, 3);
    const grid = ticks.map((t) => `<line class="grid-line" x1="0" x2="${W}" y1="${yOf(t).toFixed(1)}" y2="${yOf(t).toFixed(1)}" />`);
    // 横軸: 四半期ごとの月初め
    const months = [];
    for (let i = 1; i < n; i++) {
      const m = Number(dates[i].slice(5, 7));
      if (dates[i].slice(0, 7) !== dates[i - 1].slice(0, 7) && [1, 4, 7, 10].includes(m)) {
        months.push({ i, label: m === 1 ? `'${dates[i].slice(2, 4)}` : `${m}月` });
      }
    }
    const vlines = months.map(({ i }) => {
      const x = ((xPct(i) / 100) * W).toFixed(1);
      return `<line class="grid-line" x1="${x}" x2="${x}" y1="0" y2="${H}" />`;
    });
    const rlines = shown.map((l) => `<line class="review-line" x1="0" x2="${W}" y1="${yOf(l.price).toFixed(1)}" y2="${yOf(l.price).toFixed(1)}" />`);
    svg.innerHTML = `${vlines.join("")}${grid.join("")}${rlines.join("")}<path class="chart-line" d="${d}" />`;

    for (const t of ticks) {
      const lab = el("span", "tick-label", numFmt.format(t));
      lab.style.top = `${(yOf(t) / H) * 100}%`;
      labels.appendChild(lab);
    }
    for (const l of shown) {
      const lab = el("span", "line-label", `${l.label} ${numFmt.format(l.price)}`);
      lab.style.top = `${(yOf(l.price) / H) * 100}%`;
      labels.appendChild(lab);
    }
    for (const { i, label } of months) {
      const lab = el("span", "month-label", label);
      lab.style.left = `${xPct(i)}%`;
      labels.appendChild(lab);
    }
    box.setAttribute("aria-label", `${name}の1年チャート`);

    // ホバー: 日付と終値、そこから現在までの騰落率
    const last = close[close.map((v) => v != null).lastIndexOf(true)];
    const nearest = (idx) => {
      for (let off = 0; off < n; off++) {
        if (idx - off >= 0 && close[idx - off] != null) return idx - off;
        if (idx + off < n && close[idx + off] != null) return idx + off;
      }
      return -1;
    };
    const onMove = (ev) => {
      const rect = box.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
      const i = nearest(Math.round(frac * (n - 1)));
      if (i < 0) return;
      const left = `${xPct(i)}%`;
      crosshair.style.left = dot.style.left = tooltip.style.left = left;
      dot.style.top = `${(yOf(close[i]) / H) * 100}%`;
      tooltip.textContent = `${dateFmt(dates[i])}  ${priceFmt(close[i], cur)}\n現在まで ${pctText((last / close[i] - 1) * 100)}`;
      tooltip.classList.toggle("edge-left", xPct(i) < 20);
      tooltip.classList.toggle("edge-right", xPct(i) > 80);
      crosshair.hidden = dot.hidden = tooltip.hidden = false;
    };
    const onLeave = () => {
      crosshair.hidden = dot.hidden = tooltip.hidden = true;
    };
    box.addEventListener("pointermove", onMove);
    box.addEventListener("pointerdown", onMove);
    box.addEventListener("pointerleave", onLeave);
    box.addEventListener("pointercancel", onLeave);

    // 見直しラインまでの距離
    for (const l of lines) {
      const dist = (l.price / last - 1) * 100;
      wrap.appendChild(el("p", "chart-note", `${l.label} ${priceFmt(l.price, cur)}まで ${pctText(dist)}`));
    }
    return wrap;
  }

  // ---------- 描画 ----------

  function badge(stock) {
    const wrap = el("span");
    wrap.appendChild(el("span", `badge ${stock.tone || "hold"}`, stock.verdict));
    if (stock.sub) wrap.appendChild(el("span", "badge-sub", stock.sub));
    return wrap;
  }

  function buildCard(stock, st, prices) {
    const card = el("article", "card");
    card.id = `s-${stock.code}`;

    const head = el("div", "card-head");
    const name = el("h2", "card-name", stock.name);
    const code = el("span", "code");
    const link = el("a", null, stock.code);
    link.href = YAHOO_URL(stock);
    link.target = "_blank";
    link.rel = "noopener";
    link.title = `${stock.name}(Yahoo!ファイナンス)`;
    code.appendChild(link);
    name.appendChild(code);
    const verdict = el("div", "verdict");
    verdict.appendChild(badge(stock));
    head.append(name, verdict);

    const stats = el("dl", "stats");
    const items = st
      ? [
          [`終値(${shortDate(st.lastDate)})`, priceFmt(st.last, curOf(stock)), "pct"],
          ["前日比", pctText(st.change, 2), pctClass(st.change)],
          ["年初来高値比", pctText(st.fromHigh, 0), pctClass(st.fromHigh)],
          ["1年", pctText(st.y1), pctClass(st.y1)],
        ]
      : [
          ["終値", priceFmt(stock.close, curOf(stock)), "pct"],
          ["前日比", pctText(stock.change_pct, 2), pctClass(stock.change_pct)],
          ["年初来高値比", pctText(stock.from_high_pct, 0), pctClass(stock.from_high_pct)],
          ["PER / 利回り", `${stock.per} / ${stock.yield}`, "pct"],
        ];
    for (const [dt, dd, cls] of items) {
      const item = el("div");
      item.append(el("dt", null, dt), el("dd", cls, dd));
      stats.appendChild(item);
    }

    // 保有状況の損益表示(入力欄を変えると renderPnl で書き換える)
    const pnlSlot = el("div", "pnl-slot");
    pnlSlot.id = `pnl-${stock.code}`;
    const currentPrice = st ? st.last : stock.close;
    if (currentPrice) pnlSlot.dataset.price = String(currentPrice);
    pnlSlot.dataset.currency = curOf(stock);

    // チェック時点のリスクとリターン
    const rr = el("dl", "stats rr");
    for (const [dt, dd, cls] of [
      ["期待リターン", pctText(stock.expected_return_pct, 0), pctClass(stock.expected_return_pct)],
      ["リスク(年率)", stock.risk_pct == null ? "—" : `${stock.risk_pct}%${stock.risk_note ? "*" : ""}`, "pct"],
      ["R/Rスコア", scoreText(stock.score), "pct"],
    ]) {
      const item = el("div");
      item.append(el("dt", null, dt), el("dd", cls, dd));
      rr.appendChild(item);
    }

    const plan = el("p", "plan");
    plan.append(el("strong", null, "判定"), document.createTextNode(stock.plan));

    card.append(head, stats, pnlSlot, rr);
    renderPnl(stock.code, pnlSlot);
    if (stock.risk_note) card.appendChild(el("p", "risk-note", `* ${stock.risk_note}`));
    if (prices) card.appendChild(buildChart(prices.dates, prices.close, stock.lines || [], stock.name, curOf(stock)));
    card.appendChild(plan);

    if (stock.memo && stock.memo.length) {
      const memo = el("details", "memo");
      memo.appendChild(el("summary", null, "材料メモ"));
      const ul = el("ul");
      for (const m of stock.memo) ul.appendChild(el("li", null, m));
      if (st) ul.appendChild(el("li", null, `PER ${stock.per} / 配当利回り ${stock.yield}(チェック時点)`));
      memo.appendChild(ul);
      card.appendChild(memo);
    }
    return card;
  }

  function buildOverviewRow(stock) {
    const tr = el("tr");
    const nameTd = el("td");
    const a = el("a", null, stock.name);
    a.href = `#s-${stock.code}`;
    nameTd.append(a, el("span", "code", stock.code));
    const verdictTd = el("td");
    verdictTd.appendChild(badge(stock));
    tr.append(
      nameTd,
      el("td", pctClass(stock.expected_return_pct), pctText(stock.expected_return_pct, 0)),
      el("td", null, stock.risk_pct == null ? "—" : `${stock.risk_pct}%`),
      el("td", null, scoreText(stock.score)),
      verdictTd
    );
    return tr;
  }

  function fillList(ul, items) {
    ul.replaceChildren(...(items || []).map((t) => el("li", null, t)));
  }

  function buildPositionInputs(stocks) {
    const container = $("position-inputs");
    const positions = getPositions();

    // Enter キーでも登録できるよう form にする
    const form = el("form", "position-form");
    form.noValidate = true;
    const table = el("table", "position-inputs-table");
    const thead = el("thead");
    const headerRow = el("tr");
    headerRow.append(
      el("th", null, "銘柄"),
      el("th", null, "取得単価"),
      el("th", null, "保有株数"),
      el("th", null, "")
    );
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const status = el("p", "position-status");
    status.setAttribute("role", "status");
    const setStatus = (text, tone = "") => {
      status.textContent = text;
      status.className = `position-status ${tone}`.trim();
    };

    const rows = [];
    const tbody = el("tbody");
    for (const stock of stocks) {
      const position = positions[stock.code] || {};
      const row = el("tr");
      const priceInput = el("input");
      priceInput.type = "number";
      priceInput.inputMode = "decimal";
      priceInput.setAttribute("aria-label", `${stock.name}の取得単価`);
      priceInput.placeholder = curOf(stock) === "USD" ? "ドル" : curOf(stock) === "JPY" ? "円" : curOf(stock);
      priceInput.min = "0";
      priceInput.step = "any";
      priceInput.value = position.price ? position.price.toString() : "";

      const quantityInput = el("input");
      quantityInput.type = "number";
      quantityInput.inputMode = "numeric";
      quantityInput.setAttribute("aria-label", `${stock.name}の保有株数`);
      quantityInput.placeholder = "株数";
      quantityInput.min = "0";
      quantityInput.step = "1";
      quantityInput.value = position.quantity ? position.quantity.toString() : "";

      // 削除はその銘柄だけすぐ消す
      const clearBtn = el("button", "clear-btn");
      clearBtn.type = "button";
      clearBtn.textContent = "削除";
      clearBtn.addEventListener("click", () => {
        priceInput.value = "";
        quantityInput.value = "";
        setPosition(stock.code, 0, 0);
        renderPortfolio();
        setStatus(`${stock.name}を削除しました。`);
      });

      const priceTd = el("td");
      priceTd.appendChild(priceInput);
      const qtyTd = el("td");
      qtyTd.appendChild(quantityInput);
      const actionTd = el("td");
      actionTd.appendChild(clearBtn);

      row.append(el("td", null, `${stock.name}(${stock.code})`), priceTd, qtyTd, actionTd);
      tbody.appendChild(row);
      rows.push({ stock, row, priceInput, quantityInput });
    }
    table.appendChild(tbody);

    const actions = el("div", "position-actions");
    const saveBtn = el("button", "save-btn", "登録");
    saveBtn.type = "submit";
    actions.append(saveBtn, status);

    // 入力を変えたら、登録するまで未登録と表示する
    form.addEventListener("input", () => setStatus("未登録の変更があります。「登録」を押してください。", "pending"));

    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const incomplete = [];
      let saved = 0;
      for (const { stock, row, priceInput, quantityInput } of rows) {
        const price = Number(priceInput.value);
        const qty = Number(quantityInput.value);
        const hasPrice = priceInput.value !== "" && price > 0;
        const hasQty = quantityInput.value !== "" && qty > 0;
        row.classList.toggle("incomplete", hasPrice !== hasQty);
        if (hasPrice !== hasQty) {
          incomplete.push(stock.name); // 片方だけの行は保存しない(登録済みの値を消さない)
          continue;
        }
        setPosition(stock.code, hasPrice ? price : 0, hasQty ? qty : 0);
        if (hasPrice) saved++;
      }
      renderPortfolio();
      if (incomplete.length) {
        setStatus(`${incomplete.join("、")}は取得単価と株数の両方を入れてください。ほかの銘柄は登録しました。`, "error");
      } else {
        const now = new Date();
        const hm = `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
        setStatus(`${saved}銘柄を登録しました(${hm})。損益は各銘柄のカードに出ます。`, "ok");
      }
    });

    form.append(table, actions);
    container.appendChild(form);
    $("position-panel").hidden = false;
  }

  // 算定方法の欄: 比率の目安を定数から入れ、今日のチェックから計算例を1つ示す
  function renderMethod(check) {
    for (const e of document.querySelectorAll(".weight-cap")) e.textContent = WEIGHT_CAP;
    for (const e of document.querySelectorAll(".weight-trim")) e.textContent = WEIGHT_TRIM;
    const ex =
      check.stocks.find((s) => s.tone === "add" && s.score != null) ||
      check.stocks.find((s) => s.expected_return_pct != null && s.risk_pct != null);
    if (!ex) return;
    const score = ex.score ?? ex.expected_return_pct / ex.risk_pct;
    const why =
      ex.expected_return_pct >= 15 && score >= 0.5
        ? "+15%以上かつ0.5以上なので買い増し"
        : ex.expected_return_pct < 0
          ? "期待リターンがマイナスなので売却検討(一部)"
          : "買い増しの条件に届かないので保有継続";
    $("method-example").textContent =
      `例(${dateFmt(check.checked_on)}のチェック): ${ex.name}は期待リターン${pctText(ex.expected_return_pct, 0)}、リスク${ex.risk_pct}%で、` +
      `スコア = ${ex.expected_return_pct} ÷ ${ex.risk_pct} ≒ ${score.toFixed(2)}(表示の%は四捨五入後)。${why}。`;
    $("method-example").hidden = false;
  }

  async function loadJson(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  }

  async function load() {
    let check;
    try {
      check = await loadJson(CHECK_URL);
    } catch (err) {
      console.error(err);
      $("status").textContent = "チェック結果を読み込めませんでした。";
      $("status").classList.add("error");
      return;
    }
    // 株価データはなくてもチェック結果だけで表示する
    let prices = null;
    try {
      prices = await loadJson(PRICES_URL);
    } catch (err) {
      console.warn(err);
    }

    const series = new Map();
    if (prices) for (const s of prices.stocks) series.set(s.code, s.close);
    book.stocks = check.stocks;
    book.series = series;
    book.fx = (prices && prices.fx) || {};

    let status = `チェック日: ${dateFmt(check.checked_on)}(${dateFmt(check.price_date)} 終値ベース)`;
    if (prices) {
      const generated = prices.generated_at ? prices.generated_at.slice(0, 16).replace("T", " ").replace(/-/g, "/") : "—";
      status += ` / 株価データ更新: ${generated}`;
      const usd = book.fx.USDJPY;
      if (usd) status += ` / 1ドル=${usd.rate.toFixed(2)}円`;
    }
    $("status").textContent = status;

    $("summary-lead").textContent = check.summary || "";
    $("summary-note").textContent = check.note || "";
    fillList($("market"), check.market);
    if (check.criteria && check.criteria.length) {
      fillList($("criteria"), check.criteria);
      $("caveat").textContent = check.caveat || "";
      $("criteria-box").hidden = false;
    }
    $("summary").hidden = false;

    const overview = $("overview");
    const cards = $("cards");
    for (const stock of check.stocks) {
      const close = series.get(stock.code);
      const st = close ? statsFromPrices(prices.dates, close) : null;
      overview.appendChild(buildOverviewRow(stock));
      cards.appendChild(buildCard(stock, st, close && st ? { dates: prices.dates, close } : null));
    }
    $("overview-panel").hidden = false;
    cards.hidden = false;

    // 保有入力フォーム
    buildPositionInputs(check.stocks);
    renderPortfolio();

    if (check.next && check.next.length) {
      fillList($("next"), check.next);
      $("next-panel").hidden = false;
    }
    $("sources").textContent = check.sources ? `チェックのデータ出典: ${check.sources}` : "";
    renderMethod(check);
  }

  load();
})();
