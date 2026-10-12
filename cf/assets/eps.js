// 「EPS・BPSの推移」の節: cf/data/eps.json (cf/scripts/fetch_eps.py の出力、単位は円) から折れ線グラフを描く。
// 株価の線は cf/data/price.json (cf/price/fetch_price.py の出力) の最新の終値まで延ばす。
// cf.js が読み込む。「要点」の節の次に差し込む(なければ「数字の一覧」の節の前)。データがない銘柄では何もしない。
// window.CF を使わない独自のページ(cf/6134/ など)からは <script src="../assets/eps.js" data-code="6134"> で読み込む。
(function () {
  const me = document.currentScript;
  const code = (window.CF && window.CF.code) || (me && me.dataset.code);
  if (!code) return;
  // データはこのスクリプトの場所(cf/assets/)から見て探す。ページの場所に左右されないように
  const url = f => me && me.src ? new URL('../data/' + f, me.src) : '../data/' + f;
  const get = f => fetch(url(f)).then(r => r.ok ? r.json() : null).catch(() => null);
  Promise.all([get('eps.json'), get('price.json')]).then(([data, latest]) => {
    const E = data && data.companies && data.companies[code];
    if (!E || E.years.length < 2) return;
    const Y = E.years.map(y => `${y.slice(2, 4)}/${+y.slice(5, 7)}`);
    const fyName = s => `${+s.slice(0, 4)}年${+s.slice(5, 7)}月期`;
    const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const fmt = v => v == null ? '－' : (v < 0 ? '△' + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 }) : v.toLocaleString(undefined, { maximumFractionDigits: 2 }));
    const tip = document.querySelector('.tip');
    function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw || 1))); const n = raw / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }

    // 決算期末の株価(報告書の PER × 分割をそろえた EPS)。赤字で PER がない年は空ける
    const price = E.years.map((_, i) => E.per && E.per[i] && E.eps[i] ? Math.round(E.per[i] * E.eps[i]) : null);
    const hasPrice = price.filter(v => v != null).length >= 2;
    // 最新の終値。決算期末からの経過に合わせて、最後の期の右に置く(1年 = 1目盛り)
    const fyEnd = ym => new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0);
    const L0 = latest && latest.prices && latest.prices[code];
    const nowD = L0 && new Date(L0.date + 'T00:00:00');
    const now = hasPrice && L0 && L0.price > 0 && nowD > fyEnd(E.years[E.years.length - 1])
      ? { ...L0, t: E.years.length - 1 + (nowD - fyEnd(E.years[E.years.length - 1])) / 864e5 / 365.25, d: nowD } : null;
    const nowLabel = now && `${now.d.getFullYear()}/${now.d.getMonth() + 1}/${now.d.getDate()}`;

    function scale(vals, top, bottom) {
      const vs = vals.filter(v => v != null);
      let lo = Math.min(...vs), hi = Math.max(...vs);
      const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.1 || 1;
      lo = lo >= 0 && lo - pad < 0 ? 0 : lo - pad; hi += pad;
      const step = niceStep((hi - lo) / 4);
      hi = Math.ceil(hi / step) * step; lo = Math.floor(lo / step) * step;
      return { lo, hi, step, y: v => top + (hi - v) / (hi - lo) * (bottom - top) };
    }

    // vals を左の目盛りで実線で描き、株価があれば右の目盛りで重ねる(点線＋四角の点)
    function line(el, name, vals, color) {
      const P = hasPrice ? price : null;
      const W = 640, H = 240, L = 62, R = P ? 62 : 8, T = 14, B = 34;
      const a = scale(vals, T, H - B), b = P && scale(now ? [...P, now.price] : P, T, H - B);
      // 横軸は最新の終値の日付まで延ばす
      const cw = (W - L - R) / (now ? now.t + 1 : Y.length), xc = i => L + cw * i + cw / 2;
      const num = v => (+v.toFixed(2)).toLocaleString();
      let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${name}${P ? 'と株価' : ''}の推移">`;
      for (let v = a.lo; v <= a.hi + 1e-9; v += a.step) {
        s += `<line x1="${L}" x2="${W - R}" y1="${a.y(v)}" y2="${a.y(v)}" stroke="${Math.abs(v) < 1e-9 ? css('--text-sub') : css('--grid')}"/>`;
        s += `<text x="${L - 6}" y="${a.y(v) + 5}" text-anchor="end">${num(v)}</text>`;
      }
      if (P) for (let v = b.lo; v <= b.hi + 1e-9; v += b.step) s += `<text x="${W - R + 6}" y="${b.y(v) + 5}">${num(v)}</text>`;
      Y.forEach((lab, i) => { s += `<text x="${xc(i)}" y="${H - 6}" text-anchor="middle">${lab}</text>`; });
      const path = (vs, y, stroke, extra, xs) => {
        let seg = '';
        const flush = () => { if (seg.split(' ').length > 2) s += `<polyline points="${seg.trim()}" fill="none" stroke="${stroke}" ${extra}/>`; seg = ''; };
        vs.forEach((v, i) => { if (v == null) flush(); else seg += ` ${xc(xs ? xs[i] : i)},${y(v)}`; }); flush();
      };
      // 株価を先に(下に)描き、本題の線を上に重ねる
      if (P) {
        const PX = now ? [...P, now.price] : P, X = PX.map((_, i) => i < P.length ? i : now.t);
        path(PX, b.y, css('--c-line'), 'stroke-width="1.6" stroke-dasharray="5 4" opacity="0.75"', X);
        P.forEach((v, i) => { if (v != null) s += `<rect x="${xc(i) - 3.5}" y="${b.y(v) - 3.5}" width="7" height="7" fill="${css('--c-line')}" stroke="${css('--card-bg')}" stroke-width="1.5"/>`; });
        // 今の株価は丸い点で、決算期末の株価(四角)と見分ける
        if (now) s += `<circle cx="${xc(now.t)}" cy="${b.y(now.price)}" r="4.5" fill="${css('--c-line')}" stroke="${css('--card-bg')}" stroke-width="1.5"/>`;
        // 横軸の目盛りとは間隔が狭くて重なるので、「現在」は点の上に書く
        if (now) s += `<text x="${xc(now.t)}" y="${b.y(now.price) - 9}" text-anchor="middle">現在</text>`;
      }
      path(vals, a.y, css(color), 'stroke-width="2.4"');
      // 点は株価だけ。前後の年が欠けて線にならない年だけ、見えるように小さな点を打つ
      vals.forEach((v, i) => { if (v != null && vals[i - 1] == null && vals[i + 1] == null) s += `<circle cx="${xc(i)}" cy="${a.y(v)}" r="3" fill="${css(color)}"/>`; });
      Y.forEach((_, i) => { s += `<rect x="${L + cw * i}" y="${T}" width="${cw}" height="${H - T - B}" fill="transparent" data-i="${i}" class="hit"/>`; });
      if (P && now) {
        const x0 = (xc(Y.length - 1) + xc(now.t)) / 2;
        s += `<rect x="${x0}" y="${T}" width="${W - R - x0}" height="${H - T - B}" fill="transparent" data-i="now" class="hit"/>`;
      }
      el.innerHTML = (P ? `<div class="legend"><span class="ln" style="--sw:${css(color)}">${name}（左・円）</span><span class="ln" style="--sw:${css('--c-line')}">株価（右・円）</span></div>` : '') + s + '</svg>';
      el.querySelectorAll('.hit').forEach(r => {
        const show = e => {
          if (!tip) return;
          const i = +r.dataset.i, pt = e.touches ? e.touches[0] : e;
          tip.innerHTML = r.dataset.i === 'now' ? `<b style="color:inherit">現在（${nowLabel}終値）</b><br>株価：${fmt(now.price)}円`
            : `<b style="color:inherit">${Y[i]}期</b><br>${name}：${fmt(vals[i])}円` + (P ? `<br>株価：${fmt(P[i])}円` : '');
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
    if (hasPrice) notes.push('グラフの点線は決算期末の株価（右の目盛り）で、株式分割をそろえた後の値です。');
    if (now) notes.push(`点線の右端の丸い点は${nowLabel}の終値です` + (now.split ? '（決算期末の後の株式分割・併合をそろえた値）' : '') + '。');
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
