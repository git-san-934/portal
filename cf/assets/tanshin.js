// 「最新の決算短信」の節: cf/data/tanshin.json (cf/scripts/fetch_tanshin.py が TDnet の決算短信から作る。単位は億円、1株あたりは円) から描く。
// 最新の情報としてページの最上部に置く。上期の数字がページ上部にあればそのすぐ下、なければ header の直後に差し込む。
// ページの並びは「最新の半期」→「最新の決算短信」→ 有報の分析。短信がない銘柄では何もしない。
// 節の中に、前年同期との増減率のグラフと、過去の年度の同じ期間・通期と比べるグラフを出す。
// 過去の短信は cf/data/tanshin_hist.json (取り込むたびに貯める) から、足りない年は短信に載る前年同期の数字と、
// 有価証券報告書の通期の数字(ページの data.js と cf/data/eps.json)で補う。
// あわせて、ページ上部に Yahoo!ファイナンスへのリンクを出す(短信がない銘柄でも出す)。
(function () {
  const me = document.currentScript;
  const code = (window.CF && window.CF.code) || (window.CF_HALF && window.CF_HALF.code) || (me && me.dataset.code);
  if (!code) return;
  // 「← 投資分析の一覧へ」の横に Yahoo!ファイナンスの銘柄ページへのリンクを出す(全銘柄ページがこのファイルを読むため、ここで足す)
  const back = document.querySelector('a.back');
  if (back) {
    const y = document.createElement('a');
    y.className = 'yahoo';
    y.href = `https://finance.yahoo.co.jp/quote/${code}.T`;
    y.target = '_blank';
    y.rel = 'noopener';
    y.textContent = 'Yahoo!ファイナンスで見る ↗';
    y.style.cssText = 'float:right;font-size:0.85rem;color:var(--text-sub)';
    back.after(y);
  }
  const url = f => me && me.src ? new URL('../data/' + f, me.src) : '../data/' + f;
  const get = f => fetch(url(f)).then(r => r.ok ? r.json() : null).catch(() => null);
  // 過去の短信の履歴(tanshin_hist.json)と有報の数字(eps.json)は比較のグラフにだけ使う。なくても節は出す
  Promise.all([get('tanshin.json'), get('tanshin_hist.json'), get('eps.json')]).then(([data, hist, epsData]) => {
    const T = data && data.companies && data.companies[code];
    if (!T) return;
    const DEC = window.CF_DEC || 0;
    const ym = s => ({ y: +s.slice(0, 4), m: +s.slice(5, 7) });
    const fyName = s => `${ym(s).y}年${ym(s).m}月期`;
    const nextFy = s => `${ym(s).y + 1}-${s.slice(5, 7)}`;
    const md = s => `${+s.slice(5, 7)}月${+s.slice(8, 10)}日`;
    const fmt = (v, d) => v == null ? '－' : (v < 0 ? '△' : '') + Math.abs(+v.toFixed(d)).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: d });
    const oku = v => fmt(v, DEC), yen = v => fmt(v, 2);
    const pct = (a, b) => (a == null || b == null || b <= 0 || a < 0) ? '－' : ((a / b - 1) * 100 >= 0 ? '+' : '△') + Math.abs((a / b - 1) * 100).toFixed(1) + '%';
    const rate = (a, b) => (a == null || b == null || b <= 0 || a < 0) ? '－' : (a / b * 100).toFixed(1) + '%';
    const neg = v => v != null && v < 0 ? 'neg' : '';
    const q = T.quarter;
    const span = ['', '第1四半期（3か月）', '上期（6か月）', '第3四半期累計（9か月）', '通期（12か月）'][q];
    const A = T.actual, P = T.prior, F = T.forecast, R = T.range || {};
    const mid = T.std === 'JGAAP' || A.ord != null ? ['経常利益', 'ord'] : ['税引前利益', 'pretax'];
    const rows = [['売上高', 'sales', oku], ['営業利益', 'opinc', oku], [mid[0], mid[1], oku], ['純利益', 'net', oku], ['EPS（円）', 'eps', yen]];
    // 予想が幅で出ているときは「下限〜上限」と書く
    const fc = (k, f) => F[k] != null ? f(F[k]) : R[k] ? `${f(R[k][0])}〜${f(R[k][1])}` : '－';
    const fcv = k => F[k] != null ? F[k] : R[k] && R[k][0] != null && R[k][1] != null ? (R[k][0] + R[k][1]) / 2 : null;

    let h = '<h2>最新の決算短信</h2>';
    h += `<p class="sub">${fyName(T.fyEnd)}の${q === 4 ? '通期' : span.replace(/（.*）/, '')}の決算短信（${md(T.date)}発表）の数字です。${T.cons ? '連結' : '単体'}の数字で、単位は億円です。決算短信は監査前の速報なので、あとで出る半期報告書や有価証券報告書と少し違うことがあります。</p>`;
    h += `<h3>${q === 4 ? '通期の業績' : `${span}の業績`}</h3><div class="tbl"><table><thead><tr><th></th><th>今期</th><th>前年同期</th><th>増減率</th></tr></thead><tbody>`;
    rows.forEach(([l, k, f]) => {
      if (A[k] == null && P[k] == null) return;
      h += `<tr><td>${l}</td><td class="${neg(A[k])}">${f(A[k])}</td><td class="${neg(P[k])}">${f(P[k])}</td><td>${pct(A[k], P[k])}</td></tr>`;
    });
    h += '</tbody></table></div>';

    const D = T.dps || {};
    const hasFc = rows.some(([, k]) => F[k] != null || R[k]) || D.current != null || D.next != null;
    if (q === 4 && hasFc) {
      h += `<h3>来期の会社予想（${fyName(nextFy(T.fyEnd))}）</h3><div class="tbl"><table><thead><tr><th></th><th>今期実績</th><th>来期予想</th><th>増減率</th></tr></thead><tbody>`;
      rows.forEach(([l, k, f]) => {
        if (A[k] == null && F[k] == null && !R[k]) return;
        h += `<tr><td>${l}</td><td class="${neg(A[k])}">${f(A[k])}</td><td class="${neg(F[k])}">${fc(k, f)}</td><td>${pct(fcv(k), A[k])}</td></tr>`;
      });
      if (D.current != null || D.next != null) h += `<tr><td>年間配当（円）</td><td>${yen(D.current)}</td><td>${R.dps && D.next == null ? `${yen(R.dps[0])}〜${yen(R.dps[1])}` : yen(D.next)}</td><td>${pct(D.next, D.current)}</td></tr>`;
      h += '</tbody></table></div>';
    } else if (hasFc) {
      h += `<h3>通期の会社予想（${fyName(T.fyEnd)}）と進み具合</h3><div class="tbl"><table><thead><tr><th></th><th>通期予想</th><th>${span.replace(/（.*）/, '')}の実績</th><th>進捗率</th></tr></thead><tbody>`;
      rows.forEach(([l, k, f]) => {
        if (F[k] == null && !R[k]) return;
        h += `<tr><td>${l}</td><td class="${neg(F[k])}">${fc(k, f)}</td><td class="${neg(A[k])}">${f(A[k])}</td><td>${rate(A[k], fcv(k))}</td></tr>`;
      });
      if (D.current != null) h += `<tr><td>年間配当（円）</td><td>${yen(D.current)}</td><td>－</td><td>－</td></tr>`;
      h += '</tbody></table></div>';
      h += `<p class="sub" style="margin-top:.4rem">進捗率は、通期予想に対して${span.replace(/（.*）/, '')}でどこまで進んだかです。1年を均等に進むとすると、目安は${[0, 25, 50, 75][q]}%です。</p>`;
    }
    const tail = [];
    if (A.bps != null) tail.push(`BPS（1株あたり純資産）${yen(A.bps)}円`);
    if (A.eqr != null) tail.push(`自己資本比率${A.eqr}%`);
    if (A.assets != null) tail.push(`総資産${oku(A.assets)}億円`);
    if (tail.length) h += `<p class="sub" style="margin-top:.4rem">${['', '第1四半期末', '上期末', '第3四半期末', '期末'][q]}の${tail.join('、')}。</p>`;

    const cmp = compare(T, rows, hist, epsData, { oku, yen, fyName, span, DEC });
    h += cmp.html;

    const sec = document.createElement('section');
    sec.innerHTML = h;
    sec.id = 'cf-tanshin';
    const head = document.querySelector('.wrap > header');
    const half = document.getElementById('cf-half');
    const halfTop = half && head && half.previousElementSibling === head;
    if (halfTop) half.after(sec);
    else if (head) head.after(sec);
    else if (back) (document.querySelector('a.yahoo') || back).after(sec);
    else document.querySelector('.wrap').prepend(sec);
    cmp.mount(sec);
  }).catch(() => {});

  // ---- 過去の決算短信との比較 ----
  function compare(T, rows, hist, epsData, U) {
    const none = { html: '', mount() {} };
    const q = T.quarter, A = T.actual, P = T.prior, F = T.forecast, R = T.range || {};
    const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const tip = document.querySelector('.tip');
    const short = s => `${s.slice(2, 4)}/${+s.slice(5, 7)}`;
    const shift = (s, d) => `${+s.slice(0, 4) + d}${s.slice(4, 7)}`;
    const partName = ['', '第1四半期', '上期', '第3四半期累計', '通期'][q];
    const showTip = (e, html) => {
      if (!tip) return;
      const pt = e.touches ? e.touches[0] : e;
      tip.innerHTML = html; tip.style.display = 'block';
      tip.style.left = Math.min(pt.clientX + 12, innerWidth - tip.offsetWidth - 8) + 'px'; tip.style.top = (pt.clientY + 12) + 'px';
    };
    const hideTip = () => { if (tip) tip.style.display = 'none'; };
    function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw || 1))); const n = raw / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }
    function scale(vals, top, bottom) {
      let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
      const pad = (hi - lo) * 0.08 || 1;
      if (hi > 0) hi += pad; if (lo < 0) lo -= pad;
      const step = niceStep((hi - lo) / 4);
      hi = Math.ceil(hi / step) * step; lo = Math.floor(lo / step) * step;
      return { lo, hi, step, y: v => top + (hi - v) / (hi - lo) * (bottom - top) };
    }

    // 1) 前年同期との増減率(横向きの棒)。赤字をまたぐ項目は率を出さず、言葉で書く
    const chg = rows.filter(([, k]) => A[k] != null && P[k] != null).map(([l, k]) => {
      const a = A[k], p = P[k];
      if (p > 0 && a >= 0) return { l, k, v: (a / p - 1) * 100 };
      return { l, k, v: null, word: p > 0 ? '赤字に転落' : a > 0 ? '黒字に転換' : a > p ? '赤字が縮小' : a < p ? '赤字が拡大' : '横ばい' };
    });

    // 2) 年度ごとの比較。H: 同じ連結・単体の短信の履歴(最新の短信も含める)
    const H = ((hist && hist.companies && hist.companies[code]) || []).filter(r => r.cons === T.cons);
    if (!H.some(r => r.fyEnd === T.fyEnd && r.quarter === q)) H.push(T);
    const find = (fy, qq) => H.find(r => r.fyEnd === fy && r.quarter === qq);
    // その期間の実績。その期の短信がなければ、1年後の同じ期間の短信に載る前年同期の数字を使う
    const at = (fy, qq, k) => {
      const r = find(fy, qq);
      if (r && r.actual[k] != null) return { v: r.actual[k], src: 'tanshin' };
      const n = find(shift(fy, 1), qq);
      return n && n.prior && n.prior[k] != null ? { v: n.prior[k], src: 'prior' } : null;
    };
    // 有報の通期の数字。連結・単体が短信とそろうときだけ使う(銀行の売上高は中身が違うので使わない)
    const E = epsData && epsData.companies && epsData.companies[code];
    const C = window.CF && window.CF.code === code ? window.CF : null;
    const sameKind = !E || !!E.single === !T.cons;
    const bank = !!(window.CF_HALF && window.CF_HALF.bank);
    const report = (fy, k) => {
      if (!sameKind) return null;
      if (k === 'eps') { if (!E || (E.adj && E.adj.length)) return null; const i = E.years.indexOf(fy); return i >= 0 ? E.eps[i] : null; }
      if (!C || !C[k] || (k === 'sales' && bank)) return null;
      const i = C.years.findIndex(y => y.slice(0, 7) === fy);
      return i >= 0 ? C[k][i] : null;
    };
    const fys = [...new Set([...H.map(r => r.fyEnd), ...H.map(r => shift(r.fyEnd, -1)), ...(C ? C.years.map(y => y.slice(0, 7)) : []), ...(E ? E.years : [])])].filter(Boolean).sort();
    // 有報と短信の通期の数字が両方ある年で5%以上ずれていたら、その項目は有報で補わない(数字の範囲が違うおそれ)
    const reportOk = {};
    rows.forEach(([, k]) => {
      reportOk[k] = !fys.some(fy => { const t = at(fy, 4, k), r = report(fy, k); return t && r != null && Math.abs(r - t.v) > Math.abs(t.v) * 0.05 + 0.1; });
    });
    const annual = (fy, k) => at(fy, 4, k) || (reportOk[k] && report(fy, k) != null ? { v: report(fy, k), src: 'report' } : null);
    const fcv = k => F[k] != null ? F[k] : R[k] && R[k][0] != null && R[k][1] != null ? (R[k][0] + R[k][1]) / 2 : null;
    const metrics = rows.filter(([, k]) => A[k] != null).map(([l, k, f]) => {
      const last = q === 4 ? shift(T.fyEnd, 1) : T.fyEnd;
      let cols = [];
      for (let i = 5; i >= 0; i--) {
        const fy = shift(last, -i);
        const fc = fy === last && fcv(k) != null ? fcv(k) : null;
        const full = fy === last ? null : annual(fy, k);
        const part = q === 4 ? null : at(fy, q, k);
        cols.push({ fy, full, part, fc, fcRange: fy === last && F[k] == null && R[k] ? R[k] : null });
      }
      const empty = c => !c.full && !c.part && c.fc == null;
      while (cols.length && empty(cols[0])) cols.shift();
      while (cols.length && empty(cols[cols.length - 1])) cols.pop();
      const filled = cols.filter(c => c.full || c.part).length;
      return { l: l.replace(/（円）/, ''), k, f, unit: k === 'eps' ? '円' : '億円', cols, ok: filled >= 2 };
    }).filter(m => m.ok);
    const srcs = new Set(metrics.flatMap(m => m.cols.flatMap(c => [c.full && c.full.src, c.part && c.part.src]).filter(Boolean)));

    if (!chg.length && !metrics.length) return none;
    let h = '<h3>過去の決算短信との比較</h3>';
    if (chg.length) h += `<p class="sub">前年同期（${partName}どうし）と比べた増減率です。</p><div class="chart" id="tc-chg"></div>`;
    if (metrics.length) {
      h += `<p class="sub" style="margin-top:.8rem">${q === 4 ? '年度ごとの通期の実績と、来期の会社予想（点線の枠）です。' : `年度ごとの通期の実績（薄い棒）と、そのうち${partName}までの実績（濃い棒）です。今期は通期の会社予想を点線の枠で示します。`}</p>`;
      h += '<div class="tc-tabs" role="tablist" style="display:flex;flex-wrap:wrap;gap:.35rem;margin:.4rem 0">' + metrics.map((m, i) =>
        `<button type="button" role="tab" data-i="${i}" style="font:inherit;font-size:.8rem;padding:.2rem .7rem;border-radius:999px;border:1px solid var(--border);background:var(--card-bg);color:var(--text-sub);cursor:pointer">${m.l}</button>`).join('') + '</div>';
      h += '<div class="chart" id="tc-yr"></div><p class="sub" id="tc-yr-note" style="margin-top:.3rem"></p><div class="tbl" id="tc-yr-tbl"></div>';
      const notes = ['過去の決算短信は、取り込むたびに貯めた分を使います（TDnetには直近1か月分しか残らないため、2026年9月下旬より前の短信はさかのぼって集められません）。'];
      if (srcs.has('prior')) notes.push(`短信がない年の${q === 4 ? '通期' : `${partName}と通期`}は、1年後の短信に載っている前年同期の数字で補っています。`);
      if (srcs.has('report')) notes.push('それでも足りない年の通期は、有価証券報告書の数字で補っています（短信の数字と少し違うことがあります）。');
      h += `<p class="sub" style="margin-top:.4rem">${notes.join('')}</p>`;
    }

    function drawChg(el) {
      const W = 640, rowH = 34, L = 120, Rr = 96, T0 = 6, H0 = T0 + rowH * chg.length + 26;
      const vs = chg.filter(c => c.v != null).map(c => Math.max(-100, Math.min(100, c.v)));
      const m = Math.max(10, ...vs.map(Math.abs));
      const step = niceStep(m / 2), lim = Math.ceil(m / step) * step;
      const lo = Math.min(...vs, 0) < 0 ? -lim : 0, hi = Math.max(...vs, 0) > 0 ? lim : 0;
      const x = v => L + (v - lo) / ((hi - lo) || 1) * (W - L - Rr);
      let s = `<svg viewBox="0 0 ${W} ${H0}" role="img" aria-label="前年同期との増減率">`;
      for (let v = lo; v <= hi + 1e-9; v += step) {
        s += `<line x1="${x(v)}" x2="${x(v)}" y1="${T0}" y2="${H0 - 22}" stroke="${Math.abs(v) < 1e-9 ? css('--text-sub') : css('--grid')}"/>`;
        s += `<text x="${x(v)}" y="${H0 - 4}" text-anchor="middle">${v > 0 ? '+' : v < 0 ? '△' : ''}${Math.abs(v)}%</text>`;
      }
      chg.forEach((c, i) => {
        const yc = T0 + rowH * i + rowH / 2;
        s += `<text x="${L - 10}" y="${yc + 6}" text-anchor="end">${c.l.replace(/（円）/, '')}</text>`;
        if (c.v == null) { s += `<text x="${x(0) + 8}" y="${yc + 6}">${c.word}</text>`; }
        else {
          const v = Math.max(-100, Math.min(100, c.v)), x0 = x(0), x1 = x(v);
          s += `<rect x="${Math.min(x0, x1)}" y="${yc - 10}" width="${Math.max(Math.abs(x1 - x0), 1.5)}" height="20" rx="3" fill="${css(c.v >= 0 ? '--c-op' : '--accent')}"/>`;
          const txt = (c.v >= 0 ? '+' : '△') + Math.abs(c.v).toFixed(1) + '%';
          s += c.v >= 0 ? `<text x="${x1 + 6}" y="${yc + 6}">${txt}</text>` : `<text x="${x1 - 6}" y="${yc + 6}" text-anchor="end">${txt}</text>`;
        }
        s += `<rect x="0" y="${yc - rowH / 2}" width="${W}" height="${rowH}" fill="transparent" class="hit" data-i="${i}"/>`;
      });
      el.innerHTML = s + '</svg>';
      el.querySelectorAll('.hit').forEach(r => {
        const c = chg[+r.dataset.i], row = rows.find(x => x[1] === c.k), f = row[2], u = c.k === 'eps' ? '円' : '億円';
        const show = e => showTip(e, `<b style="color:inherit">${c.l}</b><br>今期：${f(A[c.k])}${u}<br>前年同期：${f(P[c.k])}${u}<br>${c.v == null ? c.word : '増減率：' + (c.v >= 0 ? '+' : '△') + Math.abs(c.v).toFixed(1) + '%'}`);
        r.addEventListener('mousemove', show); r.addEventListener('touchstart', show, { passive: true }); r.addEventListener('mouseleave', hideTip);
      });
    }

    function drawYears(sec, m) {
      const el = sec.querySelector('#tc-yr'), color = css('--c-op');
      const W = 640, H0 = 262, L = 62, Rr = 8, T0 = 14, B = 52;
      const vals = m.cols.flatMap(c => [c.full && c.full.v, c.part && c.part.v, c.fc, ...(c.fcRange || [])]).filter(v => v != null);
      const a = scale(vals, T0, H0 - B);
      const cw = (W - L - Rr) / m.cols.length, xc = i => L + cw * i + cw / 2;
      const bw = Math.min(cw * 0.62, 56), pw = q === 4 ? bw : bw * 0.5;
      const num = v => (+v.toFixed(2)).toLocaleString();
      let s = `<svg viewBox="0 0 ${W} ${H0}" role="img" aria-label="${m.l}の年度ごとの比較">`;
      for (let v = a.lo; v <= a.hi + 1e-9; v += a.step) {
        s += `<line x1="${L}" x2="${W - Rr}" y1="${a.y(v)}" y2="${a.y(v)}" stroke="${Math.abs(v) < 1e-9 ? css('--text-sub') : css('--grid')}"/>`;
        s += `<text x="${L - 6}" y="${a.y(v) + 5}" text-anchor="end">${num(v)}</text>`;
      }
      const bar = (xm, w, v, attrs) => { const y0 = a.y(0), y1 = a.y(v); return `<rect x="${xm - w / 2}" y="${Math.min(y0, y1)}" width="${w}" height="${Math.max(Math.abs(y0 - y1), 1)}" rx="2" ${attrs}/>`; };
      m.cols.forEach((c, i) => {
        const fc = c.fc != null;
        s += `<text x="${xc(i)}" y="${H0 - B + 22}" text-anchor="middle">${short(c.fy)}</text>`;
        const tag = q < 4 && c.fy === T.fyEnd ? '今期' : q === 4 && c.fy === T.fyEnd ? '今期' : q === 4 && fc ? '来期予想' : '';
        if (tag) s += `<text x="${xc(i)}" y="${H0 - 4}" text-anchor="middle">${tag}</text>`;
        if (c.full) s += bar(xc(i), bw, c.full.v, `fill="${color}" opacity="${q === 4 ? 1 : 0.32}"`);
        if (fc) s += bar(xc(i), bw, c.fc, `fill="none" stroke="${color}" stroke-width="1.6" stroke-dasharray="5 4"`);
        if (c.part) s += bar(xc(i), pw, c.part.v, `fill="${color}" stroke="${css('--card-bg')}" stroke-width="${q === 4 ? 0 : 1.5}"`);
        s += `<rect x="${L + cw * i}" y="${T0}" width="${cw}" height="${H0 - T0 - B}" fill="transparent" class="hit" data-i="${i}"/>`;
      });
      el.innerHTML = `<div class="legend">${q === 4 ? `<span style="--sw:${color}">通期の実績</span>` : `<span style="--sw:${color}">${partName}の実績</span><span style="--sw:color-mix(in srgb, ${color} 32%, transparent)">通期の実績</span>`}<span class="tc-fc">${q === 4 ? '来期' : '今期'}の会社予想（点線）</span></div>` + s + '</svg>';
      const ratio = c => c.part && (c.full || c.fc != null) && (c.full ? c.full.v : c.fc) > 0 && c.part.v >= 0 ? c.part.v / (c.full ? c.full.v : c.fc) * 100 : null;
      el.querySelectorAll('.hit').forEach(r => {
        const c = m.cols[+r.dataset.i];
        let t = `<b style="color:inherit">${U.fyName(c.fy)}</b>`;
        if (c.full) t += `<br>通期：${m.f(c.full.v)}${m.unit}`;
        if (c.fc != null) t += `<br>通期の会社予想：${c.fcRange ? `${m.f(c.fcRange[0])}〜${m.f(c.fcRange[1])}` : m.f(c.fc)}${m.unit}`;
        if (c.part) t += `<br>${partName}：${m.f(c.part.v)}${m.unit}` + (ratio(c) != null ? `（通期の${ratio(c).toFixed(1)}%）` : '');
        if (!c.full && !c.part && c.fc == null) t += '<br>数字がありません';
        const show = e => showTip(e, t);
        r.addEventListener('mousemove', show); r.addEventListener('touchstart', show, { passive: true }); r.addEventListener('mouseleave', hideTip);
      });
      // 進み具合を前年と比べる一文と、数字の表
      const cur = m.cols[m.cols.length - 1], prev = m.cols.find(c => c.fy === shift(T.fyEnd, -1));
      const note = sec.querySelector('#tc-yr-note');
      const parts = [];
      if (q < 4 && prev && cur.part) {
        const pr = ratio(prev), cr = ratio(cur);
        if (pr != null && cr != null) parts.push(`今期は通期予想の${cr.toFixed(1)}%まで進んでいます。前年の${partName}は通期実績の${pr.toFixed(1)}%でした${cr >= pr + 2 ? '（前年より速いペース）' : cr <= pr - 2 ? '（前年より遅いペース）' : '（前年並みのペース）'}。`);
      }
      const yrs = m.cols.filter(c => c.full);
      if (yrs.length >= 3 && yrs[0].full.v > 0 && yrs[yrs.length - 1].full.v > 0) {
        const n = (+yrs[yrs.length - 1].fy.slice(0, 4)) - (+yrs[0].fy.slice(0, 4));
        const g = ((yrs[yrs.length - 1].full.v / yrs[0].full.v) ** (1 / n) - 1) * 100;
        if (n > 0) parts.push(`通期の${m.l}は、${short(yrs[0].fy)}期から${short(yrs[yrs.length - 1].fy)}期まで年平均${Math.abs(g).toFixed(1)}%の${g >= 0 ? '伸び' : '減少'}です。`);
      }
      note.textContent = parts.join('');
      note.style.display = parts.length ? '' : 'none';
      let tb = '<table><thead><tr><th></th>' + m.cols.map(c => `<th>${short(c.fy)}</th>`).join('') + '</tr></thead><tbody>';
      const cell = v => `<td class="${v != null && v < 0 ? 'neg' : ''}">${v == null ? '－' : m.f(v)}</td>`;
      if (q < 4) tb += `<tr><td>${partName}（${m.unit}）</td>` + m.cols.map(c => cell(c.part && c.part.v)).join('') + '</tr>';
      tb += `<tr><td>通期（${m.unit}）</td>` + m.cols.map(c => c.fc != null ? `<td>${c.fcRange ? `${m.f(c.fcRange[0])}〜${m.f(c.fcRange[1])}` : m.f(c.fc)}<br><small>予想</small></td>` : cell(c.full && c.full.v)).join('') + '</tr>';
      sec.querySelector('#tc-yr-tbl').innerHTML = tb + '</tbody></table>';
    }

    return {
      html: h,
      mount(sec) {
        let cur = 0;
        const st = document.createElement('style');
        st.textContent = '#cf-tanshin .legend span.tc-fc::before{background:none;border:1.5px dashed var(--c-op);box-sizing:border-box}';
        sec.appendChild(st);
        const tabs = [...sec.querySelectorAll('.tc-tabs button')];
        const paint = () => {
          tabs.forEach((b, i) => { const on = i === cur; b.setAttribute('aria-selected', on); b.style.background = on ? css('--c-op') : css('--card-bg'); b.style.color = on ? css('--card-bg') : css('--text-sub'); b.style.borderColor = on ? css('--c-op') : css('--border'); });
          if (metrics.length) drawYears(sec, metrics[cur]);
          if (chg.length) drawChg(sec.querySelector('#tc-chg'));
        };
        tabs.forEach((b, i) => b.addEventListener('click', () => { cur = i; paint(); }));
        paint();
        matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paint);
      },
    };
  }
})();
