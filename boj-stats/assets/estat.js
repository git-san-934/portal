// 政府統計(e-Stat)の新着の分析ページ。日次チェックが表を読んで書いた分析(reports/estat_analysis.json)を、
// 要点・グラフ・ポイント・この統計とは・もとにした表の順に出す。key が無ければ分析の一覧
(() => {
  const key = new URLSearchParams(location.search).get("key") || "";
  const $ = (x) => document.getElementById(x);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const isWebUrl = (u) => /^https?:\/\//i.test(u || "");
  const fmtDay = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
  const page = (k) => `estat.html?key=${encodeURIComponent(k)}`;
  const COLORS = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)"];

  // 値の表示: 大きい数は桁区切り、小数は2桁まで。単位はそのまま後ろに付ける
  const num = (v, dg) =>
    v.toLocaleString("ja-JP", dg == null ? { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 } : { minimumFractionDigits: dg, maximumFractionDigits: dg });
  const fmt = (v, unit) => (v == null || !isFinite(v) ? "-" : `${num(v)}${unit || ""}`);

  // 横棒(項目ごとの比較)。series が2本以上なら項目ごとに並べ、stacked なら積み上げる。マイナスは0から左へ
  function barChart(c) {
    const box = el("div", "hbar");
    const vals = c.series.flatMap((s) => s.values).filter((v) => v != null && isFinite(v));
    const sums = c.stacked
      ? c.labels.map((_, i) => c.series.reduce((t, s) => t + (s.values[i] || 0), 0))
      : [];
    let lo = Math.min(0, ...vals);
    let hi = Math.max(0, ...vals, ...sums);
    if (hi === lo) hi = lo + 1;
    const pos = (v) => ((v - lo) / (hi - lo)) * 100;
    const zero = pos(0);
    const span = (from, to, color) => {
      const b = el("span", "hb-bar");
      const a = Math.min(pos(from), pos(to)), z = Math.max(pos(from), pos(to));
      b.style.left = `${a}%`;
      b.style.width = `${Math.max(z - a, 0.4)}%`;
      b.style.background = color;
      return b;
    };
    c.labels.forEach((label, i) => {
      const row = el("div", "hb-row");
      row.append(el("div", "hb-label", label));
      const bars = el("div", "hb-bars");
      const line = (parts, value) => {
        const ln = el("div", "hb-line");
        const track = el("div", "hb-track");
        if (lo < 0) {
          const z = el("span", "hb-zero");
          z.style.left = `${zero}%`;
          track.append(z);
        }
        track.append(...parts);
        ln.append(track, el("span", "hb-val", fmt(value, c.unit)));
        return ln;
      };
      if (c.stacked) {
        let acc = 0;
        const parts = [];
        c.series.forEach((s, j) => {
          const v = s.values[i];
          if (v == null || !isFinite(v)) return;
          parts.push(span(acc, acc + v, COLORS[j]));
          acc += v;
        });
        bars.append(line(parts, sums[i]));
      } else {
        c.series.forEach((s, j) => {
          const v = s.values[i];
          bars.append(line(v == null || !isFinite(v) ? [] : [span(0, v, COLORS[j])], v));
        });
      }
      row.append(bars);
      box.append(row);
    });
    return box;
  }

  function legend(c) {
    const lg = el("div", "legend");
    if (c.series.length < 2) return lg;
    c.series.forEach((s, j) => {
      const sp = el("span");
      const i = el("i");
      i.style.background = COLORS[j];
      sp.append(i, s.name);
      lg.append(sp);
    });
    return lg;
  }

  function chartPanel(c) {
    const sec = el("section", "panel");
    sec.append(el("h2", "chart-head estat-chart-head", c.title));
    if (c.type === "line") {
      const lg = el("div", "legend");
      const box = el("div", "chart tchart");
      sec.append(lg, box);
      const idx = Object.fromEntries(c.labels.map((d, i) => [d, i]));
      const vals = c.series.flatMap((s) => s.values).filter((v) => v != null && isFinite(v));
      window.MultiLine.draw(box, c.series.length > 1 ? lg : null, {
        months: c.labels,
        lines: c.series.map((s, j) => ({ name: s.name, color: COLORS[j], val: (d) => (s.values[idx[d]] == null ? NaN : s.values[idx[d]]) })),
        fmtX: (d) => d,
        fmt: (v) => fmt(v, c.unit),
        tick: (v, dg) => num(v, dg),
        nice: true,
        zero: false,
        signed: vals.some((v) => v < 0),
        trim: false,
        dots: c.labels.length <= 24,
        label: c.title,
      });
    } else {
      sec.append(legend(c), barChart(c));
    }
    const note = el("p", "note sub", `単位: ${c.unit || "-"}${c.note ? `。${c.note}` : ""}`);
    sec.append(note);
    return sec;
  }

  function historyItem(k, a, current) {
    const li = el("li", "item");
    const meta = el("span", "meta");
    meta.append(el("span", "badge estat", "e-Stat"), el("span", null, `${fmtDay(a.date)} 公表`));
    if (a.period) meta.append(el("span", null, a.period));
    if (a.charts && a.charts.length) meta.append(el("span", null, "グラフあり"));
    const t = el("a", "title", current ? a.name : a.headline);
    t.href = page(k);
    li.append(meta, t);
    if (current) li.append(el("span", "sub", a.headline));
    return li;
  }

  function showList(items) {
    document.title = "政府統計の分析 - 日銀統計の新着";
    $("name").textContent = "政府統計の分析";
    $("headline").textContent = "e-Stat の新着のうち、日次チェックが公表された表を読んで分析したものです。";
    $("history-panel").hidden = false;
    $("history-panel").querySelector(".panel-title").textContent = "分析の一覧(新しい順)";
    for (const [k, a] of Object.entries(items)) $("history").append(historyItem(k, a, true));
    $("tables").closest(".panel").hidden = true;
  }

  function show(items, a) {
    document.title = `${a.name} - 政府統計の分析`;
    $("cat").textContent = `e-Stat・${a.org}・${fmtDay(a.date)} 公表`;
    $("name").textContent = a.name;
    $("period").textContent = a.period || "";
    $("headline").textContent = a.headline;
    const charts = $("charts");
    for (const c of a.charts || []) charts.append(chartPanel(c));
    if (a.points && a.points.length) {
      $("points-panel").hidden = false;
      for (const p of a.points) $("points").append(el("li", null, p));
    }
    if (a.about) {
      $("about-panel").hidden = false;
      $("about").textContent = a.about;
    }
    for (const t of a.tables || []) {
      const li = el("li");
      if (isWebUrl(t.url)) {
        const x = el("a", null, t.title);
        x.href = t.url;
        x.target = "_blank";
        x.rel = "noopener";
        li.append(x, el("span", "note", " (ダウンロード)"));
      } else li.append(t.title);
      $("tables").append(li);
    }
    const all = el("li");
    const ex = el("a", null, "e-Stat でこの統計のファイル一覧を見る");
    ex.href = `https://www.e-stat.go.jp/stat-search/files?toukei=${encodeURIComponent(a.toukei)}&layout=dataset`;
    ex.target = "_blank";
    ex.rel = "noopener";
    all.append(ex);
    $("tables").append(all);
    $("analyzed").textContent = `${fmtDay(a.analyzed_on)} の日次チェックで、表の数値を読んで分析しました。`;
    const past = Object.entries(items).filter(([k, x]) => x.toukei === a.toukei && k !== key);
    if (past.length) {
      $("history-panel").hidden = false;
      for (const [k, x] of past) $("history").append(historyItem(k, x, false));
    }
  }

  fetch(`pipeline/reports/estat_analysis.json?t=${Date.now()}`)
    .then((r) => r.json())
    .then((d) => {
      const items = d.items || {};
      const a = items[key];
      if (!key) return showList(items);
      if (!a) {
        showList(items);
        $("headline").textContent = "この分析は見つかりませんでした(公表から120日を過ぎた分は消えます)。ほかの分析はこちらです。";
        return;
      }
      show(items, a);
    })
    .catch(() => {
      $("name").textContent = "分析を読み込めませんでした";
    });
})();
