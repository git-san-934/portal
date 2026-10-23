(() => {
  "use strict";

  const DATA_URL = "data/nav.json";
  const STORE_KEY = "nikkei43-settings";
  const WINDOW = 20; // 20営業日の高値からの下落率で判定する

  // 追加買いの段階。20日高値からの下落率が th 以下なら、次の営業日に amount 円を上乗せする(「ふつう」の大きさ)
  // big の段階(大口買い)は、1回の暴落で合計 BIG_CAP まで。使い切ったあとは BIG_FALLBACK を続ける
  const TIERS = [
    { th: -0.3, amount: 30000, color: "var(--tier1)" },
    { th: -0.4, amount: 60000, color: "var(--tier2)" },
    { th: -0.5, amount: 300000, color: "var(--tier3)", big: true },
    { th: -0.7, amount: 500000, color: "var(--tier4)", big: true },
  ];
  const BIG_CAP = 2000000;
  const BIG_FALLBACK = 100000;
  const EPISODE_GAP = 60; // 大口買いの合図が60営業日なければ、次は別の暴落として上限を数え直す
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
  // 売りのルール。基準価額が1年前(SELL_LOOKBACK 営業日前)の SELL_MULT 倍以上なら、次の営業日に持ち分の SELL_FRAC を売る。
  // 合図は SELL_GAP 営業日に1回まで。売ったお金は暴落買いに先に使い、残りは200日平均より REBUY_TH 以上安い日に REBUY_FRAC ずつ買い戻す
  const SELL_LOOKBACK = 245;
  const SELL_MULT = 3;
  const SELL_FRAC = 0.25;
  const SELL_GAP = 20;
  const MA_DAYS = 200;
  const REBUY_TH = -0.2;
  const REBUY_FRAC = 0.1;
  const TAX = 0.20315; // 特定口座の譲渡益課税
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

  const state = { dates: [], nav: [], high: [], dd: [], ma: [], yr: [], sellSig: [], rebuy: [], settings: loadSettings(), charts: [] };

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
    // 200日平均、1年前比、売りの合図(20営業日に1回まで)、買い戻しの日
    state.ma = new Array(n).fill(null);
    state.yr = new Array(n).fill(null);
    state.sellSig = new Array(n).fill(false);
    state.rebuy = new Array(n).fill(false);
    let sum = 0;
    let lastSig = -Infinity;
    for (let i = 0; i < n; i++) {
      sum += data.nav[i];
      if (i >= MA_DAYS) sum -= data.nav[i - MA_DAYS];
      if (i >= MA_DAYS - 1) state.ma[i] = sum / MA_DAYS;
      if (i >= SELL_LOOKBACK) state.yr[i] = data.nav[i] / data.nav[i - SELL_LOOKBACK];
      if (state.yr[i] >= SELL_MULT && i - lastSig > SELL_GAP) {
        state.sellSig[i] = true;
        lastSig = i;
      }
      state.rebuy[i] = state.ma[i] != null && data.nav[i] < state.ma[i] * (1 + REBUY_TH);
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
  // start〜end の各日の合図から、次の営業日の追加額を決める。plan.extras[j + 1] が j の合図で買う額。
  // plan.used / plan.lastBig は end 時点の「今回の暴落」で使った大口買いの額と、最後に大口の合図が出た日
  function planExtras(start, end, scale) {
    const extras = {};
    let used = 0;
    let lastBig = -Infinity;
    for (let j = start; j <= end; j++) {
      const t = tierOf(state.dd[j]);
      if (!t) continue;
      const tier = TIERS[t - 1];
      let a = tier.amount * scale;
      let capped = false;
      if (tier.big) {
        if (j - lastBig > EPISODE_GAP) used = 0;
        lastBig = j;
        const b = Math.min(a, Math.max(0, BIG_CAP * scale - used));
        used += b;
        capped = b < a;
        a = Math.max(b, BIG_FALLBACK * scale);
      }
      extras[j + 1] = { a, t, capped };
    }
    return { extras, used, lastBig };
  }

  // start〜end(両端含む)の日に毎日 daily 円を買い、前の営業日に合図が出ていたら追加額も買う
  function simulate(start, end, daily, scale) {
    let units = 0, invested = 0, extra = 0, count = 0;
    const { extras } = scale > 0 ? planExtras(start, end - 1, scale) : { extras: {} };
    for (let i = start; i <= end; i++) {
      const nav = state.nav[i];
      units += daily / nav;
      invested += daily;
      {
        const a = extras[i] ? extras[i].a : 0;
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

  // simulate に売りルールを足したもの。前の営業日に売りの合図が出ていたら持ち分の SELL_FRAC を売り(利益には税金)、
  // 現金は暴落買いに先に使い、前の営業日が買い戻しの日なら現金の REBUY_FRAC を買う。外から入れたお金(invested)は現金で払った分を除く
  function simulateSell(start, end, daily, scale) {
    let units = 0, cost = 0, cash = 0, invested = 0, sells = 0, taxPaid = 0;
    const { extras } = scale > 0 ? planExtras(start, end - 1, scale) : { extras: {} };
    for (let i = start; i <= end; i++) {
      const nav = state.nav[i];
      const a = extras[i] ? extras[i].a : 0;
      const fromCash = Math.min(cash, a);
      cash -= fromCash;
      invested += daily + a - fromCash;
      units += (daily + a) / nav;
      cost += daily + a;
      if (i > start && state.rebuy[i - 1] && cash > 0) {
        const r = cash * REBUY_FRAC;
        cash -= r;
        units += r / nav;
        cost += r;
      }
      if (i > start && state.sellSig[i - 1] && units > 0) {
        const u = units * SELL_FRAC;
        const c = cost * SELL_FRAC;
        const tax = Math.max(0, u * nav - c) * TAX;
        cash += u * nav - tax;
        taxPaid += tax;
        units -= u;
        cost -= c;
        sells++;
      }
    }
    const hold = units * state.nav[end];
    const value = hold + cash;
    return { invested, hold, cash, value, sells, taxPaid, ret: invested ? value / invested - 1 : 0 };
  }

  // ---------- 今日のアドバイス ----------

  function renderAdvice() {
    const last = state.nav.length - 1;
    const dd = state.dd[last];
    const t = tierOf(dd);
    const { daily, scale } = state.settings;
    const plan = planExtras(0, last, scale);
    const today = plan.extras[last + 1];
    const extra = today ? today.a : 0;

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
      if (today && today.capped) reason += ` 今回の暴落の大口買いは上限(${man(BIG_CAP * scale)})に達したので、${man(extra)} にしています。`;
      else if (next) reason += ` さらに ${(Math.abs(next.th - dd) * 100).toFixed(1)}ポイント下がると追加額を ${man(next.amount * scale)} に増やします。`;
    }
    if (last - plan.lastBig <= EPISODE_GAP) {
      reason += ` 今回の暴落で使った大口買い: ${man(plan.used)} / 上限 ${man(BIG_CAP * scale)}。`;
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
      `金額の下の値は、今の20日高値で換算した基準価額の目安です。−50%以下の大口買いは1回の暴落で合計 ${man(BIG_CAP * scale)} まで(使い切ったあとは ${man(BIG_FALLBACK * scale)} ずつ)。追加額の大きさは「自分の積立シミュレーション」で変えられます。`;
  }

  // ---------- 売り時 ----------

  function renderSell() {
    const last = state.nav.length - 1;
    const nav = state.nav[last];
    const yr = state.yr[last];
    const ma = state.ma[last];
    const sig = state.sellSig[last];
    const rebuy = state.rebuy[last];
    let prevSig = -1;
    for (let i = last; i >= 0; i--) if (state.sellSig[i]) { prevSig = i; break; }
    const cooling = !sig && prevSig >= 0 && last - prevSig <= SELL_GAP;

    $("sell").classList.toggle("on", sig || rebuy);
    $("sell-when").textContent = `売り時の判定(${dateJa(state.dates[last])} の基準価額)→ 次の営業日 ${nextWeekday(state.dates[last])} の注文`;
    const action = $("sell-action");
    action.textContent = "";
    if (sig) action.append(Object.assign(el("span", "plus"), { textContent: "持ち分の1/4を売る" }));
    else if (rebuy) action.append(Object.assign(el("span", "plus"), { textContent: "売ったお金の10%を買い戻す" }));
    else action.textContent = "売らずに持ち続ける";

    const base = state.nav[last - SELL_LOOKBACK];
    let reason = yr != null ? `1年前(${dateJa(state.dates[last - SELL_LOOKBACK])})の ${yen(base)} から ${yr.toFixed(2)}倍。` : "";
    if (sig) reason += `売りの目安(1年前の${SELL_MULT}倍)を超えました。上がりすぎたあとは大きな下げが来やすいので、持ち分の1/4を利益確定します。`;
    else if (cooling) reason += `${dateJa(state.dates[prevSig])} に売りの合図が出たばかりなので、20営業日あけます(次の合図は早くて ${SELL_GAP + 1 - (last - prevSig)} 営業日後)。`;
    else if (yr != null) reason += `売りの目安(${SELL_MULT}倍)まで、あと ${pctText(SELL_MULT / yr - 1)} です。`;
    if (ma != null) {
      reason += ` 200日平均(${yen(ma)})から ${pctText(nav / ma - 1)}。`;
      reason += rebuy ? "買い戻しの目安(−20%)を下回っています。売って取ってあるお金があれば、その10%を買い戻します。" : "";
    }
    $("sell-reason").textContent = reason;

    const ladder = $("sell-ladder");
    ladder.textContent = "";
    const steps = [
      { on: sig, title: "売る", b: "持ち分の1/4", lv: `${yen(Math.ceil(base * SELL_MULT))}以上`, color: "var(--sell)" },
      { on: !sig && !rebuy, title: "持ち続ける", b: "何もしない", lv: "その間", color: "var(--border)" },
      { on: rebuy, title: "買い戻す", b: "現金の10%", lv: ma != null ? `${yen(Math.floor(ma * (1 + REBUY_TH)))}未満` : "—", color: "var(--ma)" },
    ];
    steps.forEach((x) => {
      const box = el("div", "step" + (x.on ? " current" : ""));
      const title = el("div");
      const sw = el("span", "swatch");
      sw.style.background = x.color;
      title.append(sw, x.title);
      box.append(title, el("b", null, x.b), el("span", "lv", x.lv));
      ladder.append(box);
    });
    $("sell-note").textContent =
      "金額の下の値は、今日の1年前の基準価額・200日平均で換算した目安です。売ったお金はまず暴落時の追加買いに使い、残りを買い戻しに回します。売った利益には約20%の税金がかかります。信託期間は 2027年9月7日まで(延長されることがあります)。";
  }

  function renderSellTable() {
    const table = $("sell-table");
    table.textContent = "";
    const head = el("tr");
    ["売りの合図の日", "基準価額", "1年前の何倍", "3ヶ月後", "半年後", "1年後"].forEach((h) => head.append(el("th", null, h)));
    table.append(head);
    const n = state.nav.length;
    const after = (i, k) => (i + k < n ? state.nav[i + k] / state.nav[i] - 1 : null);
    for (let i = 0; i < n; i++) {
      if (!state.sellSig[i]) continue;
      const tr = el("tr");
      tr.append(el("td", null, dateJa(state.dates[i])), el("td", null, yen(state.nav[i])), el("td", null, `${state.yr[i].toFixed(2)}倍`));
      [63, 125, 245].forEach((k) => {
        const v = after(i, k);
        tr.append(el("td", pctClass(v), v == null ? "—" : pctText(v, 0)));
      });
      table.append(tr);
    }
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
      let pen = "M";
      for (let i = s; i <= e; i++) {
        if (ser.values[i] == null) {
          pen = "M";
          continue;
        }
        d += `${pen}${x(i).toFixed(2)},${y(ser.values[i]).toFixed(2)}`;
        pen = "L";
      }
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
      const d = el("span", "mark" + (m.cls ? " " + m.cls : ""));
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
    // 大口買いの上限は過去からの続きで数えるので、データの最初から計画する
    const { extras } = planExtras(0, state.nav.length - 2, scale);
    const marks = [];
    for (let i = Math.max(1, s); i <= e; i++) {
      const x = extras[i];
      if (x) marks.push({ i, v: state.nav[i], color: TIERS[x.t - 1].color });
      if (state.sellSig[i - 1]) marks.push({ i, v: state.nav[i], color: "var(--sell)", cls: "sell" });
    }
    const tipFor = (i) => {
      const x = extras[i];
      return (
        `${dateJa(state.dates[i])}\n基準価額 ${yen(state.nav[i])}\n20日高値から ${pctText(state.dd[i])}` +
        (x ? `\nこの日の追加 ${man(x.a)}${x.capped ? "(上限到達)" : ""}` : "") +
        (state.yr[i] != null ? `\n1年前の ${state.yr[i].toFixed(2)}倍` : "") +
        (i > 0 && state.sellSig[i - 1] ? "\nこの日に1/4を売る" : "")
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
    item(el("i", "ln ma"), "200日平均");
    TIERS.forEach((t) => {
      const pt = el("i", "pt");
      pt.style.background = t.color;
      item(pt, `+${man(t.amount * scale)}の日`);
    });
    const sp = el("i", "pt sq");
    sp.style.background = "var(--sell)";
    item(sp, "1/4を売る日");

    const setNav = drawChart($("chart-nav"), {
      s, e, lo, hi,
      series: [
        { values: state.high, cls: "l-high" },
        { values: state.ma, cls: "l-ma" },
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
    ddLo = Math.min(-0.75, ddLo - 0.03);
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
    const q = simulateSell(s, e, daily, scale);
    // 現金から払った暴落買いの分は外から入れずに済んだお金なので、差に足す
    const diff = q.value + (r.invested - q.invested) - r.value;
    box.append(
      tile("売りルールも使うと", yen(q.value), q.sells ? `売り ${q.sells}回` : "まだ売りなし"),
      tile("うち現金", yen(q.cash), q.taxPaid ? `税金 ${man(q.taxPaid)} 支払い後` : null),
      tile("売らない場合との差", `${diff >= 0 ? "+" : "−"}${yen(Math.abs(diff))}`, null, pctClass(Math.round(diff)))
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
      `毎日 ${man(daily)} を買い続けた場合と、そこに暴落時の追加(${TIERS.map((t) => man(t.amount * scale)).join(" / ")}、大口は1回の暴落で ${man(BIG_CAP * scale)} まで)を足した場合の、その年の投資額に対する年末時点の損益率です。` +
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
    renderSell();
    renderTiles();
    renderCharts();
    renderMine();
    renderBacktest();
    renderSellTable();
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

  // データの更新日時 "2026-10-16T09:36+09:00" → "10/16 9:36"
  const updatedJa = (s) => {
    const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s || "");
    return m ? `${Number(m[1])}/${Number(m[2])} ${Number(m[3])}:${m[4]}` : "";
  };

  let controlsReady = false;

  // nav.json をキャッシュなしで取り直して描き直す(最初の表示と「最新データを読み込む」ボタンの両方で使う)
  async function load() {
    const reloadBtn = $("reload");
    reloadBtn.disabled = true;
    const prevLast = state.dates[state.dates.length - 1];
    try {
      const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      prepare(data);
      const last = data.dates[data.dates.length - 1];
      const upd = updatedJa(data.updated);
      let text = `最新の基準価額: ${dateJa(last)}(${data.nav.length.toLocaleString("ja-JP")}日分)`;
      if (upd) text += ` ・ データ更新 ${upd}`;
      if (prevLast) text += prevLast === last ? " ・ 新しいデータはまだありません" : " ・ 新しいデータを読み込みました";
      statusEl.textContent = text;
      statusEl.classList.remove("error");
      if (!controlsReady) {
        setupControls();
        controlsReady = true;
      }
      $("main").hidden = false;
      renderAll();
    } catch (err) {
      statusEl.textContent = `データを読み込めませんでした(${err.message})。時間をおいてもう一度お試しください。`;
      statusEl.classList.add("error");
    } finally {
      reloadBtn.disabled = false;
    }
  }

  $("reload").onclick = load;

  // 「今すぐ更新」: 更新依頼の Issue を作る画面を開く。所有者が作ると Actions が基準価額を取りに行く
  // (.github/workflows/request-nikkei43-update.yml)
  const q = new URLSearchParams({
    title: "日経4.3ブルの基準価額を更新",
    body: "暴落買いナビの「今すぐ更新」から作成。\n\nこのまま「Create」(または「Submit new issue」)を押すと、2〜5分で基準価額の取得とページの更新が行われます。反映後にページの「最新データを読み込む」を押してください。",
  });
  $("refresh").href = `https://github.com/git-san-934/portal/issues/new?${q}`;

  load();
})();
