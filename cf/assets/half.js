// 「最新の半期」の節: window.CF_HALF (edinet/analysis/half.py の出力、単位は億円) から描く。
// 「数字の一覧」の節(#tbl を含む節)の前に差し込む。半期報告書が年次の有報より古いときは、次の提出時期の目安だけを出す。
(function () {
  const H = window.CF_HALF;
  if (!H) return;
  const DEC = window.CF_DEC || 0;
  const ym = s => ({ y: +s.slice(0, 4), m: +s.slice(5, 7) });
  const span = (a, b) => { const A = ym(a), B = ym(b); return A.y === B.y ? `${A.y}年${A.m}月〜${B.m}月` : `${A.y}年${A.m}月〜${B.y}年${B.m}月`; };
  const fyName = s => `${ym(s).y}年${ym(s).m}月期`;
  const num = v => v == null ? null : +(+v).toFixed(DEC);
  const fmt = v => v == null ? '－' : (v < 0 ? '△' + Math.abs(v).toLocaleString() : v.toLocaleString());
  const pct = (a, b) => (a == null || b == null || b === 0 || (a < 0) !== (b < 0) || a < 0) ? '－' : ((a / b - 1) * 100 >= 0 ? '+' : '△') + Math.abs((a / b - 1) * 100).toFixed(1) + '%';
  const diff = (a, b) => (a == null || b == null) ? '－' : fmt(+(a - b).toFixed(DEC)).replace(/^(?!△)/, a - b > 0 ? '+' : '');

  const sec = document.createElement('section');
  let h = '<h2>最新の半期（上期）</h2>';
  if (!H.newer) {
    h += `<p>直近の半期報告書${H.halfStart ? `（${span(H.halfStart, H.halfEnd)}）` : ''}の内容は、上の年次の数字（${fyName(H.annualEnd)}）にすでに含まれています。</p>`;
    h += `<p class="sub" style="margin-top:.4rem">次の半期報告書（${span(H.next.halfStart, H.next.halfEnd)}）は、${ym(H.next.fileBy).y}年${ym(H.next.fileBy).m}月ごろに提出される見込みです。提出されたら、ここに上期の数字を追加します。</p>`;
  } else {
    const capex = i => H.ppe && H.ppe[i] != null ? -H.ppe[i] : null;
    const fcf = i => H.op && H.op[i] != null && capex(i) != null ? H.op[i] - capex(i) : null;
    const flows = H.bank
      ? [['経常収益', H.sales], ['経常利益', H.opinc], ['純利益', H.net]]
      : [['売上高', H.sales], ['営業利益', H.opinc], ['純利益', H.net], null,
         ['営業CF', H.op], ['投資CF', H.inv], ['　うち設備投資', [capex(0), capex(1)]], ['本業のフリーCF', [fcf(0), fcf(1)]], ['減価償却費', H.dep]];
    const stocks = [['現金', H.cash], ['売掛金など', H.recv], ['在庫', H.inventory], ['借入金など', H.debt], ['総資産', H.assets]];
    h += `<p class="sub">${fyName(H.fyEnd)}の上期（${span(H.halfStart, H.halfEnd)}）の数字です。年次の数字（${fyName(H.annualEnd)}まで）より新しい情報で、半期報告書から取り出しました。単位は億円です。</p>`;
    h += '<h3>上期の業績とお金の流れ</h3><div class="tbl"><table><thead><tr><th></th><th>今期上期</th><th>前年上期</th><th>増減率</th></tr></thead><tbody>';
    flows.forEach(r => {
      if (!r) { h += '<tr><td colspan="4" style="border:0;padding:.25rem"></td></tr>'; return; }
      const [l, v] = r; if (!v || (v[0] == null && v[1] == null)) return;
      const a = num(v[0]), b = num(v[1]);
      h += `<tr><td>${l}</td><td class="${a < 0 ? 'neg' : ''}">${fmt(a)}</td><td class="${b < 0 ? 'neg' : ''}">${fmt(b)}</td><td>${pct(a, b)}</td></tr>`;
    });
    h += '</tbody></table></div>';
    h += '<h3>上期末の残高（前期末との比較）</h3><div class="tbl"><table><thead><tr><th></th><th>上期末</th><th>前期末</th><th>増減</th></tr></thead><tbody>';
    stocks.forEach(([l, v]) => {
      if (!v || v[0] == null) return;
      const a = num(v[0]), b = num(v[1]);
      h += `<tr><td>${l}</td><td>${fmt(a)}</td><td>${fmt(b)}</td><td>${diff(a, b)}</td></tr>`;
    });
    h += '</tbody></table></div>';
    h += `<p class="sub" style="margin-top:.5rem">次の半期報告書（${span(H.next.halfStart, H.next.halfEnd)}）は、${ym(H.next.fileBy).y}年${ym(H.next.fileBy).m}月ごろに提出される見込みです。</p>`;
  }
  sec.innerHTML = h;
  const tbl = document.getElementById('tbl');
  const before = tbl ? tbl.closest('section') : document.querySelector('footer');
  if (before) before.parentNode.insertBefore(sec, before); else document.querySelector('.wrap').appendChild(sec);
})();
