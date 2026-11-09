(function () {
  "use strict";

  var statusEl = document.getElementById("status");
  var sumEl = document.getElementById("summary");
  var tbody = document.querySelector("#results tbody");
  var WEEK = ["日", "月", "火", "水", "木", "金", "土"];

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function md(iso) {
    if (!iso) return "";
    var p = iso.split("-").map(Number);
    return p[1] + "/" + p[2] + "(" + WEEK[new Date(p[0], p[1] - 1, p[2]).getDay()] + ")";
  }
  function yen(v) { return v == null ? "—" : Number(v).toLocaleString("ja-JP", { maximumFractionDigits: 1 }); }
  function pct(v) {
    if (v == null) return "—";
    var t = Math.abs(v) < 0.05 ? 0 : v;
    return (t > 0 ? "+" : t < 0 ? "−" : "±") + Math.abs(t).toFixed(1) + "%";
  }
  function sign(v) { return v == null || Math.abs(v) < 0.05 ? "" : v > 0 ? "up" : "down"; }
  function yahooUrl(code) {
    return "https://finance.yahoo.co.jp/quote/" + encodeURIComponent(code) + ".T/chart?frm=mthly&trm=10y";
  }

  function stat(label, value, cls, note) {
    var d = el("div", "stat");
    d.appendChild(el("div", "stat-label", label));
    d.appendChild(el("div", "stat-value " + (cls || ""), value));
    if (note) d.appendChild(el("div", "stat-note", note));
    return d;
  }

  function renderSummary(s) {
    sumEl.textContent = "";
    sumEl.appendChild(stat("平均の騰落率(最新)", pct(s.avg_ret_pct), sign(s.avg_ret_pct), s.with_data + "件"));
    sumEl.appendChild(stat("上がった割合", s.win_rate_pct == null ? "—" : s.win_rate_pct.toFixed(0) + "%", "", "基準より上の件数"));
    [1, 3, 5, 10, 20].forEach(function (h) {
      var v = s["avg_" + h + "d_pct"];
      if (v != null) sumEl.appendChild(stat(h + "営業日後の平均", pct(v), sign(v), s["n_" + h + "d"] + "件"));
    });
    sumEl.appendChild(stat("本のルールで決済", s.closed + "件", "", "うち利益 " + s.closed_wins + "件・合計 " + (s.closed_sum_r > 0 ? "+" : "") + s.closed_sum_r + "R"));
    sumEl.appendChild(stat("保有中", s.open + "件", ""));
  }

  function ruleCell(r) {
    var td = el("td", "rule");
    var st = r.status || "";
    var cls = st.indexOf("利確") === 0 ? "win" : st === "損切り" ? "loss" : st === "高値後の安値割れ" ? "exit" : st === "保有中" ? "hold" : "none";
    td.appendChild(el("span", "badge " + cls, st));
    if (r.exit) {
      td.appendChild(el("div", "rule-note", md(r.exit.date) + " " + yen(r.exit.price) + "円 " + pct(r.exit.ret_pct) + "(" + (r.exit.r > 0 ? "+" : "") + r.exit.r + "R)"));
    } else if (r.open_r != null) {
      td.appendChild(el("div", "rule-note", "いま " + (r.open_r > 0 ? "+" : "") + r.open_r + "R"));
    }
    return td;
  }

  function renderRows(rows) {
    tbody.textContent = "";
    rows.forEach(function (r) {
      var tr = el("tr");
      var d = el("td", "date", md(r.price_date));
      if (r.rank) d.appendChild(el("div", "sub", r.rank + "位"));
      tr.appendChild(d);
      var n = el("td", "name");
      var a = el("a", null, r.name);
      a.href = yahooUrl(r.code); a.target = "_blank"; a.rel = "noopener";
      n.appendChild(a);
      n.appendChild(el("div", "sub", r.code));
      tr.appendChild(n);
      tr.appendChild(el("td", "num", yen(r.base)));
      var last = el("td", "num", yen(r.last_close));
      if (r.last_date) last.appendChild(el("div", "sub", md(r.last_date)));
      tr.appendChild(last);
      tr.appendChild(el("td", "num strong " + sign(r.ret_pct), pct(r.ret_pct)));
      tr.appendChild(el("td", "num " + sign(r.max_up_pct), r.max_up_pct == null ? "—" : pct(r.max_up_pct)));
      tr.appendChild(el("td", "num " + sign(r.max_down_pct), r.max_down_pct == null ? "—" : pct(r.max_down_pct)));
      var sl = el("td", "num", r.stop == null ? "—" : yen(r.stop) + " / " + yen(r.target));
      if (r.risk_pct != null) sl.appendChild(el("div", "sub", "−" + r.risk_pct + "% / +" + r.target_pct + "%"));
      tr.appendChild(sl);
      tr.appendChild(ruleCell(r));
      tbody.appendChild(tr);
    });
  }

  fetch("data/performance.json?t=" + Date.now(), { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (data) {
      statusEl.textContent = "株価は " + md(data.latest_price_date) + " の終値まで(更新 " + (data.updated_at || "").replace("T", " ").slice(0, 16) + ")";
      renderSummary(data.summary || {});
      renderRows(data.rows || []);
    })
    .catch(function () {
      statusEl.textContent = "データを読み込めませんでした。時間をおいて再読み込みしてください。";
      statusEl.classList.add("error");
    });
})();
