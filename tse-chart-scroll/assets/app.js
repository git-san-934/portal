(() => {
  "use strict";

  const DATA_BASE = "https://git-san-934.github.io/tse-price-db/data/";
  const BATCH_SIZE = 6;
  const MAX_RENDERED = 60; // 古いカードを間引いてDOMを軽く保つ
  const PRUNE_TO = 40;
  const SLIDE_INTERVAL_MS = 1000;
  const SWIPE_THRESHOLD_PX = 40;

  const SORT_OPTIONS = [
    { key: "market_cap", label: "時価総額" },
    { key: "close", label: "終値" },
    { key: "turnover", label: "売買代金" },
    { key: "pbr", label: "PBR" },
    { key: "per", label: "PER" },
    { key: "dividend_yield", label: "配当利回り" },
  ];
  const DEFAULT_SORT_KEY = "market_cap";

  const statusEl = document.getElementById("status");
  const filterEl = document.getElementById("filter");
  const sortToggleEl = document.getElementById("sort-toggle");
  const feedEl = document.getElementById("feed");
  const sentinelEl = document.getElementById("sentinel");
  const endMessageEl = document.getElementById("end-message");
  const normalViewEl = document.getElementById("normal-view");
  const footerEl = document.getElementById("footer");
  const slideshowEl = document.getElementById("slideshow");
  const slideshowEnterBtn = document.getElementById("slideshow-enter");
  const slideshowExitBtn = document.getElementById("slideshow-exit");
  const slideCardWrapEl = document.getElementById("slide-card-wrap");
  const slidePositionEl = document.getElementById("slide-position");
  const slidePrevBtn = document.getElementById("slide-prev");
  const slideNextBtn = document.getElementById("slide-next");
  const slidePlayBtn = document.getElementById("slide-play");

  const state = {
    allItems: [],
    items: [], // 現在表示対象の配列(絞り込み・並び替え適用後)
    sortKey: DEFAULT_SORT_KEY,
    sortDir: "desc",
    cursor: 0,
    renderedCards: [], // { el, code } を先頭が古い順に保持
    historyCache: new Map(),
    slideIndex: 0,
    slidePlaying: true,
    slideTimer: null,
  };

  const yenFmt = (v) => (v == null ? "—" : `${new Intl.NumberFormat("ja-JP").format(v)}円`);
  const numberFmt = (v) => (v == null ? "—" : new Intl.NumberFormat("ja-JP").format(v));
  const okuFmt = (v) =>
    v == null ? "—" : `${Math.floor(v / 1e8).toLocaleString("ja-JP")}億円`;
  const ratioFmt = (v) =>
    v == null ? "—" : `${v.toLocaleString("ja-JP", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}倍`;
  const pctFmt = (v) =>
    v == null ? "—" : `${v.toLocaleString("ja-JP", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;

  const SORT_VALUE_FMT = {
    market_cap: okuFmt,
    close: yenFmt,
    turnover: numberFmt,
    pbr: ratioFmt,
    per: ratioFmt,
    dividend_yield: pctFmt,
  };

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

    const metaParts = [item.market, item.date ? `${item.date}時点` : null].filter(Boolean);
    if (metaParts.length) {
      const meta = document.createElement("div");
      meta.className = "card-price";
      meta.textContent = metaParts.join(" ・ ");
      card.appendChild(meta);
    }

    const metrics = document.createElement("div");
    metrics.className = "card-metrics";
    metrics.innerHTML = SORT_OPTIONS.map((opt) => {
      const activeClass = opt.key === state.sortKey ? " metric-active" : "";
      return `
        <div class="metric${activeClass}">
          <span class="metric-label">${opt.label}</span>
          <span class="metric-value">${SORT_VALUE_FMT[opt.key](item[opt.key])}</span>
        </div>
      `;
    }).join("");
    card.appendChild(metrics);

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

  function sortItems(items, key, dir) {
    const mul = dir === "asc" ? 1 : -1;
    return [...items].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // 値なしは順序に関わらず末尾へ
      if (bv == null) return -1;
      return mul * (av - bv);
    });
  }

  function applyFilterAndSort() {
    const q = filterEl.value.trim().toLowerCase();
    const filtered = q
      ? state.allItems.filter(
          (item) =>
            item.code.toLowerCase().includes(q) || (item.name || "").toLowerCase().includes(q)
        )
      : state.allItems;
    state.items = sortItems(filtered, state.sortKey, state.sortDir);
    resetFeed();
  }

  function renderSortToggle() {
    sortToggleEl.innerHTML = "";
    SORT_OPTIONS.forEach((opt) => {
      const isActive = opt.key === state.sortKey;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `sort-btn${isActive ? " active" : ""}`;
      btn.textContent = isActive ? `${opt.label} ${state.sortDir === "asc" ? "▲" : "▼"}` : opt.label;
      btn.addEventListener("click", () => {
        if (state.sortKey === opt.key) {
          state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        } else {
          state.sortKey = opt.key;
          state.sortDir = "desc";
        }
        renderSortToggle();
        applyFilterAndSort();
      });
      sortToggleEl.appendChild(btn);
    });
  }

  let filterTimer = null;
  filterEl.addEventListener("input", () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(applyFilterAndSort, 200);
  });

  function updatePlayButton() {
    slidePlayBtn.textContent = state.slidePlaying ? "⏸" : "▶";
    slidePlayBtn.setAttribute("aria-label", state.slidePlaying ? "一時停止" : "自動再生");
  }

  function stopSlideTimer() {
    if (state.slideTimer) {
      clearInterval(state.slideTimer);
      state.slideTimer = null;
    }
  }

  function startSlideTimer() {
    stopSlideTimer();
    if (!state.slidePlaying) return;
    state.slideTimer = setInterval(() => goToSlide(state.slideIndex + 1), SLIDE_INTERVAL_MS);
  }

  function renderSlide() {
    const item = state.items[state.slideIndex];
    slideCardWrapEl.innerHTML = "";
    if (item) slideCardWrapEl.appendChild(buildCard(item));
    slidePositionEl.textContent = state.items.length
      ? `${state.slideIndex + 1} / ${state.items.length.toLocaleString("ja-JP")}`
      : "";
  }

  function goToSlide(index) {
    if (!state.items.length) return;
    const len = state.items.length;
    state.slideIndex = ((index % len) + len) % len; // 前後どちらへもループ
    renderSlide();
  }

  function pauseAndGoToSlide(index) {
    state.slidePlaying = false;
    stopSlideTimer();
    updatePlayButton();
    goToSlide(index);
  }

  function enterSlideshow() {
    if (!state.items.length) return;
    document.body.classList.add("slideshow-active");
    normalViewEl.hidden = true;
    footerEl.hidden = true;
    slideshowEl.hidden = false;
    state.slideIndex = 0;
    state.slidePlaying = true;
    updatePlayButton();
    renderSlide();
    startSlideTimer();
  }

  function exitSlideshow() {
    stopSlideTimer();
    document.body.classList.remove("slideshow-active");
    slideshowEl.hidden = true;
    normalViewEl.hidden = false;
    footerEl.hidden = false;
  }

  slideshowEnterBtn.addEventListener("click", enterSlideshow);
  slideshowExitBtn.addEventListener("click", exitSlideshow);
  slidePrevBtn.addEventListener("click", () => pauseAndGoToSlide(state.slideIndex - 1));
  slideNextBtn.addEventListener("click", () => pauseAndGoToSlide(state.slideIndex + 1));
  slidePlayBtn.addEventListener("click", () => {
    state.slidePlaying = !state.slidePlaying;
    updatePlayButton();
    if (state.slidePlaying) startSlideTimer();
    else stopSlideTimer();
  });

  document.addEventListener("keydown", (e) => {
    if (slideshowEl.hidden) return;
    if (e.key === "ArrowRight") pauseAndGoToSlide(state.slideIndex + 1);
    else if (e.key === "ArrowLeft") pauseAndGoToSlide(state.slideIndex - 1);
    else if (e.key === "Escape") exitSlideshow();
    else if (e.key === " ") {
      e.preventDefault();
      slidePlayBtn.click();
    }
  });

  let touchStartX = null;
  slideCardWrapEl.addEventListener(
    "touchstart",
    (e) => {
      touchStartX = e.changedTouches[0].clientX;
    },
    { passive: true }
  );
  slideCardWrapEl.addEventListener(
    "touchend",
    (e) => {
      if (touchStartX == null) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      touchStartX = null;
      if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return;
      if (dx < 0) pauseAndGoToSlide(state.slideIndex + 1);
      else pauseAndGoToSlide(state.slideIndex - 1);
    },
    { passive: true }
  );

  async function init() {
    try {
      const res = await fetch(`${DATA_BASE}latest.json`, { cache: "no-store" });
      const data = await res.json();
      state.allItems = data.items || [];
      statusEl.textContent = `${state.allItems.length.toLocaleString("ja-JP")}銘柄 ・ データ更新: ${data.updated_at || "不明"}`;
      renderSortToggle();
      state.items = sortItems(state.allItems, state.sortKey, state.sortDir);
      renderNextBatch();
    } catch (err) {
      console.error(err);
      statusEl.textContent = "銘柄一覧の読み込みに失敗しました。時間をおいて再読み込みしてください。";
    }
  }

  init();
})();
