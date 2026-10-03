(() => {
  "use strict";

  const MEMBERS_URL = "data/sector_members.json";
  const PRICE_BASE = "https://git-san-934.github.io/tse-price-db/data/";
  const YAHOO_URL = (code) => `https://finance.yahoo.co.jp/quote/${encodeURIComponent(code)}.T`;
  const SPARK_CONCURRENCY = 6;

  // ETFコード → TOPIX-17業種コード(1615 東証銀行業は 17業種の「銀行」と同じ銘柄群)
  const ETF_TO_SECTOR = {
    1617: 1, 1618: 2, 1619: 3, 1620: 4, 1621: 5, 1622: 6, 1623: 7, 1624: 8, 1625: 9,
    1626: 10, 1627: 11, 1628: 12, 1629: 13, 1630: 14, 1631: 15, 1632: 16, 1633: 17, 1615: 15,
  };

  const MARKET_OPTIONS = [
    { key: "all", label: "すべて" },
    { key: "プライム", label: "プライム" },
    { key: "スタンダード", label: "スタンダード" },
    { key: "グロース", label: "グロース" },
  ];
  const SORT_OPTIONS = [
    { key: "market_cap", label: "時価総額" },
    { key: "close", label: "終値" },
    { key: "per", label: "PER" },
    { key: "pbr", label: "PBR" },
    { key: "dividend_yield", label: "配当利回り" },
    { key: "code", label: "コード" },
  ];

  const titleEl = document.getElementById("title");
  const introEl = document.getElementById("intro");
  const statusEl = document.getElementById("status");
  const s33GroupEl = document.getElementById("s33-group");
  const s33ToggleEl = document.getElementById("s33-toggle");
  const marketToggleEl = document.getElementById("market-toggle");
  const sortToggleEl = document.getElementById("sort-toggle");
  const filterEl = document.getElementById("filter");
  const countEl = document.getElementById("count");
  const listEl = document.getElementById("stock-list");
  const rowsEl = document.getElementById("rows");

  const state = {
    items: [],
    s33: "all",
    market: "all",
    sortKey: "market_cap",
    sortDir: "desc",
    query: "",
    sparkCache: new Map(),
    sparkQueue: [],
    sparkActive: 0,
  };

  const numFmt = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 });
  const yenFmt = (v) => (v == null ? "—" : `${numFmt.format(v)}円`);
  const capFmt = (v) => {
    if (v == null) return "—";
    if (v >= 1e12) return `${(v / 1e12).toLocaleString("ja-JP", { maximumFractionDigits: 1 })}兆円`;
    return `${Math.round(v / 1e8).toLocaleString("ja-JP")}億円`;
  };
  const ratioFmt = (v) => (v == null ? "—" : `${v.toLocaleString("ja-JP", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}倍`);
  const pctFmt = (v) => (v == null ? "—" : `${v.toLocaleString("ja-JP", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function badgeClass(judgment) {
    if (judgment === "高値圏") return "badge badge-high";
    if (judgment === "安値圏") return "badge badge-low";
    return "badge badge-neutral";
  }

  // ---------- 5年チャート(表示されたときに読み込む) ----------

  function drawSpark(holder, rows) {
    const values = rows.map((r) => r.close);
    const valid = values.filter((v) => v != null);
    holder.replaceChildren();
    if (valid.length < 2) {
      holder.appendChild(el("span", "spark-empty", "チャートなし"));
      return;
    }
    const min = Math.min(...valid);
    const max = Math.max(...valid);
    const range = max - min || 1;
    const W = 200;
    const H = 40;
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v == null) return;
      const x = (i / (values.length - 1)) * W;
      const y = 2 + (1 - (v - min) / range) * (H - 4);
      d += `${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
      pen = true;
    });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("class", "spark");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = `<path d="${d}" />`;
    holder.appendChild(svg);
  }

  function pumpSparks() {
    while (state.sparkActive < SPARK_CONCURRENCY && state.sparkQueue.length) {
      const { code5, holder } = state.sparkQueue.shift();
      if (!holder.isConnected) continue;
      state.sparkActive++;
      fetch(`${PRICE_BASE}history_weekly/${encodeURIComponent(code5)}.json`, { cache: "force-cache" })
        .then((res) => (res.ok ? res.json() : []))
        .catch(() => [])
        .then((rows) => {
          state.sparkCache.set(code5, rows);
          drawSpark(holder, rows);
        })
        .finally(() => {
          state.sparkActive--;
          pumpSparks();
        });
    }
  }

  const sparkObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const holder = entry.target;
        sparkObserver.unobserve(holder);
        const code5 = holder.dataset.code5;
        if (state.sparkCache.has(code5)) drawSpark(holder, state.sparkCache.get(code5));
        else {
          state.sparkQueue.push({ code5, holder });
          pumpSparks();
        }
      }
    },
    { rootMargin: "300px 0px" }
  );

  // ---------- 一覧 ----------

  function buildRow(it) {
    const row = el("div", "stock-row");

    const name = el("div", "s-name");
    const link = el("a", null, it.name);
    link.href = YAHOO_URL(it.code);
    link.target = "_blank";
    link.rel = "noopener";
    name.appendChild(link);
    const meta = [it.code, it.market, it.s33, it.size || "TOPIX外"].filter(Boolean).join(" · ");
    name.appendChild(el("div", "s-meta", meta));

    const chart = el("div", "s-chart");
    chart.dataset.code5 = it.code5;
    chart.appendChild(el("span", "spark-empty", "…"));
    sparkObserver.observe(chart);

    const judge = el("div", "s-judge");
    if (it.judgment) judge.appendChild(el("span", badgeClass(it.judgment), it.judgment));

    const mobile = el("div", "s-nums-mobile");
    for (const [label, text] of [
      ["時価総額", capFmt(it.market_cap)],
      ["PER", ratioFmt(it.per)],
      ["PBR", ratioFmt(it.pbr)],
      ["利回り", pctFmt(it.dividend_yield)],
    ]) {
      const span = el("span");
      span.append(el("span", "s-label", label), text);
      mobile.appendChild(span);
    }
    if (it.judgment) mobile.appendChild(el("span", badgeClass(it.judgment), it.judgment));

    row.append(
      name,
      chart,
      el("div", "s-num s-close", yenFmt(it.close)),
      el("div", "s-num s-cap", capFmt(it.market_cap)),
      el("div", "s-num s-per", ratioFmt(it.per)),
      el("div", "s-num s-pbr", ratioFmt(it.pbr)),
      el("div", "s-num s-yield", pctFmt(it.dividend_yield)),
      judge,
      mobile
    );
    return row;
  }

  function visibleItems() {
    const q = state.query.trim().toLowerCase();
    const list = state.items.filter(
      (it) =>
        (state.s33 === "all" || it.s33 === state.s33) &&
        (state.market === "all" || (it.market || "").startsWith(state.market)) &&
        (!q || it.code.toLowerCase().includes(q) || it.name.toLowerCase().includes(q))
    );
    const k = state.sortKey;
    const sign = state.sortDir === "desc" ? -1 : 1;
    return list.sort((a, b) => {
      if (k === "code") return sign * a.code.localeCompare(b.code);
      if (a[k] == null) return b[k] == null ? 0 : 1; // 値なしは常に末尾
      if (b[k] == null) return -1;
      return sign * (a[k] - b[k]);
    });
  }

  function renderList() {
    const items = visibleItems();
    state.sparkQueue = [];
    rowsEl.replaceChildren(...items.map(buildRow));
    countEl.textContent = `${items.length}銘柄を表示中(全${state.items.length}銘柄)`;
  }

  function toggleGroup(container, options, current, onPick, arrowFor) {
    container.replaceChildren(
      ...options.map((opt) => {
        const active = opt.key === current;
        const btn = el("button", `toggle-btn${active ? " active" : ""}`, opt.label + (arrowFor ? arrowFor(opt, active) : ""));
        btn.type = "button";
        btn.setAttribute("aria-pressed", String(active));
        btn.addEventListener("click", () => onPick(opt));
        return btn;
      })
    );
  }

  function renderControls(s33Options) {
    if (s33Options.length > 2) {
      s33GroupEl.hidden = false;
      toggleGroup(s33ToggleEl, s33Options, state.s33, (opt) => {
        state.s33 = opt.key;
        renderControls(s33Options);
        renderList();
      });
    }
    toggleGroup(marketToggleEl, MARKET_OPTIONS, state.market, (opt) => {
      state.market = opt.key;
      renderControls(s33Options);
      renderList();
    });
    toggleGroup(
      sortToggleEl,
      SORT_OPTIONS,
      state.sortKey,
      (opt) => {
        if (state.sortKey === opt.key) state.sortDir = state.sortDir === "desc" ? "asc" : "desc";
        else {
          state.sortKey = opt.key;
          state.sortDir = opt.key === "code" ? "asc" : "desc";
        }
        renderControls(s33Options);
        renderList();
      },
      (opt, active) => (active ? (state.sortDir === "desc" ? " ↓" : " ↑") : "")
    );
  }

  async function load() {
    const etfCode = Number(new URLSearchParams(location.search).get("code"));
    const s17 = ETF_TO_SECTOR[etfCode];
    if (!s17) {
      statusEl.textContent = "業種が指定されていません。業種別ETFチャート一覧から業種を選んでください。";
      statusEl.classList.add("error");
      return;
    }

    try {
      const [members, latest] = await Promise.all([
        fetch(MEMBERS_URL, { cache: "no-cache" }).then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        }),
        // 株価が読めなくても一覧は出す
        fetch(`${PRICE_BASE}latest.json`, { cache: "no-cache" })
          .then((res) => (res.ok ? res.json() : null))
          .catch(() => null),
      ]);

      const sector = members.sectors[String(s17)];
      const label = etfCode === 1615 ? "銀行業(東証)" : sector.name;
      document.title = `${label}の個別銘柄一覧`;
      titleEl.textContent = `${label}の個別銘柄`;
      introEl.textContent = `ETF ${etfCode} と同じ業種(TOPIX-17「${sector.name}」)に分類される東証上場銘柄です。銘柄名を押すと Yahoo!ファイナンスが開きます。`;

      const priceByCode = new Map((latest?.items || []).map((p) => [p.code, p]));
      state.items = sector.stocks.map((s) => {
        const code5 = `${s.c}0`; // 東証株価データベースは5桁コード(末尾0)
        const p = priceByCode.get(code5) || {};
        return {
          code: s.c,
          code5,
          name: s.n,
          market: s.m,
          s33: s.s33,
          size: s.sz,
          close: p.close ?? null,
          market_cap: p.market_cap ?? null,
          per: p.per ?? null,
          pbr: p.pbr ?? null,
          dividend_yield: p.dividend_yield ?? null,
          judgment: p.judgment ?? null,
        };
      });

      const asOf = members.as_of ? members.as_of.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1/$2/$3") : "—";
      const priceDate = latest?.updated_at ? latest.updated_at.slice(0, 10).replace(/-/g, "/") : null;
      statusEl.textContent = `業種分類: ${asOf} 時点 / 株価: ${priceDate ? `${priceDate} 更新` : "読み込めませんでした"}`;

      const s33Names = [...new Set(state.items.map((it) => it.s33).filter(Boolean))];
      const s33Options = [{ key: "all", label: "すべて" }, ...s33Names.map((n) => ({ key: n, label: n }))];
      renderControls(s33Options);
      listEl.hidden = false;
      renderList();

      filterEl.addEventListener("input", () => {
        state.query = filterEl.value;
        renderList();
      });
    } catch (err) {
      console.error(err);
      statusEl.textContent =
        "銘柄一覧を読み込めませんでした。まだデータが作られていない場合は、GitHub の Actions タブで「業種別ETFデータ更新」を実行してください。";
      statusEl.classList.add("error");
    }
  }

  load();
})();
