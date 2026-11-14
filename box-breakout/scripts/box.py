"""ダーバスのボックス理論: ボックス判定と売買シミュレーション.

ルール(過去5年の検証で一番成績が良かった条件):
- 52週の新高値の後、3日間高値を更新しなければ「上限」、その後3日間安値を更新しなければ「下限」
- ボックス幅15%以内・ボックス期間10日以上・50日平均売買代金5,000万円以上
- 終値が上限を上抜けたら翌日の寄付きで買う
- 損切りラインは下限の10%下。新しいボックスができるたびに引き上げる(下げない)
- 終値が損切りラインを割ったら翌日の寄付きで売る
"""
import numpy as np, pandas as pd

RULE = dict(width_max=0.15, width_min=0.03, min_box_days=10, confirm=3, lookback=250,
            min_turnover=5e7, stop_buf=0.10)


def scan(o, h, l, c, v, p=RULE):
    """Return dict(trades=[closed], pos=open position or None, box=current box state, signal=bool)."""
    n = len(c); trades = []
    turn = pd.Series(c * v).rolling(50, min_periods=50).mean().values
    hh = pd.Series(h).rolling(p['lookback'], min_periods=p['lookback']).max().shift(1).values
    new = lambda: dict(top=None, top_i=None, top_ok=False, bot=None, bot_i=None, bot_ok=False)
    st = new(); pos = None; signal = None
    for t in range(p['lookback'] + 1, n):
        if np.isnan(c[t]) or np.isnan(h[t]):
            continue
        if pos is not None and c[t] < pos['stop']:
            if t < n - 1:
                pos.update(exit_i=t + 1, exit=o[t + 1]); trades.append(pos); pos = None
            else:
                pos['sell_signal'] = True   # 今日割った: 明日の寄付きで売り
            st = new(); continue
        if pos is not None:
            pos['hi'] = max(pos['hi'], h[t])
        if st['top'] is None:
            if (pos is None and not np.isnan(hh[t]) and h[t] >= hh[t]) or (pos is not None and h[t] >= pos['hi']):
                st.update(top=h[t], top_i=t)
            continue
        if not st['top_ok']:
            if h[t] > st['top']: st.update(top=h[t], top_i=t)
            elif t - st['top_i'] >= p['confirm']:
                st['top_ok'] = True; st.update(bot=l[st['top_i'] + 1:t + 1].min(), bot_i=t)
            continue
        if not st['bot_ok']:
            if h[t] > st['top']:
                st = new(); st.update(top=h[t], top_i=t); continue
            if l[t] < st['bot']: st.update(bot=l[t], bot_i=t)
            elif t - st['bot_i'] >= p['confirm']:
                st['bot_ok'] = True
                if pos is not None and st['bot'] * (1 - p['stop_buf']) > pos['stop']:
                    pos['stop'] = st['bot'] * (1 - p['stop_buf']); pos['n_boxes'] += 1
            continue
        if c[t] < st['bot']:
            st = new(); continue
        if c[t] > st['top']:
            width = (st['top'] - st['bot']) / st['top']; days = t - st['top_i']
            ok = (pos is None and p['width_min'] <= width <= p['width_max'] and days >= p['min_box_days']
                  and not np.isnan(turn[t]) and turn[t] >= p['min_turnover'])
            if ok:
                info = dict(box_top=st['top'], box_bot=st['bot'], width=width, box_days=days,
                            stop=st['bot'] * (1 - p['stop_buf']), hi=h[t], n_boxes=0, signal_i=t)
                if t < n - 1:
                    pos = dict(info, i=t + 1, entry=o[t + 1])
                else:
                    signal = info          # 今日上抜け: 明日の寄付きで買い
            st = new(); st.update(top=h[t], top_i=t)
    box = None
    if pos is None and st['top_ok']:
        box = dict(top=st['top'], bot=st['bot'] if st['bot_ok'] else None, top_i=st['top_i'],
                   confirmed=st['bot_ok'], turnover=turn[-1])
    return dict(trades=trades, pos=pos, box=box, signal=signal)
