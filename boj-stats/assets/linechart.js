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

  // opts: { months: [YYYY-MM], lines: [{name, color, val(d)}], extra: [{name, val(d)}](吹き出しのみ), yoy: bool, label }
  function draw(box, legend, opts) {
    const { months: ms, lines, extra = [], yoy } = opts;
    if (legend) {
      legend.replaceChildren(
        ...lines.map((s) => {
          const sp = el("span");
          const i = el("i");
          i.style.background = s.color;
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
    if (yoy) {
      // 前年が小さい月の極端な伸び率で軸がつぶれないよう、上下1%を切る
      const sorted = [...vals].sort((a, b) => a - b);
      lo = Math.min(0, sorted[Math.floor(sorted.length * 0.01)]);
      hi = Math.max(0, sorted[Math.ceil(sorted.length * 0.99) - 1]);
    }
    const pad = (hi - lo) * 0.06 || 1;
    if (yoy) lo -= pad;
    hi += pad;
    const sx = (i) => L + (i / (ms.length - 1)) * (W - L - R);
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
    for (let i = 0; i <= 4; i++) {
      const v = lo + ((hi - lo) * i) / 4;
      add("line", { class: "grid", x1: L, x2: W - R, y1: sy(v), y2: sy(v) });
      add("text", { x: L - 6, y: sy(v) + 4, "text-anchor": "end" }, yoy ? `${Math.round(v)}%` : Math.round(v).toLocaleString("ja-JP"));
    }
    if (lo < 0 && hi > 0) add("line", { class: "grid", x1: L, x2: W - R, y1: sy(0), y2: sy(0), "stroke-dasharray": "4 3" });
    add("text", { x: L, y: H - 6 }, fmtMonth(ms[0]));
    add("text", { x: W - R, y: H - 6, "text-anchor": "end" }, fmtMonth(ms[ms.length - 1]));
    for (const s of [...lines].reverse()) {
      let d = "", pen = false;
      ms.forEach((mo, i) => {
        const v = s.val(mo);
        if (!isFinite(v)) { pen = false; return; }
        d += `${pen ? "L" : "M"}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`;
        pen = true;
      });
      add("path", { class: "line", d }).style.stroke = s.color;
    }
    const cross = add("line", { class: "cross", y1: T, y2: H - B, visibility: "hidden" });
    const hit = add("rect", { x: L, y: T, width: W - L - R, height: H - T - B, fill: "transparent" });
    const tip = el("div", "tip");
    tip.hidden = true;
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(ms.length - 1, Math.round(((px - L) / (W - L - R)) * (ms.length - 1))));
      const d = ms[i];
      cross.setAttribute("x1", sx(i));
      cross.setAttribute("x2", sx(i));
      cross.setAttribute("visibility", "visible");
      tip.replaceChildren(el("b", null, fmtMonth(d)));
      for (const s of [...lines, ...extra]) {
        const row = el("div");
        if (s.color) {
          const sw = el("i");
          sw.style.background = s.color;
          row.append(sw);
        }
        row.append(`${s.name} ${fmtVal(s.val(d), yoy)}`);
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
