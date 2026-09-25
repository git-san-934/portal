(() => {
  "use strict";

  const DATA_URL = "data/events.json";
  const BUYBACK_URL = "data/buyback.json";
  const BUYBACK_DAYS = 50; // 自己株券買付状況報告書は翌月15日までに出るので、これ以内に出ていれば「実施中」
  const STOCK_URL = (code) => `data/stocks/${encodeURIComponent(code)}.json`;
  const YAHOO_URL = (code) => `https://finance.yahoo.co.jp/quote/${encodeURIComponent(code)}.T`;

  const GAP_OPTIONS = [
    { key: 60, label: "3ヶ月以上" },
    { key: 250, label: "1年以上" },
    { key: 750, label: "3年以上" },
  ];
  const ERA_OPTIONS = [
    { key: "all", label: "全期間" },
    { key: "2013", label: "2013年以降" },
    { key: "5y", label: "直近5年" },
  ];
  const SIZE_OPTIONS = [
    { key: 0, label: "時価総額上位500" },
    { key: 100, label: "上位100" },
  ];
  const PATH_OPTIONS = [
    { key: "path", label: "株価" },
    { key: "rel", label: "TOPIX比" },
  ];
  const PATH_NOTES = {
    path: "ブレイク日の終値を100として、前後の株価を並べています。1年後まで値がそろっているブレイクだけで集計しています。",
    rel: "ブレイク日を100として、TOPIX連動ETF(1306)に比べてどれだけ強かったか(株価÷TOPIX)を並べています。100より上ならTOPIXより強かったことになります。",
  };
  const HORIZON_LABELS = { 5: "1週後", 20: "1ヶ月後", 60: "3ヶ月後", 120: "6ヶ月後", 250: "1年後" };
  const PAGE = 50;
  const RECENT_DAYS = 92; // 「いま最高値を更新中」とみなすブレイクからの日数(暦日)
  const HIDDEN_KEY = "ath-breakout:hidden"; // 一覧から外した銘柄 { code: 外した時点の最高値日 }

  // チャート座標(SVG viewBox)。preserveAspectRatio="none" で横幅いっぱいに伸ばす
  const W = 1000;
  const H = 500;
  const PAD_Y = 16;

  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");
  const mainEl = $("main");

  const state = {
    data: null,
    stockMap: new Map(), // code -> stock
    rankMap: new Map(), // code -> 時価総額順位(1〜)
    gap: 60,
    era: "all",
    size: 0,
    pathKind: "path",
    hidden: loadHidden(),
    recentSort: { key: "last", dir: -1 }, // 「いま最高値を更新中」の並び(見出しを押すと切り替え)
    buyback: {}, // code -> 自己株券買付状況報告書の提出日(古い順)
    filtered: [],
    shown: PAGE,
  };

  const numFmt = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 });
  const priceFmt = (v) => (v == null ? "—" : `${numFmt.format(v)}円`);
  const pctText = (v, digits = 1) => {
    if (v == null || Number.isNaN(v)) return "—";
    const s = Math.abs(v * 100).toLocaleString("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return v > 0 ? `+${s}%` : v < 0 ? `−${s}%` : `${s}%`;
  };
  const rateText = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);
  const pctClass = (v) => (v == null || v === 0 ? "pct" : v > 0 ? "pct up" : "pct down");
  const dateFmt = (iso) => iso.replace(/-/g, "/");
  const gapText = (g) => (g >= 250 ? `${numFmt.format(Math.round((g / 250) * 10) / 10)}年ぶり` : `${Math.max(1, Math.round(g / 21))}ヶ月ぶり`);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function pctCell(v) {
    return el("td", pctClass(v), pctText(v));
  }
  // 自社株買い: 直近 BUYBACK_DAYS 日以内に自己株券買付状況報告書を出していれば「実施中」
  function buybackActive(code, today) {
    const last = (state.buyback[code] || []).at(-1);
    return !!last && (new Date(today) - new Date(last)) / 86400000 <= BUYBACK_DAYS;
  }
  function buybackCell(code, today) {
    const last = (state.buyback[code] || []).at(-1);
    if (!last) return el("td", "muted", "—");
    const active = buybackActive(code, today);
    const td = el("td", active ? null : "muted", active ? "実施中" : "—");
    td.title = `最後の報告書: ${dateFmt(last)}`;
    return td;
  }

  // ---------- 有望度の順位(目安) ----------
  // 過去の検証(2017〜2025年のブレイク)で時期をまたいで一貫したのは「売上の伸び」だけ(5%以上で1年後が約+4pt)。
  // そこで売上の伸びの段階を主に、評価マーク(ブレイクが続いているか)を従にして点数をつける
  function salesTier(g) {
    if (g == null) return 0;
    return g >= 0.2 ? 3 : g >= 0.1 ? 2 : g >= 0.05 ? 1 : 0;
  }
  const GRADE_POINT = { 上: 1, 中: 0.5, 下: 0 };
  function promiseRanks(events) {
    const score = (e) => {
      const s = state.stockMap.get(e.code);
      return salesTier(s?.sales?.growth) * 2 + (GRADE_POINT[gradeOf(e, s)] ?? 0);
    };
    const growth = (e) => state.stockMap.get(e.code)?.sales?.growth ?? -Infinity;
    const sorted = [...events].sort((a, b) => score(b) - score(a) || growth(b) - growth(a) || a.code.localeCompare(b.code));
    return new Map(sorted.map((e, i) => [e.code, i + 1]));
  }

  // ---------- 外した銘柄(この端末のブラウザにだけ保存) ----------

  function loadHidden() {
    try {
      return JSON.parse(localStorage.getItem(HIDDEN_KEY)) || {};
    } catch {
      return {};
    }
  }
  function saveHidden() {
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(state.hidden));
    } catch {
      // 保存できなくても、開いている間は外したままにする
    }
  }
  // 外したあとに最高値を更新していれば、また表示する
  function isHidden(code) {
    const at = state.hidden[code];
    const s = state.stockMap.get(code);
    return at != null && !(s && s.ath_date > at);
  }

  // ---------- 評価マーク(上・中・下) ----------
  // fetch_ath.py の grade() と同じ決め方。上=ブレイク価格以上で最高値の近く / 下=ブレイク価格を5%超下回った
  function gradeOf(e, s) {
    if (!s) return null;
    const rules = state.data.rules || {};
    const fail = rules.rate_fail ?? -0.05;
    const near = rules.rate_near ?? -0.05;
    if (s.last / e.price - 1 < fail) return "下";
    if (s.last >= e.price && s.last / s.ath - 1 >= near) return "上";
    return "中";
  }
  const GRADE_CLASS = { 上: "grade up", 中: "grade mid", 下: "grade down" };
  function gradeCell(g) {
    const td = el("td");
    if (g) td.append(el("span", GRADE_CLASS[g], g));
    else td.textContent = "—";
    return td;
  }

  function renderRating() {
    const r = state.data.rating;
    const table = $("rating");
    table.textContent = "";
    if (!r) {
      $("rating-panel").hidden = true;
      return;
    }
    const thead = el("thead");
    const h1 = el("tr");
    h1.append(el("th", null, ""));
    const a = el("th", null, "判定から1年後の株価");
    a.colSpan = 3;
    const b = el("th", "group", "TOPIX比");
    b.colSpan = 2;
    const c = el("th", "group", "2013年以降");
    h1.append(a, b, c);
    const h2 = el("tr");
    ["評価", "中央値", "平均", "上がった割合"].forEach((t) => h2.append(el("th", null, t)));
    ["中央値", "勝った割合"].forEach((t, i) => h2.append(el("th", i === 0 ? "group" : null, t)));
    h2.append(el("th", "group", "株価の中央値"));
    thead.append(h1, h2);
    const tbody = el("tbody");
    for (const g of ["上", "中", "下"]) {
      const st = r.grades[g]?.all;
      if (!st) continue;
      const tr = el("tr");
      const th = el("th");
      th.append(el("span", GRADE_CLASS[g], g), el("span", "code", `${st.n.toLocaleString("ja-JP")}件`));
      tr.append(th, pctCell(st.median), pctCell(st.mean), el("td", null, rateText(st.win)));
      const xm = pctCell(st.exc_median);
      xm.classList.add("group");
      tr.append(xm, el("td", null, rateText(st.exc_win)));
      const late = pctCell(r.grades[g]?.late?.median ?? null);
      late.classList.add("group");
      tr.append(late);
      tbody.append(tr);
    }
    table.append(thead, tbody);
  }

  // ---------- 集計 ----------

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  function summarize(values) {
    const v = values.filter((x) => x != null).sort((a, b) => a - b);
    if (!v.length) return { n: 0, mean: null, median: null, win: null };
    return {
      n: v.length,
      mean: v.reduce((s, x) => s + x, 0) / v.length,
      median: quantile(v, 0.5),
      win: v.filter((x) => x > 0).length / v.length,
    };
  }

  function eraStart() {
    if (state.era === "2013") return "2013-01-01";
    if (state.era === "5y") {
      const d = new Date(state.data.generated_at.slice(0, 10));
      d.setFullYear(d.getFullYear() - 5);
      return d.toISOString().slice(0, 10);
    }
    return "";
  }

  function applyFilter() {
    const from = eraStart();
    state.filtered = state.data.events
      .filter((e) => e.gap >= state.gap)
      .filter((e) => !from || e.date >= from)
      .filter((e) => !state.size || (state.rankMap.get(e.code) || Infinity) <= state.size);
    state.shown = PAGE;
  }

  // ---------- 描画: 要約・表 ----------

  function renderTiles() {
    const tiles = $("tiles");
    tiles.textContent = "";
    const hIdx = state.data.horizons.indexOf(250);
    const ret = summarize(state.filtered.map((e) => e.ret[hIdx]));
    const exc = summarize(state.filtered.map((e) => e.exc[hIdx]));
    const codes = new Set(state.filtered.map((e) => e.code));
    const items = [
      ["ブレイクの件数", `${state.filtered.length.toLocaleString("ja-JP")}件`, `${codes.size}銘柄`],
      ["1年後に上がっていた割合", rateText(ret.win), `中央値 ${pctText(ret.median)}(${ret.n}件)`],
      ["1年後にTOPIXに勝った割合", rateText(exc.win), `TOPIX比の中央値 ${pctText(exc.median)}`],
    ];
    for (const [label, value, sub] of items) {
      const dl = el("dl", "tile");
      dl.append(el("dt", null, label));
      dl.append(el("dd", null, value));
      dl.append(el("div", "sub", sub));
      tiles.append(dl);
    }
  }

  function renderStats() {
    const table = $("stats");
    table.textContent = "";
    const thead = el("thead");
    const r1 = el("tr");
    r1.append(el("th", null, ""));
    const g1 = el("th", null, "株価の騰落率");
    g1.colSpan = 3;
    const g2 = el("th", "group", "TOPIX比(超過リターン)");
    g2.colSpan = 3;
    r1.append(g1, g2);
    const r2 = el("tr");
    r2.append(el("th", null, "期間"));
    ["平均", "中央値", "上昇した割合"].forEach((t) => r2.append(el("th", null, t)));
    ["平均", "中央値", "勝った割合"].forEach((t, i) => r2.append(el("th", i === 0 ? "group" : null, t)));
    thead.append(r1, r2);

    const tbody = el("tbody");
    state.data.horizons.forEach((h, i) => {
      const r = summarize(state.filtered.map((e) => e.ret[i]));
      const x = summarize(state.filtered.map((e) => e.exc[i]));
      const tr = el("tr");
      const th = el("th", null, HORIZON_LABELS[h] || `${h}営業日後`);
      th.append(el("span", "code", `${r.n}件`));
      tr.append(th, pctCell(r.mean), pctCell(r.median), el("td", null, rateText(r.win)));
      const xm = pctCell(x.mean);
      xm.classList.add("group");
      tr.append(xm, pctCell(x.median), el("td", null, rateText(x.win)));
      tbody.append(tr);
    });
    table.append(thead, tbody);
  }

  function stockCell(code) {
    const s = state.stockMap.get(code);
    const td = el("td", "name", s ? s.name : code);
    td.append(el("span", "code", code));
    return td;
  }
  function clickableRow(tr, code) {
    tr.tabIndex = 0;
    tr.addEventListener("click", () => openStock(code));
    tr.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        openStock(code);
      }
    });
  }
  function headRow(labels) {
    const thead = el("thead");
    const tr = el("tr");
    labels.forEach((t) => tr.append(el("th", t === "銘柄" ? "name" : null, t)));
    thead.append(tr);
    return thead;
  }
  // 押すと並び替えられる見出し
  function sortHeadRow(cols, sort, onSort) {
    const thead = el("thead");
    const tr = el("tr");
    for (const c of cols) {
      const th = el("th", c.label === "銘柄" ? "name" : null);
      if (!c.key) {
        tr.append(th);
        continue;
      }
      const active = c.key === sort.key;
      if (active) th.setAttribute("aria-sort", sort.dir > 0 ? "ascending" : "descending");
      const btn = el("button", active ? "sort-btn active" : "sort-btn", c.label);
      btn.type = "button";
      btn.append(el("span", "sort-mark", active ? (sort.dir > 0 ? "▲" : "▼") : "↕"));
      btn.addEventListener("click", () => onSort(c.key));
      th.append(btn);
      tr.append(th);
    }
    thead.append(tr);
    return thead;
  }
  function emptyRow(tbody, cols, text) {
    const tr = el("tr");
    const td = el("td", "empty", text);
    td.colSpan = cols;
    tr.append(td);
    tbody.append(tr);
  }

  function renderRecent() {
    const table = $("recent");
    table.textContent = "";
    const latest = state.data.stocks.reduce((m, s) => (s.last_date > m ? s.last_date : m), "");
    const since = new Date(latest);
    since.setDate(since.getDate() - RECENT_DAYS);
    const from = since.toISOString().slice(0, 10);
    // 条件(空白期間・対象)にあうブレイクのうち、各銘柄の最新1件
    const byCode = new Map();
    for (const e of state.data.events) {
      if (e.date < from || e.gap < state.gap) continue;
      if (state.size && (state.rankMap.get(e.code) || Infinity) > state.size) continue;
      byCode.set(e.code, e);
    }
    const athDate = (e) => e.last_high || state.stockMap.get(e.code)?.ath_date || e.date;
    const stock = (e) => state.stockMap.get(e.code);
    // 並び替えできる列。value が null の銘柄は、どちら向きでも一番下
    const GRADE_ORDER = { 上: 3, 中: 2, 下: 1 };
    const ranks = promiseRanks([...byCode.values()].filter((e) => !isHidden(e.code)));
    const cols = [
      { label: "" },
      { key: "rank", label: "有望度(目安)", value: (e) => ranks.get(e.code) ?? null },
      { key: "name", label: "銘柄", value: (e) => e.code },
      { key: "grade", label: "評価", value: (e) => GRADE_ORDER[gradeOf(e, stock(e))] ?? null },
      { key: "sales", label: "売上の伸び(前年比)", value: (e) => stock(e)?.sales?.growth ?? null },
      { key: "buyback", label: "自社株買い", value: (e) => (buybackActive(e.code, latest) ? 1 : 0) },
      { key: "first", label: "最初に更新した日", value: (e) => e.date },
      { key: "last", label: "最後に更新した日", value: athDate },
      { key: "highs", label: "更新した日数", value: (e) => e.highs ?? null },
      { key: "gap", label: "何年ぶりの高値", value: (e) => e.gap },
      { key: "since", label: "最初の更新から", value: (e) => (stock(e) ? stock(e).last / e.price - 1 : null) },
      { key: "from_ath", label: "最高値から", value: (e) => stock(e)?.from_ath ?? null },
    ];
    const { key, dir } = state.recentSort;
    const col = cols.find((c) => c.key === key);
    const cmp = (a, b) => (typeof a === "string" ? a.localeCompare(b) : a - b);
    const all = [...byCode.values()].sort((a, b) => {
      const va = col.value(a);
      const vb = col.value(b);
      if (va == null || vb == null) return (va == null) - (vb == null);
      // 同じ値のときは、最高値を更新した日が新しい順
      return dir * cmp(va, vb) || athDate(b).localeCompare(athDate(a)) || b.date.localeCompare(a.date);
    });
    const rows = all.filter((e) => !isHidden(e.code));
    table.append(sortHeadRow(cols, state.recentSort, (k) => {
      // 同じ列をもう一度押すと向きを反対に。別の列は大きい(新しい)順から
      state.recentSort = { key: k, dir: k === key ? -dir : k === "name" || k === "rank" ? 1 : -1 };
      renderRecent();
    }));
    const tbody = el("tbody");
    for (const e of rows) {
      const s = state.stockMap.get(e.code);
      const tr = el("tr");
      const btn = el("button", "hide-btn", "外す");
      btn.type = "button";
      btn.setAttribute("aria-label", `${s ? s.name : e.code}を一覧から外す`);
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        state.hidden[e.code] = s ? s.ath_date : e.date;
        saveHidden();
        renderRecent();
      });
      btn.addEventListener("keydown", (ev) => ev.stopPropagation());
      const td = el("td");
      td.append(btn);
      const rank = ranks.get(e.code);
      tr.append(td, el("td", rank <= 3 ? "rank top" : "rank", rank ? `${rank}位` : "—"), stockCell(e.code), gradeCell(gradeOf(e, s)), pctCell(s?.sales?.growth ?? null), buybackCell(e.code, latest), el("td", null, dateFmt(e.date)), el("td", null, dateFmt(athDate(e))));
      tr.append(el("td", null, e.highs ? `${e.highs}日` : "—"), el("td", null, gapText(e.gap)));
      tr.append(pctCell(s ? s.last / e.price - 1 : null), pctCell(s ? s.from_ath : null));
      clickableRow(tr, e.code);
      tbody.append(tr);
    }
    if (!rows.length) emptyRow(tbody, 12, all.length ? "すべて外しています" : "この条件にあう最近のブレイクはありません");
    table.append(tbody);

    const hiddenCodes = Object.keys(state.hidden).filter(isHidden);
    const note = $("hidden-note");
    note.textContent = "";
    note.hidden = !hiddenCodes.length;
    if (hiddenCodes.length) {
      const names = hiddenCodes.map((c) => state.stockMap.get(c)?.name || c);
      note.append(`外した銘柄 ${hiddenCodes.length}件(${names.slice(0, 5).join("、")}${names.length > 5 ? " ほか" : ""}) `);
      const undo = el("button", "hide-btn", "すべて戻す");
      undo.type = "button";
      undo.addEventListener("click", () => {
        state.hidden = {};
        saveHidden();
        renderRecent();
      });
      note.append(undo);
    }
  }

  function renderEvents() {
    const table = $("events");
    table.textContent = "";
    const hs = state.data.horizons;
    const i1m = hs.indexOf(20);
    const i3m = hs.indexOf(60);
    const i1y = hs.indexOf(250);
    table.append(headRow(["ブレイク日", "銘柄", "前回の最高値から", "1ヶ月後", "3ヶ月後", "1年後", "1年後のTOPIX比"]));
    const tbody = el("tbody");
    const rows = [...state.filtered].reverse().slice(0, state.shown);
    for (const e of rows) {
      const tr = el("tr");
      tr.append(el("td", null, dateFmt(e.date)), stockCell(e.code), el("td", null, gapText(e.gap)));
      tr.append(pctCell(e.ret[i1m]), pctCell(e.ret[i3m]), pctCell(e.ret[i1y]), pctCell(e.exc[i1y]));
      clickableRow(tr, e.code);
      tbody.append(tr);
    }
    if (!rows.length) emptyRow(tbody, 7, "この条件にあうブレイクはありません");
    table.append(tbody);
    $("more").hidden = state.shown >= state.filtered.length;
  }

  // ---------- 描画: チャート共通 ----------

  function niceTicks(min, max, targetCount) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [];
    const roughStep = (max - min) / targetCount;
    const mag = Math.pow(10, Math.floor(Math.log10(roughStep)));
    const norm = roughStep / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) ticks.push(Math.round(v * 100) / 100);
    return ticks;
  }
  // 対数目盛り用: 1・2・5 × 10^k のうち範囲内のもの
  function logTicks(min, max) {
    const ticks = [];
    for (let k = Math.floor(Math.log10(min)); k <= Math.ceil(Math.log10(max)); k++) {
      for (const m of [1, 2, 5]) {
        const v = m * Math.pow(10, k);
        if (v >= min && v <= max) ticks.push(v);
      }
    }
    return ticks.length > 8 ? ticks.filter((v) => String(v)[0] === "1") : ticks;
  }

  function svgEl(tag, attrs) {
    const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }

  // box にチャートを描き、ホバー時に tooltipFor(i) を呼ぶ共通の枠組み
  // xs: 0〜1 の横位置、ys: 0〜1 の縦位置(上が0)
  function mountChart(box, { paths, hLines, xLabels, dots, hoverXs, hoverYs, tooltipFor }) {
    box.textContent = "";
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" });
    for (const { y, cls } of hLines) svg.append(svgEl("line", { x1: 0, x2: W, y1: y * H, y2: y * H, class: cls }));
    for (const p of paths) svg.append(p);
    box.append(svg);
    for (const { y, text } of hLines) {
      if (!text) continue;
      const lab = el("span", "tick-label", text);
      lab.style.top = `${y * 100}%`;
      box.append(lab);
    }
    xLabels.forEach(({ x, text }, i) => {
      const lab = el("span", i === 0 && x < 0.05 ? "x-label first" : "x-label", text);
      lab.style.left = `${x * 100}%`;
      box.append(lab);
    });
    for (const { x, y } of dots) {
      const d = el("span", "event-dot");
      d.style.left = `${x * 100}%`;
      d.style.top = `${y * 100}%`;
      box.append(d);
    }

    const cross = el("div", "crosshair");
    const dot = el("div", "dot");
    const tip = el("div", "tooltip");
    [cross, dot, tip].forEach((n) => (n.hidden = true));
    box.append(cross, dot, tip);

    function show(clientX) {
      const rect = box.getBoundingClientRect();
      const fx = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      let best = -1;
      let bestDist = Infinity;
      hoverXs.forEach((x, i) => {
        if (hoverYs[i] == null) return;
        const d = Math.abs(x - fx);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
      if (best < 0) return;
      const x = hoverXs[best];
      cross.style.left = `${x * 100}%`;
      dot.style.left = `${x * 100}%`;
      dot.style.top = `${hoverYs[best] * 100}%`;
      tip.style.left = `${x * 100}%`;
      tip.textContent = tooltipFor(best);
      tip.classList.toggle("edge-left", x < 0.15);
      tip.classList.toggle("edge-right", x > 0.85);
      [cross, dot, tip].forEach((n) => (n.hidden = false));
    }
    function hide() {
      [cross, dot, tip].forEach((n) => (n.hidden = true));
    }
    box.onpointermove = (ev) => show(ev.clientX);
    box.onpointerdown = (ev) => show(ev.clientX);
    box.onpointerleave = hide;
  }

  function linePath(xs, ys) {
    let d = "";
    let pen = false;
    xs.forEach((x, i) => {
      if (ys[i] == null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${(x * W).toFixed(1)},${(ys[i] * H).toFixed(1)}`;
      pen = true;
    });
    return d;
  }

  // ---------- 描画: ブレイク前後の平均的な値動き ----------

  function offsetLabel(off) {
    if (off === 0) return "ブレイク日";
    const a = Math.abs(off);
    const t = a >= 250 ? "1年" : a >= 21 ? `${Math.round(a / 21)}ヶ月` : `${a}営業日`;
    return off < 0 ? `${t}前` : `${t}後`;
  }

  function renderPath() {
    const kind = state.pathKind;
    $("path-note").textContent = PATH_NOTES[kind];
    const offs = state.data.path_offsets;
    const last = offs.length - 1;
    const evs = state.filtered.filter((e) => e[kind][last] != null && e[kind][0] != null);
    const q = offs.map((_, i) => {
      const v = evs.map((e) => e[kind][i]).filter((x) => x != null).map((x) => x / 10).sort((a, b) => a - b);
      return { lo: quantile(v, 0.25), mid: quantile(v, 0.5), hi: quantile(v, 0.75), n: v.length };
    });
    const box = $("path-chart");
    if (!evs.length) {
      box.textContent = "";
      box.append(el("p", "empty", "1年後まで値がそろっているブレイクがありません"));
      return;
    }
    let min = Math.min(100, ...q.map((d) => d.lo));
    let max = Math.max(100, ...q.map((d) => d.hi));
    const pad = (max - min) * 0.08 || 1;
    min -= pad;
    max += pad;
    const toY = (v) => (v == null ? null : (PAD_Y + ((max - v) / (max - min)) * (H - 2 * PAD_Y)) / H);
    const x0 = offs[0];
    const xs = offs.map((o) => (o - x0) / (offs[last] - x0));

    const band = svgEl("path", {
      class: "chart-band",
      d:
        xs.map((x, i) => `${i ? "L" : "M"}${(x * W).toFixed(1)},${(toY(q[i].hi) * H).toFixed(1)}`).join("") +
        xs.map((x, i) => i).reverse().map((i) => `L${(xs[i] * W).toFixed(1)},${(toY(q[i].lo) * H).toFixed(1)}`).join("") +
        "Z",
    });
    const mids = q.map((d) => toY(d.mid));
    const line = svgEl("path", { class: "chart-line", d: linePath(xs, mids) });
    const zeroX = xs[offs.indexOf(0)];
    const vline = svgEl("line", { x1: zeroX * W, x2: zeroX * W, y1: 0, y2: H, class: "base-line" });

    const hLines = niceTicks(min, max, 5).map((v) => ({ y: toY(v), cls: v === 100 ? "base-line" : "grid-line", text: numFmt.format(v) }));
    if (!hLines.some((h) => h.cls === "base-line")) hLines.push({ y: toY(100), cls: "base-line", text: "" });
    const labelOffs = [-60, 0, 60, 120, 250];
    const xLabels = labelOffs.filter((o) => offs.includes(o)).map((o) => ({ x: xs[offs.indexOf(o)], text: offsetLabel(o) }));

    mountChart(box, {
      paths: [band, vline, line],
      hLines,
      xLabels,
      dots: [],
      hoverXs: xs,
      hoverYs: mids,
      tooltipFor: (i) => {
        const d = q[i];
        const f = (v) => numFmt.format(Math.round(v * 10) / 10);
        return `${offsetLabel(offs[i])}\n中央値 ${f(d.mid)}(25〜75%: ${f(d.lo)}〜${f(d.hi)})\n${d.n}件`;
      },
    });
  }

  // ---------- 描画: 銘柄チャート ----------

  const dialog = $("stock-dialog");
  $("dialog-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (ev) => {
    if (ev.target === dialog) dialog.close();
  });

  async function openStock(code) {
    const s = state.stockMap.get(code);
    $("dialog-title").textContent = `${s ? s.name : ""} ${code}`;
    const sub = $("dialog-sub");
    sub.textContent = s
      ? `最高値 ${priceFmt(s.ath)}(${dateFmt(s.ath_date)}) ・ 直近 ${priceFmt(s.last)}(最高値から ${pctText(s.from_ath)}) ・ データ開始 ${dateFmt(s.first_date)} ・ `
      : "";
    const a = el("a", null, "Yahoo!ファイナンス");
    a.href = YAHOO_URL(code);
    a.target = "_blank";
    a.rel = "noopener";
    sub.append(a);
    const box = $("stock-chart");
    box.textContent = "";
    box.append(el("p", "empty", "読み込み中..."));
    renderStockEvents(code);
    renderSales(s);
    if (!dialog.open) dialog.showModal();
    try {
      const res = await fetch(STOCK_URL(code));
      if (!res.ok) throw new Error(res.status);
      drawStock(box, await res.json());
    } catch (err) {
      console.error(err);
      box.textContent = "";
      box.append(el("p", "empty", "チャートを読み込めませんでした"));
    }
  }

  function drawStock(box, d) {
    const vals = d.weekly;
    const start = new Date(`${d.start}T00:00:00Z`).getTime();
    const weekDate = (i) => new Date(start + i * 7 * 864e5).toISOString().slice(0, 10);
    const present = vals.filter((v) => v != null && v > 0);
    const min = Math.min(...present) * 0.9;
    const max = Math.max(...present) * 1.1;
    const lmin = Math.log(min);
    const lmax = Math.log(max);
    // 長い期間を見るので縦軸は対数(同じ上昇率が同じ高さになる)
    const toY = (v) => (v == null || v <= 0 ? null : (PAD_Y + ((lmax - Math.log(v)) / (lmax - lmin)) * (H - 2 * PAD_Y)) / H);
    const n = vals.length;
    const xs = vals.map((_, i) => (n > 1 ? i / (n - 1) : 0));
    const ys = vals.map(toY);
    const line = svgEl("path", { class: "chart-line", d: linePath(xs, ys) });

    const hLines = logTicks(min, max).map((v) => ({ y: toY(v), cls: "grid-line", text: numFmt.format(v) }));
    const xLabels = [];
    const firstYear = Number(d.start.slice(0, 4));
    const lastYear = Number(weekDate(n - 1).slice(0, 4));
    const step = Math.max(1, Math.ceil((lastYear - firstYear) / 6));
    for (let y = firstYear + 1; y <= lastYear; y += step) {
      const i = Math.ceil((Date.UTC(y, 0, 1) - start) / (7 * 864e5));
      if (i > 0 && i < n) xLabels.push({ x: xs[i], text: String(y) });
    }
    const dots = (d.events || [])
      .map((date) => Math.ceil((new Date(`${date}T00:00:00Z`).getTime() - start) / (7 * 864e5)))
      .filter((i) => i >= 0 && i < n && ys[i] != null)
      .map((i) => ({ x: xs[i], y: ys[i] }));

    mountChart(box, {
      paths: [line],
      hLines,
      xLabels,
      dots,
      hoverXs: xs,
      hoverYs: ys,
      tooltipFor: (i) => `${dateFmt(weekDate(i))}の週\n${priceFmt(vals[i])}`,
    });
  }

  const okuText = (v) => {
    const oku = v / 1e8;
    return oku >= 10000 ? `${numFmt.format(Math.round(oku / 1000) / 10)}兆円` : `${Math.round(oku).toLocaleString("ja-JP")}億円`;
  };
  function renderSales(s) {
    const table = $("stock-sales");
    table.textContent = "";
    const annual = s?.sales?.annual || [];
    $("stock-sales-wrap").hidden = !annual.length;
    if (!annual.length) return;
    table.append(headRow(["決算期", "売上高", "前年比"]));
    const tbody = el("tbody");
    annual.forEach(([period, v], i) => {
      const tr = el("tr");
      const prev = i > 0 ? annual[i - 1][1] : null;
      tr.append(el("td", null, `${period.slice(0, 4)}年${Number(period.slice(5, 7))}月期`), el("td", null, okuText(v)), pctCell(prev ? v / prev - 1 : null));
      tbody.prepend(tr);
    });
    table.append(tbody);
  }

  function renderStockEvents(code) {
    const table = $("stock-events");
    table.textContent = "";
    const hs = state.data.horizons;
    const i3m = hs.indexOf(60);
    const i1y = hs.indexOf(250);
    table.append(headRow(["ブレイク日", "前回の最高値から", "3ヶ月後", "1年後", "1年後のTOPIX比", "1年以内の最大下落"]));
    const tbody = el("tbody");
    const evs = state.data.events.filter((e) => e.code === code).reverse();
    for (const e of evs) {
      const tr = el("tr");
      tr.append(el("td", null, dateFmt(e.date)), el("td", null, gapText(e.gap)));
      tr.append(pctCell(e.ret[i3m]), pctCell(e.ret[i1y]), pctCell(e.exc[i1y]), pctCell(e.mdd));
      tbody.append(tr);
    }
    if (!evs.length) emptyRow(tbody, 6, "ブレイクはありません");
    table.append(tbody);
  }

  // ---------- 操作 ----------

  function renderToggle(container, options, getKey, setKey) {
    container.textContent = "";
    for (const opt of options) {
      const btn = el("button", "toggle-btn", opt.label);
      btn.type = "button";
      const active = getKey() === opt.key;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
      btn.addEventListener("click", () => {
        setKey(opt.key);
        renderToggle(container, options, getKey, setKey);
      });
      container.append(btn);
    }
  }

  function renderAll() {
    applyFilter();
    renderTiles();
    renderStats();
    renderPath();
    renderRecent();
    renderRating();
    renderEvents();
  }

  function setupControls() {
    renderToggle($("gap-toggle"), GAP_OPTIONS, () => state.gap, (k) => ((state.gap = k), renderAll()));
    renderToggle($("era-toggle"), ERA_OPTIONS, () => state.era, (k) => ((state.era = k), renderAll()));
    renderToggle($("size-toggle"), SIZE_OPTIONS, () => state.size, (k) => ((state.size = k), renderAll()));
    renderToggle($("path-toggle"), PATH_OPTIONS, () => state.pathKind, (k) => ((state.pathKind = k), renderPath()));
    $("more").addEventListener("click", () => {
      state.shown += PAGE;
      renderEvents();
    });
  }

  async function init() {
    try {
      const res = await fetch(DATA_URL, { cache: "no-cache" });
      if (!res.ok) throw new Error(res.status);
      state.data = await res.json();
      // 自社株買いのデータは無くても一覧は出す
      state.buyback = await fetch(BUYBACK_URL, { cache: "no-cache" })
        .then((r) => (r.ok ? r.json() : {}))
        .then((b) => b.dates || {})
        .catch(() => ({}));
    } catch (err) {
      console.error(err);
      statusEl.textContent = "データを読み込めませんでした。初回はデータの自動作成が終わるまでお待ちください。";
      statusEl.classList.add("error");
      return;
    }
    const d = state.data;
    [...d.stocks].sort((a, b) => b.market_cap - a.market_cap).forEach((s, i) => {
      state.stockMap.set(s.code, s);
      state.rankMap.set(s.code, i + 1);
    });
    statusEl.textContent = `${d.stocks.length}銘柄 ・ ブレイク ${d.events.length.toLocaleString("ja-JP")}件 ・ データ更新: ${d.generated_at.replace("T", " ")}`;
    setupControls();
    renderAll();
    mainEl.hidden = false;
  }

  init();
})();
