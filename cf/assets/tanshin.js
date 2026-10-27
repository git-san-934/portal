// 「最新の決算短信」の節: cf/data/tanshin.json (cf/scripts/fetch_tanshin.py が TDnet の決算短信から作る。単位は億円、1株あたりは円) から描く。
// 「最新の半期」の節の前(なければ「数字の一覧」の節の前)に差し込む。短信がない銘柄では何もしない。
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
  const url = me && me.src ? new URL('../data/tanshin.json', me.src) : '../data/tanshin.json';
  fetch(url).then(r => r.ok ? r.json() : null).then(data => {
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

    const sec = document.createElement('section');
    sec.innerHTML = h;
    const half = [...document.querySelectorAll('section > h2')].find(e => e.textContent.trim().startsWith('最新の半期'));
    const tbl = document.getElementById('tbl');
    const before = half ? half.parentNode : tbl ? tbl.closest('section') : document.querySelector('footer');
    if (before) before.parentNode.insertBefore(sec, before); else document.querySelector('.wrap').appendChild(sec);
  }).catch(() => {});
})();
