(() => {
  "use strict";

  const DATA_BASE = "https://git-san-934.github.io/tse-price-db/data/";
  const BATCH_SIZE = 6;
  const MAX_RENDERED = 60; // 古いカードを間引いてDOMを軽く保つ
  const PRUNE_TO = 40;

  const statusEl = document.getElementById("status");
  const filterEl = document.getElementById("filter");
  const feedEl = document.getElementById("feed");
  const sentinelEl = document.getElementById("sentinel");
  const endMessageEl = document.getElementById("end-message");

  const state = {
    allItems: [],
    items: [], // 現在表示対象の配列(絞り込み適用後)
    cursor: 0,
    renderedCards: [], // { el, code } を先頭が古い順に保持
    historyCache: new Map(),
  };

  const yenFmt = (v) => (v == null ? "—" : `${new Intl.NumberFormat("ja-JP").format(v)}円`);

  function badgeClass(judgment) {
    if (judgment === "高値圏") return "badge-high";
    if (judgment === "安値圏") return "badge-low";
    return "badge-neutral";
  }

  async function fetchHistoryWeekly(code) {
    if (state.historyCache.has(code)) return state.historyCache.get(code);
    const url = `${DATA_BASE}history_weekly/${encodeURIComponent(code)}.json`;
    try {
      const res = await fetch(url, { cache: "force-cache" });
      const rows = res.ok ? await res.json() : [];
      state.historyCache.set(code, rows);
      return rows;
    } catch (err) {
      console.error(err);
      return [];
    }
  }

  function buildChartSvg(rows) {
    const w = 640;
    const h = 200;
    const padTop = 10;
    const padBottom = 10;
    const values = rows.map((r) => r.close).filter((v) => v != null);
    if (values.length < 2) return null;

    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const x = (i) => (rows.length <= 1 ? w / 2 : (i / (rows.length - 1)) * w);
    const y = (v) => padTop + (1 - (v - min) / range) * (h - padTop - padBottom);

    let d = "";
    let started = false;
    rows.forEach((r, i) => {
      if (r.close == null) {
        started = false;
        return;
      }
      d += `${started ? "L" : "M"}${x(i).toFixed(1)},${y(r.close).toFixed(1)} `;
      started = true;
    });

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.classList.add("chart");
    svg.innerHTML = `<path d="${d.trim()}" fill="none" stroke="var(--accent)" stroke-width="1.8" />`;
    return svg;
  }

  function buildCard(item) {
    const card = document.createElement("article");
    card.className = "card";
    card.dataset.code = item.code;

    const head = document.createElement("div");
    head.className = "card-head";
    head.innerHTML = `
      <span class="card-title">${item.name || "(銘柄名不明)"}<span class="card-code">${item.code}</span></span>
      <span class="badge ${badgeClass(item.judgment)}">${item.judgment || "—"}</span>
    `;
    card.appendChild(head);

    const meta = document.createElement("div");
    meta.className = "card-price";
    meta.textContent = `${item.market || ""}${item.market ? " ・ " : ""}直近終値 ${yenFmt(item.close)}${item.date ? `(${item.date})` : ""}`;
    card.appendChild(meta);

    const chartWrap = document.createElement("div");
    chartWrap.className = "chart-wrap";
    const loading = document.createElement("div");
    loading.className = "chart-loading";
    loading.textContent = "チャート読み込み中...";
    chartWrap.appendChild(loading);
    card.appendChild(chartWrap);

    fetchHistoryWeekly(item.code).then((rows) => {
      const svg = buildChartSvg(rows);
      chartWrap.innerHTML = "";
      if (svg) {
        chartWrap.appendChild(svg);
      } else {
        const empty = document.createElement("div");
        empty.className = "chart-empty";
        empty.textContent = "5年チャートのデータがありません";
        chartWrap.appendChild(empty);
      }
    });

    return card;
  }

  function pruneIfNeeded() {
    if (state.renderedCards.length <= MAX_RENDERED) return;
    const removeCount = state.renderedCards.length - PRUNE_TO;
    const toRemove = state.renderedCards.splice(0, removeCount);
    toRemove.forEach(({ el }) => el.remove());
  }

  function renderNextBatch() {
    if (state.cursor >= state.items.length) {
      endMessageEl.hidden = state.items.length === 0;
      return;
    }
    const slice = state.items.slice(state.cursor, state.cursor + BATCH_SIZE);
    slice.forEach((item) => {
      const card = buildCard(item);
      feedEl.appendChild(card);
      state.renderedCards.push({ el: card, code: item.code });
    });
    state.cursor += slice.length;
    endMessageEl.hidden = state.cursor < state.items.length;
    pruneIfNeeded();
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) renderNextBatch();
      });
    },
    { rootMargin: "800px 0px" }
  );
  observer.observe(sentinelEl);

  function resetFeed() {
    feedEl.innerHTML = "";
    state.renderedCards = [];
    state.cursor = 0;
    endMessageEl.hidden = true;
    renderNextBatch();
  }

  let filterTimer = null;
  filterEl.addEventListener("input", () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      const q = filterEl.value.trim().toLowerCase();
      state.items = q
        ? state.allItems.filter(
            (item) =>
              item.code.toLowerCase().includes(q) || (item.name || "").toLowerCase().includes(q)
          )
        : state.allItems;
      resetFeed();
    }, 200);
  });

  async function init() {
    try {
      const res = await fetch(`${DATA_BASE}latest.json`, { cache: "no-store" });
      const data = await res.json();
      state.allItems = data.items || [];
      state.items = state.allItems;
      statusEl.textContent = `${state.allItems.length.toLocaleString("ja-JP")}銘柄 ・ データ更新: ${data.updated_at || "不明"}`;
      renderNextBatch();
    } catch (err) {
      console.error(err);
      statusEl.textContent = "銘柄一覧の読み込みに失敗しました。時間をおいて再読み込みしてください。";
    }
  }

  init();
})();
