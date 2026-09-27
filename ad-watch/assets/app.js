(() => {
  "use strict";

  const DATA_URL = "data/ad.json";
  const YAHOO_URL = (code) => `https://finance.yahoo.co.jp/quote/${encodeURIComponent(code)}.T`;
  const EDINET_URL = "https://disclosure2.edinet-fsa.go.jp/";
  const PAGE = 50;
  const BB_DAYS = 45; // 自己株券買付状況報告書がこの日数以内に出ていれば「自社株買い中」
  const MIN_AD = 1e8; // 広告費1億円以上
  const MIN_RATIO = 0.01; // 売上に占める広告費1%以上(広告にあまり頼らない会社の小さな変化を除く)

  const JUDGES = {
    good: { label: "広告が効いている" },
    miss: { label: "空振り気味" },
    loss: { label: "赤字に注意" },
    up: { label: "広告増" },
  };
  const FILTERS = [
    { key: "good", label: JUDGES.good.label },
    { key: "adup", label: "広告費+10%以上すべて" },
    { key: "miss", label: JUDGES.miss.label },
    { key: "loss", label: JUDGES.loss.label },
    { key: "all", label: "すべて" },
  ];

  const $ = (id) => document.getElementById(id);
  const state = { rows: [], updated: null, filter: "good", sort: "adG", onlyBB: false, minAd: true, minRatio: true, shown: PAGE };

  // ---------- 表示用の小道具 ----------

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function fmtPct(v) {
    if (v == null || !isFinite(v)) return "—";
    const p = v * 100;
    return `${p > 0 ? "+" : ""}${p.toFixed(Math.abs(p) >= 100 ? 0 : 1)}%`;
  }

  const fmtRatio = (v) => (v == null || !isFinite(v) ? "—" : `${(v * 100).toFixed(1)}%`);
  const cls = (v) => (v == null || !isFinite(v) || v === 0 ? "" : v > 0 ? "up" : "down");

  function fmtYen(v) {
    if (v == null) return "—";
    const oku = v / 1e8;
    if (Math.abs(oku) >= 100) return `${Math.round(oku).toLocaleString("ja-JP")}億円`;
    if (Math.abs(oku) >= 1) return `${oku.toFixed(1)}億円`;
    return `${Math.round(v / 1e6).toLocaleString("ja-JP")}百万円`;
  }

  function fmtPeriod(p) {
    const [y, m] = p.split("-").map(Number);
    return `${y}年${m}月期`;
  }

  function prevPeriod(p, n = 1) {
    const [y, m] = p.split("-");
    return `${String(Number(y) - n).padStart(4, "0")}-${m}`;
  }

  const growth = (a, b) => (a != null && b != null && b > 0 ? a / b - 1 : null);

  function daysBetween(a, b) {
    return Math.round((new Date(a) - new Date(b)) / 86400000);
  }

  // ---------- データを1社ずつの行にする ----------

  function toRow(code, rec, updated) {
    if (rec.noad || !rec.latest) return null;
    const p0 = rec.latest;
    const p1 = prevPeriod(p0);
    const ad0 = rec.ad[p0];
    if (ad0 == null) return null;
    const s0 = rec.sales[p0];
    const op0 = rec.op[p0];
    const op1 = rec.op[p1];
    const row = {
      code,
      name: (rec.name || code).normalize("NFKC").replace(/株式会社/g, "").replace(/[\s\u3000]+/g, " ").trim() || code,
      period: p0,
      ad0,
      adG: growth(ad0, rec.ad[p1]),
      salesG: growth(s0, rec.sales[p1]),
      ratio: s0 ? ad0 / s0 : null,
      opMargin: s0 && op0 != null ? op0 / s0 : null,
      op0,
      op1,
      rec,
      bb: rec.buyback && updated ? daysBetween(updated, rec.buyback) <= BB_DAYS : false,
    };
    row.judge = judge(row);
    return row;
  }

  function judge(r) {
    if (r.adG == null || r.adG < 0.1) return null;
    if (r.op0 != null && r.op0 < 0) return "loss";
    if (r.salesG != null && r.salesG < 0.03) return "miss";
    const opOk = r.op0 != null && r.op0 > 0 && (r.op1 == null || r.op1 <= 0 || r.op0 >= r.op1 * 0.8);
    if (r.salesG != null && r.salesG >= 0.1 && opOk) return "good";
    return "up";
  }

  // ---------- 絞り込み・並び替え ----------

  function matches(r, key) {
    if (key === "all") return true;
    if (key === "adup") return r.judge != null;
    return r.judge === key;
  }

  function base() {
    return state.rows.filter((r) => (!state.onlyBB || r.bb) && (!state.minAd || r.ad0 >= MIN_AD) && (!state.minRatio || (r.ratio ?? 0) >= MIN_RATIO));
  }

  function renderFilters() {
    const rows = base();
    $("judge-filter").innerHTML = FILTERS.map((f) => {
      const n = rows.filter((r) => matches(r, f.key)).length;
      const on = state.filter === f.key;
      return `<button type="button" data-key="${f.key}" class="${on ? "active" : ""}" aria-pressed="${on}">${esc(f.label)} ${n}</button>`;
    }).join("");
  }

  function sorted(rows) {
    const k = state.sort;
    const v = (r) => r[k] ?? -Infinity;
    return [...rows].sort((a, b) => v(b) - v(a));
  }

  // ---------- 一覧 ----------

  function yearsTable(r) {
    const periods = [0, 1, 2, 3, 4].map((n) => prevPeriod(r.period, n)).filter((p) => r.rec.sales[p] != null || r.rec.ad[p] != null);
    const body = periods
      .map((p) => {
        const s = r.rec.sales[p];
        const a = r.rec.ad[p];
        return `<tr><td>${esc(fmtPeriod(p))}</td><td>${fmtYen(s)}</td><td>${fmtYen(a)}</td><td>${fmtRatio(s && a != null ? a / s : null)}</td><td>${fmtYen(r.rec.op[p])}</td></tr>`;
      })
      .join("");
    const src = [r.rec.ad_src && `広告宣伝費: ${r.rec.ad_src}`, r.rec.sales_src && `売上高: ${r.rec.sales_src}`].filter(Boolean).join(" / ");
    return `<details class="years"><summary>年ごとの数字</summary>
      <div class="scroll"><table>
        <thead><tr><th>決算期</th><th>売上高</th><th>広告費</th><th>広告費/売上</th><th>営業利益</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>
      <p class="src">読み取った項目(${esc(src)})。<a href="${EDINET_URL}" target="_blank" rel="noopener">EDINET</a>で証券コード ${esc(r.code)} を検索すると報告書を確かめられます。</p>
    </details>`;
  }

  function card(r) {
    const badges = [
      r.judge ? `<span class="badge j-${r.judge}">${esc(JUDGES[r.judge].label)}</span>` : `<span class="badge j-none">広告費は横ばい・減少</span>`,
      r.bb ? `<span class="badge bb">自社株買い中</span>` : "",
    ].join("");
    return `<article class="co">
      <div class="co-head">
        <div>
          <h2>${esc(r.name)}<span class="code"><a href="${YAHOO_URL(r.code)}" target="_blank" rel="noopener">${esc(r.code)}</a></span></h2>
          <div class="period">${esc(fmtPeriod(r.period))}(前の年と比べて)</div>
        </div>
        <div class="badges">${badges}</div>
      </div>
      <div class="stats">
        <div class="stat"><span class="label">広告費</span><span class="val ${cls(r.adG)}">${fmtPct(r.adG)}</span><span class="sub">${fmtYen(r.ad0)}</span></div>
        <div class="stat"><span class="label">売上</span><span class="val ${cls(r.salesG)}">${fmtPct(r.salesG)}</span><span class="sub">${fmtYen(r.rec.sales[r.period])}</span></div>
        <div class="stat"><span class="label">売上に占める広告費</span><span class="val">${fmtRatio(r.ratio)}</span></div>
        <div class="stat"><span class="label">営業利益率</span><span class="val ${r.opMargin != null && r.opMargin < 0 ? "down" : ""}">${fmtRatio(r.opMargin)}</span><span class="sub">前年 ${fmtRatio(r.op1 != null && r.rec.sales[prevPeriod(r.period)] ? r.op1 / r.rec.sales[prevPeriod(r.period)] : null)}</span></div>
      </div>
      ${yearsTable(r)}
    </article>`;
  }

  function renderList() {
    renderFilters();
    const rows = sorted(base().filter((r) => matches(r, state.filter)));
    $("count").textContent = `${rows.length} 社`;
    $("list").innerHTML = rows.length
      ? rows.slice(0, state.shown).map(card).join("")
      : `<p class="empty">条件にあう会社はありません。</p>`;
    $("more").hidden = rows.length <= state.shown;
  }

  // ---------- 操作 ----------

  function bind() {
    $("judge-filter").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-key]");
      if (!b) return;
      state.filter = b.dataset.key;
      state.shown = PAGE;
      renderList();
    });
    $("sort").addEventListener("change", (e) => {
      state.sort = e.target.value;
      state.shown = PAGE;
      renderList();
    });
    $("only-bb").addEventListener("change", (e) => {
      state.onlyBB = e.target.checked;
      state.shown = PAGE;
      renderList();
    });
    $("min-ad").addEventListener("change", (e) => {
      state.minAd = e.target.checked;
      state.shown = PAGE;
      renderList();
    });
    $("min-ratio").addEventListener("change", (e) => {
      state.minRatio = e.target.checked;
      state.shown = PAGE;
      renderList();
    });
    $("more").addEventListener("click", () => {
      state.shown += PAGE;
      renderList();
    });
  }

  async function main() {
    bind();
    try {
      const res = await fetch(DATA_URL, { cache: "no-cache" });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      state.updated = data.updated || null;
      const companies = data.companies || {};
      state.rows = Object.entries(companies)
        .map(([code, rec]) => toRow(code, rec, state.updated))
        .filter(Boolean);
      $("status").textContent = state.updated
        ? `データ更新日: ${state.updated.replace(/-/g, "/")} ・ 広告宣伝費がわかった会社 ${state.rows.length} 社`
        : "データはまだありません(毎日自動で集めています)。";
    } catch {
      $("status").textContent = "データはまだありません(毎日自動で集めています)。";
    }
    renderList();
  }

  main();
})();
