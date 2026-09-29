(() => {
  "use strict";

  const DATA_URL = "data/nav.json";
  const STORE_KEY = "nikkei43-settings";
  const WINDOW = 20; // 20営業日の高値からの下落率で判定する

  // 追加買いの段階。20日高値からの下落率が th 以下なら、次の営業日に amount 円を上乗せする(「ふつう」の大きさ)
  const TIERS = [
    { th: -0.3, amount: 30000, color: "var(--tier1)" },
    { th: -0.4, amount: 60000, color: "var(--tier2)" },
    { th: -0.5, amount: 100000, color: "var(--tier3)" },
  ];
  const SCALE_OPTIONS = [
    { key: 0.5, label: "控えめ(½)" },
    { key: 1, label: "ふつう" },
    { key: 2, label: "多め(×2)" },
  ];
  const PERIOD_OPTIONS = [
    { key: "m3", label: "3ヶ月", days: 63 },
    { key: "y1", label: "1年", days: 245 },
    { key: "y3", label: "3年", days: 735 },
    { key: "all", label: "全期間", days: null },
  ];
  const DEFAULTS = { start: "2026-09-28", daily: 10000, scale: 1, period: "y1" };

  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");

  const yen = (v) => `${Math.round(v).toLocaleString("ja-JP")}円`;
  const man = (v) => {
    const m = v / 10000;
    return `${m.toLocaleString("ja-JP", { maximumFractionDigits: m < 10 ? 1 : 0 })}万円`;
  };
  const pctText = (v, digits = 1) => {
    if (v == null || !isFinite(v)) return "—";
    const s = Math.abs(v * 100).toLocaleString("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return v > 0 ? `+${s}%` : v < 0 ? `−${s}%` : `${s}%`;
  };
  const pctClass = (v) => (v == null || v === 0 ? "pct" : v > 0 ? "pct up" : "pct down");
  const WD = ["日", "月", "火", "水", "木", "金", "土"];
  const parseISO = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  };
  const dateJa = (iso) => {
    const d = parseISO(iso);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
  };
  const nextWeekday = (iso) => {
    const d = parseISO(iso);
    do d.setDate(d.getDate() + 1);
    while (d.getDay() === 0 || d.getDay() === 6);
    return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
  };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---------- 設定(この端末にだけ保存) ----------

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
      return { ...DEFAULTS, ...s };
    } catch {
      return { ...DEFAULTS };
    }
  }
  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state.settings));
    } catch {
      /* 保存できない環境でも表示は続ける */
    }
  }

  const state = { dates: [], nav: [], high: [], dd: [], settings: loadSettings(), charts: [] };

  // ---------- 計算 ----------

  function prepare(data) {
    state.dates = data.dates;
    state.nav = data.nav;
    const n = data.nav.length;
    state.high = new Array(n);
    state.dd = new Array(n);
    for (let i = 0; i < n; i++) {
      let h = 0;
      for (let k = Math.max(0, i - WINDOW + 1); k <= i; k++) h = Math.max(h, data.nav[k]);
      state.high[i] = h;
      state.dd[i] = data.nav[i] / h - 1;
    }
  }

  // 下落率から段階(0 = 追加なし, 1〜3)
  function tierOf(dd) {
    let t = 0;
    TIERS.forEach((x, i) => {
      if (dd <= x.th) t = i + 1;
    });
    return t;
  }
  const extraOf = (dd, scale) => {
    const t = tierOf(dd);
    return t ? TIERS[t - 1].amount * scale : 0;
  };

  // start〜end(両端含む)の日に毎日 daily 円を買い、前の営業日に合図が出ていたら追加額も買う
  function simulate(start, end, daily, scale) {
    let units = 0, invested = 0, extra = 0, count = 0;
    for (let i = start; i <= end; i++) {
      const nav = state.nav[i];
      units += daily / nav;
      invested += daily;
      if (scale > 0 && i - 1 >= start) {
        const a = extraOf(state.dd[i - 1], scale);
        if (a) {
          units += a / nav;
          invested += a;
          extra += a;
          count++;
        }
      }
    }
    const value = units * state.nav[end];
    return { invested, extra, count, units, value, ret: invested ? value / invested - 1 : 0 };
  }

  // ---------- 今日のアドバイス ----------

  function renderAdvice() {
    const last = state.nav.length - 1;
    const dd = state.dd[last];
    const t = tierOf(dd);
    const { daily, scale } = state.settings;
    const extra = extraOf(dd, scale);

    $("advice").classList.toggle("on", t > 0);
    $("advice-when").textContent = `${dateJa(state.dates[last])} の基準価額で判定 → 次の営業日 ${nextWeekday(state.dates[last])} の注文`;
    const amount = $("advice-amount");
    amount.textContent = "";
    if (t > 0) {
      amount.append(`${man(daily)} `, Object.assign(el("span", "plus"), { textContent: `+ 追加 ${man(extra)}` }));
    } else {
      amount.textContent = `いつもどおり ${man(daily)}`;
    }

    const next = TIERS[t]; // 次の段階(なければ undefined)
    let reason = `20日高値(${yen(state.high[last])})から ${pctText(dd)}。`;
    if (t === 0) {
      reason += `追加買いの目安(−30%)まで、あと ${(Math.abs(TIERS[0].th - dd) * 100).toFixed(1)}ポイントです。`;
    } else {
      reason += `第${t}段階の暴落ラインを下回っています。`;
      if (next) reason += ` さらに ${(Math.abs(next.th - dd) * 100).toFixed(1)}ポイント下がると追加額を ${man(next.amount * scale)} に増やします。`;
    }
    $("advice-reason").textContent = reason;

    const ladder = $("ladder");
    ladder.textContent = "";
    const steps = [{ th: null, amount: 0, color: "var(--border)" }, ...TIERS];
    steps.forEach((s, i) => {
      const box = el("div", "step" + (i === t ? " current" : ""));
      const title = el("div");
      const sw = el("span", "swatch");
      sw.style.background = s.color;
      title.append(sw, s.th == null ? "−30%より浅い" : `−${Math.round(-s.th * 100)}%以下`);
      box.append(title, el("b", null, s.th == null ? "追加なし" : `+${man(s.amount * scale)}`));
      box.append(
        el("span", "lv", s.th == null ? `${yen(Math.floor(state.high[last] * (1 + TIERS[0].th)))}より上` : `${yen(Math.floor(state.high[last] * (1 + s.th)))}以下`)
      );
      ladder.append(box);
    });

    const staleDays = (Date.now() - parseISO(state.dates[last]).getTime()) / 86400000;
    $("advice-note").textContent =
      (staleDays > 4 ? "⚠ データが数日更新されていません。最新の基準価額を確かめてから判断してください。 " : "") +
      "金額の下の値は、今の20日高値で換算した基準価額の目安です。追加額の大きさは「自分の積立シミュレーション」で変えられます。";
  }

  function tile(label, value, sub, cls) {
    const box = el("dl", "tile");
    box.append(el("dt", null, label));
    const dd = el("dd", cls || null, value);
    if (sub) dd.append(" ", el("small", null, sub));
    box.append(dd);
    return box;
  }

  function renderTiles() {
    const n = state.nav.length - 1;
    const nav = state.nav;
    const ath = Math.max(...nav);
    const back = (k) => (n - k >= 0 ? nav[n] / nav[n - k] - 1 : null);
    const box = $("tiles");
    box.textContent = "";
    box.append(
      tile("基準価額", yen(nav[n]), `${state.dates[n].slice(5).replace("-", "/")}`),
      tile("前日比", pctText(back(1)), null, pctClass(back(1))),
      tile("20日高値から", pctText(state.dd[n]), null, pctClass(state.dd[n])),
      tile("過去最高値から", pctText(nav[n] / ath - 1), null, pctClass(nav[n] / ath - 1)),
      tile("1ヶ月", pctText(back(21)), null, pctClass(back(21))),
      tile("1年", pctText(back(245)), null, pctClass(back(245)))
    );
  }

  // ---------- チャート ----------

  const SVG = "http://www.w3.org/2000/svg";
  const W = 1000;
  const H = 100;

  function svgEl(tag, attrs) {
    const e = document.createElementNS(SVG, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function periodRange() {
    const n = state.nav.length;
    const p = PERIOD_OPTIONS.find((x) => x.key === state.settings.period) || PERIOD_OPTIONS[1];
    return [p.days ? Math.max(0, n - p.days) : 0, n - 1];
  }

  function xLabels(s, e) {
    const span = e - s;
    const out = [];
    let prev = null;
    for (let i = s; i <= e; i++) {
      const [y, m] = state.dates[i].split("-");
      let key, text;
      if (span <= 130) {
        key = y + m;
        text = `${Number(m)}月`;
      } else if (span <= 400) {
        if ((Number(m) - 1) % 3 !== 0) continue;
        key = y + m;
        text = `${y.slice(2)}/${Number(m)}`;
      } else {
        key = y;
        text = span > 1500 && Number(y) % 2 ? null : y;
      }
      if (key !== prev) {
        if (prev !== null && text) out.push({ i, text });
        prev = key;
      }
    }
    return out;
  }

  // box にチャートを描き、ホバー位置を他のチャートと合わせるための関数を返す
  function drawChart(box, { s, e, series, lo, hi, ticks, tickFmt, hlines = [], marks = [], tipFor, dotSeries }) {
    box.textContent = "";
    const x = (i) => ((i - s) / Math.max(1, e - s)) * W;
    const y = (v) => H - ((v - lo) / (hi - lo)) * H;
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", "aria-hidden": "true" });
    ticks.forEach((t) => svg.append(svgEl("line", { x1: 0, x2: W, y1: y(t), y2: y(t), class: "grid-line" })));
    hlines.forEach((h) => svg.append(svgEl("line", { x1: 0, x2: W, y1: y(h.v), y2: y(h.v), class: "th-line", style: `stroke:${h.color}` })));
    series.forEach((ser) => {
      let d = "";
      for (let i = s; i <= e; i++) d += `${i === s ? "M" : "L"}${x(i).toFixed(2)},${y(ser.values[i]).toFixed(2)}`;
      if (ser.area) svg.append(svgEl("path", { d: `${d}L${x(e)},${y(ser.base)}L${x(s)},${y(ser.base)}Z`, class: ser.area }));
      svg.append(svgEl("path", { d, class: ser.cls }));
    });
    box.append(svg);
    ticks.forEach((t) => {
      const lab = el("span", "tick-label", tickFmt(t));
      lab.style.top = `${(y(t) / H) * 100}%`;
      box.append(lab);
    });
    xLabels(s, e).forEach((l) => {
      const lab = el("span", "x-label", l.text);
      lab.style.left = `${(x(l.i) / W) * 100}%`;
      box.append(lab);
    });
    marks.forEach((m) => {
      const d = el("span", "mark");
      d.style.left = `${(x(m.i) / W) * 100}%`;
      d.style.top = `${(y(m.v) / H) * 100}%`;
      d.style.background = m.color;
      box.append(d);
    });

    const cross = el("div", "crosshair");
    const dot = el("div", "dot");
    const tip = el("div", "tooltip");
    [cross, dot, tip].forEach((n) => {
      n.hidden = true;
      box.append(n);
    });

    const setHover = (i) => {
      const show = i != null && i >= s && i <= e;
      [cross, dot, tip].forEach((n) => (n.hidden = !show));
      if (!show) return;
      const left = (x(i) / W) * 100;
      cross.style.left = `${left}%`;
      dot.style.left = `${left}%`;
      dot.style.top = `${(y(dotSeries[i]) / H) * 100}%`;
      tip.textContent = tipFor(i);
      tip.style.left = `${left}%`;
      tip.classList.toggle("edge-left", left < 15);
      tip.classList.toggle("edge-right", left > 85);
    };
    const onMove = (ev) => {
      const r = box.getBoundingClientRect();
      const px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
      const i = Math.round(s + (px / r.width) * (e - s));
      state.charts.forEach((c) => c(Math.min(e, Math.max(s, i))));
    };
    const onLeave = () => state.charts.forEach((c) => c(null));
    box.onpointermove = onMove;
    box.onpointerdown = onMove;
    box.onpointerleave = onLeave;
    return setHover;
  }

  function niceTicks(lo, hi, count) {
    const raw = (hi - lo) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((st) => st >= raw);
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
    return out;
  }

  function renderCharts() {
    const [s, e] = periodRange();
    const scale = state.settings.scale;
    let lo = Infinity, hi = -Infinity;
    for (let i = s; i <= e; i++) {
      lo = Math.min(lo, state.nav[i]);
      hi = Math.max(hi, state.high[i]);
    }
    const pad = (hi - lo) * 0.06;
    lo = Math.max(0, lo - pad);
    hi += pad;

    // 追加買いの日(合図の翌営業日)に印をつける
    const marks = [];
    for (let i = Math.max(1, s); i <= e; i++) {
      const t = tierOf(state.dd[i - 1]);
      if (t) marks.push({ i, v: state.nav[i], color: TIERS[t - 1].color });
    }
    const tipFor = (i) => {
      const t = i > 0 ? tierOf(state.dd[i - 1]) : 0;
      return (
        `${dateJa(state.dates[i])}\n基準価額 ${yen(state.nav[i])}\n20日高値から ${pctText(state.dd[i])}` +
        (t ? `\nこの日の追加 ${man(TIERS[t - 1].amount * scale)}` : "")
      );
    };

    const legend = $("legend-nav");
    legend.textContent = "";
    const item = (iEl, text) => {
      const sp = el("span");
      sp.append(iEl, text);
      legend.append(sp);
    };
    item(el("i", "ln"), "基準価額");
    item(el("i", "ln high"), "20日高値");
    TIERS.forEach((t) => {
      const pt = el("i", "pt");
      pt.style.background = t.color;
      item(pt, `+${man(t.amount * scale)}の日`);
    });

    const setNav = drawChart($("chart-nav"), {
      s, e, lo, hi,
      series: [
        { values: state.high, cls: "l-high" },
        { values: state.nav, cls: "l-nav" },
      ],
      ticks: niceTicks(lo, hi, 4),
      tickFmt: (v) => `${(v / 10000).toLocaleString("ja-JP", { maximumFractionDigits: 1 })}万`,
      marks,
      tipFor,
      dotSeries: state.nav,
    });

    let ddLo = 0;
    for (let i = s; i <= e; i++) ddLo = Math.min(ddLo, state.dd[i]);
    ddLo = Math.min(-0.55, ddLo - 0.03);
    const setDd = drawChart($("chart-dd"), {
      s, e, lo: ddLo, hi: 0.02,
      series: [{ values: state.dd, cls: "l-dd", area: "a-dd", base: 0 }],
      ticks: [0, -0.2, -0.4, -0.6, -0.8].filter((t) => t >= ddLo),
      tickFmt: (v) => (v === 0 ? "0%" : `−${Math.round(-v * 100)}%`),
      hlines: TIERS.map((t) => ({ v: t.th, color: t.color })),
      tipFor,
      dotSeries: state.dd,
    });
    state.charts = [setNav, setDd];
  }

  // ---------- 自分の積立 ----------

  function renderMine() {
    const { start, daily, scale } = state.settings;
    const box = $("mine");
    box.textContent = "";
    const s = state.dates.findIndex((d) => d >= start);
    if (s < 0) {
      box.append(el("p", "sub", `${start} 以降の基準価額はまだありません。公表されしだい計算します。`));
      return;
    }
    const e = state.dates.length - 1;
    const r = simulate(s, e, daily, scale);
    const pl = r.value - r.invested;
    box.append(
      tile("投資額", yen(r.invested), r.extra ? `うち追加 ${man(r.extra)}` : null),
      tile("評価額", yen(r.value), `${state.dates[e].slice(5).replace("-", "/")}時点`),
      tile("損益", `${pl >= 0 ? "+" : "−"}${yen(Math.abs(pl))}`, pctText(r.ret), pctClass(pl)),
      tile("平均取得単価", yen(r.invested / r.units), "1万口あたり"),
      tile("投資した日数", `${e - s + 1}日`, `追加 ${r.count}回`)
    );
  }

  // ---------- 過去の成績 ----------

  function renderBacktest() {
    const { daily, scale } = state.settings;
    const years = [...new Set(state.dates.map((d) => d.slice(0, 4)))];
    const rows = [];
    years.forEach((y) => {
      const s = state.dates.findIndex((d) => d.startsWith(y));
      let e = s;
      while (e + 1 < state.dates.length && state.dates[e + 1].startsWith(y)) e++;
      if (e - s < 40) return; // 数日分しかない年(設定年など)は省く
      rows.push({ label: `${y}年`, base: simulate(s, e, daily, 0), rule: simulate(s, e, daily, scale) });
    });
    const last = state.dates.length - 1;
    const total = { label: `全期間(${state.dates[0].slice(0, 4)}〜)`, base: simulate(0, last, daily, 0), rule: simulate(0, last, daily, scale) };

    const table = $("bt-table");
    table.textContent = "";
    const head = el("tr");
    ["年", "毎日だけ", "追加ルールあり", "差", "追加回数", "追加額"].forEach((h) => head.append(el("th", null, h)));
    table.append(head);
    [...rows, total].forEach((r, idx) => {
      const tr = el("tr", idx === rows.length ? "total" : null);
      const diff = r.rule.ret - r.base.ret;
      tr.append(
        el("td", null, r.label),
        el("td", pctClass(r.base.ret), pctText(r.base.ret, 0)),
        el("td", pctClass(r.rule.ret) + (diff > 0 ? " win" : ""), pctText(r.rule.ret, 0)),
        el("td", null, `${diff >= 0 ? "+" : "−"}${Math.abs(diff * 100).toFixed(0)}pt`),
        el("td", null, `${r.rule.count}回`),
        el("td", null, man(r.rule.extra))
      );
      table.append(tr);
    });

    const wins = rows.filter((r) => r.rule.ret > r.base.ret).length;
    const maxYear = rows.reduce((a, b) => (b.rule.extra > a.rule.extra ? b : a), rows[0]);
    const avg = rows.reduce((a, b) => a + b.rule.extra, 0) / rows.length;
    $("bt-sub").textContent =
      `毎日 ${man(daily)} を買い続けた場合と、そこに暴落時の追加(${TIERS.map((t) => man(t.amount * scale)).join(" / ")})を足した場合の、その年の投資額に対する年末時点の損益率です。` +
      `追加ありの方が良かった年は ${rows.length}年中 ${wins}年。追加額は平均で年 ${man(avg)}、最も多かった ${maxYear.label} は ${man(maxYear.rule.extra)} でした。`;
  }

  // ---------- 操作 ----------

  function buildToggle(box, options, key, onChange) {
    box.textContent = "";
    options.forEach((o) => {
      const b = el("button", "toggle-btn" + (state.settings[key] === o.key ? " active" : ""), o.label);
      b.type = "button";
      b.setAttribute("aria-pressed", state.settings[key] === o.key);
      b.onclick = () => {
        state.settings[key] = o.key;
        saveSettings();
        buildToggle(box, options, key, onChange);
        onChange();
      };
      box.append(b);
    });
  }

  function renderAll() {
    renderAdvice();
    renderTiles();
    renderCharts();
    renderMine();
    renderBacktest();
  }

  function setupControls() {
    buildToggle($("period-toggle"), PERIOD_OPTIONS, "period", renderCharts);
    buildToggle($("scale-toggle"), SCALE_OPTIONS, "scale", renderAll);
    const inStart = $("in-start");
    const inDaily = $("in-daily");
    inStart.value = state.settings.start;
    inStart.min = state.dates[0];
    inDaily.value = state.settings.daily;
    inStart.onchange = () => {
      if (!inStart.value) return;
      state.settings.start = inStart.value;
      saveSettings();
      renderMine();
    };
    inDaily.onchange = () => {
      const v = Math.round(Number(inDaily.value));
      if (!(v > 0)) return;
      state.settings.daily = v;
      saveSettings();
      renderAll();
    };
  }

  async function main() {
    try {
      const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      prepare(data);
      const last = data.dates[data.dates.length - 1];
      statusEl.textContent = `最新の基準価額: ${dateJa(last)}(${data.nav.length.toLocaleString("ja-JP")}日分)`;
      setupControls();
      $("main").hidden = false;
      renderAll();
    } catch (err) {
      statusEl.textContent = `データを読み込めませんでした(${err.message})。時間をおいて開き直してください。`;
      statusEl.classList.add("error");
    }
  }

  main();
})();
