(() => {
  const QUOTE = "https://finance.yahoo.co.jp/quote/";
  const state = { def: "f", max: 0.05, mkt: "all", q: "", sort: "fixed", desc: false, data: null };

  const DEFS = [["f", "浮動株割合"], ["b", "不動株割合（東証式）"], ["a", "特定株比率（四季報式）"]];
  const MAXES = [[0.05, "5%未満"], [0.1, "10%未満"], [0.2, "20%未満"], [Infinity, "すべて"]];
  const MKTS = [["all", "すべて"], ["プライム", "プライム"], ["スタンダード", "スタンダード"], ["グロース", "グロース"]];

  const pct = (v, d = 1) => (v == null ? "-" : (v * 100).toFixed(d) + "%");
  const yen = (v) => (v == null ? "-" : Math.round(v).toLocaleString("ja-JP"));
  const oku = (v) => (v == null ? "-" : (v / 100).toLocaleString("ja-JP", { maximumFractionDigits: v >= 10000 ? 0 : 1 }));
  const fixedOf = (r) => r[state.def];
  const defName = () => DEFS.find((x) => x[0] === state.def)[1];

  const COLS = [
    { key: "code", label: "コード", cls: "left", get: (r) => r.c, fmt: (r) => r.c },
    { key: "name", label: "銘柄名", cls: "left name", get: (r) => r.n,
      fmt: (r) => `<a href="${QUOTE}${encodeURIComponent(r.c)}.T" target="_blank" rel="noopener">${esc(r.n)}</a>` },
    { key: "mkt", label: "市場", cls: "left", get: (r) => r.m || "", fmt: (r) => esc((r.m || "").replace(/（.*）/, "")) },
    { key: "fixed", label: "割合", get: fixedOf, fmt: (r) => pct(fixedOf(r)), hit: true },
    { key: "bb", label: "大株主", get: (r) => r.bb, fmt: (r) => pct(r.bb) },
    { key: "bf", label: "投資信託等", get: (r) => r.bf, fmt: (r) => pct(r.bf) },
    { key: "bx", label: "外国人", get: (r) => r.bx, fmt: (r) => pct(r.bx) },
    { key: "bo", label: "その他", get: (r) => r.bo, fmt: (r) => pct(r.bo) },
    { key: "gm", label: "粗利率", get: (r) => r.g, fmt: (r) => pct(r.g) },
    { key: "cash", label: "保有現金(億円)", get: (r) => r.cash, fmt: (r) => oku(r.cash) },
    { key: "yield", label: "配当利回り", get: (r) => r.y, fmt: (r) => pct(r.y, 2) + (r.yc ? '<span class="warn" title="株式分割や特別配当で実際とずれている可能性があります">※</span>' : "") },
    { key: "dps", label: "1株配当(円)", get: (r) => r.d, fmt: (r) => (r.d == null ? "-" : r.d.toLocaleString("ja-JP")) },
    { key: "buy", label: "自社株買", cls: "left buy", get: (r) => r.bs * 1e15 + (r.ba || 0),
      fmt: (r) => (r.bs ? "実施" : r.ba >= 1 ? "単元未満等のみ" : "なし"), rowCls: (r) => (r.bs ? "yes" : "") },
    { key: "buyamt", label: "取得額(億円)", get: (r) => r.ba, fmt: (r) => (r.ba ? oku(r.ba) : "-") },
    { key: "trs", label: "自己株式", get: (r) => r.t, fmt: (r) => pct(r.t) },
    { key: "top1", label: "筆頭株主", cls: "left", get: (r) => r.top1 || "", fmt: (r) => esc(r.top1 || "") },
    { key: "fy", label: "決算期", cls: "left", get: (r) => r.fy || "", fmt: (r) => (r.fy || "").slice(0, 7) },
  ];

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function toggle(id, items, key) {
    const box = document.getElementById(id);
    box.innerHTML = "";
    for (const [val, label] of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "toggle-btn" + (state[key] === val ? " active" : "");
      b.textContent = label;
      b.setAttribute("aria-pressed", state[key] === val);
      b.onclick = () => { state[key] = val; toggle(id, items, key); render(); };
      box.appendChild(b);
    }
  }

  function render() {
    const rows = state.data.rows.filter((r) => {
      const f = fixedOf(r);
      if (state.max !== Infinity && !(f != null && f < state.max)) return false;
      if (state.mkt !== "all" && !(r.m || "").includes(state.mkt)) return false;
      if (state.q && !(r.c.includes(state.q) || r.n.includes(state.q))) return false;
      return true;
    });
    const col = COLS.find((c) => c.key === state.sort);
    const dir = state.desc ? -1 : 1;
    rows.sort((x, y) => {
      const a = col.get(x), b = col.get(y);
      if (a == null || a === "") return 1;
      if (b == null || b === "") return -1;
      return (typeof a === "string" ? a.localeCompare(b, "ja") : a - b) * dir;
    });

    const maxName = MAXES.find((m) => m[0] === state.max)[1];
    document.getElementById("list-title").textContent =
      state.max === Infinity ? "全銘柄" : `${defName()}${maxName}の銘柄`;
    document.getElementById("count").textContent = `${rows.length.toLocaleString("ja-JP")}社`;

    const head = COLS.map((c) => {
      const s = state.sort === c.key ? " sorted" + (state.desc ? " desc" : "") : "";
      const label = c.key === "fixed" ? defName() : c.label;
      return `<th class="${(c.cls || "").split(" ")[0]}${s}" data-key="${c.key}" aria-sort="${s ? (state.desc ? "descending" : "ascending") : "none"}">${label}</th>`;
    }).join("");
    const body = rows.length
      ? rows.map((r) => "<tr>" + COLS.map((c) => {
          const f = fixedOf(r);
          const hit = c.hit && f != null && f < 0.05 ? " hit" : "";
          const extra = c.rowCls ? " " + c.rowCls(r) : "";
          return `<td class="${c.cls || ""}${hit}${extra}">${c.fmt(r)}</td>`;
        }).join("") + "</tr>").join("")
      : `<tr><td class="empty" colspan="${COLS.length}">条件にあう銘柄はありません</td></tr>`;
    const table = document.getElementById("list");
    table.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
    table.querySelectorAll("thead th").forEach((th) => {
      th.onclick = () => {
        const k = th.dataset.key;
        if (state.sort === k) state.desc = !state.desc;
        else { state.sort = k; state.desc = ["bb", "bf", "bx", "bo", "gm", "cash", "yield", "dps", "buy", "buyamt", "trs"].includes(k); }
        render();
      };
    });
  }

  toggle("def-toggle", DEFS, "def");
  toggle("max-toggle", MAXES, "max");
  toggle("mkt-toggle", MKTS, "mkt");
  document.getElementById("q").addEventListener("input", (e) => { state.q = e.target.value.trim(); render(); });

  fetch("data/screen.json?v=" + Date.now())
    .then((r) => r.json())
    .then((d) => {
      state.data = d;
      document.getElementById("status").textContent =
        `データ: 有価証券報告書 ${d.fy_range}／株価 ${d.price_date} 時点（${d.rows.length.toLocaleString("ja-JP")}社、${d.updated} 更新）`;
      render();
    })
    .catch(() => {
      const s = document.getElementById("status");
      s.textContent = "データを読み込めませんでした。";
      s.classList.add("error");
    });
})();
