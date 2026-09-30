(() => {
  const SHOW_DAYS = 14; // 最初に見せる日数(残りは「さらに表示」)
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
  // 観測期の表記: 2026-08 → 2026年8月分, 2026Q2 → 2026年4-6月期, 2026-09-28 → 9/28
  const fmtObs = (o) => {
    let m = o.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return `${+m[2]}/${+m[3]}`;
    m = o.match(/^(\d{4})-(\d{2})$/);
    if (m) return `${m[1]}年${+m[2]}月分`;
    m = o.match(/^(\d{4})Q(\d)$/);
    if (m) return `${m[1]}年${3 * m[2] - 2}-${3 * m[2]}月期`;
    return o;
  };
  const dirCls = (s) => (!s || /^[+-]0(\.0+)?(%|%pt)?$/.test(s) ? "" : /^[+上]/.test(s) ? "up" : s && /^[-−低]/.test(s) ? "down" : "");
  const link = (id) => `series.html?id=${encodeURIComponent(id)}`;

  function renderFeed() {
    const box = $("feed");
    box.replaceChildren();
    const days = data.days
      .map((d) => ({ date: d.date, items: d.items.filter((it) => filter === "all" || it.kind === filter) }))
      .filter((d) => d.items.length);
    if (!days.length) {
      box.append(el("p", "empty", "該当する新着はありません"));
      return;
    }
    const dayBlock = (d) => {
      const sec = el("div", "day");
      const h = el("h3", "day-title", fmtDate(d.date));
      if (d.date === data.report_date) h.append(el("span", "badge new", "今日"));
      sec.append(h);
      // 同じ系列の検知は1行にまとめる
      const groups = new Map();
      for (const it of d.items) {
        const k = it.kind + it.id;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(it);
      }
      const ul = el("ul", "news");
      for (const g of groups.values()) {
        const it = g[0];
        const li = el("li", "item");
        const meta = el("span", "meta");
        meta.append(el("span", `badge ${it.kind}`, it.kind === "release" ? "公表" : "変化"));
        meta.append(el("span", null, fmtObs(it.obs)));
        const a = el("a", "title", it.name);
        a.href = link(it.id);
        li.append(meta, a);
        if (it.kind === "release") {
          const sub = el("span", "sub");
          sub.append(it.value != null ? `${it.value} ${it.unit}` : "値なし");
          if (it.change) sub.append("(前回比 ", el("span", dirCls(it.change), it.change), ")");
          li.append(sub);
        } else {
          for (const x of g) {
            const sub = el("span", "sub");
            sub.append(el("span", dirCls(x.dir), `${x.type}・${x.dir}`), `: ${x.detail}`);
            if (x.obs !== it.obs) sub.append(`(${fmtObs(x.obs)})`);
            li.append(sub);
          }
        }
        ul.append(li);
      }
      sec.append(ul);
      return sec;
    };
    days.slice(0, SHOW_DAYS).forEach((d) => box.append(dayBlock(d)));
    if (days.length > SHOW_DAYS) {
      const more = el("details", "more");
      more.append(el("summary", null, `さらに ${days.length - SHOW_DAYS} 日分`));
      days.slice(SHOW_DAYS).forEach((d) => more.append(dayBlock(d)));
      box.append(more);
    }
  }

  function row(id, s) {
    const tr = el("tr");
    const td = el("td");
    const a = el("a", null, s.name);
    a.href = link(id);
    td.append(a, el("span", "sub", s.date ? `${fmtObs(s.date)}時点` : "未取得"));
    const v = el("td", "num");
    v.append(el("span", null, s.value != null ? `${s.value} ${s.unit}` : "-"), el("span", `sub ${dirCls(s.change)}`, s.change || ""));
    tr.append(td, v);
    return tr;
  }

  function renderTables() {
    const entries = Object.entries(data.series);
    const head = () => {
      const tr = el("tr");
      ["系列", "最新値・前回比"].forEach((t) => tr.append(el("th", null, t)));
      return tr;
    };
    const daily = $("daily");
    daily.replaceChildren(head());
    entries.filter(([, s]) => s.freq === "D").forEach(([id, s]) => daily.append(row(id, s)));

    const jump = [];
    const cats = data.categories.map((c, i) => {
      const list = entries.filter(([, s]) => s.category === c && s.freq !== "D");
      if (!list.length) return null;
      const sec = el("section", "panel");
      sec.id = `c${i}`;
      sec.append(el("h2", "panel-title", c));
      const t = el("table", "vals");
      t.append(head());
      list.forEach(([id, s]) => t.append(row(id, s)));
      sec.append(t);
      const a = el("a", null, c);
      a.href = `#c${i}`;
      jump.push(a);
      return sec;
    });
    $("jump").replaceChildren(...jump);
    $("cats").replaceChildren(...cats.filter(Boolean));
  }

  document.querySelectorAll(".filters button").forEach((b) =>
    b.addEventListener("click", () => {
      filter = b.dataset.filter;
      document.querySelectorAll(".filters button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      renderFeed();
    })
  );

  fetch(`data/feed.json?t=${Date.now()}`)
    .then((r) => {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    })
    .then((d) => {
      data = d;
      const t = new Date(d.generated_at);
      $("status").textContent = `最終更新: ${fmtDate(d.report_date)} ${t.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" })}`;
      $("disclaimer").textContent = d.disclaimer;
      renderFeed();
      renderTables();
    })
    .catch(() => {
      $("status").textContent = "まだデータがありません。最初の更新をお待ちください。";
    });
})();
