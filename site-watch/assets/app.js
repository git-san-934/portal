(() => {
  const FRESH_HOURS = 72;
  const SHOW = 15; // 1日ぶん・1銘柄ごとに最初に見せる件数
  const KIND = { pdf: "PDF", xls: "Excel", xlsx: "Excel", doc: "Word", docx: "Word", ppt: "PowerPoint", pptx: "PowerPoint", csv: "CSV" };
  let data = null;
  let filter = "all";

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const link = (href, text, cls) => {
    const a = el("a", cls, text);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  };

  // found_at は日本時間の ISO 文字列(例: 2026-10-07T05:03:12+09:00)
  const dayOf = (iso) => iso.slice(0, 10);
  const fmtDate = (d) => {
    const [y, m, day] = d.split("-").map(Number);
    const wd = "日月火水木金土"[new Date(y, m - 1, day).getDay()];
    return `${y}/${m}/${day}(${wd})`;
  };
  const fmtTime = (iso) => {
    const t = new Date(iso);
    return `${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  };
  const isFresh = (it) => Date.now() - new Date(it.found_at).getTime() < FRESH_HOURS * 3600e3;
  const shortUrl = (u) => {
    try {
      const p = new URL(u);
      return decodeURI(p.host + p.pathname + p.search);
    } catch {
      return u;
    }
  };

  function item(it, names) {
    const li = el("li", "item");
    if (isFresh(it)) li.classList.add("fresh");
    const meta = el("span", "meta");
    meta.append(el("span", "stock", names[it.code] || it.code));
    if (KIND[it.kind]) meta.append(el("span", "badge kind", KIND[it.kind]));
    if (it.lastmod) meta.append(el("span", "date", `更新日 ${it.lastmod.replaceAll("-", "/")}`));
    if (isFresh(it)) meta.append(el("span", "badge new", "NEW"));
    li.append(meta, link(it.url, it.title, "title"), el("span", "url", shortUrl(it.url)));
    return li;
  }

  function list(items, names) {
    const wrap = document.createDocumentFragment();
    const ul = el("ul", "news");
    items.slice(0, SHOW).forEach((it) => ul.append(item(it, names)));
    wrap.append(ul);
    if (items.length > SHOW) {
      const more = el("details", "more");
      more.append(el("summary", null, `さらに ${items.length - SHOW} 件`));
      const ul2 = el("ul", "news");
      items.slice(SHOW).forEach((it) => ul2.append(item(it, names)));
      more.append(ul2);
      wrap.append(more);
    }
    return wrap;
  }

  function render() {
    const names = Object.fromEntries(data.sites.map((s) => [s.code, s.name]));
    const items = data.items.filter((it) => filter === "all" || it.code === filter);
    $("count").textContent = `${items.length} 件`;

    // 見つけた日ごと → 銘柄ごとにまとめる
    const days = new Map();
    for (const it of items) {
      const d = dayOf(it.found_at);
      if (!days.has(d)) days.set(d, new Map());
      const byCode = days.get(d);
      if (!byCode.has(it.code)) byCode.set(it.code, []);
      byCode.get(it.code).push(it);
    }
    const blocks = [];
    for (const [d, byCode] of days) {
      const block = el("div", "day");
      const n = [...byCode.values()].reduce((a, v) => a + v.length, 0);
      block.append(el("h3", "day-title", `${fmtDate(d)} に見つけたもの(${n} 件)`));
      for (const its of byCode.values()) block.append(list(its, names));
      blocks.push(block);
    }
    if (!blocks.length) {
      const started = data.sites.some((s) => s.baseline_on);
      blocks.push(el("p", "empty", started ? "新しく見つかったページはまだありません" : "まだ巡回していません。最初の巡回をお待ちください"));
    }
    $("days").replaceChildren(...blocks);

    const rows = data.sites.map((s) => {
      const tr = el("tr");
      const name = el("td", "name");
      name.append(el("span", null, s.name), el("span", "sub", s.code));
      if (s.home) name.append(link(s.home, "公式サイト ↗", "home"));
      const st = el("td", s.status === "ok" ? "ok" : "warn");
      st.textContent = s.status === "ok" ? `OK(${fmtTime(s.checked_at)})` : s.status;
      if (s.status !== "ok" && s.last_ok_at) st.append(el("span", "sub", ` 前回OK ${fmtTime(s.last_ok_at)}`));
      if (s.note) st.append(el("span", "sub", ` ${s.note}`));
      if (s.baseline_on) st.append(el("span", "sub", `${fmtDate(s.baseline_on)} から記録`));
      tr.append(name, st, el("td", "num", s.known ? s.known.toLocaleString() : "-"));
      return tr;
    });
    $("sites").replaceChildren(...rows);
  }

  function filters() {
    const counts = {};
    for (const it of data.items) counts[it.code] = (counts[it.code] || 0) + 1;
    const btns = [["all", "すべて"], ...data.sites.map((s) => [s.code, s.name])].map(([code, name]) => {
      const b = el("button", null, code === "all" || !counts[code] ? name : `${name} ${counts[code]}`);
      b.type = "button";
      b.setAttribute("aria-pressed", String(code === filter));
      b.addEventListener("click", () => {
        filter = code;
        document.querySelectorAll("#filters button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        render();
      });
      return b;
    });
    $("filters").replaceChildren(...btns);
  }

  // 「今すぐ更新」: 更新依頼の Issue を作る画面を開く。所有者が作ると Actions が巡回を起動する
  // (.github/workflows/request-site-watch-update.yml)
  const q = new URLSearchParams({
    title: "サイトの新着ページを更新",
    body: "持ち株サイトの新着ページの「今すぐ更新」から作成。\n\nこのまま「Create」(または「Submit new issue」)を押すと、10〜30分で新着ページの一覧が更新されます。",
  });
  $("refresh").href = `https://github.com/git-san-934/portal/issues/new?${q}`;

  fetch(`data/new_pages.json?t=${Date.now()}`)
    .then((r) => {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    })
    .then((d) => {
      data = d;
      const bad = d.sites.filter((s) => s.status !== "ok").length;
      $("status").textContent = `最終更新 ${fmtTime(d.updated_at)}` + (bad ? `(${bad} 社は巡回できませんでした。下の「巡回の状況」を参照)` : "");
      filters();
      render();
    })
    .catch(() => {
      $("status").textContent = "まだデータがありません。最初の巡回をお待ちください。";
    });
})();
