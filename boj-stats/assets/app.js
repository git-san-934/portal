(() => {
  // 新着は当日(日本時間)の分だけ表示する
  const todayJst = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
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
  const fmtDay = (d) => d.split("-").map(Number).join("/");
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
  const SG = window.SeriesGroups || { GROUPS: [], HIDDEN: new Set(), of: () => null, labels: (x) => x };

  function renderFeed() {
    const box = $("feed");
    box.replaceChildren();
    const days = data.days
      .map((d) => ({ date: d.date, items: d.items.filter((it) => (filter === "all" || it.kind === filter) && !SG.HIDDEN.has(it.id)) }))
      .filter((d) => d.items.length);
    const today = todayJst();
    const todays = days.filter((d) => d.date === today);
    if (!todays.length) {
      const last = days[0];
      box.append(el("p", "empty", `今日(${fmtDate(today)})の新着はまだありません` + (last ? `。最後の新着は ${fmtDate(last.date)} です` : "")));
      return;
    }
    const dayBlock = (d) => {
      const sec = el("div", "day");
      const h = el("h3", "day-title", fmtDate(d.date));
      if (d.date === todayJst()) h.append(el("span", "badge new", "今日"));
      sec.append(h);
      // 同じ系列の検知は1行にまとめる
      const groups = new Map();
      for (const it of d.items) {
        const k = it.kind + it.id;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(it);
      }
      h.insertBefore(el("span", "count", `${groups.size}件`), h.querySelector(".badge"));
      const ul = el("ul", "news");
      // e-Stat の新着: 取り込み済みの統計は値を添えて1行ずつ、ほかはまとめて折りたたむ。
      // その統計の系列の公表・変化は e-Stat の行にまとめるので、個別の行は出さない
      const estat = d.items.filter((it) => it.kind === "estat");
      const merged = new Set(estat.flatMap((it) => (it.stats || []).map((x) => x.id)));
      const shown = (x) => (x.stats && x.stats.length) || x.analysis;
      for (const it of estat.filter(shown)) ul.append(estatItem(it));
      for (const g of groups.values()) {
        const it = g[0];
        if (it.kind === "estat" || ((it.kind === "release" || it.kind === "signal") && merged.has(it.id))) continue;
        const li = el("li", "item");
        if (it.kind === "news") {
          // 日銀ホームページの新着情報: 日銀のページへ直接リンク
          const meta = el("span", "meta");
          meta.append(el("span", "badge news", "日銀"), el("span", null, it.time));
          const a = el("a", "title", it.name);
          if (isWebUrl(it.url)) a.href = it.url;
          a.target = "_blank";
          a.rel = "noopener";
          li.append(meta, a);
          ul.append(li);
          continue;
        }
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
      const rest = estat.filter((x) => !shown(x));
      if (rest.length) ul.append(estatRest(rest));
      // 件数は e-Stat にまとめた系列を除いて数え直す
      h.querySelector(".count").textContent = `${ul.children.length - (rest.length ? 1 : 0) + rest.length}件`;
      sec.append(ul);
      return sec;
    };
    todays.forEach((d) => box.append(dayBlock(d)));
  }

  // e-Stat の新着の見出し部分(バッジ・新着/更新・組織)
  function estatMeta(it) {
    const meta = el("span", "meta");
    meta.append(el("span", "badge estat", "e-Stat"));
    if (it.status) meta.append(el("span", null, it.status));
    if (it.org) meta.append(el("span", null, it.org));
    return meta;
  }
  const extLink = (cls, text, url) => {
    const a = el("a", cls, text);
    if (isWebUrl(url)) a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  };

  // 取り込み済みの統計: 系列ごとに最新値・前回比と、その日の検知を出す
  function estatItem(it) {
    const li = el("li", "item");
    const meta = estatMeta(it);
    if (it.published) meta.append(el("span", null, `${fmtDay(it.published)} 公表分の分析`));
    li.append(meta, extLink("title", it.name, it.url));
    const a = it.analysis;
    if (a) {
      // 日次チェックの分析: 要点の1文を出し、詳しい点と読んだ表は折りたたむ
      const sub = el("span", "sub analysis");
      if (a.period) sub.append(el("span", "note", `${a.period} `));
      sub.append(a.headline);
      // 分析ページ(グラフ・ポイント・この統計とは)へ
      if (a.date && a.toukei) {
        const go = el("a", "analysis-link", a.charts && a.charts.length ? "グラフで見る →" : "詳しく見る →");
        go.href = `estat.html?key=${encodeURIComponent(`${a.date}|${a.toukei}`)}`;
        sub.append(" ", go);
      }
      li.append(sub);
      if ((a.points && a.points.length) || (a.tables && a.tables.length)) {
        const det = el("details", "analysis-more");
        det.append(el("summary", null, "詳しく"));
        const pts = el("ul", "points");
        for (const p of a.points || []) pts.append(el("li", null, p));
        det.append(pts);
        const src = el("p", "note");
        src.append("読んだ表: ");
        (a.tables || []).forEach((t, i) => {
          if (i) src.append("、");
          src.append(t.url ? extLink(null, t.title, t.url) : t.title);
        });
        src.append(`(${fmtDay(a.analyzed_on)} 日次チェックで分析)`);
        det.append(src);
        li.append(det);
      }
    }
    for (const x of it.stats || []) {
      const sub = el("span", "sub");
      const a = el("a", null, x.name);
      a.href = link(x.id);
      sub.append(a, ` ${x.obs ? fmtObs(x.obs) : ""} `);
      sub.append(x.value != null ? `${x.value} ${x.unit}` : "値なし");
      if (x.change) sub.append("(前回比 ", el("span", dirCls(x.change), x.change), ")");
      if (!x.fresh) sub.append(el("span", "note", " ・取り込み済みの最新値"));
      li.append(sub);
      for (const g of x.signals || []) {
        const s2 = el("span", "sub signal-line");
        s2.append(el("span", dirCls(g.dir), `${g.type}・${g.dir}`), `: ${g.detail}`);
        li.append(s2);
      }
    }
    return li;
  }

  // 値を取り込んでいない統計: 件数だけ見せて、中身は折りたたむ
  function estatRest(list) {
    const li = el("li", "item");
    const det = el("details", "estat-rest");
    const sum = el("summary");
    sum.append(el("span", "badge estat", "e-Stat"), ` まだ分析していない政府統計の新着 ${list.length}件`);
    det.append(sum);
    const ul = el("ul", "estat-list");
    for (const it of list) {
      const li2 = el("li");
      li2.append(extLink(null, it.name, it.url), el("span", "note", ` ${it.org}${it.status ? "・" + it.status : ""}`));
      ul.append(li2);
    }
    det.append(ul);
    det.append(el("p", "note", "公表された表は、平日朝の日次チェック(6:52〜9:52)で読んで分析し、ここに載せます。"));
    li.append(det);
    return li;
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

  // まとめて表示する組の1行: 名前は組の名前、値は系列ごとに並べる
  function groupRow(g, series) {
    const tr = el("tr");
    const td = el("td");
    const a = el("a", null, g.name);
    a.href = link(g.ids[0]);
    const dates = g.ids.map((x) => series[x].date).filter(Boolean).sort();
    td.append(a, el("span", "sub", dates.length ? `${fmtObs(dates[dates.length - 1])}時点` : "未取得"));
    const v = el("td", "num");
    const names = SG.names ? SG.names(g, series) : SG.labels(g.ids.map((x) => series[x].name));
    g.ids.forEach((x, i) => {
      const s = series[x];
      const line = el("span", "sub");
      line.append(`${names[i]} ${s.value != null ? `${s.value} ${s.unit}` : "-"} `, el("span", dirCls(s.change), s.change || ""));
      v.append(line);
    });
    tr.append(td, v);
    return tr;
  }

  // 見出しの横の「(YYYY/M/D 更新)」: その中の系列で最後に新しい値が入った日
  const lastUpdated = (list) => list.map(([, s]) => s.updated).filter(Boolean).sort().pop() || "";
  const titleDate = (list) => {
    const d = lastUpdated(list);
    return d ? el("span", "title-date", ` (${fmtDay(d)} 更新)`) : "";
  };

  function renderTables() {
    const entries = Object.entries(data.series);
    const head = () => {
      const tr = el("tr");
      ["系列", "最新値・前回比"].forEach((t) => tr.append(el("th", null, t)));
      return tr;
    };
    // 毎日値が出る系列(金利・為替・国債利回り)はこのページに表示しない

    // 「短期金利・為替」の分類はこのページに表示しない(取得と系列ページは残す)
    const HIDDEN_CATS = new Set(["短期金利・為替"]);
    const cats = data.categories.map((c, i) => {
      if (HIDDEN_CATS.has(c)) return null;
      const list = entries.filter(([id, s]) => s.category === c && s.freq !== "D" && !SG.HIDDEN.has(id));
      if (!list.length) return null;
      // 分類ごとの表は最初は閉じておき、見出しを押すと開く
      const sec = el("details", "panel cat");
      sec.id = `c${i}`;
      const sum = el("summary");
      const h = el("h2", "panel-title", c);
      const cnt = el("span", "count");
      h.append(cnt, titleDate(list));
      sum.append(h);
      sec.append(sum);
      const t = el("table", "vals");
      t.append(head());
      const done = new Set();
      list.forEach(([id, s]) => {
        if (SG.HIDDEN.has(id) || done.has(id)) return;
        const g = SG.of(id);
        // 組の系列がそろっていれば1行にまとめる(個別の行は出さない)
        if (g && g.ids.every((x) => data.series[x])) {
          g.ids.forEach((x) => done.add(x));
          t.append(groupRow(g, data.series));
          return;
        }
        t.append(row(id, s));
      });
      cnt.textContent = `${t.rows.length - 1}系列`;
      sec.append(t);
      const a = el("a", null, c);
      a.href = `#c${i}`;
      // 上の分類リンクから飛んだときは開いて見せる
      a.addEventListener("click", () => { sec.open = true; });
      return { sec, a, last: lastUpdated(list) };
    });
    // 更新日の新しい分類から並べる(同じ日なら元の順)
    const shown = cats.filter(Boolean).sort((x, y) => y.last.localeCompare(x.last));
    $("jump").replaceChildren(...shown.map((x) => x.a));
    $("cats").replaceChildren(...shown.map((x) => x.sec));
    const target = location.hash && document.getElementById(location.hash.slice(1));
    if (target && target.matches("details.cat")) target.open = true;
  }

  // 取り込み状況: 失敗した系列・長く更新の無い系列があれば、最終更新の下に出す
  function renderFetchStatus(st) {
    const box = $("fetch-status");
    if (!st) return;
    const problems = st.problems || [];
    const others = st.other_errors || [];
    if (!problems.length && !others.length) {
      box.textContent = `前回の取得: 全${st.total}系列 正常`;
      box.className = "fetch-status ok";
      return;
    }
    const failed = problems.filter((p) => p.state === "error");
    const stale = problems.filter((p) => p.state === "stale");
    const parts = [];
    if (failed.length) parts.push(`${failed.length}系列が取得できませんでした(表示はそれより前に取れた値です)`);
    if (stale.length) parts.push(`${stale.length}系列はしばらく新しい値が入っていません`);
    if (others.length) parts.push("ほかに取得エラーがありました");
    const sum = document.createElement("summary");
    sum.textContent = `前回の取得: ${parts.join("。")}`;
    const ul = document.createElement("ul");
    for (const p of problems) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `series.html?id=${encodeURIComponent(p.id)}`;
      a.textContent = p.name;
      const why = p.state === "error"
        ? `取得失敗(最後に成功: ${p.last_ok ? fmtDate(p.last_ok) : "不明"})`
        : `${fmtDate(p.last_new)}から新しい値なし(最新 ${p.latest})`;
      li.append(a, ` … ${why}`);
      ul.append(li);
    }
    for (const e of others) {
      const li = document.createElement("li");
      li.textContent = e;
      ul.append(li);
    }
    const det = document.createElement("details");
    det.append(sum, ul);
    box.replaceChildren(det);
    box.className = "fetch-status warn";
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
      renderFetchStatus(d.fetch_status);
      if (d.trade_updated) $("trade-updated").textContent = ` (${fmtDay(d.trade_updated)} 更新)`;
      if (d.tankan_latest) $("tankan-latest").textContent = ` (${+d.tankan_latest.slice(0, 4)}年${+d.tankan_latest.slice(5)}月調査まで)`;
      $("disclaimer").textContent = d.disclaimer;
      renderFeed();
      renderTables();
    })
    .catch(() => {
      $("status").textContent = "まだデータがありません。最初の更新をお待ちください。";
    });
})();
