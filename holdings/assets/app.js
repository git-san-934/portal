(() => {
  "use strict";

  const CHECK_URL = "data/check.json";
  const PRICES_URL = "data/prices.json";
  const YAHOO_URL = (code) => `https://finance.yahoo.co.jp/quote/${encodeURIComponent(code)}.T`;

  // チャート座標(SVG viewBox)。preserveAspectRatio="none" で横幅いっぱいに伸ばす
  const W = 1000;
  const H = 100;
  const PAD_Y = 8;

  const $ = (id) => document.getElementById(id);

  const numFmt = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 });
  const priceFmt = (v) => (v == null ? "—" : `${numFmt.format(v)}円`);
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

  function buildChart(dates, close, lines, name) {
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
      tooltip.textContent = `${dateFmt(dates[i])}  ${priceFmt(close[i])}\n現在まで ${pctText((last / close[i] - 1) * 100)}`;
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
      wrap.appendChild(el("p", "chart-note", `${l.label} ${priceFmt(l.price)}まで ${pctText(dist)}`));
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
    link.href = YAHOO_URL(stock.code);
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
          [`終値(${shortDate(st.lastDate)})`, priceFmt(st.last), "pct"],
          ["前日比", pctText(st.change, 2), pctClass(st.change)],
          ["年初来高値比", pctText(st.fromHigh, 0), pctClass(st.fromHigh)],
          ["1年", pctText(st.y1), pctClass(st.y1)],
        ]
      : [
          ["終値", priceFmt(stock.close), "pct"],
          ["前日比", pctText(stock.change_pct, 2), pctClass(stock.change_pct)],
          ["年初来高値比", pctText(stock.from_high_pct, 0), pctClass(stock.from_high_pct)],
          ["PER / 利回り", `${stock.per} / ${stock.yield}`, "pct"],
        ];
    for (const [dt, dd, cls] of items) {
      const item = el("div");
      item.append(el("dt", null, dt), el("dd", cls, dd));
      stats.appendChild(item);
    }

    // 保有状況の損益表示
    const positions = getPositions();
    const position = positions[stock.code];
    const currentPrice = st ? st.last : stock.close;
    if (position && currentPrice) {
      const pnl = calcPnl(currentPrice, position.price, position.quantity);
      if (pnl) {
        const pnlStats = el("dl", "stats pnl");
        for (const [dt, dd, cls] of [
          ["取得単価", priceFmt(position.price), "pct"],
          ["保有株数", `${numFmt.format(position.quantity)}株`, "pct"],
          ["評価額", priceFmt(pnl.currentValue), "pct"],
          ["損益", priceFmt(pnl.gain), pctClass(pnl.gain)],
          ["損益率", pctText(pnl.gainPct), pctClass(pnl.gainPct)],
        ]) {
          const item = el("div");
          item.append(el("dt", null, dt), el("dd", cls, dd));
          pnlStats.appendChild(item);
        }
        card.appendChild(pnlStats);
      }
    }

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

    card.append(head, stats, rr);
    if (stock.risk_note) card.appendChild(el("p", "risk-note", `* ${stock.risk_note}`));
    if (prices) card.appendChild(buildChart(prices.dates, prices.close, stock.lines || [], stock.name));
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

    const table = el("table", "position-inputs-table");
    const thead = el("thead");
    const headerRow = el("tr");
    headerRow.append(
      el("th", null, "銘柄"),
      el("th", null, "取得単価(円)"),
      el("th", null, "保有株数"),
      el("th", null, "")
    );
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = el("tbody");
    for (const stock of stocks) {
      const position = positions[stock.code] || {};
      const row = el("tr");
      const priceInput = el("input");
      priceInput.type = "number";
      priceInput.placeholder = "取得単価";
      priceInput.min = "0";
      priceInput.step = "0.01";
      priceInput.value = position.price ? position.price.toString() : "";
      priceInput.addEventListener("input", () => {
        const qty = quantityInput.value;
        setPosition(stock.code, priceInput.value, qty);
        location.reload();
      });

      const quantityInput = el("input");
      quantityInput.type = "number";
      quantityInput.placeholder = "株数";
      quantityInput.min = "0";
      quantityInput.step = "1";
      quantityInput.value = position.quantity ? position.quantity.toString() : "";
      quantityInput.addEventListener("input", () => {
        const price = priceInput.value;
        setPosition(stock.code, price, quantityInput.value);
        location.reload();
      });

      const clearBtn = el("button", "clear-btn");
      clearBtn.textContent = "削除";
      clearBtn.addEventListener("click", () => {
        setPosition(stock.code, 0, 0);
        location.reload();
      });

      row.append(
        el("td", null, `${stock.name}(${stock.code})`),
        el("td", null, priceInput),
        el("td", null, quantityInput),
        el("td", null, clearBtn)
      );
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    container.appendChild(table);
    $("position-panel").hidden = false;
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

    let status = `チェック日: ${dateFmt(check.checked_on)}(${dateFmt(check.price_date)} 終値ベース)`;
    if (prices) {
      const generated = prices.generated_at ? prices.generated_at.slice(0, 16).replace("T", " ").replace(/-/g, "/") : "—";
      status += ` / 株価データ更新: ${generated}`;
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

    if (check.next && check.next.length) {
      fillList($("next"), check.next);
      $("next-panel").hidden = false;
    }
    $("sources").textContent = check.sources ? `チェックのデータ出典: ${check.sources}` : "";
  }

  load();
})();
