// 「最新の半期」の節: window.CF_HALF (cf/scripts/half.py が毎朝の更新で半期報告書から作る。単位は億円、1株あたりは円) から描く。
// 有報をもとにした分析(ページの本文)のあと、footer の前に差し込む。上期の数字から「上期のポイント」の文章も作る。
// 半期報告書が年次の有報より古いとき(新しい有報が出たとき)は、分析を外して次の提出時期の目安だけを出す。
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
    h += points(capex, fcf);
    h += '<h3>上期の業績とお金の流れ</h3><div class="tbl"><table><thead><tr><th></th><th>今期上期</th><th>前年上期</th><th>増減率</th></tr></thead><tbody>';
    flows.forEach(r => {
      if (!r) { h += '<tr><td colspan="4" style="border:0;padding:.25rem"></td></tr>'; return; }
      const [l, v] = r; if (!v || (v[0] == null && v[1] == null)) return;
      const a = num(v[0]), b = num(v[1]);
      h += `<tr><td>${l}</td><td class="${a < 0 ? 'neg' : ''}">${fmt(a)}</td><td class="${b < 0 ? 'neg' : ''}">${fmt(b)}</td><td>${pct(a, b)}</td></tr>`;
    });
    h += '</tbody></table></div>';
    // 1株あたりの数字(円)。BPS は上期末の親会社の株主の持分を、発行済株式数から自己株式を除いた株数で割ったもの
    const yen = v => v == null ? '－' : fmt(+(+v).toFixed(2));
    const eps = H.eps || [], bps = H.bps || [];
    if (eps[0] != null || bps[0] != null) {
      h += '<h3>1株あたりの数字（円）</h3><div class="tbl"><table><thead><tr><th></th><th>今期上期</th><th>前年上期</th><th>増減率</th></tr></thead><tbody>';
      if (eps[0] != null) h += `<tr><td>EPS</td><td class="${eps[0] < 0 ? 'neg' : ''}">${yen(eps[0])}</td><td class="${eps[1] < 0 ? 'neg' : ''}">${yen(eps[1])}</td><td>${pct(eps[0], eps[1])}</td></tr>`;
      if (bps[0] != null) h += `<tr><td>BPS（上期末）</td><td>${yen(bps[0])}</td><td>－</td><td>－</td></tr>`;
      h += '</tbody></table></div>';
      h += '<p class="sub" style="margin-top:.4rem">EPSは上期6か月分の利益なので、年間のEPSのおよそ半分になります。BPSは上期末の純資産（親会社の株主の分）を、自己株式を除いた株数で割って計算しました。</p>';
    }
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
  const foot = document.querySelector('footer');
  if (foot) foot.parentNode.insertBefore(sec, foot); else document.querySelector('.wrap').appendChild(sec);

  // 「上期のポイント」: 上期の数字を、前年上期・前期末・年次の数字(window.CF。前期の1年分があるとき)と比べて文章にする
  function points(capex, fcf) {
    const C = window.CF || {};
    const yi = (C.years || []).indexOf(`${ym(H.fyEnd).y - 1}-${H.fyEnd.slice(5, 7)}`);
    const yr = k => yi >= 0 && C[k] ? C[k][yi] : null;  // 前期1年分の数字
    const oku = v => fmt(num(v)) + '億円';
    const chg = (a, b) => a == null || b == null || b <= 0 || a < 0 ? null : (a / b - 1) * 100;
    const word = (c, up, down) => c == null ? '' : Math.abs(c) < 3 ? 'ほぼ横ばい' : `${Math.abs(c).toFixed(0)}%${c > 0 ? up : down}`;
    const share = (a, b) => a == null || b == null || b <= 0 || a < 0 ? null : Math.round(a / b * 100);
    const li = [];
    const [s0, s1] = H.sales || [], [o0, o1] = H.opinc || [], [n0, n1] = H.net || [];
    const L = H.bank ? ['経常収益', '経常利益'] : ['売上高', '営業利益'];

    // 1. 業績
    if (s0 != null && o0 != null) {
      const cs = chg(s0, s1), co = chg(o0, o1);
      let t;
      if (o0 < 0) t = `<b>上期は${L[1].slice(0, 2)}赤字でした</b>。${L[0]}は${oku(s0)}（前年上期から${word(cs, '増', '減') || '－'}）、${L[1]}は${oku(o0)}です。`;
      else if (o1 != null && o1 < 0) t = `<b>上期は${L[1].slice(0, 2)}黒字に戻りました</b>。${L[0]}は${oku(s0)}、${L[1]}は${oku(o0)}（前年上期は${oku(o1)}）です。`;
      else if (cs != null && co != null) {
        const tag = Math.abs(cs) < 3 && Math.abs(co) < 3 ? '前年並みでした'
          : Math.abs(cs) < 3 ? `売上は横ばいで、${co > 0 ? '増益' : '減益'}でした` : Math.abs(co) < 3 ? `${cs > 0 ? '増収' : '減収'}で、利益は横ばいでした`
          : `${cs > 0 ? '増収' : '減収'}・${co > 0 ? '増益' : '減益'}でした`;
        t = `<b>上期は${tag}</b>。${L[0]}は${oku(s0)}で前年上期から${word(cs, '増', '減')}、${L[1]}は${oku(o0)}で${word(co, '増', '減')}です。`;
        if (!H.bank && s1 > 0 && o1 != null) t += `売上高に対する営業利益の割合（営業利益率）は${(o0 / s0 * 100).toFixed(1)}%で、前年上期の${(o1 / s1 * 100).toFixed(1)}%から${Math.abs(o0 / s0 - o1 / s1) * 100 < 0.5 ? 'ほぼ変わっていません' : o0 / s0 > o1 / s1 ? '上がりました' : '下がりました'}。`;
      }
      // 純利益の動きが営業利益と大きく違うとき
      const cn = chg(n0, n1);
      if (t && cn != null && co != null && Math.abs(cn - co) >= 20 && Math.abs(cn) >= 10) t += `純利益は${oku(n0)}で${word(cn, '増', '減')}と、${L[1]}とは違う動きです（${L[1]}より下の損益や税金の影響です）。`;
      else if (t && n0 != null && n0 < 0 && o0 >= 0) t += `ただし、純利益は${oku(n0)}の赤字です。`;
      if (t) li.push(t);
    }
    // 2. 前期1年分に対する進み具合
    const po = share(o0, yr('opinc')), ps = share(s0, yr('sales'));
    if (ps != null && po != null) li.push(`<b>前期1年分との比較</b>：上期の${L[0]}は前期1年分の${ps}%、${L[1]}は${po}%です。季節による偏りがなければ、半年分は50%が目安です${po >= 55 ? '。利益は前期を上回るペースです' : po <= 45 ? '。利益は前期を下回るペースです' : ''}。`);
    if (H.bank) return li.length ? '<h3>上期のポイント</h3><ul>' + li.map(x => `<li>${x}</li>`).join('') + '</ul>' + note() : '';

    // 3. 営業CFとフリーCF
    const [op0, op1] = H.op || [];
    if (op0 != null) {
      let t = `<b>本業で稼いだお金（営業CF）は${oku(op0)}</b>${op1 != null ? `で、前年上期の${oku(op1)}から${op1 > 0 && op0 > 0 ? word(chg(op0, op1), '増えました', '減りました').replace(/^ほぼ横ばい$/, 'ほぼ横ばいでした') : op0 > op1 ? '増えました' : '減りました'}` : 'でした'}。`;
      if (fcf(0) != null) t += `設備投資を引いた本業のフリーCFは${oku(fcf(0))}${fcf(0) < 0 ? 'で、投資が稼ぎを上回りました' : 'です'}。`;
      li.push(t);
    }
    // 4. 設備投資
    const c0 = capex(0), c1 = capex(1), cy = yr('ppe') != null ? -yr('ppe') : null, d0 = H.dep && H.dep[0];
    if (c0 != null && c0 > 0) {
      const cc = chg(c0, c1);
      let t = `<b>設備投資は${oku(c0)}</b>${cc != null ? `で、前年上期から${word(cc, '増', '減')}` : ''}です。`;
      const sh = share(c0, cy);
      if (sh != null) t += `前期1年分（${oku(cy)}）の${sh}%にあたります。`;
      if (d0 > 0) {
        const r = +(c0 / d0).toFixed(1);
        t += `減価償却費（${oku(d0)}）の${r}倍で、${r >= 1.2 ? '設備を増やす投資が中心です' : r >= 0.8 ? '設備の維持・更新に近い水準です' : '償却を下回り、投資は控えめです'}。`;
      }
      // 年次で設備投資が増え続けていたか
      const ys = yi >= 2 && C.ppe ? C.ppe.slice(yi - 2, yi + 1).map(v => v == null ? null : -v) : [];
      if (ys.length === 3 && ys.every(v => v != null) && ys[0] < ys[1] && ys[1] < ys[2] && cc != null) t += cc >= 3 ? '前期まで増えていた設備投資は、上期も増える流れが続いています。' : '前期まで増えていた設備投資は、上期は一服しています。';
      li.push(t);
    }
    // 5. M&A
    const a0 = H.acq && H.acq[0] != null ? -H.acq[0] : null;
    if (a0 != null && a0 >= 1 && (c0 == null || a0 >= c0 * 0.2)) li.push(`<b>子会社の取得（M&A）に${oku(a0)}を使いました</b>。`);
    // 6. 株主への還元
    const dv = H.div && H.div[0] != null ? -H.div[0] : 0, bb = H.buy && H.buy[0] != null ? -H.buy[0] : 0, bb1 = H.buy && H.buy[1] != null ? -H.buy[1] : 0;
    if (dv + bb >= 0.1) {
      let t = `<b>株主への還元は${oku(dv + bb)}</b>（配当${oku(dv)}${bb >= 0.1 ? `、自社株買い${oku(bb)}` : ''}）です。`;
      if (bb >= 0.1 && bb1 >= 0.1) t += `自社株買いは前年上期の${oku(bb1)}から${word(chg(bb, bb1), '増えました', '減りました').replace(/^ほぼ横ばい$/, 'ほぼ同じでした')}。`;
      else if (bb >= 0.1) t += '前年上期はなかった自社株買いを行っています。';
      else if (bb1 >= 0.1) t += `前年上期は自社株買い（${oku(bb1)}）をしていましたが、今期の上期はしていません。`;
      if (fcf(0) != null) t += fcf(0) > 0 && dv + bb <= fcf(0) ? '本業のフリーCFの範囲内です。' : '本業のフリーCFを上回っていて、手元のお金や借入金などでまかなっています。';
      li.push(t);
    }
    // 7. 残高の変化(前期末と比べて目立つもの)
    const bal = [];
    const mv = (k, l) => {
      const [a, b] = H[k] || [];
      const c = chg(a, b);
      if (c != null && Math.abs(c) >= 10 && Math.abs(a - b) >= 1) bal.push(`${l}が${oku(b)}から${oku(a)}に${c > 0 ? '増え' : '減り'}`);
    };
    mv('cash', '現金'); mv('inventory', '在庫'); mv('recv', '売掛金など'); mv('debt', '借入金など');
    if (bal.length) li.push(`<b>前期末からの変化</b>：${bal.join('、')}ました。`);
    return li.length ? '<h3>上期のポイント</h3><ul>' + li.map(x => `<li>${x}</li>`).join('') + '</ul>' + note() : '';
  }
  function note() {
    return '<p class="sub" style="margin-top:.4rem">「上期のポイント」は、半期報告書の数字を前年上期・前期末・前期1年分と比べて自動で作った文章です。</p>';
  }
})();
