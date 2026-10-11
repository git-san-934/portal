(() => {
  const QUOTE = "https://finance.yahoo.co.jp/quote/";
  const state = { def: "f", max: Infinity, mkt: "all", bk: 0, q: "", draft: [], conds: [], sort: "eps", desc: true, data: null };

  const DEFS = [["f", "浮動株割合"], ["b", "不動株割合（東証式）"], ["a", "特定株比率（四季報式）"]];
  const MAXES = [[Infinity, "すべて"], [0.05, "5%未満"], [0.1, "10%未満"], [0.2, "20%未満"]];
  const BKS = [[0, "すべて"], [5, "5期以上"], [10, "10期以上"]];
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
    { key: "eps", label: "EPS(円)", get: (r) => r.eps, fmt: (r) => num(r.eps, 2) },
    { key: "bps", label: "BPS(円)", get: (r) => r.bps, fmt: (r) => num(r.bps, 2) },
    { key: "bk", label: "BPS連続増加(期)", get: (r) => r.bk,
      fmt: (r) => (r.bk == null ? "-" : r.bh ? `<span title="${esc(r.bh)}">${r.bk}</span>` : String(r.bk)), rowCls: (r) => (r.bk >= 10 ? "yes" : "") },
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

  // 抽出条件（項目・以上/以下/等しい・数値）。数値は表に出ている単位で入力し、すべて満たす銘柄を出す
  const PCT = ["fixed", "bb", "bf", "bx", "bo", "gm", "om", "roe", "er", "cm", "nc", "sg", "og", "cxs", "yield", "rt", "xm", "trs"];
  const OKU = ["cash", "mc", "oc", "ic", "fc", "cx", "ma", "sp", "pa2", "buyamt"];
  const TEXT = ["code", "name", "mkt", "ct", "pt", "dp", "cs", "top1", "fy"];
  const MARK = ["pl", "buy", "cc", "xc", "pa", "nw"];
  for (const c of COLS) {
    c.ft = TEXT.includes(c.key) ? "text" : MARK.includes(c.key) ? "mark" : "num";
    c.scale = PCT.includes(c.key) ? 0.01 : OKU.includes(c.key) ? 100 : 1;
    const m = c.label.match(/\((.+)\)$/);
    c.unit = PCT.includes(c.key) ? "%" : m ? m[1] : c.key === "cxd" ? "倍" : "";
    c.name = c.label.replace(/\(.+\)$/, "");
  }
  const CCOLS = COLS.filter((c) => c.ft !== "text");
  const OPS = { num: [["ge", "以上"], ["le", "以下"], ["eq", "等しい"]], mark: [["yes", "あり"], ["no", "なし"]] };
  const markOf = (c, r) => (c.key === "buy" ? !!r.bs : !!c.get(r));
  const parseNum = (s) => {
    const t = String(s).replace(/[０-９．－，]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/[,%％\s]/g, "").replace(/^[ー−]/, "-");
    return t === "" || isNaN(+t) ? null : +t;
  };
  const colOf = (k) => COLS.find((c) => c.key === k);

  function passConds(r) {
    for (const k of state.conds) {
      const c = colOf(k.key);
      if (c.ft === "mark") {
        if (markOf(c, r) !== (k.op === "yes")) return false;
        continue;
      }
      const v = c.get(r);
      if (v == null) return false;
      const x = v / c.scale;
      if (k.op === "ge" && x < k.num - 1e-9) return false;
      if (k.op === "le" && x > k.num + 1e-9) return false;
      if (k.op === "eq") {  // 入力した桁で一致（12.3 なら 12.25以上12.35未満）
        const dec = (String(k.val).split(".")[1] || "").length;
        const tol = 0.5 * Math.pow(10, -dec);
        if (!(x >= k.num - tol - 1e-9 && x < k.num + tol - 1e-9)) return false;
      }
    }
    return true;
  }

  function drawConds() {
    const box = document.getElementById("conds");
    box.innerHTML = state.draft.map((d, i) => {
      const c = colOf(d.key);
      const opts = CCOLS.map((x) => `<option value="${x.key}"${x.key === d.key ? " selected" : ""}>${esc(x.key === "fixed" ? "浮動株などの割合" : x.name)}</option>`).join("");
      const ops = OPS[c.ft].map(([v, l]) => `<option value="${v}"${v === d.op ? " selected" : ""}>${l}</option>`).join("");
      const val = c.ft === "num"
        ? `<input class="cond-val${d.bad ? " bad" : ""}" data-i="${i}" inputmode="decimal" placeholder="数値" value="${esc(d.val || "")}"><span class="cond-unit">${esc(c.unit)}</span>`
        : "";
      return `<div class="cond-row"><select class="cond-key" data-i="${i}" aria-label="項目">${opts}</select>${val}<select class="cond-op" data-i="${i}" aria-label="条件">${ops}</select><button type="button" class="cond-del" data-i="${i}" aria-label="この条件を消す">×</button></div>`;
    }).join("") || `<p class="cond-empty">「＋条件を追加」で条件を入れてください。</p>`;
    box.querySelectorAll(".cond-key").forEach((el) => (el.onchange = () => {
      const d = state.draft[el.dataset.i];
      d.key = el.value;
      d.op = OPS[colOf(d.key).ft][0][0];
      drawConds();
    }));
    box.querySelectorAll(".cond-op").forEach((el) => (el.onchange = () => { state.draft[el.dataset.i].op = el.value; }));
    box.querySelectorAll(".cond-val").forEach((el) => {
      el.oninput = () => { state.draft[el.dataset.i].val = el.value; };
      el.onkeydown = (e) => { if (e.key === "Enter") runConds(); };
    });
    box.querySelectorAll(".cond-del").forEach((el) => (el.onclick = () => { state.draft.splice(el.dataset.i, 1); drawConds(); }));
  }

  function runConds() {
    const ok = [];
    let bad = 0;
    for (const d of state.draft) {
      d.bad = false;
      if (colOf(d.key).ft === "mark") { ok.push({ key: d.key, op: d.op }); continue; }
      if (!String(d.val || "").trim()) continue;  // 数値が空の行は使わない
      const num = parseNum(d.val);
      if (num == null) { d.bad = true; bad++; continue; }
      ok.push({ key: d.key, op: d.op, val: String(d.val).trim(), num });
    }
    const msg = document.getElementById("cond-msg");
    drawConds();
    if (bad) { msg.textContent = "数値になっていない条件があります（赤枠）。"; return; }
    msg.textContent = "";
    state.conds = ok;
    saveHash();
    render();
    document.getElementById("list-title").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function saveHash() {
    const h = state.conds.map((k) => [k.key, k.op, k.val || ""].join("~")).join("|");
    history.replaceState(null, "", h ? "#c=" + encodeURIComponent(h) : location.pathname + location.search);
  }

  function loadHash() {
    const m = location.hash.match(/^#c=(.*)$/);
    if (!m) return;
    for (const part of decodeURIComponent(m[1]).split("|")) {
      const [key, op, val] = part.split("~");
      const c = colOf(key);
      if (!c || c.ft === "text" || !OPS[c.ft].some((o) => o[0] === op)) continue;
      state.draft.push({ key, op, val });
    }
    runConds();
  }

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
      if (state.bk && !(r.bk >= state.bk)) return false;
      if (state.mkt !== "all" && !(r.m || "").includes(state.mkt)) return false;
      if (state.q && !(r.c.includes(state.q) || r.n.includes(state.q))) return false;
      return passConds(r);
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
      (state.max === Infinity ? (state.bk ? "" : "全銘柄") : `${defName()}${maxName}の銘柄`) +
      (state.bk ? `${state.max === Infinity ? "" : "・"}BPS${state.bk}期以上連続増加` : "");
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
    if (state.conds.length) {
      const t = document.getElementById("list-title");
      t.textContent = (t.textContent === "全銘柄" ? "" : t.textContent + "・") + `抽出条件 ${state.conds.length}件にあう銘柄`;
    }
    document.getElementById("cond-now").textContent = state.conds.length
      ? "適用中: " + state.conds.map((k) => {
          const c = colOf(k.key), name = k.key === "fixed" ? defName() : c.name;
          return c.ft === "mark" ? `${name} ${k.op === "yes" ? "あり" : "なし"}` : `${name} ${k.val}${c.unit} ${OPS.num.find((o) => o[0] === k.op)[1]}`;
        }).join("、")
      : "";
    const table = document.getElementById("list");
    table.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
    table.querySelectorAll("thead th").forEach((th) => {
      th.onclick = () => {
        const k = th.dataset.key;
        if (state.sort === k) state.desc = !state.desc;
        else { state.sort = k; state.desc = ["bb", "bf", "bx", "bo", "gm", "om", "cash", "yield", "dps", "buy", "buyamt", "trs",
          "mc", "eps", "bps", "bk", "roe", "er", "cm", "nc", "sg", "og", "cc", "rt", "dp", "xc", "xm", "pa", "cs", "nw", "em", "ag", "tn", "sl", "oc", "ic", "fc", "cx", "cxs", "cxd", "ma", "sp", "pl", "pa2"].includes(k); }
        render();
      };
    });
  }

  toggle("def-toggle", DEFS, "def");
  toggle("max-toggle", MAXES, "max");
  toggle("bk-toggle", BKS, "bk");
  toggle("mkt-toggle", MKTS, "mkt");
  document.getElementById("cond-add").onclick = () => {
    state.draft.push({ key: "pe", op: "ge", val: "" });
    drawConds();
    const ins = document.querySelectorAll(".cond-val");
    if (ins.length) ins[ins.length - 1].focus();
  };
  document.getElementById("cond-run").onclick = runConds;
  document.getElementById("cond-clear").onclick = () => {
    state.draft = []; state.conds = [];
    document.getElementById("cond-msg").textContent = "";
    saveHash(); drawConds(); render();
  };
  drawConds();
  document.getElementById("q").addEventListener("input", (e) => { state.q = e.target.value.trim(); render(); });

  fetch("data/screen.json?v=" + Date.now())
    .then((r) => r.json())
    .then((d) => {
      state.data = d;
      document.getElementById("status").textContent =
        `データ: 有価証券報告書 ${d.fy_range}／株価 ${d.price_date} 時点（${d.rows.length.toLocaleString("ja-JP")}社、${d.updated} 更新）`;
      if (location.hash.startsWith("#c=")) loadHash();
      else render();
    })
    .catch(() => {
      const s = document.getElementById("status");
      s.textContent = "データを読み込めませんでした。";
      s.classList.add("error");
    });
})();
