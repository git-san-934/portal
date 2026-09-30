(() => {
  const id = new URLSearchParams(location.search).get("id") || "";
  const $ = (x) => document.getElementById(x);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const fmtObs = (o) => {
    let m = o.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return `${m[1]}/${+m[2]}/${+m[3]}`;
    m = o.match(/^(\d{4})-(\d{2})$/);
    if (m) return `${m[1]}年${+m[2]}月`;
    m = o.match(/^(\d{4})Q(\d)$/);
    if (m) return `${m[1]}年${3 * m[2] - 2}-${3 * m[2]}月期`;
    return o;
  };
  const dirCls = (s) => (!s || /^[+-]0(\.0+)?(%|%pt)?$/.test(s) ? "" : /^[+上]/.test(s) ? "up" : s && /^[-−低]/.test(s) ? "down" : "");
  const fmtNum = (v) => (Math.abs(v) >= 1000 ? v.toLocaleString("ja-JP", { maximumFractionDigits: 0 }) : String(+v.toPrecision(6)));

  // 引用符つき CSV の最小限の読み取り
  function parseCSV(text) {
    const rows = [];
    let row = [], cur = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cur); rows.push(row); row = []; cur = "";
      } else cur += c;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    const [head, ...body] = rows.filter((r) => r.length > 1);
    return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
  }

  // 期の表記を年の小数に(横軸用)
  const toX = (d) => {
    let m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return +m[1] + (m[2] - 1) / 12 + (m[3] - 1) / 365;
    m = d.match(/^(\d{4})-(\d{2})$/);
    if (m) return +m[1] + (m[2] - 1) / 12;
    m = d.match(/^(\d{4})Q(\d)$/);
    if (m) return +m[1] + (m[2] - 1) / 4;
    return NaN;
  };

  function drawChart(points, marks, years) {
    const box = $("chart");
    const last = points.length ? points[points.length - 1].x : 0;
    const pts = years ? points.filter((p) => p.x >= last - years) : points;
    if (pts.length < 2) {
      box.replaceChildren(el("p", "empty", "チャートを描くだけの値がありません"));
      return;
    }
    const W = 420, H = 240, L = 58, R = 12, T = 12, B = 26;
    let lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v));
    if (lo === hi) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.06;
    lo -= pad; hi += pad;
    const x0 = pts[0].x, x1 = pts[pts.length - 1].x;
    const sx = (x) => L + ((x - x0) / (x1 - x0 || 1)) * (W - L - R);
    const sy = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("role", "img");
    const add = (tag, attrs, text) => {
      const e = document.createElementNS(ns, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      if (text != null) e.textContent = text;
      svg.append(e);
      return e;
    };
    for (let i = 0; i <= 4; i++) {
      const v = lo + ((hi - lo) * i) / 4;
      add("line", { class: "grid", x1: L, x2: W - R, y1: sy(v), y2: sy(v) });
      add("text", { x: L - 6, y: sy(v) + 4, "text-anchor": "end" }, fmtNum(v));
    }
    if (lo < 0 && hi > 0) add("line", { class: "grid", x1: L, x2: W - R, y1: sy(0), y2: sy(0), "stroke-dasharray": "4 3" });
    add("text", { x: L, y: H - 6 }, fmtObs(pts[0].d));
    add("text", { x: W - R, y: H - 6, "text-anchor": "end" }, fmtObs(pts[pts.length - 1].d));
    add("path", { class: "line", d: pts.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.v).toFixed(1)}`).join("") });
    for (const m of marks) {
      const p = pts.find((q) => q.d === m);
      if (p) add("circle", { class: "dot", cx: sx(p.x), cy: sy(p.v), r: 4 }).append(Object.assign(document.createElementNS(ns, "title"), { textContent: "検知した変化" }));
    }
    const lastP = pts[pts.length - 1];
    add("circle", { cx: sx(lastP.x), cy: sy(lastP.v), r: 3.5, fill: "var(--accent)" });
    box.replaceChildren(svg);
  }

  Promise.all([
    fetch(`data/feed.json?t=${Date.now()}`).then((r) => r.json()),
    fetch(`pipeline/data/${encodeURIComponent(id)}.csv?t=${Date.now()}`).then((r) => (r.ok ? r.text() : "")),
    fetch(`pipeline/reports/signals_log.csv?t=${Date.now()}`).then((r) => (r.ok ? r.text() : "")),
  ])
    .then(([feed, csv, log]) => {
      const s = feed.series[id];
      if (!s) {
        $("name").textContent = "系列が見つかりません";
        return;
      }
      document.title = `${s.name} - 日銀統計の新着`;
      $("name").textContent = s.name;
      $("cat").textContent = s.category;
      $("latest").replaceChildren(s.value != null ? `${s.value}` : "-", el("small", null, s.unit));
      $("meta").replaceChildren(s.date ? `${fmtObs(s.date)}時点` : "", s.change ? " 前回比 " : "", el("span", dirCls(s.change), s.change || ""));
      $("source").textContent = s.source[0];
      $("source").href = s.source[1];
      $("code").textContent = `(系列コード ${s.db} ${s.code})`;
      $("disclaimer").textContent = feed.disclaimer;
      if (s.implication) {
        $("implication").textContent = s.implication;
        $("implication-panel").hidden = false;
      }

      const sigs = parseCSV(log).filter((r) => r.db === s.db && r.code === s.code).reverse();
      const ul = $("signals");
      sigs.forEach((r) => {
        const li = el("li", "item");
        li.append(el("span", "meta", `${fmtObs(r.obs_date)}分(${r.detected_on} に検知)`));
        const t = el("span", "title");
        t.append(el("span", dirCls(r.dir), `${r.type}・${r.dir}`), `: ${r.detail}`);
        li.append(t);
        ul.append(li);
      });
      if (!sigs.length) ul.append(el("li", "empty", "まだ検知した変化はありません"));

      const rows = csv ? parseCSV(csv).filter((r) => r.value !== "" && r.value != null) : [];
      const points = rows.map((r) => ({ d: r.date, x: toX(r.date), v: +r.value })).filter((p) => !isNaN(p.x) && !isNaN(p.v));
      const marks = sigs.map((r) => r.obs_date);
      const ranges = s.freq === "D" ? [["3か月", 0.25], ["1年", 1], ["3年", 3], ["10年", 10], ["全期間", 0]] : [["3年", 3], ["5年", 5], ["10年", 10], ["全期間", 0]];
      const def = s.freq === "D" ? 1 : s.freq === "Q" ? 10 : 5;
      const nav = $("ranges");
      ranges.forEach(([label, y]) => {
        const b = el("button", null, label);
        b.type = "button";
        b.setAttribute("aria-pressed", String(y === def));
        b.addEventListener("click", () => {
          nav.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
          drawChart(points, marks, y);
        });
        nav.append(b);
      });
      drawChart(points, marks, def);

      const tbl = $("recent");
      const head = el("tr");
      ["時点", "値", "前回比"].forEach((t) => head.append(el("th", null, t)));
      tbl.append(head);
      const n = s.freq === "D" ? 20 : 12;
      for (let i = points.length - 1; i >= Math.max(0, points.length - n); i--) {
        const p = points[i], q = points[i - 1];
        let ch = "";
        if (q) {
          const diff = s.kind === "level" ? (q.v ? (p.v / q.v - 1) * 100 : NaN) : p.v - q.v;
          if (!isNaN(diff)) ch = s.kind === "level" ? `${diff >= 0 ? "+" : ""}${diff.toFixed(2)}%` : s.kind === "rate" ? `${diff >= 0 ? "+" : ""}${diff.toFixed(3)}%pt` : `${diff >= 0 ? "+" : ""}${fmtNum(diff)}${s.unit}`;
        }
        const tr = el("tr");
        tr.append(el("td", "date", fmtObs(p.d)), el("td", "num", `${fmtNum(p.v)} ${s.unit}`), el("td", `num ${dirCls(ch)}`, ch));
        tbl.append(tr);
      }
      if (!points.length) tbl.append(el("tr", null)).append(el("td", "empty", "値がありません"));
    })
    .catch(() => {
      $("name").textContent = "データを読み込めませんでした";
    });
})();
