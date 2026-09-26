(() => {
  "use strict";

  const CASES_URL = "data/cases.json";
  const PRICES_URL = "data/prices.json";
  const YAHOO_URL = (code) => `https://finance.yahoo.co.jp/quote/${encodeURIComponent(code)}.T`;
  const MEMO_KEY = "scandal-watch:memos"; // { id: { decision, text, date, close } }

  const TYPES = {
    temporary: { label: "一時的", long: "一時的な問題", desc: "本業の稼ぐ力は大きく変わらないと見た例" },
    core: { label: "本業に響く", long: "本業に響く問題", desc: "会社の信頼や稼ぐ力そのものが傷ついた例" },
    watch: { label: "見きわめ中", long: "見きわめ中", desc: "まだ影響を判断する材料がそろっていない例" },
  };
  const FILTERS = [
    { key: "all", label: "すべて" },
    { key: "temporary", label: TYPES.temporary.label },
    { key: "core", label: TYPES.core.label },
    { key: "watch", label: TYPES.watch.label },
  ];
  const DECISIONS = [
    { key: "", label: "(未記入)" },
    { key: "buy", label: "買いたい" },
    { key: "wait", label: "様子を見る" },
    { key: "skip", label: "見送る" },
  ];

  // チャート座標(SVG viewBox)。preserveAspectRatio="none" で横幅いっぱいに伸ばす
  const W = 1000;
  const H = 300;
  const PAD_Y = 12;

  const $ = (id) => document.getElementById(id);
  const state = { cases: [], prices: {}, updated: null, filter: "all", sort: "date", memos: loadMemos() };

  // ---------- 保存(この端末のブラウザだけ) ----------

  function loadMemos() {
    try {
      return JSON.parse(localStorage.getItem(MEMO_KEY)) || {};
    } catch {
      return {};
    }
  }

  function saveMemos() {
    try {
      localStorage.setItem(MEMO_KEY, JSON.stringify(state.memos));
      return true;
    } catch {
      return false;
    }
  }

  // ---------- 表示用の小道具 ----------

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function fmtPct(v) {
    if (v == null) return "—";
    const p = v * 100;
    return `${p > 0 ? "+" : ""}${p.toFixed(Math.abs(p) >= 100 ? 0 : 1)}%`;
  }

  const cls = (v) => (v == null || v === 0 ? "" : v > 0 ? "up" : "down");

  function fmtDate(s) {
    if (!s) return "";
    const [y, m, d] = s.split("-").map(Number);
    return `${y}年${m}月${d}日`;
  }

  function median(xs) {
    if (!xs.length) return null;
    const a = [...xs].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  // ---------- 分類ごとの成績 ----------

  function renderSummary() {
    const el = $("summary");
    if (!state.updated) {
      el.innerHTML = `<p class="note">株価データはまだありません(毎日自動で作られます)。</p>`;
      return;
    }
    el.innerHTML = Object.entries(TYPES)
      .map(([key, t]) => {
        const rows = state.cases.filter((c) => c.type === key).map((c) => state.prices[c.id]).filter(Boolean);
        const y1 = rows.map((p) => p.moves?.y1?.excess).filter((v) => v != null);
        const bottoms = rows.map((p) => p.bottom?.ret).filter((v) => v != null);
        const med = median(y1);
        const beat = y1.filter((v) => v > 0).length;
        const body = y1.length
          ? `<div class="big ${cls(med)}">${fmtPct(med)}</div>
             <p>1年後のTOPIXとの差(真ん中の値)。${y1.length}件中${beat}件がTOPIXを上回った</p>`
          : `<div class="big">—</div><p>1年たった例がまだありません</p>`;
        const drop = bottoms.length ? `<p>半年以内の下げ(真ん中の値): ${fmtPct(median(bottoms))}</p>` : "";
        return `<div class="sum-card t-${key}"><h3>${esc(t.long)}</h3>${body}${drop}</div>`;
      })
      .join("");
  }

  // ---------- 絞り込み・並び替え ----------

  function renderFilters() {
    const el = $("type-filter");
    el.innerHTML = FILTERS.map((f) => {
      const n = f.key === "all" ? state.cases.length : state.cases.filter((c) => c.type === f.key).length;
      return `<button type="button" data-key="${f.key}" class="${state.filter === f.key ? "active" : ""}" aria-pressed="${state.filter === f.key}">${esc(f.label)} ${n}</button>`;
    }).join("");
  }

  function sortValue(c) {
    const p = state.prices[c.id];
    switch (state.sort) {
      case "bottom":
        return p?.bottom?.ret ?? Infinity;
      case "y1":
        return -(p?.moves?.y1?.excess ?? -Infinity);
      case "latest":
        return -(p?.latest?.excess ?? -Infinity);
      default:
        return -Date.parse(c.date);
    }
  }

  // ---------- 1件ずつのカード ----------

  function moveCell(label, v, sub) {
    return `<div class="move"><span class="label">${label}</span><span class="val ${cls(v)}">${fmtPct(v)}</span><span class="sub">${sub}</span></div>`;
  }

  function renderMoves(c, p) {
    if (!p) {
      const why = c.status === "delisted" ? "上場廃止のため株価を取得できません。" : "株価データはまだありません。";
      return `<p class="moves-none">${why}</p>`;
    }
    const m = p.moves || {};
    const ex = (x) => (x?.excess != null ? `TOPIX比 ${fmtPct(x.excess)}` : "まだ先");
    return `<div class="moves">
      ${moveCell("1週間後", m.w1?.ret, ex(m.w1))}
      ${moveCell("半年以内の底", p.bottom?.ret, p.bottom ? fmtDate(p.bottom.date).replace(/^\d+年/, "") : "")}
      ${moveCell("1年後", m.y1?.ret, ex(m.y1))}
      ${moveCell(c.status === "delisted" ? "最後の株価" : "今", p.latest?.ret, ex(p.latest))}
    </div>
    <p class="note" style="margin-top:0.35rem">基準: ${fmtDate(p.baseDate)}の終値 ${Math.round(p.base).toLocaleString()}円。${
      p.recovered ? `${fmtDate(p.recovered)}に基準の株価まで戻った。` : "まだ基準の株価まで戻っていない。"
    }</p>`;
  }

  function renderChart(p) {
    const pts = p?.chart;
    if (!pts || pts.length < 2) return "";
    const vals = pts.flatMap((r) => [r[1], r[2]]);
    const lo = Math.min(...vals, 100);
    const hi = Math.max(...vals, 100);
    const t0 = Date.parse(pts[0][0]);
    const t1 = Date.parse(pts[pts.length - 1][0]);
    const x = (d) => ((Date.parse(d) - t0) / (t1 - t0 || 1)) * W;
    const y = (v) => PAD_Y + (1 - (v - lo) / (hi - lo || 1)) * (H - PAD_Y * 2);
    const line = (i) => pts.map((r, k) => `${k ? "L" : "M"}${x(r[0]).toFixed(1)},${y(r[i]).toFixed(1)}`).join("");
    const bx = x(p.baseDate).toFixed(1);
    return `<div class="chart">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="基準日を100とした株価とTOPIXの動き">
        <line x1="0" x2="${W}" y1="${y(100).toFixed(1)}" y2="${y(100).toFixed(1)}" stroke="var(--border)" stroke-width="1" vector-effect="non-scaling-stroke" />
        <line x1="${bx}" x2="${bx}" y1="0" y2="${H}" stroke="var(--core)" stroke-width="1" stroke-dasharray="4 4" vector-effect="non-scaling-stroke" />
        <path d="${line(2)}" fill="none" stroke="var(--bench)" stroke-width="1.5" vector-effect="non-scaling-stroke" />
        <path d="${line(1)}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke" />
      </svg>
      <div class="legend">
        <span><i style="background:var(--accent)"></i>株価</span>
        <span><i style="background:var(--bench)"></i>TOPIX</span>
        <span><i style="background:var(--core)"></i>不祥事が知られた日</span>
        <span>${esc(pts[0][0].slice(0, 7))} 〜 ${esc(pts[pts.length - 1][0].slice(0, 7))}(基準日=100)</span>
      </div>
    </div>`;
  }

  function renderMemo(c, p) {
    const memo = state.memos[c.id] || {};
    const options = DECISIONS.map(
      (d) => `<option value="${d.key}"${memo.decision === d.key ? " selected" : ""}>${d.label}</option>`,
    ).join("");
    let result = "";
    if (memo.date) {
      const label = DECISIONS.find((d) => d.key === memo.decision)?.label || "(未記入)";
      const now = p?.latest?.close;
      const change = memo.close && now ? now / memo.close - 1 : null;
      result = `<p class="memo-result">${fmtDate(memo.date)}に「${esc(label)}」と記録${
        memo.close ? `(そのときの株価 ${Math.round(memo.close).toLocaleString()}円)` : ""
      }${change != null ? ` → 今 ${Math.round(now).toLocaleString()}円 <b class="${cls(change)}">${fmtPct(change)}</b>` : ""}</p>`;
    }
    return `<div class="memo" data-id="${esc(c.id)}">
      <h3>わたしの判断</h3>
      <div class="memo-row">
        <select aria-label="判断">${options}</select>
        <button type="button" data-act="save">記録する</button>
        ${memo.date ? `<button type="button" class="ghost" data-act="clear">消す</button>` : ""}
      </div>
      <textarea placeholder="理由(例: 本業とは関係ない子会社の問題。次の決算で売上が落ちていなければ買う)" aria-label="判断の理由">${esc(memo.text || "")}</textarea>
      ${result}
    </div>`;
  }

  function renderCase(c) {
    const p = state.prices[c.id];
    const t = TYPES[c.type] || TYPES.watch;
    const sources = (c.sources || [])
      .map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`)
      .join("");
    return `<article class="case">
      <div class="case-head">
        <h2>${esc(c.name)}<span class="code"><a href="${YAHOO_URL(c.code)}" target="_blank" rel="noopener">${esc(c.code)}</a></span></h2>
        <span class="badge t-${esc(c.type)}">${esc(t.label)}</span>
      </div>
      <div class="case-title">${esc(c.title)}</div>
      <div class="case-date">${fmtDate(c.date)}${c.status === "delisted" ? `<span class="delisted">${fmtDate(c.delisted)} 上場廃止</span>` : ""}</div>
      <dl>
        <div><dt>何が起きたか</dt><dd>${esc(c.what)}</dd></div>
        <div><dt>「${esc(t.label)}」と見た理由</dt><dd>${esc(c.why)}</dd></div>
        <div><dt>その後</dt><dd>${esc(c.after)}</dd></div>
      </dl>
      ${renderMoves(c, p)}
      ${renderChart(p)}
      <details class="sources"><summary>出典(${(c.sources || []).length}件)</summary><ul>${sources}</ul></details>
      ${renderMemo(c, p)}
    </article>`;
  }

  function renderList() {
    const rows = state.cases
      .filter((c) => state.filter === "all" || c.type === state.filter)
      .sort((a, b) => sortValue(a) - sortValue(b));
    $("list").innerHTML = rows.length ? rows.map(renderCase).join("") : `<p class="note">該当する例はありません。</p>`;
  }

  function render() {
    renderSummary();
    renderFilters();
    renderList();
  }

  // ---------- 操作 ----------

  $("type-filter").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-key]");
    if (!b) return;
    state.filter = b.dataset.key;
    renderFilters();
    renderList();
  });

  $("sort").addEventListener("change", (e) => {
    state.sort = e.target.value;
    renderList();
  });

  $("list").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const box = b.closest(".memo");
    const id = box.dataset.id;
    if (b.dataset.act === "clear") {
      delete state.memos[id];
    } else {
      const close = state.prices[id]?.latest?.close ?? null;
      state.memos[id] = {
        decision: box.querySelector("select").value,
        text: box.querySelector("textarea").value.trim(),
        date: new Date().toLocaleDateString("sv-SE"), // YYYY-MM-DD(端末の日付)
        close,
      };
    }
    if (!saveMemos()) alert("このブラウザでは記録を保存できませんでした(プライベートモードなど)。");
    box.outerHTML = renderMemo(state.cases.find((c) => c.id === id), state.prices[id]);
  });

  // ---------- 読み込み ----------

  async function load() {
    const status = $("status");
    try {
      const res = await fetch(CASES_URL, { cache: "no-cache" });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      state.cases = data.cases || [];
      status.textContent = `${state.cases.length}件(内容は${fmtDate(data.checked)}時点で確認)`;
    } catch (e) {
      status.textContent = "データを読み込めませんでした。時間をおいて開き直してください。";
      return;
    }
    try {
      const res = await fetch(PRICES_URL, { cache: "no-cache" });
      if (res.ok) {
        const data = await res.json();
        state.prices = data.cases || {};
        state.updated = data.updated;
        status.textContent += ` / 株価 ${data.updated} 更新`;
      }
    } catch {
      // 株価がなくても不祥事の一覧は見られるようにする
    }
    render();
  }

  load();
})();
