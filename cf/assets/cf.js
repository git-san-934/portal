// 投資分析ページ共通: window.CF (analysis/extract.py の出力、単位は億円) からグラフと表を描く。
// ページ側は id="c-flow" などの入れ物を置くだけでよい。入れ物がないグラフは描かない。
(function () {
  const C = window.CF;
  const Y = C.years.map(y => `${y.slice(2, 4)}/${+y.slice(5, 7)}`);
  const neg = a => (a || []).map(v => v == null ? null : -v);
  const r1 = v => v == null ? null : Math.round(v);
  const D = {};
  ['sales','opinc','net','op','inv','fin','dep','rd','cash','imp','recv','assets','equity'].forEach(k => D[k] = (C[k] || []).map(r1));
  D.capex = neg(C.ppe).map(r1);
  D.div = neg(C.div).map(r1);
  D.buy = neg(C.buy).map(v => v == null ? 0 : r1(v));
  D.acq = neg(C.acq).map(v => v == null ? 0 : r1(v));
  const ok = (...a) => a.every(v => v != null);
  D.fcf = D.op.map((v, i) => ok(v, D.capex[i]) ? v - D.capex[i] : null);
  const hasRd = D.rd.some(v => v != null);  // 研究開発費が一部の年だけ欠けている場合は、その年の合計を出さない
  D.future = D.capex.map((v, i) => v == null || (hasRd && D.rd[i] == null) ? null : v + (D.rd[i] || 0));
  D.futRatio = D.future.map((v, i) => ok(v, D.sales[i]) ? +(v / D.sales[i] * 100).toFixed(1) : null);
  D.ret = D.div.map((v, i) => v == null ? null : v + (D.buy[i] || 0));
  D.dso = D.recv.map((v, i) => ok(v, D.sales[i]) ? Math.round(v / D.sales[i] * 365) : null);
  D.opm = D.opinc.map((v, i) => ok(v, D.sales[i]) ? +(v / D.sales[i] * 100).toFixed(1) : null);
  Object.assign(D, C.extra || {});
  window.CFD = D;

  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const tip = document.createElement('div'); tip.className = 'tip'; document.body.appendChild(tip);
  const fmt = v => v == null ? '－' : (v < 0 ? '△' + Math.abs(v).toLocaleString() : v.toLocaleString());
  function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw || 1))); const n = raw / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }

  // series: {name,key,color,type:'bar'|'line',stack?,axis?:'r',unit?}
  function chart(id, series, opt = {}) {
    const el = document.getElementById(id); if (!el) return;
    series = series.filter(s => (D[s.key] || []).some(v => v != null && v !== 0));
    const W = 640, H = opt.h || 300, L = 62, R = opt.right ? 58 : 8, T = 14, B = 34;
    const bars = series.filter(s => s.type === 'bar'), lines = series.filter(s => s.type === 'line' && s.axis !== 'r'), rl = series.filter(s => s.axis === 'r');
    const stacks = {}; bars.forEach(s => { const g = s.stack || s.key; (stacks[g] = stacks[g] || []).push(s); });
    const groups = Object.values(stacks);
    let lo = 0, hi = 0;
    Y.forEach((_, i) => {
      groups.forEach(g => { let p = 0, n = 0; g.forEach(s => { const v = D[s.key][i] || 0; v >= 0 ? p += v : n += v; }); hi = Math.max(hi, p); lo = Math.min(lo, n); });
      lines.forEach(s => { const v = D[s.key][i]; if (v != null) { hi = Math.max(hi, v); lo = Math.min(lo, v); } });
    });
    const step = niceStep((hi - lo) / 4 || 1);
    hi = Math.ceil(hi / step) * step; lo = Math.floor(lo / step) * step; if (hi === lo) hi = lo + step;
    const y = v => T + (hi - v) / (hi - lo) * (H - T - B);
    const cw = (W - L - R) / Y.length, x0 = i => L + cw * i;
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
    for (let v = lo; v <= hi + 1e-9; v += step) {
      s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? css('--text-sub') : css('--grid')}"/>`;
      s += `<text x="${L - 6}" y="${y(v) + 5}" text-anchor="end">${(+v.toFixed(2)).toLocaleString()}</text>`;
    }
    let rlo = 0, rmax = 0; rl.forEach(sr => D[sr.key].forEach(v => { if (v != null) { rmax = Math.max(rmax, v); rlo = Math.min(rlo, v); } }));
    const rstep = niceStep((rmax - rlo) / 4 || 1); rmax = Math.ceil(rmax / rstep) * rstep; rlo = Math.floor(rlo / rstep) * rstep;
    const yr = v => T + (rmax - v) / (rmax - rlo || 1) * (H - T - B);
    if (opt.right) for (let v = rlo; v <= rmax + 1e-9; v += rstep) s += `<text x="${W - R + 6}" y="${yr(v) + 5}">${+v.toFixed(1)}${opt.runit || '%'}</text>`;
    const gw = Math.min(cw * 0.78 / Math.max(groups.length, 1), 34);
    Y.forEach((lab, i) => {
      s += `<text x="${x0(i) + cw / 2}" y="${H - 6}" text-anchor="middle">${lab}</text>`;
      groups.forEach((g, gi) => {
        let p = 0, n = 0; const gx = x0(i) + cw / 2 - gw * groups.length / 2 + gw * gi + 1.5;
        g.forEach(sr => {
          const v = D[sr.key][i]; if (v == null || v === 0) return;
          let a, b; if (v >= 0) { a = y(p + v); b = y(p); p += v; } else { a = y(n); b = y(n + v); n += v; }
          s += `<rect x="${gx}" y="${a}" width="${gw - 3}" height="${Math.max(b - a, 0.5)}" rx="2" fill="${css(sr.color)}"/>`;
        });
      });
      s += `<rect x="${x0(i)}" y="${T}" width="${cw}" height="${H - T - B}" fill="transparent" data-i="${i}" class="hit"/>`;
    });
    const drawLine = (sr, yf) => {
      const pts = D[sr.key].map((v, i) => v == null ? null : [x0(i) + cw / 2, yf(v)]).filter(Boolean);
      s += `<polyline points="${pts.map(p => p.join(',')).join(' ')}" fill="none" stroke="${css(sr.color)}" stroke-width="2.2"/>`;
      pts.forEach(p => s += `<circle cx="${p[0]}" cy="${p[1]}" r="3.4" fill="${css('--card-bg')}" stroke="${css(sr.color)}" stroke-width="2"/>`);
    };
    lines.forEach(sr => drawLine(sr, y)); rl.forEach(sr => drawLine(sr, yr));
    el.innerHTML = s + `</svg>`;
    let lg = el.nextElementSibling;
    if (!lg || !lg.classList.contains('legend')) { lg = document.createElement('div'); lg.className = 'legend'; el.after(lg); }
    lg.innerHTML = series.map(sr => `<span class="${sr.type === 'line' ? 'ln' : ''}" style="--sw:${css(sr.color)}">${sr.name}</span>`).join('');
    el.querySelectorAll('.hit').forEach(r => {
      const show = e => {
        const i = +r.dataset.i, pt = e.touches ? e.touches[0] : e;
        tip.innerHTML = `<b style="color:inherit">${Y[i]}期</b><br>` + series.map(sr => `${sr.name}：${fmt(D[sr.key][i])}${sr.axis === 'r' ? (sr.unit || '%') : ''}`).join('<br>');
        tip.style.display = 'block';
        tip.style.left = Math.min(pt.clientX + 12, innerWidth - tip.offsetWidth - 8) + 'px'; tip.style.top = (pt.clientY + 12) + 'px';
      };
      r.addEventListener('mousemove', show); r.addEventListener('touchstart', show, { passive: true });
      r.addEventListener('mouseleave', () => tip.style.display = 'none');
    });
  }
  document.addEventListener('touchstart', e => { if (!e.target.classList.contains('hit')) tip.style.display = 'none'; }, { passive: true });

  const CHARTS = {
    'c-pl': [[{ name: '売上高', key: 'sales', color: '--c-dep', type: 'bar' }, { name: '営業利益', key: 'opinc', color: '--c-op', type: 'bar' }, { name: '営業利益率', key: 'opm', color: '--c-line', type: 'line', axis: 'r' }], { right: true }],
    'c-flow': [[{ name: '営業CF', key: 'op', color: '--c-op', type: 'bar' }, { name: '投資CF', key: 'inv', color: '--c-inv', type: 'bar' }, { name: '財務CF', key: 'fin', color: '--c-fin', type: 'bar' }, { name: '本業のフリーCF', key: 'fcf', color: '--c-line', type: 'line' }]],
    'c-future': [[{ name: '設備投資', key: 'capex', color: '--c-capex', type: 'bar', stack: 'f' }, { name: '研究開発費', key: 'rd', color: '--c-rd', type: 'bar', stack: 'f' }, { name: '売上高に対する比率', key: 'futRatio', color: '--c-line', type: 'line', axis: 'r' }], { right: true }],
    'c-dep': [[{ name: '設備投資', key: 'capex', color: '--c-capex', type: 'bar' }, { name: '減価償却費', key: 'dep', color: '--c-dep', type: 'bar' }], { h: 260 }],
    'c-ret': [[{ name: '配当', key: 'div', color: '--c-div', type: 'bar', stack: 'r' }, { name: '自社株買い', key: 'buy', color: '--c-buy', type: 'bar', stack: 'r' }, { name: '本業のフリーCF', key: 'fcf', color: '--c-line', type: 'line' }], { h: 280 }],
    'c-recv': [[{ name: '売掛金など', key: 'recv', color: '--c-op', type: 'bar' }, { name: '回収日数の目安', key: 'dso', color: '--c-line', type: 'line', axis: 'r', unit: '日' }], { right: true, runit: '日', h: 260 }],
  };
  // ページ独自のグラフ: window.CF_CHARTS = { id: [series, opt] }
  Object.assign(CHARTS, window.CF_CHARTS || {});
  function render() { for (const id in CHARTS) chart(id, ...CHARTS[id]); }

  const last = Y.length - 1;
  const kp = document.getElementById('kpis');
  if (kp) {
    const k = (window.CF_KPIS || [['営業CF', 'op'], ['投資CF', 'inv'], ['設備投資', 'capex', 'dep', '減価償却費'], ['現金残高', 'cash']]);
    kp.innerHTML = k.map(([l, key, sub, subl]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${fmt(D[key][last])}</div><div class="d">${sub ? `${subl} ${fmt(D[sub][last])}` : `前期 ${fmt(D[key][last - 1])}`}</div></div>`).join('');
  }
  const tb = document.getElementById('tbl');
  if (tb) {
    const rows = window.CF_ROWS || [
      ['売上高', 'sales'], ['営業利益', 'opinc'], ['純利益', 'net'], null,
      ['営業CF', 'op', 1], ['　減価償却費', 'dep'], ['投資CF', 'inv', 1], ['　うち設備投資', 'capex', 0, -1], ['　うち企業買収', 'acq', 0, -1],
      ['財務CF', 'fin', 1], ['　うち配当', 'div', 0, -1], ['　うち自社株買い', 'buy', 0, -1], null,
      ['本業のフリーCF', 'fcf', 1], ['研究開発費', 'rd'], ['減損損失', 'imp'], ['現金残高', 'cash', 1],
    ];
    tb.innerHTML = '<thead><tr><th></th>' + Y.map(y => `<th>${y}</th>`).join('') + '</tr></thead><tbody>' +
      rows.filter(r => !r || (D[r[1]] || []).some(v => v)).map(r => r ? `<tr class="${r[2] ? 'sum' : ''}"><td>${r[0]}</td>` + D[r[1]].map(v => { const x = v == null ? null : v * (r[3] || 1); return `<td class="${x < 0 ? 'neg' : ''}">${fmt(x)}</td>`; }).join('') + '</tr>'
        : `<tr><td colspan="${Y.length + 1}" style="border:0;padding:.25rem"></td></tr>`).join('') + '</tbody>';
  }
  render();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
})();
