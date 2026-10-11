// 「EPS・BPSの推移」の節: cf/data/eps.json (cf/scripts/fetch_eps.py の出力、単位は円) から折れ線グラフを描く。
// cf.js が読み込む。「要点」の節の次に差し込む(なければ「数字の一覧」の節の前)。データがない銘柄では何もしない。
(function () {
  const code = window.CF && window.CF.code;
  if (!code) return;
  fetch('../data/eps.json').then(r => r.ok ? r.json() : null).then(data => {
    const E = data && data.companies && data.companies[code];
    if (!E || E.years.length < 2) return;
    const Y = E.years.map(y => `${y.slice(2, 4)}/${+y.slice(5, 7)}`);
    const fyName = s => `${+s.slice(0, 4)}年${+s.slice(5, 7)}月期`;
    const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const fmt = v => v == null ? '－' : (v < 0 ? '△' + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 }) : v.toLocaleString(undefined, { maximumFractionDigits: 2 }));
    const tip = document.querySelector('.tip');
    function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw || 1))); const n = raw / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }

    function line(el, name, vals, color) {
      const W = 640, H = 240, L = 62, R = 8, T = 14, B = 34;
      const vs = vals.filter(v => v != null);
      let lo = Math.min(...vs), hi = Math.max(...vs);
      const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.1 || 1;
      lo = lo >= 0 && lo - pad < 0 ? 0 : lo - pad; hi += pad;
      const step = niceStep((hi - lo) / 4);
      hi = Math.ceil(hi / step) * step; lo = Math.floor(lo / step) * step;
      const y = v => T + (hi - v) / (hi - lo) * (H - T - B);
      const cw = (W - L - R) / Y.length, xc = i => L + cw * i + cw / 2;
      let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${name}の推移">`;
      for (let v = lo; v <= hi + 1e-9; v += step) {
        s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${Math.abs(v) < 1e-9 ? css('--text-sub') : css('--grid')}"/>`;
        s += `<text x="${L - 6}" y="${y(v) + 5}" text-anchor="end">${(+v.toFixed(2)).toLocaleString()}</text>`;
      }
      Y.forEach((lab, i) => { s += `<text x="${xc(i)}" y="${H - 6}" text-anchor="middle">${lab}</text>`; });
      // 欠けている年は線を切る
      let seg = [];
      const flush = () => { if (seg.length > 1) s += `<polyline points="${seg.join(' ')}" fill="none" stroke="${css(color)}" stroke-width="2.2"/>`; seg = []; };
      vals.forEach((v, i) => { if (v == null) flush(); else seg.push(`${xc(i)},${y(v)}`); }); flush();
      vals.forEach((v, i) => { if (v != null) s += `<circle cx="${xc(i)}" cy="${y(v)}" r="3.4" fill="${css('--card-bg')}" stroke="${css(color)}" stroke-width="2"/>`; });
      Y.forEach((_, i) => { s += `<rect x="${L + cw * i}" y="${T}" width="${cw}" height="${H - T - B}" fill="transparent" data-i="${i}" class="hit"/>`; });
      el.innerHTML = s + '</svg>';
      el.querySelectorAll('.hit').forEach(r => {
        const show = e => {
          if (!tip) return;
          const i = +r.dataset.i, pt = e.touches ? e.touches[0] : e;
          tip.innerHTML = `<b style="color:inherit">${Y[i]}期</b><br>${name}：${fmt(vals[i])}円`;
          tip.style.display = 'block';
          tip.style.left = Math.min(pt.clientX + 12, innerWidth - tip.offsetWidth - 8) + 'px'; tip.style.top = (pt.clientY + 12) + 'px';
        };
        r.addEventListener('mousemove', show); r.addEventListener('touchstart', show, { passive: true });
        r.addEventListener('mouseleave', () => { if (tip) tip.style.display = 'none'; });
      });
    }

    const sec = document.createElement('section');
    const kind = E.single ? '単体' : '連結';
    const dps = E.dps || [];
    let h = '<h2>EPS・BPS・配当の推移</h2>';
    h += `<p class="sub">1株あたりの利益（EPS）、1株あたりの純資産（BPS）、1株あたりの配当金の${fyName(E.years[0])}〜${fyName(E.years[E.years.length - 1])}の推移です。${kind}の数字で、単位は<strong>円</strong>です。</p>`;
    const has = a => a.some(v => v != null);
    if (has(E.eps)) h += '<h3>EPS（1株あたり利益）</h3><div class="chart" id="c-eps"></div>';
    if (has(E.bps)) h += '<h3>BPS（1株あたり純資産）</h3><div class="chart" id="c-bps"></div>';
    if (has(dps)) h += '<h3>1株あたり配当金（年間）</h3><div class="chart" id="c-dps"></div>';
    const none = Y.map(() => null);
    const rows = [['EPS（円）', E.eps], ['BPS（円）', E.bps], ['配当（円）', dps],
      ['PER（倍）', E.per], ['PBR（倍）', E.pbr], ['ROE（％）', E.roe], ['ROA（％）', E.roa],
      ['配当利回り（％）', E.yield], ['自己資本比率（％）', E.eqr], ['時価総額（億円）', E.mcap]];
    h += '<div class="tbl"><table><thead><tr><th></th>' + Y.map(y => `<th>${y}</th>`).join('') + '</tr></thead><tbody>' +
      rows.map(([l, v]) => [l, v || none]).filter(([, v]) => has(v)).map(([l, v]) => `<tr><td>${l}</td>` + v.map(x => `<td class="${x < 0 ? 'neg' : ''}">${fmt(x)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>';
    const notes = ['有価証券報告書の「主要な経営指標等の推移」の数字です。'];
    if (has(dps)) notes.push('配当は中間と期末の合計で、記念配当なども含みます。');
    if (has(E.per || none)) notes.push('PER・PBR・配当利回りは決算期末の株価（報告書のPER×EPS）で計算し、赤字の年は出していません。時価総額はPER×当期純利益（自己株式を除いた株数での額）です。ROAは当期純利益÷総資産（期首と期末の平均）です。');
    if (E.adj && E.adj.length) notes.push('途中で株式分割などがあったため、それより前の年は今の株数にそろえて計算し直しています。');
    const bs = [...new Set(E.basis.filter(Boolean))];
    if (bs.length > 1) notes.push('途中で会計基準が変わっているため、その前後の数字はそのまま比べられないことがあります。');
    h += `<p class="sub" style="margin-top:.5rem">${notes.join('')}</p>`;
    sec.innerHTML = h;
    const point = [...document.querySelectorAll('section > h2')].find(e => e.textContent.trim() === '要点');
    const tbl = document.getElementById('tbl');
    const before = point ? point.parentNode.nextElementSibling : tbl ? tbl.closest('section') : document.querySelector('footer');
    if (before) before.parentNode.insertBefore(sec, before); else document.querySelector('.wrap').appendChild(sec);

    const render = () => {
      if (has(E.eps)) line(document.getElementById('c-eps'), 'EPS', E.eps, '--c-op');
      if (has(E.bps)) line(document.getElementById('c-bps'), 'BPS', E.bps, '--c-rd');
      if (has(dps)) line(document.getElementById('c-dps'), '配当', dps, '--c-capex');
    };
    render();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
  }).catch(() => {});
})();
