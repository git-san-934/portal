(() => {
  const FRESH_HOURS = 72;
  const SHOW = 8; // 銘柄ごとに最初に見せる件数
  const LABEL = { official: "公式", edinet: "EDINET", sec: "SEC" };
  let data = null;
  let filter = "all";

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  const fmtDate = (d) => {
    const [y, m, day] = d.split("-").map(Number);
    const wd = "日月火水木金土"[new Date(y, m - 1, day).getDay()];
    return `${y}/${m}/${day}(${wd})`;
  };
  const isFresh = (it) => Date.now() - new Date(it.first_seen).getTime() < FRESH_HOURS * 3600e3;
  const pass = (it) => filter === "all" || it.source === filter;

  function item(it, stock) {
    const li = el("li", "item");
    if (isFresh(it)) li.classList.add("fresh");
    const meta = el("span", "meta");
    meta.append(el("span", "date", fmtDate(it.date) + (it.time ? ` ${it.time}` : "")));
    meta.append(el("span", `badge src-${it.source}`, LABEL[it.source] || it.source));
    if (stock) meta.append(el("span", "stock", stock.name));
    if (isFresh(it)) meta.append(el("span", "badge new", "NEW"));
    const a = el("a", "title", it.title);
    a.href = it.url;
    a.target = "_blank";
    a.rel = "noopener";
    li.append(meta, a);
    return li;
  }

  function render() {
    const fresh = [];
    for (const s of data.stocks) for (const it of s.items) if (isFresh(it) && pass(it)) fresh.push([it, s]);
    fresh.sort((a, b) => (b[0].date + (b[0].time || "")).localeCompare(a[0].date + (a[0].time || "")));
    $("fresh").replaceChildren(...fresh.map(([it, s]) => item(it, s)));
    if (!fresh.length) $("fresh").append(el("li", "empty", "この3日間に見つけた新しい情報はありません"));
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
      if (s.home) {
        const a = el("a", null, "公式サイト");
        a.href = s.home;
        a.target = "_blank";
        a.rel = "noopener";
        links.append(a);
      }
      if (s.official_status && s.official_status !== "ok") links.append(el("span", "warn", `公式サイトのニュース: ${s.official_status}`));
      if (links.childNodes.length) sec.append(links);

      const ul = el("ul", "news");
      items.slice(0, SHOW).forEach((it) => ul.append(item(it)));
      if (!items.length) ul.append(el("li", "empty", "該当する情報はありません"));
      sec.append(ul);
      if (items.length > SHOW) {
        const more = el("details", "more");
        more.append(el("summary", null, `さらに ${items.length - SHOW} 件`));
        const ul2 = el("ul", "news");
        items.slice(SHOW).forEach((it) => ul2.append(item(it)));
        more.append(ul2);
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
      if (d.edinet !== "ok") notes.push(`EDINET: ${d.edinet}`);
      if (d.sec !== "ok") notes.push(`SEC: ${d.sec}`);
      $("status").textContent =
        `最終更新 ${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}` +
        (notes.length ? `(${notes.join("、")})` : "");
      render();
    })
    .catch(() => {
      $("status").textContent = "まだデータがありません。最初の更新をお待ちください。";
    });
})();
