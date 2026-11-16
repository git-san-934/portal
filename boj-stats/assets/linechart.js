// 複数系列の折れ線(月次)。trade.html と系列ページの品目内訳で共用
window.MultiLine = (() => {
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const fmtMonth = (d) => `${d.slice(0, 4)}年${+d.slice(5)}月`;
  const fmtVal = (v, yoy) =>
    v == null || !isFinite(v) ? "-" : yoy ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` : `${v.toLocaleString("ja-JP", { maximumFractionDigits: Math.abs(v) < 10 ? 1 : 0 })}億円`;

  // opts: { months: [YYYY-MM], lines: [{name, color, val(d)}], extra: [{name, val(d)}](吹き出しのみ), yoy: bool, label,
  //         fmt(v): 吹き出しの値(省略で億円/%), tick(v): 軸の目盛り(省略で整数),
  //         fmtX(d): 横軸と吹き出しの日付(省略で「YYYY年M月」), signed: 0をまたぐ値(yoy と同じ縦軸の取り方), dots: 点を打つ }
  // lines の各要素は dash(破線)、noLegend(凡例に出さない)、tip(d)(吹き出しの値。値が無ければ吹き出しに出さない)も持てる
  //         xTicks: [{at, text}](横軸の目盛り。指定すると両端の日付の代わりに出す),
  //         breaks: [d](その点の手前で線を切り、縦の点線を引く。系列の断層用),
  //         xAt(d): 横位置の数値(年の小数など。指定すると時間に比例した横軸),
  //         nice: true(縦軸の目盛りを切りのよい数に。tick(v, 小数の桁数) で呼ぶ),
  //         trim: false(signed の縦軸で上下1%を切らない。DIなど極端な値も見せたい系列用)
  function draw(box, legend, opts) {
    const { months: ms, lines, extra = [], yoy } = opts;
    const signed = yoy || opts.signed;
    const fmtX = opts.fmtX || fmtMonth;
    const fmt = opts.fmt || ((v) => fmtVal(v, yoy));
    const tick = opts.tick || ((v) => (yoy ? `${Math.round(v)}%` : Math.round(v).toLocaleString("ja-JP")));
    if (legend) {
      legend.replaceChildren(
        ...lines.filter((s) => !s.noLegend).map((s) => {
          const sp = el("span");
          const i = el("i");
          // 破線の系列は凡例も破線にする
          i.style.background = s.dash ? `repeating-linear-gradient(90deg, ${s.color} 0 4px, transparent 4px 7px)` : s.color;
          sp.append(i, s.name);
          return sp;
        })
      );
    }
    if (ms.length < 2) {
      box.replaceChildren(el("p", "empty", "チャートを描くだけの値がありません"));
      return;
    }
    const W = 440, H = 260, L = 58, R = 12, T = 12, B = 26;
    const vals = lines.flatMap((s) => ms.map((d) => s.val(d))).filter((v) => isFinite(v));
    if (!vals.length) {
      box.replaceChildren(el("p", "empty", "チャートを描くだけの値がありません"));
      return;
    }
    let lo = 0, hi = Math.max(...vals, 1);
    if (signed) {
      // 前年が小さい月の極端な伸び率で軸がつぶれないよう、上下1%を切る(trim: false なら切らない)
      const sorted = [...vals].sort((a, b) => a - b);
      const cut = opts.trim === false ? 0 : 0.01;
      lo = Math.min(0, sorted[Math.floor(sorted.length * cut)]);
      hi = Math.max(0, sorted[Math.ceil(sorted.length * (1 - cut)) - 1]);
    }
    // nice: 縦軸の目盛りを切りのよい数(1・2・2.5・5 の10のべき倍)にそろえる
    let ticks = null;
    if (opts.nice) {
      const raw = (hi - lo) / 4 || 1;
      const mag = 10 ** Math.floor(Math.log10(raw));
      const k = [1, 2, 2.5, 5, 10].find((x) => x * mag >= raw - 1e-12);
      const step = k * mag;
      lo = Math.floor(lo / step + 1e-9) * step;
      hi = Math.ceil(hi / step - 1e-9) * step;
      if (hi === lo) hi = lo + step;
      const dg = Math.max(0, -Math.floor(Math.log10(step) + 1e-9)) + (k === 2.5 && step < 10 ? 1 : 0);
      ticks = [];
      for (let v = lo; v <= hi + step / 2; v += step) ticks.push({ v: Math.abs(v) < step / 1e6 ? 0 : v, dg });
    } else {
      const pad = (hi - lo) * 0.06 || 1;
      if (signed) lo -= pad;
      hi += pad;
    }
    // xAt(d) があれば横位置は時間の比率(月次と旬次が混ざる系列でも時間の幅をそろえる)。無ければ点の順番で等間隔
    const n = ms.length;
    const xv = opts.xAt ? ms.map(opts.xAt) : null;
    const frac = (i) => {
      if (!xv) return i / (n - 1);
      const a = Math.max(0, Math.floor(i)), b = Math.min(n - 1, Math.ceil(i));
      const v = xv[a] + (xv[b] - xv[a]) * (i - a);
      return (v - xv[0]) / (xv[n - 1] - xv[0] || 1);
    };
    const sx = (i) => L + frac(i) * (W - L - R);
    // 横位置 px にいちばん近い点の番号
    const nearest = (px) => {
      const f = (px - L) / (W - L - R);
      if (!xv) return Math.max(0, Math.min(n - 1, Math.round(f * (n - 1))));
      const t = xv[0] + f * (xv[n - 1] - xv[0]);
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (xv[mid] < t) lo = mid; else hi = mid;
      }
      return t - xv[lo] < xv[hi] - t ? lo : hi;
    };
    const sy = (v) => T + (1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (H - T - B);
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("role", "img");
    if (opts.label) svg.setAttribute("aria-label", opts.label);
    const add = (tag, attrs, text) => {
      const e = document.createElementNS(ns, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      if (text != null) e.textContent = text;
      svg.append(e);
      return e;
    };
    for (const t of ticks || [0, 1, 2, 3, 4].map((i) => ({ v: lo + ((hi - lo) * i) / 4 }))) {
      add("line", { class: "grid", x1: L, x2: W - R, y1: sy(t.v), y2: sy(t.v) });
      add("text", { x: L - 6, y: sy(t.v) + 4, "text-anchor": "end" }, tick(t.v, t.dg));
    }
    if (lo < 0 && hi > 0) add("line", { class: "grid", x1: L, x2: W - R, y1: sy(0), y2: sy(0), "stroke-dasharray": "4 3" });
    const idx = Object.fromEntries(ms.map((d, i) => [d, i]));
    if (opts.xTicks) {
      for (const t of opts.xTicks) {
        const i = idx[t.at];
        if (i == null) continue;
        add("line", { class: "grid", x1: sx(i), x2: sx(i), y1: H - B, y2: H - B + 4 });
        const anchor = sx(i) < L + 20 ? "start" : sx(i) > W - R - 20 ? "end" : "middle";
        add("text", { x: sx(i), y: H - 6, "text-anchor": anchor }, t.text);
      }
    } else {
      add("text", { x: L, y: H - 6 }, fmtX(ms[0]));
      add("text", { x: W - R, y: H - 6, "text-anchor": "end" }, fmtX(ms[ms.length - 1]));
    }
    const breaks = new Set((opts.breaks || []).filter((d) => idx[d] > 0));
    for (const d of breaks) {
      const x = sx(idx[d] - 0.5);
      add("line", { class: "brk", x1: x, x2: x, y1: T, y2: H - B });
    }
    for (const s of [...lines].reverse()) {
      let d = "", pen = false;
      ms.forEach((mo, i) => {
        const v = s.val(mo);
        if (!isFinite(v)) { pen = false; return; }
        if (breaks.has(mo) && (!s.cut || s.cut.has(mo))) pen = false; // cut: その系列で線を切る断層(省略で全部)
        d += `${pen ? "L" : "M"}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`;
        pen = true;
      });
      const path = add("path", { class: "line", d });
      path.style.stroke = s.color;
      if (s.dash) path.setAttribute("stroke-dasharray", "5 4");
      if (opts.dots)
        ms.forEach((mo, i) => {
          const v = s.val(mo);
          if (isFinite(v)) add("circle", { cx: sx(i), cy: sy(v), r: 2.4 }).style.fill = s.color;
        });
    }
    const cross = add("line", { class: "cross", y1: T, y2: H - B, visibility: "hidden" });
    const hit = add("rect", { x: L, y: T, width: W - L - R, height: H - T - B, fill: "transparent" });
    const tip = el("div", "tip");
    tip.hidden = true;
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const i = nearest(px);
      const d = ms[i];
      cross.setAttribute("x1", sx(i));
      cross.setAttribute("x2", sx(i));
      cross.setAttribute("visibility", "visible");
      tip.replaceChildren(el("b", null, fmtX(d)));
      for (const s of [...lines, ...extra]) {
        const v = s.tip ? s.tip(d) : s.val(d);
        if (s.tip && !isFinite(v)) continue;
        const row = el("div");
        if (s.color) {
          const sw = el("i");
          sw.style.background = s.color;
          row.append(sw);
        }
        row.append(`${s.name} ${fmt(v)}`);
        tip.append(row);
      }
      tip.hidden = false;
      const x = (sx(i) / W) * r.width;
      tip.style.left = `${x > r.width / 2 ? x - tip.offsetWidth - 10 : x + 10}px`;
      tip.style.top = "8px";
    };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerdown", move);
    hit.addEventListener("pointerleave", () => {
      tip.hidden = true;
      cross.setAttribute("visibility", "hidden");
    });
    box.replaceChildren(svg, tip);
  }

  // 月の並び months に対する n か月合計と前年同期比
  function series(months) {
    const idx = Object.fromEntries(months.map((d, i) => [d, i]));
    const prevYear = (d) => `${+d.slice(0, 4) - 1}${d.slice(4)}`;
    const sumN = (v, d, n) => {
      const i = idx[d];
      if (i == null || i - n + 1 < 0) return NaN;
      let t = 0;
      for (let k = i - n + 1; k <= i; k++) t += v[months[k]] || 0;
      return t;
    };
    return (v, d, yoy, n) => {
      const x = sumN(v, d, n);
      if (!yoy) return x / n;
      const p = sumN(v, prevYear(d), n);
      return p > 0 ? (x / p - 1) * 100 : NaN;
    };
  }

  return { draw, series, fmtMonth, fmtVal, el };
})();
