(() => {
  const SHOW_DAYS = 8; // 銘柄ごとに最初に見せる日数(1日1件。それより古い日はまとめて折りたたむ)
  const LABEL = { official: "公式", tdnet: "適時開示", edinet: "EDINET", sec: "SEC" };
  let data = null;
  let filter = "all";

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // 外から集めた URL は http/https のときだけリンクにする(javascript: などを踏ませない)
  const isWebUrl = (u) => /^https?:\/\//i.test(u || "");

  const fmtDate = (d) => {
    const [y, m, day] = d.split("-").map(Number);
    const wd = "日月火水木金土"[new Date(y, m - 1, day).getDay()];
    return `${y}/${m}/${day}(${wd})`;
  };
  // 新着 = 記事の日付が今日(日本時間)のもの
  const todayJST = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
  let today = todayJST();
  const isFresh = (it) => it.date === today;
  const pass = (it) => filter === "all" || it.source === filter;

  function item(it, stock) {
    const li = el("li", "item");
    if (isFresh(it)) li.classList.add("fresh");
    const meta = el("span", "meta");
    meta.append(el("span", "date", fmtDate(it.date) + (it.time ? ` ${it.time}` : "")));
    meta.append(el("span", `badge src-${it.source}`, LABEL[it.source] || it.source));
    if (stock) meta.append(el("span", "stock", stock.name));
    if (isFresh(it)) meta.append(el("span", "badge new", "NEW"));
    // 英語のタイトルは日本語訳を見せ、原文は下に小さく(マウスを載せても出る)
    const a = el("a", "title", it.title_ja || it.title);
    if (isWebUrl(it.url)) a.href = it.url;
    a.target = "_blank";
    a.rel = "noopener";
    li.append(meta, a);
    if (it.title_ja) {
      a.title = it.title;
      li.append(el("span", "orig", it.title));
    }
    return li;
  }

  // 1日・1社ごとにまとめる。rows は [item, stock] の並び(新しい順)
  function groupByDay(rows) {
    const groups = new Map();
    for (const r of rows) {
      const k = `${r[0].date}|${r[1].code}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    return [...groups.values()];
  }

  // 1グループ = 1日・1社。1件目だけ見せ、残りは「(会社名) の残り N 件を表示」ボタンで開く
  function groupNodes(g, showStock) {
    const [first, ...rest] = g;
    const nodes = [item(first[0], showStock ? first[1] : null)];
    if (rest.length) {
      const li = el("li", "more-li");
      const more = el("details", "more");
      const label = `${first[1].name} の残り ${rest.length} 件を表示`;
      const sum = el("summary", null, label);
      more.addEventListener("toggle", () => (sum.textContent = more.open ? "閉じる" : label));
      const ul = el("ul", "news");
      rest.forEach(([it, s]) => ul.append(item(it, showStock ? s : null)));
      more.append(sum, ul);
      li.append(more);
      nodes.push(li);
    }
    return nodes;
  }

  function render() {
    today = todayJST();
    const fresh = [];
    for (const s of data.stocks) for (const it of s.items) if (isFresh(it) && pass(it)) fresh.push([it, s]);
    fresh.sort((a, b) => (b[0].date + (b[0].time || "")).localeCompare(a[0].date + (a[0].time || "")));
    // 会社ごとに間をあけて区切る(見やすくするため)
    $("fresh").replaceChildren(
      ...groupByDay(fresh).flatMap((g, i) => {
        const nodes = groupNodes(g, true);
        if (i > 0) nodes[0].classList.add("co-start");
        return nodes;
      })
    );
    if (!fresh.length) $("fresh").append(el("li", "empty", "今日の日付の新しい情報はまだありません"));
    $("fresh-panel").hidden = false;

    const jump = [];
    const sections = data.stocks.map((s) => {
      const items = s.items.filter(pass);
      const sec = el("section", "panel stock");
      sec.id = `s-${s.code}`;
      const h = el("h2", "panel-title");
      h.append(el("span", null, s.name), el("span", "code", s.code));
      const nFresh = items.filter(isFresh).length;
      if (nFresh) h.append(el("span", "badge new", `新着 ${nFresh}`));
      sec.append(h);

      const links = el("p", "links");
      if (isWebUrl(s.home)) {
        const a = el("a", null, "公式サイト");
        a.href = s.home;
        a.target = "_blank";
        a.rel = "noopener";
        links.append(a);
      }
      if (s.official_status && s.official_status !== "ok") links.append(el("span", "warn", `公式サイトのニュース: ${s.official_status}`));
      if (links.childNodes.length) sec.append(links);

      const ul = el("ul", "news");
      const groups = groupByDay(items.map((it) => [it, s]));
      groups.slice(0, SHOW_DAYS).forEach((g) => ul.append(...groupNodes(g, false)));
      if (!items.length) ul.append(el("li", "empty", "該当する情報はありません"));
      sec.append(ul);
      if (groups.length > SHOW_DAYS) {
        const old = groups.slice(SHOW_DAYS);
        const more = el("details", "more older");
        const label = `それより前の ${old.reduce((a, g) => a + g.length, 0)} 件を表示`;
        const sum = el("summary", null, label);
        more.addEventListener("toggle", () => (sum.textContent = more.open ? "閉じる" : label));
        const ul2 = el("ul", "news");
        old.forEach((g) => ul2.append(...groupNodes(g, false)));
        more.append(sum, ul2);
        sec.append(more);
      }

      const j = el("a", nFresh ? "has-new" : null, s.name);
      j.href = `#s-${s.code}`;
      jump.push(j);
      return sec;
    });
    $("stocks").replaceChildren(...sections);
    $("jump").replaceChildren(...jump);
  }

  // 「今すぐ更新」: 更新依頼の Issue を作る画面を開く。所有者が作ると Actions が更新を起動する
  // (.github/workflows/request-news-update.yml)
  const q = new URLSearchParams({
    title: "新着情報を更新",
    body: "新着情報ページの「今すぐ更新」から作成。\n\nこのまま「Create」(または「Submit new issue」)を押すと、3〜5分で新着情報ページが更新されます。",
  });
  $("refresh").href = `https://github.com/git-san-934/portal/issues/new?${q}`;

  document.querySelectorAll(".filters button").forEach((b) =>
    b.addEventListener("click", () => {
      filter = b.dataset.filter;
      document.querySelectorAll(".filters button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      if (data) render();
    })
  );

  fetch(`data/news.json?t=${Date.now()}`)
    .then((r) => {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    })
    .then((d) => {
      data = d;
      const t = new Date(d.updated_at);
      const notes = [];
      if (d.tdnet && d.tdnet !== "ok") notes.push(`適時開示: ${d.tdnet}`);
      if (d.edinet !== "ok") notes.push(`EDINET: ${d.edinet}`);
      $("status").textContent =
        `最終更新 ${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}` +
        (notes.length ? `(${notes.join("、")})` : "");
      render();
    })
    .catch(() => {
      $("status").textContent = "まだデータがありません。最初の更新をお待ちください。";
    });
})();
