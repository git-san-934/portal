(function () {
  "use strict";

  var statusEl = document.getElementById("status");
  var daysEl = document.getElementById("days");
  var MARKS = ["◎", "○", "△", "×", "不明"];
  var WEEK = ["日", "月", "火", "水", "木", "金", "土"];

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fmtDate(iso) {
    var p = iso.split("-").map(Number);
    var d = new Date(p[0], p[1] - 1, p[2]);
    return p[0] + "年" + p[1] + "月" + p[2] + "日(" + WEEK[d.getDay()] + ")";
  }

  function yahooUrl(code) {
    return "https://finance.yahoo.co.jp/quote/" + encodeURIComponent(code) + ".T/chart?frm=mthly&trm=10y";
  }

  function markClass(m) {
    return { "◎": "m-best", "○": "m-good", "△": "m-part", "×": "m-bad" }[m] || "m-unknown";
  }

  var perf = {}; // "price_date|code" -> performance.json の行

  // ---------- 過去1年のチャート(data/charts/<price_date>_<code>.json) ----------
  var SVGNS = "http://www.w3.org/2000/svg";
  function svg(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function dnum(iso) { var p = iso.split("-").map(Number); return Date.UTC(p[0], p[1] - 1, p[2]) / 864e5; }
  function yen(v) { return Number(v).toLocaleString("ja-JP", { maximumFractionDigits: 1 }); }

  function drawChart(box, c) {
    var pts = c.close || [];
    if (pts.length < 2) { box.textContent = "チャートのデータがありません"; return; }
    var W = 600, H = 220, L = 8, R = 72, T = 14, B = 26;
    var x0 = dnum(pts[0][0]), x1 = dnum(pts[pts.length - 1][0]);
    var vals = pts.map(function (q) { return q[1]; }).concat((c.ma40w || []).map(function (q) { return q[1]; }));
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), pad = (hi - lo) * 0.08 || 1;
    lo -= pad; hi += pad;
    function X(d) { return L + (dnum(d) - x0) / (x1 - x0 || 1) * (W - L - R); }
    function Y(v) { return T + (hi - v) / (hi - lo) * (H - T - B); }
    function path(list) {
      return list.filter(function (q) { var n = dnum(q[0]); return n >= x0 && n <= x1; })
        .map(function (q, i) { return (i ? "L" : "M") + X(q[0]).toFixed(1) + " " + Y(q[1]).toFixed(1); }).join("");
    }
    var s = svg("svg", { viewBox: "0 0 " + W + " " + H, class: "chart-svg", role: "img",
      "aria-label": "過去1年の終値チャート" });
    // 横線と価格目盛り(右側)
    for (var i = 0; i <= 3; i++) {
      var v = lo + pad + (hi - lo - 2 * pad) * i / 3, y = Y(v);
      s.appendChild(svg("line", { x1: L, x2: W - R, y1: y, y2: y, class: "grid" }));
      var t = svg("text", { x: W - R + 6, y: y + 4, class: "tick" }); t.textContent = yen(Math.round(v)); s.appendChild(t);
    }
    // 月の目盛り(3か月ごと)
    var d0 = new Date(x0 * 864e5), m = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1));
    while (m.getTime() / 864e5 <= x1) {
      if (m.getUTCMonth() % 3 === 0) {
        var iso = m.toISOString().slice(0, 10), x = X(iso);
        s.appendChild(svg("line", { x1: x, x2: x, y1: T, y2: H - B, class: "grid" }));
        var mt = svg("text", { x: x, y: H - 6, class: "tick", "text-anchor": "middle" });
        mt.textContent = (m.getUTCMonth() === 0 ? m.getUTCFullYear() + "/" : "") + (m.getUTCMonth() + 1) + "月";
        s.appendChild(mt);
      }
      m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
    }
    if (c.ma40w && c.ma40w.length > 1) s.appendChild(svg("path", { d: path(c.ma40w), class: "ma" }));
    s.appendChild(svg("path", { d: path(pts), class: "line" }));
    var last = pts[pts.length - 1], lx = X(last[0]), ly = Y(last[1]);
    s.appendChild(svg("circle", { cx: lx, cy: ly, r: 3.5, class: "dot" }));
    box.appendChild(s);

    var closes = pts.map(function (q) { return q[1]; });
    var mx = Math.max.apply(null, closes), mn = Math.min.apply(null, closes);
    var first = pts[0][1], chg = (last[1] / first - 1) * 100;
    var leg = el("p", "chart-legend");
    leg.appendChild(el("span", "lg-line", "終値"));
    if (c.ma40w && c.ma40w.length > 1) leg.appendChild(el("span", "lg-ma", "40週線(200日線の目安)"));
    leg.appendChild(el("span", null, "1年の高値 " + yen(mx) + "円・安値 " + yen(mn) + "円・1年で " +
      (chg >= 0 ? "+" : "−") + Math.abs(chg).toFixed(0) + "%"));
    box.appendChild(leg);
  }

  function chartBox(p, day) {
    var wrap = el("div", "chart");
    wrap.appendChild(el("p", "sub-title", "過去1年の株価"));
    var box = el("div", "chart-box", "チャートを読み込み中...");
    wrap.appendChild(box);
    var pd = day.price_date || day.date;
    fetch("data/charts/" + pd + "_" + encodeURIComponent(p.code) + ".json")
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (c) { box.textContent = ""; drawChart(box, c); })
      .catch(function () { box.textContent = "チャートのデータがありません"; });
    return wrap;
  }

  function plText(r) {
    var v = r.ret_pct;
    var t = Math.abs(v) < 0.05 ? 0 : v;
    var diff = r.last_close - r.base;
    return "いま " + (t > 0 ? "+" : t < 0 ? "−" : "±") + Math.abs(t).toFixed(1) + "%(" +
      (diff > 0 ? "+" : diff < 0 ? "−" : "±") + Math.abs(diff).toLocaleString("ja-JP", { maximumFractionDigits: 1 }) + "円)";
  }

  function renderPick(p, day) {
    var card = el("article", "card");

    var head = el("div", "card-head");
    head.appendChild(el("span", "rank", String(p.rank)));
    var name = el("h3", "card-name");
    var a = el("a", null, p.name);
    a.href = yahooUrl(p.code);
    a.target = "_blank";
    a.rel = "noopener";
    name.appendChild(a);
    name.appendChild(el("span", "code", p.code + (p.market ? "・" + p.market : "")));
    head.appendChild(name);
    if (p.close != null) head.appendChild(el("span", "close", Number(p.close).toLocaleString("ja-JP") + "円"));
    var r = perf[(day.price_date || day.date) + "|" + p.code];
    if (r && r.ret_pct != null && r.last_close != null) {
      var t = Math.abs(r.ret_pct) < 0.05 ? "" : r.ret_pct > 0 ? " up" : " down";
      var pl = el("a", "pl" + t, plText(r));
      pl.href = "results.html";
      pl.title = "買値(" + r.entry_date + " の初値) " + r.base + "円 → " + r.last_date + " の終値 " + r.last_close + "円";
      head.appendChild(pl);
    }
    card.appendChild(head);

    var counts = {};
    (p.conditions || []).forEach(function (c) { counts[c.mark] = (counts[c.mark] || 0) + 1; });
    var tally = el("p", "tally");
    MARKS.forEach(function (m) {
      if (!counts[m]) return;
      var s = el("span", "chip " + markClass(m), m + " " + counts[m]);
      tally.appendChild(s);
    });
    card.appendChild(tally);

    if (p.headline) card.appendChild(el("p", "headline", p.headline));

    card.appendChild(chartBox(p, day));

    if (p.conditions && p.conditions.length) {
      var det = el("details", "conds");
      det.appendChild(el("summary", null, "12条件の判定"));
      var table = el("table");
      p.conditions.forEach(function (c) {
        var tr = el("tr");
        tr.appendChild(el("td", "no", String(c.no)));
        var td = el("td");
        td.appendChild(el("div", "label", c.label));
        td.appendChild(el("div", "value", c.value));
        tr.appendChild(td);
        tr.appendChild(el("td", "mark " + markClass(c.mark), c.mark));
        table.appendChild(tr);
      });
      det.appendChild(table);
      card.appendChild(det);
    }

    if (p.risks && p.risks.length) {
      card.appendChild(el("p", "sub-title", "リスク・懸念"));
      var ul = el("ul", "bullets");
      p.risks.forEach(function (r) { ul.appendChild(el("li", null, r)); });
      card.appendChild(ul);
    }

    if (p.sources && p.sources.length) {
      var src = el("p", "sources", "出典: ");
      p.sources.forEach(function (s, i) {
        if (i) src.appendChild(document.createTextNode("、"));
        var l = el("a", null, s.label);
        l.href = s.url;
        l.target = "_blank";
        l.rel = "noopener";
        src.appendChild(l);
      });
      card.appendChild(src);
    }
    return card;
  }

  function renderDay(day, isLatest) {
    var sec = el("section", "day" + (isLatest ? " latest" : ""));
    var h = el("h2", "day-title", fmtDate(day.date));
    if (isLatest) h.appendChild(el("span", "new", "最新"));
    sec.appendChild(h);
    if (day.price_date && day.price_date !== day.date) {
      sec.appendChild(el("p", "day-note", "株価は" + fmtDate(day.price_date) + "の終値"));
    }
    if (day.summary) sec.appendChild(el("p", "day-summary", day.summary));
    if (day.scope) sec.appendChild(el("p", "day-note", day.scope));
    var list = el("div", "cards");
    (day.picks || []).forEach(function (p) { list.appendChild(renderPick(p, day)); });
    sec.appendChild(list);
    return sec;
  }

  function load() {
    statusEl.classList.remove("error");
    statusEl.textContent = "読み込み中...";
    return fetch("data/picks.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      })
      .then(function (data) {
        var days = (data.days || []).slice().sort(function (a, b) {
          return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
        });
        daysEl.textContent = "";
        if (!days.length) {
          statusEl.textContent = "まだ記録がありません。";
          return;
        }
        statusEl.textContent = "最新: " + fmtDate(days[0].date) + "(" + days.length + "日分)";
        days.forEach(function (d, i) { daysEl.appendChild(renderDay(d, i === 0)); });
      })
      .catch(function () {
        statusEl.textContent = "データを読み込めませんでした。時間をおいて再読み込みしてください。";
        statusEl.classList.add("error");
      });
  }

  // 成績(performance.json)を先に読む。読めなくても一覧は出す
  fetch("data/performance.json?t=" + Date.now(), { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; })
    .then(function (d) {
      ((d && d.rows) || []).forEach(function (r) { perf[r.price_date + "|" + r.code] = r; });
      load();
    });
})();
