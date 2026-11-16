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
      for (const g of groups.values()) {
        const it = g[0];
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
      sec.append(ul);
      return sec;
    };
    todays.forEach((d) => box.append(dayBlock(d)));
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
    const names = SG.labels(g.ids.map((x) => series[x].name));
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
