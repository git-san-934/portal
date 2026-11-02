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
    return "https://finance.yahoo.co.jp/quote/" + encodeURIComponent(code) + ".T";
  }

  function markClass(m) {
    return { "◎": "m-best", "○": "m-good", "△": "m-part", "×": "m-bad" }[m] || "m-unknown";
  }

  function renderPick(p) {
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
    (day.picks || []).forEach(function (p) { list.appendChild(renderPick(p)); });
    sec.appendChild(list);
    return sec;
  }

  fetch("data/picks.json?t=" + Date.now(), { cache: "no-store" })
    .then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    })
    .then(function (data) {
      var days = (data.days || []).slice().sort(function (a, b) {
        return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
      });
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
})();
