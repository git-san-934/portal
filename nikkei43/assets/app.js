(() => {
  "use strict";

  const DATA_URL = "data/nav.json";
  const STORE_KEY = "nikkei43-settings";
  const WINDOW = 20; // 20営業日の高値からの下落率で判定する

  // 追加買いの段階。20日高値からの下落率が th 以下なら、次の営業日に amount 円を上乗せする(「ふつう」の大きさ)
  // 1回の追加は最大6万円。−30%から5ポイント下がるごとに1万円ずつ増やす(2026-11-07 に変更)
  const TIERS = [
    { th: -0.3, amount: 10000, color: "var(--tier1)" },
    { th: -0.35, amount: 20000, color: "var(--tier2)" },
    { th: -0.4, amount: 30000, color: "var(--tier3)" },
    { th: -0.45, amount: 40000, color: "var(--tier4)" },
    { th: -0.5, amount: 50000, color: "var(--tier5)" },
    { th: -0.55, amount: 60000, color: "var(--tier6)" },
  ];
  // 合図(−30%以下)が続く間は EVERY 日に1回だけ追加する(続いた1日目・3日目・5日目…)。−30%より上に戻ると数え直す
  const EVERY = 2;
  // 2026-11-16 から「毎日の金額だけ(追加なし)」が標準。追加買いは設定で選んだときだけ計算する
  const SCALE_OPTIONS = [
    { key: 0, label: "なし(毎日だけ)" },
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
  const DEFAULTS = { start: "2026-09-28", daily: 5000, scale: 0, period: "y1" };
  // 3: 2026-11-24 から毎日5千円に減額(以前に保存した毎日の金額は5千円に戻す)。2: 追加なしを標準にした
  const SETTINGS_VERSION = 3;
  // 自分の積立で、この日までは毎日1万円で買っていた(それ以降は設定の「毎日の金額」)
  const PAST_DAILY = { until: "2026-11-20", amount: 10000 };

  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");

  const yen = (v) => `${Math.round(v).toLocaleString("ja-JP")}円`;
  // 1万円未満は「5,000円」のように円で出す
  const amt = (v) => (v < 10000 ? yen(v) : man(v));
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
      if (s.v !== SETTINGS_VERSION) {
        s.scale = DEFAULTS.scale;
        s.daily = DEFAULTS.daily;
      }
      return { ...DEFAULTS, ...s, v: SETTINGS_VERSION };
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

  const state = { dates: [], nav: [], high: [], dd: [], ma: [], dev: [], yr: [], sellSig: [], rebuy: [], settings: loadSettings(), charts: [] };

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
    // 合図(−30%以下)が何日続いているか。追加はその1日目・3日目…に行う
    state.streak = new Array(n);
    for (let i = 0; i < n; i++) state.streak[i] = state.dd[i] <= TIERS[0].th ? (i > 0 ? state.streak[i - 1] : 0) + 1 : 0;
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
    // 200日平均からの乖離率(基準価額 ÷ 200日平均 − 1)
    state.dev = state.ma.map((m, i) => (m == null ? null : data.nav[i] / m - 1));
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
  // 合図が続く日は EVERY 日に1回だけ買う(買わない合図の日は plan.skips に入れる)
  function planExtras(start, end, scale) {
    const extras = {};
    const skips = new Set();
    if (!(scale > 0)) return { extras, skips };
    for (let j = start; j <= end; j++) {
      const t = tierOf(state.dd[j]);
      if (!t) continue;
      if ((state.streak[j] - 1) % EVERY !== 0) {
        skips.add(j);
        continue;
      }
      extras[j + 1] = { a: TIERS[t - 1].amount * scale, t };
    }
    return { extras, skips };
  }

  // start〜end(両端含む)の日に毎日 daily 円を買い、前の営業日に合図が出ていたら追加額も買う
  function simulate(start, end, daily, scale) {
    let units = 0, invested = 0, extra = 0, count = 0;
    const { extras } = scale > 0 ? planExtras(start, end - 1, scale) : { extras: {} };
    for (let i = start; i <= end; i++) {
      const nav = state.nav[i];
      const d = typeof daily === "function" ? daily(i) : daily;
      units += d / nav;
      invested += d;
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

  // simulate に売りルールを足したもの。判定は start(自分の積立の開始日)からの自分の持ち分で行う:
  // 基準価額が1年前の SELL_MULT 倍以上で、持ち分に利益が出ていれば売りの合図(SELL_GAP 営業日に1回まで)。合図の次の営業日に持ち分の
  // SELL_FRAC を売り(利益には税金)、現金は暴落買いに先に使い、前の営業日が買い戻しの日なら現金の REBUY_FRAC を買う。
  // 外から入れたお金(invested)は現金で払った分を除く。sigs は合図の日、最後の日の合図は次の営業日に売る分
  function simulateSell(start, end, daily, scale) {
    let units = 0, cost = 0, cash = 0, invested = 0, sells = 0, taxPaid = 0, lastSig = -Infinity;
    const sigs = [];
    const { extras } = scale > 0 ? planExtras(start, end - 1, scale) : { extras: {} };
    for (let i = start; i <= end; i++) {
      const nav = state.nav[i];
      const a = extras[i] ? extras[i].a : 0;
      const d = typeof daily === "function" ? daily(i) : daily;
      const fromCash = Math.min(cash, a);
      cash -= fromCash;
      invested += d + a - fromCash;
      units += (d + a) / nav;
      cost += d + a;
      if (i > start && state.rebuy[i - 1] && cash > 0) {
        const r = cash * REBUY_FRAC;
        cash -= r;
        units += r / nav;
        cost += r;
      }
      if (lastSig === i - 1 && units > 0) {
        const u = units * SELL_FRAC;
        const c = cost * SELL_FRAC;
        const tax = Math.max(0, u * nav - c) * TAX;
        cash += u * nav - tax;
        taxPaid += tax;
        units -= u;
        cost -= c;
        sells++;
      }
      if (state.yr[i] >= SELL_MULT && units * nav >= cost && i - lastSig > SELL_GAP) {
        sigs.push(i);
        lastSig = i;
      }
    }
    const hold = units * state.nav[end];
    const value = hold + cash;
    return { invested, hold, cash, value, units, cost, sells, sigs, lastSig, taxPaid, ret: invested ? value / invested - 1 : 0 };
  }

  // 自分の積立の毎日の金額: PAST_DAILY.until までは実際に買った1万円、それ以降は設定の金額
  const myDaily = () => {
    const daily = state.settings.daily;
    return (i) => (state.dates[i] <= PAST_DAILY.until ? PAST_DAILY.amount : daily);
  };

  // 自分の積立の開始日(のデータ上の位置)。まだデータがなければ -1
  const startIndex = () => state.dates.findIndex((d) => d >= state.settings.start);

  // ---------- 今日のアドバイス ----------

  function renderAdvice() {
    const last = state.nav.length - 1;
    const dd = state.dd[last];
    const t = tierOf(dd);
    const { daily, scale } = state.settings;
    const plan = planExtras(0, last, scale);
    const today = plan.extras[last + 1];
    const extra = today ? today.a : 0;

    const noExtra = !(scale > 0);
    $("advice").classList.toggle("on", t > 0 && !noExtra);
    $("advice-when").textContent = `${dateJa(state.dates[last])} の基準価額で判定 → 次の営業日 ${nextWeekday(state.dates[last])} の注文`;
    const amount = $("advice-amount");
    amount.textContent = "";
    if (noExtra) {
      amount.textContent = `いつもどおり ${amt(daily)}(追加買いなし)`;
    } else if (t > 0 && today) {
      amount.append(`${amt(daily)} `, Object.assign(el("span", "plus"), { textContent: `+ 追加 ${man(extra)}` }));
    } else {
      amount.textContent = t > 0 ? `いつもどおり ${amt(daily)}(追加は見送り)` : `いつもどおり ${amt(daily)}`;
    }

    const next = TIERS[t]; // 次の段階(なければ undefined)
    let reason = `20日高値(${yen(state.high[last])})から ${pctText(dd)}。`;
    if (noExtra) {
      reason += "下がっても上がっても、毎日同じ金額だけ買います(2026年11月16日から追加買いはやめました)。";
    } else if (t === 0) {
      reason += `追加買いの目安(−30%)まで、あと ${(Math.abs(TIERS[0].th - dd) * 100).toFixed(1)}ポイントです。`;
    } else {
      reason += `第${t}段階の暴落ラインを下回っています(合図が続いて${state.streak[last]}日目)。`;
      if (!today) reason += ` 追加は合図が続く間${EVERY}日に1回なので、今回は見送りです(次の合図の日に追加)。`;
      else if (next) reason += ` さらに ${(Math.abs(next.th - dd) * 100).toFixed(1)}ポイント下がると追加額を ${man(next.amount * scale)} に増やします。`;
    }
    $("advice-reason").textContent = reason;

    const ladder = $("ladder");
    ladder.textContent = "";
    ladder.style.display = noExtra ? "none" : "";
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
      (noExtra ? "追加買いを試算したいときは「自分の積立シミュレーション」の「追加額の大きさ」で選べます。" : `金額の下の値は、今の20日高値で換算した基準価額の目安です。−30%以下が続く間、追加は${EVERY}日に1回です。追加額の大きさは「自分の積立シミュレーション」で変えられます。`);
  }

  // ---------- 売り時 ----------

  function renderSell() {
    const last = state.nav.length - 1;
    const nav = state.nav[last];
    const yr = state.yr[last];
    const ma = state.ma[last];
    const rebuy = state.rebuy[last];
    const { start, daily, scale } = state.settings;
    const s = startIndex();
    const q = s >= 0 ? simulateSell(s, last, myDaily(), scale) : null;
    const sig = q != null && q.lastSig === last;
    const cooling = q != null && !sig && q.lastSig >= s && last - q.lastSig <= SELL_GAP;
    const avg = q && q.units > 0 ? q.cost / q.units : null; // 平均取得単価(1万口あたり)
    const gain = avg ? nav / avg - 1 : null;
    const doRebuy = rebuy && q != null && q.cash > 0;

    $("sell").classList.toggle("on", sig || doRebuy);
    $("sell-when").textContent = `売り時の判定(${dateJa(state.dates[last])} の基準価額)→ 次の営業日 ${nextWeekday(state.dates[last])} の注文`;
    const action = $("sell-action");
    action.textContent = "";
    if (sig) action.append(Object.assign(el("span", "plus"), { textContent: `持ち分の1/4(約${man(q.units * nav * SELL_FRAC)})を売る` }));
    else if (doRebuy) action.append(Object.assign(el("span", "plus"), { textContent: `現金の10%(${man(q.cash * REBUY_FRAC)})を買い戻す` }));
    else action.textContent = q ? "売らずに持ち続ける" : "まだ持ち分がありません";

    const base = state.nav[last - SELL_LOOKBACK];
    let reason = q
      ? `${dateJa(state.dates[s])} からの持ち分: 評価額 ${yen(q.hold)}・平均取得単価 ${yen(avg || 0)}(${pctText(gain)})${q.cash > 0 ? `・売って取ってある現金 ${yen(q.cash)}` : ""}。`
      : `積立の開始日(${start})以降の基準価額がまだないので、売りの判定はできません。`;
    if (yr != null) reason += ` 基準価額は1年前(${dateJa(state.dates[last - SELL_LOOKBACK])})の ${yen(base)} の ${yr.toFixed(2)}倍です。`;
    if (sig) reason += `1年前の${SELL_MULT}倍を超え、持ち分にも利益が出ているので、1/4を利益確定します。`;
    else if (cooling) reason += `${dateJa(state.dates[q.lastSig])} に売りの合図が出たので、20営業日あけます(次は早くて ${SELL_GAP + 1 - (last - q.lastSig)} 営業日後)。`;
    else if (q && yr >= SELL_MULT) reason += `1年前の${SELL_MULT}倍は超えていますが、持ち分が含み損なので売りません。`;
    else if (yr != null) reason += `売りの目安(1年前の${SELL_MULT}倍)まで、あと ${pctText(SELL_MULT / yr - 1)} です。`;
    if (ma != null) {
      reason += ` 200日平均(${yen(ma)})から ${pctText(nav / ma - 1)}。`;
      if (rebuy) reason += doRebuy ? "買い戻しの目安(−20%)を下回っているので、現金の10%を買い戻します。" : "買い戻しの目安(−20%)を下回っていますが、売って取ってある現金はありません。";
    }
    $("sell-reason").textContent = reason;

    const ladder = $("sell-ladder");
    ladder.textContent = "";
    const sellLv = Math.ceil(Math.max(base * SELL_MULT, avg || 0));
    const steps = [
      { on: sig, title: "売る", b: "持ち分の1/4", lv: `${yen(sellLv)}以上`, color: "var(--sell)" },
      { on: !sig && !doRebuy, title: "持ち続ける", b: "何もしない", lv: "その間", color: "var(--border)" },
      { on: doRebuy, title: "買い戻す", b: "現金の10%", lv: ma != null ? `${yen(Math.floor(ma * (1 + REBUY_TH)))}未満` : "—", color: "var(--ma)" },
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
      "判定は「自分の積立シミュレーション」の開始日・毎日の金額・追加額の設定どおりに買った持ち分で行います。売りは、基準価額が1年前の3倍以上で、しかも持ち分に利益が出ているとき(売りの目安は、1年前の3倍と平均取得単価の高い方)。売ったお金はまず暴落時の追加買いに使い、残りを買い戻しに回します。売った利益には約20%の税金がかかります。信託期間は 2027年9月7日まで(延長されることがあります)。";
  }

  function renderSellTable() {
    const table = $("sell-table");
    table.textContent = "";
    const head = el("tr");
    ["売りの合図の日", "基準価額", "1年前の何倍", "200日平均から", "3ヶ月後", "半年後", "1年後"].forEach((h) => head.append(el("th", null, h)));
    table.append(head);
    const n = state.nav.length;
    const after = (i, k) => (i + k < n ? state.nav[i + k] / state.nav[i] - 1 : null);
    for (let i = 0; i < n; i++) {
      if (!state.sellSig[i]) continue;
      const tr = el("tr");
      tr.append(el("td", null, dateJa(state.dates[i])), el("td", null, yen(state.nav[i])), el("td", null, `${state.yr[i].toFixed(2)}倍`), el("td", pctClass(state.dev[i]), pctText(state.dev[i], 0)));
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
    hlines.forEach((h) => {
      if (!h.label) return;
      const lab = el("span", "th-label", h.label);
      lab.style.top = `${(y(h.v) / H) * 100}%`;
      lab.style.color = h.color;
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
    // 合図が何日続いたかは過去からの続きで数えるので、データの最初から計画する
    const { extras } = planExtras(0, state.nav.length - 2, scale);
    // 売りの印は、自分の積立の開始日からの持ち分で出た合図の次の営業日(実際に売る日)
    const st = startIndex();
    const sold = new Set(st >= 0 ? simulateSell(st, state.nav.length - 1, myDaily(), scale).sigs.map((j) => j + 1) : []);
    const marks = [];
    for (let i = Math.max(1, s); i <= e; i++) {
      const x = extras[i];
      if (x) marks.push({ i, v: state.nav[i], color: TIERS[x.t - 1].color });
      if (sold.has(i)) marks.push({ i, v: state.nav[i], color: "var(--sell)", cls: "sell" });
    }
    const tipFor = (i) => {
      const x = extras[i];
      return (
        `${dateJa(state.dates[i])}\n基準価額 ${yen(state.nav[i])}\n20日高値から ${pctText(state.dd[i])}` +
        (x ? `\nこの日の追加 ${man(x.a)}` : "") +
        (state.yr[i] != null ? `\n1年前の ${state.yr[i].toFixed(2)}倍` : "") +
        (sold.has(i) ? "\nこの日に1/4を売る" : "")
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
    if (scale > 0) TIERS.forEach((t) => {
      const pt = el("i", "pt");
      pt.style.background = t.color;
      item(pt, `+${man(t.amount * scale)}の日`);
    });
    const sp = el("i", "pt sq");
    sp.style.background = "var(--sell)";
    item(sp, "1/4を売る日(自分の持ち分)");

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
    state.charts = [setNav, setDd, renderDevChart(s, e)];
  }

  // ---------- 200日平均からの乖離率(売り時の研究用) ----------

  // 目安の線。+50% は以前に試した「過熱」の売りの目安、−20% は今の売りルールの買い戻しの目安
  const DEV_LINES = [
    { v: 1, label: "+100%", color: "var(--up)" },
    { v: 0.5, label: "+50% 過熱", color: "var(--up)" },
    { v: 0.2, label: "+20%", color: "var(--high)" },
    { v: 0, label: "0% 平均", color: "var(--ma)" },
    { v: -0.2, label: "−20% 買い戻し", color: "var(--down)" },
  ];

  function renderDevChart(s, e) {
    let lo = -0.25, hi = 0.55;
    for (let i = s; i <= e; i++) {
      const v = state.dev[i];
      if (v == null) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    const pad = (hi - lo) * 0.06;
    lo -= pad;
    hi += pad;
    const step = hi - lo > 1.6 ? 0.5 : hi - lo > 0.8 ? 0.25 : 0.1;
    const ticks = [];
    for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(Math.round(t * 100) / 100);

    // 上に離れた部分は赤、下に離れた部分は青で塗る
    const up = state.dev.map((v) => (v == null ? null : Math.max(0, v)));
    const down = state.dev.map((v) => (v == null ? null : Math.min(0, v)));
    const marks = [];
    for (let i = s; i <= e; i++) if (state.sellSig[i] && state.dev[i] != null) marks.push({ i, v: state.dev[i], color: "var(--sell)", cls: "sell" });

    const legend = $("legend-dev");
    legend.textContent = "";
    const item = (iEl, text) => {
      const sp = el("span");
      sp.append(iEl, text);
      legend.append(sp);
    };
    item(el("i", "ln dev"), "乖離率");
    const sq = el("i", "pt sq");
    sq.style.background = "var(--sell)";
    item(sq, `「1年前の${SELL_MULT}倍」の合図の日`);

    return drawChart($("chart-dev"), {
      s, e, lo, hi,
      series: [
        { values: up, cls: "l-none", area: "a-dev-up", base: 0 },
        { values: down, cls: "l-none", area: "a-dev-down", base: 0 },
        { values: state.dev, cls: "l-dev" },
      ],
      // 目安の線と同じ高さの目盛りは、目安の線の名前の方を出す
      ticks: ticks.filter((t) => !DEV_LINES.some((h) => Math.abs(h.v - t) < 1e-9)),
      tickFmt: (v) => pctText(v, 0),
      hlines: DEV_LINES.filter((h) => h.v >= lo && h.v <= hi),
      marks,
      tipFor: (i) =>
        state.dev[i] == null
          ? `${dateJa(state.dates[i])}\n200日平均はまだ出ません`
          : `${dateJa(state.dates[i])}\n200日平均から ${pctText(state.dev[i])}\n基準価額 ${yen(state.nav[i])}\n200日平均 ${yen(state.ma[i])}` +
            (state.sellSig[i] ? `\n1年前の${SELL_MULT}倍の合図` : ""),
      dotSeries: state.dev.map((v) => (v == null ? 0 : v)),
    });
  }

  // 今の乖離率と、過去の日の中での位置
  function renderDevNow() {
    const n = state.nav.length - 1;
    const cur = state.dev[n];
    const all = state.dev.filter((v) => v != null);
    const box = $("dev-now");
    box.textContent = "";
    if (cur == null || !all.length) return;
    const share = (f) => all.filter(f).length / all.length;
    const above = share((v) => v > cur);
    box.append(
      `今日(${dateJa(state.dates[n])})は200日平均(${yen(state.ma[n])})から `,
      el("b", pctClass(cur), pctText(cur)),
      `。${dateJa(state.dates[MA_DAYS - 1])}以降の${all.length.toLocaleString("ja-JP")}日のうち、これより高かった日は ${Math.round(above * 100)}% です。` +
        `+20%以上だった日は ${Math.round(share((v) => v >= 0.2) * 100)}%、+50%以上は ${Math.round(share((v) => v >= 0.5) * 100)}%、+100%以上は ${Math.round(share((v) => v >= 1) * 100)}%、−20%以下(買い戻しの目安)は ${Math.round(share((v) => v <= REBUY_TH) * 100)}%。`
    );
  }

  // 乖離率が +30% を超えた山(20営業日以内に戻ってきたものは同じ山)ごとに、いちばん高かった日とそのあと
  const PEAK_TH = 0.3;
  function renderDevPeaks() {
    const table = $("dev-peaks");
    table.textContent = "";
    const n = state.nav.length;
    const eps = [];
    let cur = null;
    for (let i = 0; i < n; i++) {
      if (state.dev[i] == null || state.dev[i] < PEAK_TH) continue;
      if (cur && i - cur.end <= 20) cur.end = i;
      else eps.push((cur = { start: i, end: i }));
    }
    const head = el("tr");
    ["山のてっぺん", "200日平均から", "基準価額", "3ヶ月後", "1年後", "1年以内の最大の下げ", "山の間の売りの合図"].forEach((h) => head.append(el("th", null, h)));
    table.append(head);
    eps.reverse().forEach((ep) => {
      let p = ep.start;
      for (let i = ep.start; i <= ep.end; i++) if (state.dev[i] > state.dev[p]) p = i;
      const after = (k) => (p + k < n ? state.nav[p + k] / state.nav[p] - 1 : null);
      let low = state.nav[p];
      for (let i = p; i < Math.min(n, p + 246); i++) low = Math.min(low, state.nav[i]);
      const sigInEp = [];
      for (let i = ep.start; i <= ep.end; i++) if (state.sellSig[i]) sigInEp.push(i);
      const ongoing = ep.end >= n - 1;
      const tr = el("tr");
      tr.append(
        el("td", null, dateJa(state.dates[p]) + (ongoing ? "(続いている)" : "")),
        el("td", pctClass(state.dev[p]), pctText(state.dev[p], 0)),
        el("td", null, yen(state.nav[p]))
      );
      [63, 245].forEach((k) => {
        const v = after(k);
        tr.append(el("td", pctClass(v), v == null ? "—" : pctText(v, 0)));
      });
      const dd = low / state.nav[p] - 1;
      tr.append(el("td", pctClass(dd), pctText(dd, 0) + (p + 245 >= n ? "(途中)" : "")));
      tr.append(el("td", null, sigInEp.length ? `${sigInEp.length}回(最初 ${state.dates[sigInEp[0]].slice(5).replace("-", "/")})` : "なし"));
      table.append(tr);
    });
  }

  // ---------- 自分の積立 ----------

  function renderMine() {
    const { start, daily, scale } = state.settings;
    const box = $("mine");
    box.textContent = "";
    const s = startIndex();
    if (s < 0) {
      box.append(el("p", "sub", `${start} 以降の基準価額はまだありません。公表されしだい計算します。`));
      return;
    }
    const e = state.dates.length - 1;
    const r = simulate(s, e, myDaily(), scale);
    const pl = r.value - r.invested;
    box.append(
      tile("投資額", yen(r.invested), r.extra ? `うち追加 ${man(r.extra)}` : null),
      tile("評価額", yen(r.value), `${state.dates[e].slice(5).replace("-", "/")}時点`),
      tile("損益", `${pl >= 0 ? "+" : "−"}${yen(Math.abs(pl))}`, pctText(r.ret), pctClass(pl)),
      tile("平均取得単価", yen(r.invested / r.units), "1万口あたり"),
      tile("投資した日数", `${e - s + 1}日`, `追加 ${r.count}回`)
    );
    const q = simulateSell(s, e, myDaily(), scale);
    // 現金から払った暴落買いの分は外から入れずに済んだお金なので、差に足す
    const diff = q.value + (r.invested - q.invested) - r.value;
    box.append(
      tile("売りルールも使うと", yen(q.value), q.sells ? `売り ${q.sells}回` : "まだ売りなし"),
      tile("うち現金", yen(q.cash), q.taxPaid ? `税金 ${q.taxPaid < 10000 ? yen(q.taxPaid) : man(q.taxPaid)} 支払い後` : null),
      tile("売らない場合との差", `${diff >= 0 ? "+" : "−"}${yen(Math.abs(diff))}`, null, pctClass(Math.round(diff)))
    );
  }

  // ---------- 過去の成績 ----------

  function renderBacktest() {
    const { daily } = state.settings;
    const ref = !(state.settings.scale > 0); // 追加なしの設定なら、参考として「ふつう」の追加ルールと比べる
    const scale = ref ? 1 : state.settings.scale;
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
    ["年", "毎日だけ", ref ? "追加ルールあり(参考)" : "追加ルールあり", "差", "追加回数", "追加額"].forEach((h) => head.append(el("th", null, h)));
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
      (ref ? "今の設定は「毎日だけ」です。参考に、以前の追加ルール(ふつう)を足した場合と比べています。" : "") +
      `毎日 ${man(daily)} を買い続けた場合と、そこに暴落時の追加(${TIERS.map((t) => man(t.amount * scale)).join(" / ")}、−30%以下が続く間は${EVERY}日に1回)を足した場合の、その年の投資額に対する年末時点の損益率です。` +
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
    renderDevNow();
    renderDevPeaks();
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
      renderAll();
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


  // ---------- 条件の毎日見直し(data/optimize.json。scripts/optimize.py が基準価額の更新ごとに作る) ----------

  const OPT_URL = "data/optimize.json";
  const ptText = (v) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}`);

  function optTable(table, rows, cols) {
    table.textContent = "";
    const head = el("tr");
    cols.forEach((c) => head.append(el("th", null, c.h)));
    table.append(head);
    rows.forEach((r) => {
      const tr = el("tr", r.cls || null);
      cols.forEach((c) => {
        const v = c.f(r);
        tr.append(el("td", c.cls ? c.cls(r) : null, v));
      });
      table.append(tr);
    });
  }

  function renderOptPart(key, o, since) {
    const badge = $(`opt-${key}-badge`);
    const change = o.verdict === "change";
    badge.className = "badge " + (change ? "change" : "keep");
    badge.textContent = change ? "見直し候補あり" : "今のルールのまま";
    const same = o.best.label === o.current.label;
    let v = same
      ? `${(o.families || []).length}種類・${o.tested}通りのルールを試して、今のルール(${o.current.label})がいちばん良い結果でした。`
      : `${(o.families || []).length}種類・${o.tested}通りのルールの中でいちばん良かったのは「${o.best.label}」。`;
    if (!same) v += change ? " 下の確認もすべて通ったので、ルールを変える候補です。" : " ただし下の理由で、今のルールを変えるほどではありません。";
    if (since && since.date && !same) v += ` このルールがいちばん良い状態は ${dateJa(since.date)} の基準価額から続いています。`;
    $(`opt-${key}-verdict`).textContent = v;

    const rows = [{ ...o.current, name: "今のルール", cls: "cur" }];
    if (!same) rows.push({ ...o.best, name: "いちばん良かったルール", cls: change ? "total" : null });
    o.top.filter((t) => t.label !== o.best.label && t.label !== o.current.label).slice(0, 3).forEach((t) => rows.push({ ...t, name: "次の候補" }));
    const pc = (x) => (x == null ? "pct" : pctClass(x));
    const cols = [{ h: "条件", f: (r) => `${r.name}: ${r.label}` }];
    if (key === "buy") {
      cols.push(
        { h: "3年の差(中央値)", f: (r) => `${ptText(r.y3.med)}%`, cls: (r) => pc(r.y3.med) },
        { h: "5年の差(中央値)", f: (r) => `${ptText(r.y5.med)}%`, cls: (r) => pc(r.y5.med) },
        { h: "5年で勝った", f: (r) => (r.cls === "cur" ? "—" : `${Math.round(r.y5.win * 100)}%`) },
        { h: "5年でいちばん負けた回", f: (r) => (r.cls === "cur" ? "—" : `${ptText(r.y5.worst)}%`) },
        { h: "1年で要った追加の現金(最大)", f: (r) => man(r.cash_peak) },
        { h: "2018年〜の実際の基準価額", f: (r) => `×${r.real_mult.toFixed(2)}` }
      );
    } else {
      cols.push(
        { h: "3年: 売らないとの差", f: (r) => `${ptText(r.y3.med)}%`, cls: (r) => pc(r.y3.med) },
        { h: "5年: 売らないとの差", f: (r) => `${ptText(r.y5.med)}%`, cls: (r) => pc(r.y5.med) },
        { h: "5年で勝った(同じ)", f: (r) => `${Math.round(r.y5.win * 100)}%(${Math.round(r.y5.tie * 100)}%)` },
        { h: "5年でいちばん負けた回", f: (r) => `${ptText(r.y5.worst)}%` },
        { h: "2018年〜の実際の基準価額", f: (r) => `×${r.real_mult.toFixed(2)}` }
      );
    }
    optTable($(`opt-${key}-table`), rows, cols);

    // 種類ごとのいちばん良い条件(条件を満たすものがない種類も出す)
    const fam = (o.families || []).map((f) => ({ ...f.best, name: f.name, excluded: f.excluded }));
    const fcols = [
      { h: "種類", f: (r) => r.name },
      { h: "いちばん良い条件", f: (r) => (r.excluded ? `${r.label}(選ばない: ${r.excluded})` : r.label), cls: () => "lt" },
      { h: key === "buy" ? "5年の差(中央値)" : "5年: 売らないとの差", f: (r) => `${ptText(r.y5.med)}%`, cls: (r) => pc(r.y5.med) },
      { h: "5年で勝った", f: (r) => `${Math.round(r.y5.win * 100)}%` },
      { h: "いちばん負けた回", f: (r) => `${ptText(r.y5.worst)}%` },
      { h: "2018年〜", f: (r) => `×${r.real_mult.toFixed(2)}` },
    ];
    optTable($(`opt-${key}-fam`), fam, fcols);

    const why = $(`opt-${key}-why`);
    why.textContent = "";
    o.reasons.forEach((t) => why.append(el("li", null, t)));
    const w = o.walk;
    if (w && w.n) {
      why.append(
        el(
          "li",
          null,
          `過去の確かめ(${w.years[0].year}〜${w.years[w.years.length - 1].year}年の${w.n}年): その年より前のデータだけで選び直すと、今のルールと違う条件になったのが ${w.changed}年。その後3年で今のルールに勝ったのが ${w.win}年、負けたのが ${w.lose}年でした。`
        )
      );
    }
    if (key === "sell") why.append(el("li", null, `2018年〜の実際の基準価額で「売らない」は ×${o.never_real_mult.toFixed(2)}(倍率は最後に全部売ったときの税引後の資産 ÷ 自分で入れたお金)。`));
    else why.append(el("li", null, "差は、同じ期間に今のルールで買った場合の「資産 ÷ 入れたお金」との比べです。2018年〜は売らずに持ち続けた場合の倍率。"));
  }

  function renderOpt(o) {
    $("opt").hidden = false;
    $("opt-sub").textContent =
      `${dateJa(o.data_end)} までの基準価額(${o.data_start.slice(0, 4)}年〜。${o.real_start.slice(0, 7).replace("-", "年")}月より前は日経平均×4.3の仮の値)で、買い時・売り時の条件を計算し直した結果です(計算 ${updatedJa(o.computed)})。基準価額が更新されるたびに自動で計算し直します。ページのルール自体は変えていません。`;
    renderOptPart("buy", o.buy, o.best_since && o.best_since.buy);
    renderOptPart("sell", o.sell, o.best_since && o.best_since.sell);
    const h = (o.history || []).slice(-10).reverse();
    optTable($("opt-history"), h, [
      { h: "基準価額の日", f: (r) => dateJa(r.data_end) },
      { h: "追加買い", f: (r) => `${r.buy_verdict === "change" ? "見直し候補" : "そのまま"}(いちばん良い: ${r.buy})` },
      { h: "売り", f: (r) => `${r.sell_verdict === "change" ? "見直し候補" : "そのまま"}(いちばん良い: ${r.sell})` },
    ]);
  }

  async function loadOpt() {
    try {
      const res = await fetch(`${OPT_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      renderOpt(await res.json());
    } catch {
      $("opt").hidden = true; // 見直しの結果がまだなくても、ほかの表示は続ける
    }
  }

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
      loadOpt();
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
