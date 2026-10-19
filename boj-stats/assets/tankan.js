(() => {
  const $ = (x) => document.getElementById(x);
  const { el } = MultiLine;
  const COLORS = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)"];
  const fmtSurvey = (d) => `${d.slice(0, 4)}年${+d.slice(5)}月`;
  const fmtDay = (d) => d.split("-").map(Number).join("/");
  const signed = (v) => (v == null || !isFinite(v) ? "-" : `${v > 0 ? "+" : ""}${v}`);
  const nextQuarter = (d) => {
    let y = +d.slice(0, 4), m = +d.slice(5) + 3;
    if (m > 12) (y += 1), (m -= 12);
    return `${y}-${String(m).padStart(2, "0")}`;
  };
  // 業種の並び(短観の計表の順)
  const INDUSTRIES = [
    "製造業", "素材業種", "加工業種", "繊維", "木材・木製品", "紙・パルプ", "化学", "石油・石炭製品", "窯業・土石製品", "鉄鋼", "非鉄金属",
    "食料品", "金属製品", "はん用機械", "生産用機械", "業務用機械", "電気機械", "造船・重機等", "自動車",
    "非製造業", "建設", "不動産", "物品賃貸", "卸売", "小売", "運輸・郵便", "通信", "情報サービス", "電気・ガス",
    "対事業所サービス", "対個人サービス", "宿泊・飲食サービス", "全産業",
  ];
  const SIZES = ["大企業", "中堅企業", "中小企業", "全規模合計"];
  const MAIN4 = [["大企業", "製造業"], ["大企業", "非製造業"], ["中小企業", "製造業"], ["中小企業", "非製造業"]];
  const BIZ_VIEWS = {
    main: { label: "主な4つ", lines: () => MAIN4 },
    size: { label: "規模別(全産業)", lines: () => SIZES.map((s) => [s, "全産業"]) },
    ind: { label: "業種を選ぶ", lines: () => SIZES.map((s) => [s, state.ind]) },
  };
  // その他の判断DI。lines は [規模, 業種]
  const OTHERS = {
    国内需給: { name: "国内での製商品・サービス需給", def: "「需要超過」−「供給超過」", lines: MAIN4 },
    海外需給: { name: "海外での製商品需給", def: "「需要超過」−「供給超過」", lines: [["大企業", "製造業"], ["中小企業", "製造業"]] },
    製品在庫: { name: "製商品在庫水準", def: "「過大」−「不足」", lines: [["大企業", "製造業"], ["中小企業", "製造業"]] },
    流通在庫: { name: "製商品流通在庫水準", def: "「過大」−「不足」", lines: [["大企業", "製造業"], ["中小企業", "製造業"]] },
    販売価格: { name: "販売価格", def: "「上昇」−「下落」", lines: MAIN4 },
    仕入価格: { name: "仕入価格", def: "「上昇」−「下落」", lines: MAIN4 },
    設備: { name: "生産・営業用設備", def: "「過剰」−「不足」", lines: SIZES.map((s) => [s, "全産業"]) },
    雇用人員: { name: "雇用人員", def: "「過剰」−「不足」", lines: SIZES.map((s) => [s, "全産業"]) },
    資金繰り: { name: "資金繰り", def: "「楽である」−「苦しい」", lines: SIZES.map((s) => [s, "全産業"]) },
    貸出態度: { name: "金融機関の貸出態度", def: "「緩い」−「厳しい」", lines: SIZES.map((s) => [s, "全産業"]) },
    借入金利水準: { name: "借入金利水準", def: "「上昇」−「低下」", lines: SIZES.map((s) => [s, "全産業"]) },
  };
  const params = new URLSearchParams(location.search);
  const state = {
    view: BIZ_VIEWS[params.get("v")] ? params.get("v") : "main",
    ind: INDUSTRIES.includes(params.get("ind")) ? params.get("ind") : "製造業",
    other: OTHERS[params.get("o")] ? params.get("o") : "販売価格",
    price: params.get("p") === "all" ? "all" : "sales",
  };
  let T, latest, fc;

  const get = (item, size, ind, kind) => ((T.series[`${item}|${size}|${ind}`] || {})[kind]) || {};
  const label = (size, ind) => (size === "全規模合計" ? `全規模 ${ind}` : `${size} ${ind}`);

  function saveUrl() {
    const p = new URLSearchParams();
    if (state.view !== "main") p.set("v", state.view);
    if (state.view === "ind") p.set("ind", state.ind);
    if (state.other !== "販売価格") p.set("o", state.other);
    if (state.price !== "sales") p.set("p", state.price);
    const q = p.toString();
    history.replaceState(null, "", q ? `?${q}` : location.pathname);
  }

  function buttons(box, entries, current, onPick) {
    box.replaceChildren(
      ...entries.map(([k, text]) => {
        const b = el("button", null, text);
        b.type = "button";
        b.setAttribute("aria-pressed", k === current);
        b.onclick = () => onPick(k);
        return b;
      })
    );
  }

  // 判断DIの折れ線: 実線が各回の「最近」、最新回から次の期への破線が「先行き」
  function drawDI(box, legend, item, specs) {
    const specsWith = specs.filter(([s, i]) => Object.keys(get(item, s, i, "最近")).length);
    const hasFc = specsWith.some(([s, i]) => get(item, s, i, "先行き")[latest] != null);
    const xs = hasFc ? [...T.surveys, fc] : T.surveys;
    const lines = [];
    specsWith.forEach(([s, i], n) => {
      const rec = get(item, s, i, "最近");
      const f = get(item, s, i, "先行き")[latest];
      const color = COLORS[n % COLORS.length];
      lines.push({ name: label(s, i), color, val: (d) => (rec[d] == null ? NaN : rec[d]) });
      if (f != null)
        lines.push({
          name: `${label(s, i)}(先行き)`, color, dash: true, noLegend: true,
          val: (d) => (d === latest ? rec[d] ?? NaN : d === fc ? f : NaN),
          tip: (d) => (d === fc ? f : NaN),
        });
    });
    MultiLine.draw(box, legend, {
      months: xs, lines, signed: true, dots: true,
      fmtX: (d) => (d === fc ? `${fmtSurvey(d)}(先行き)` : `${fmtSurvey(d)}調査`),
      fmt: signed, tick: (v) => Math.round(v),
      label: `${item}の推移`,
    });
    return specsWith;
  }

  // 最新回の表: 前回・今回・変化・先行き
  function table(box, item, specs) {
    const prev = T.surveys[T.surveys.length - 2];
    const head = el("tr");
    for (const t of ["", `${fmtSurvey(prev)}`, `${fmtSurvey(latest)}`, "変化", "先行き"]) head.append(el("th", null, t));
    const rows = specs.map(([s, i]) => {
      const rec = get(item, s, i, "最近");
      const f = get(item, s, i, "先行き")[latest];
      const tr = el("tr");
      tr.append(el("td", "cname", label(s, i)));
      tr.append(el("td", "num", signed(rec[prev])));
      tr.append(el("td", "num", signed(rec[latest])));
      const ch = rec[latest] != null && rec[prev] != null ? rec[latest] - rec[prev] : null;
      tr.append(el("td", `num ${ch > 0 ? "up" : ch < 0 ? "down" : ""}`, signed(ch)));
      tr.append(el("td", "num", f == null ? "-" : signed(f)));
      return tr;
    });
    box.replaceChildren(head, ...rows);
  }

  function renderBiz() {
    buttons($("biz-views"), Object.entries(BIZ_VIEWS).map(([k, v]) => [k, v.label]), state.view, (k) => {
      state.view = k;
      saveUrl();
      renderBiz();
    });
    const sel = $("biz-ind");
    sel.hidden = state.view !== "ind";
    const specs = BIZ_VIEWS[state.view].lines();
    const shown = drawDI($("biz-chart"), $("biz-legend"), "業況判断", specs);
    table($("biz-table"), "業況判断", shown);
  }

  function renderOther() {
    buttons($("other-items"), Object.entries(OTHERS).map(([k, v]) => [k, v.name]), state.other, (k) => {
      state.other = k;
      saveUrl();
      renderOther();
    });
    const o = OTHERS[state.other];
    $("other-name").textContent = `${o.name}判断`;
    $("other-def").textContent = `${o.def}(%ポイント)`;
    const shown = drawDI($("other-chart"), $("other-legend"), state.other, o.lines);
    table($("other-table"), state.other, shown);
  }

  function renderPrice() {
    const items = { sales: "物価見通し 販売価格", all: "物価見通し 物価全般" };
    buttons($("price-kinds"), [["sales", "自社の販売価格"], ["all", "物価全般(消費者物価)"]], state.price, (k) => {
      state.price = k;
      saveUrl();
      renderPrice();
    });
    const item = items[state.price];
    const lines = ["1年後", "3年後", "5年後"].map((h, n) => {
      const v = get(item, "全規模合計", "全産業", h);
      return { name: h, color: COLORS[n], val: (d) => (v[d] == null ? NaN : v[d]) };
    });
    const xs = T.surveys.filter((d) => lines.some((s) => isFinite(s.val(d))));
    MultiLine.draw($("price-chart"), $("price-legend"), {
      months: xs, lines, dots: true,
      fmtX: (d) => `${fmtSurvey(d)}調査`,
      fmt: (v) => (isFinite(v) ? `${v.toFixed(1)}%` : "-"),
      tick: (v) => `${v.toFixed(1)}%`,
      label: "企業の物価見通しの推移",
    });
    $("price-note").textContent =
      state.price === "sales"
        ? "自社の主な製品・サービスの販売価格が、現在の水準から何%変わると見ているか(全規模・全産業の平均)。"
        : "消費者物価が前年比で何%上がると見ているか(全規模・全産業の平均)。";
  }

  function init() {
    const sel = $("biz-ind");
    sel.replaceChildren(
      ...INDUSTRIES.filter((i) => SIZES.some((s) => T.series[`業況判断|${s}|${i}`])).map((i) => {
        const o = el("option", null, i);
        o.value = i;
        o.selected = i === state.ind;
        return o;
      })
    );
    sel.onchange = () => {
      state.ind = sel.value;
      saveUrl();
      renderBiz();
    };
    renderBiz();
    renderOther();
    renderPrice();
  }

  fetch(`pipeline/data/tankan.json?t=${Date.now()}`)
    .then((r) => {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    })
    .then((d) => {
      T = d;
      latest = d.latest;
      fc = nextQuarter(latest);
      $("title-date").textContent = `(${fmtSurvey(latest)}調査まで)`;
      const src = d.sources[latest];
      $("status").replaceChildren(
        `最新: ${fmtSurvey(latest)}調査`,
        src ? " ・ " : "",
        ...(src ? [Object.assign(el("a", null, "元データ(zip)"), { href: src })] : []),
        d.updated ? ` ・ ${fmtDay(d.updated)} 取り込み` : ""
      );
      $("fc-note").textContent = `破線は ${fmtSurvey(latest)}調査で答えた3か月後(${fmtSurvey(fc)})の予想(先行き)です。`;
      init();
    })
    .catch(() => {
      $("status").textContent = "まだデータがありません。最初の更新をお待ちください。";
    });
})();
