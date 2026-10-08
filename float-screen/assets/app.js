(() => {
  const QUOTE = "https://finance.yahoo.co.jp/quote/";
  const state = { def: "f", max: 0.05, mkt: "all", q: "", sort: "fixed", desc: false, data: null };

  const DEFS = [["f", "浮動株割合"], ["b", "不動株割合（東証式）"], ["a", "特定株比率（四季報式）"]];
  const MAXES = [[0.05, "5%未満"], [0.1, "10%未満"], [0.2, "20%未満"], [Infinity, "すべて"]];
  const MKTS = [["all", "すべて"], ["プライム", "プライム"], ["スタンダード", "スタンダード"], ["グロース", "グロース"]];

  const pct = (v, d = 1) => (v == null ? "-" : (v * 100).toFixed(d) + "%");
  const yen = (v) => (v == null ? "-" : Math.round(v).toLocaleString("ja-JP"));
  const oku = (v) => (v == null ? "-" : (v / 100).toLocaleString("ja-JP", { maximumFractionDigits: v >= 10000 ? 0 : 1 }));
  const num = (v, d = 1) => (v == null ? "-" : v.toLocaleString("ja-JP", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const sgn = (v) => (v == null ? "-" : (v > 0 ? "+" : "") + (v * 100).toFixed(1) + "%");
  const mark = (v, yes, no = "-") => (v == null ? "-" : v ? yes : no);
  const txt = (t) => (t ? `<span title="${esc(t)}">${esc(t.length > 40 ? t.slice(0, 40) + "…" : t)}</span>` : "-");
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
    { key: "om", label: "営業利益率", get: (r) => r.om, fmt: (r) => pct(r.om) },
    { key: "cash", label: "保有現金(億円)", get: (r) => r.cash, fmt: (r) => oku(r.cash) },
    { key: "mc", label: "時価総額(億円)", get: (r) => r.mc, fmt: (r) => oku(r.mc) },
    { key: "pe", label: "PER(倍)", get: (r) => r.pe, fmt: (r) => num(r.pe) },
    { key: "pb", label: "PBR(倍)", get: (r) => r.pb, fmt: (r) => num(r.pb, 2) },
    { key: "roe", label: "ROE", get: (r) => r.roe, fmt: (r) => pct(r.roe) },
    { key: "er", label: "自己資本比率", get: (r) => r.er, fmt: (r) => pct(r.er) },
    { key: "cm", label: "現金÷時価総額", get: (r) => r.cm, fmt: (r) => pct(r.cm, 0) },
    { key: "nc", label: "ネットキャッシュ÷時価総額", get: (r) => r.nc, fmt: (r) => pct(r.nc, 0) },
    { key: "sg", label: "売上の伸び", get: (r) => r.sg, fmt: (r) => sgn(r.sg) },
    { key: "og", label: "営業利益の伸び", get: (r) => r.og, fmt: (r) => sgn(r.og) },
    { key: "oc", label: "営業CF(億円)", get: (r) => r.oc, fmt: (r) => oku(r.oc) },
    { key: "ic", label: "投資CF(億円)", get: (r) => r.ic, fmt: (r) => oku(r.ic) },
    { key: "fc", label: "フリーCF(億円)", get: (r) => r.fc, fmt: (r) => oku(r.fc) },
    { key: "cx", label: "設備投資(億円)", get: (r) => r.cx, fmt: (r) => oku(r.cx) },
    { key: "cxs", label: "設備投資÷売上", get: (r) => r.cxs, fmt: (r) => pct(r.cxs) },
    { key: "cxd", label: "設備投資÷減価償却", get: (r) => r.cxd, fmt: (r) => num(r.cxd, 2) },
    { key: "ma", label: "M&A(億円)", get: (r) => r.ma, fmt: (r) => oku(r.ma) },
    { key: "sp", label: "投資有価証券の取得(億円)", get: (r) => r.sp, fmt: (r) => oku(r.sp) },
    { key: "ct", label: "当期の設備投資の内容", cls: "left text", get: (r) => r.ct || "", fmt: (r) => txt(r.ct) },
    { key: "pl", label: "新設計画", cls: "left", get: (r) => r.pl, fmt: (r) => mark(r.pl, "あり", "なし"), rowCls: (r) => (r.pl ? "yes" : "") },
    { key: "pa2", label: "計画額(億円)", get: (r) => r.pa2, fmt: (r) => oku(r.pa2) },
    { key: "pt", label: "今後の設備投資計画", cls: "left text", get: (r) => r.pt || "", fmt: (r) => txt(r.pt) },
    { key: "yield", label: "配当利回り", get: (r) => r.y, fmt: (r) => pct(r.y, 2) + (r.yc ? '<span class="warn" title="株式分割や特別配当で実際とずれている可能性があります">※</span>' : "") },
    { key: "dps", label: "1株配当(円)", get: (r) => r.d, fmt: (r) => (r.d == null ? "-" : r.d.toLocaleString("ja-JP")) },
    { key: "buy", label: "自社株買", cls: "left buy", get: (r) => r.bs * 1e15 + (r.ba || 0),
      fmt: (r) => (r.bs ? "実施" : r.ba >= 1 ? "単元未満等のみ" : "なし"), rowCls: (r) => (r.bs ? "yes" : "") },
    { key: "buyamt", label: "取得額(億円)", get: (r) => r.ba, fmt: (r) => (r.ba ? oku(r.ba) : "-") },
    { key: "cc", label: "資本コスト・PBRへの言及", cls: "left", get: (r) => r.cc, fmt: (r) => mark(r.cc, "あり"), rowCls: (r) => (r.cc ? "yes" : "") },
    { key: "rt", label: "ROE目標", get: (r) => r.rt, fmt: (r) => pct(r.rt) },
    { key: "dp", label: "配当方針", cls: "left", get: (r) => r.dp || "", fmt: (r) => esc(r.dp || "-") },
    { key: "xc", label: "政策保有株の縮減方針", cls: "left", get: (r) => r.xc, fmt: (r) => mark(r.xc, "あり"), rowCls: (r) => (r.xc ? "yes" : "") },
    { key: "xm", label: "政策保有株÷時価総額", get: (r) => r.xm, fmt: (r) => pct(r.xm) },
    { key: "pa", label: "親会社", cls: "left", get: (r) => r.pa, fmt: (r) => mark(r.pa, "あり") },
    { key: "cs", label: "社長就任", cls: "left", get: (r) => r.cs || "", fmt: (r) => esc(r.cs || "-") },
    { key: "nw", label: "新社長", cls: "left", get: (r) => r.nw, fmt: (r) => mark(r.nw, "新社長"), rowCls: (r) => (r.nw ? "yes" : "") },
    { key: "em", label: "従業員数", get: (r) => r.em, fmt: (r) => yen(r.em) },
    { key: "ag", label: "平均年齢", get: (r) => r.ag, fmt: (r) => num(r.ag) },
    { key: "tn", label: "平均勤続年数", get: (r) => r.tn, fmt: (r) => num(r.tn) },
    { key: "sl", label: "平均年収(万円)", get: (r) => r.sl, fmt: (r) => yen(r.sl) },
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
        else { state.sort = k; state.desc = ["bb", "bf", "bx", "bo", "gm", "om", "cash", "yield", "dps", "buy", "buyamt", "trs",
          "mc", "roe", "er", "cm", "nc", "sg", "og", "cc", "rt", "dp", "xc", "xm", "pa", "cs", "nw", "em", "ag", "tn", "sl", "oc", "ic", "fc", "cx", "cxs", "cxd", "ma", "sp", "pl", "pa2"].includes(k); }
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
