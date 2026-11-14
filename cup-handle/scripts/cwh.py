"""Cup-with-handle detector (daily, adjusted closes)."""
import numpy as np

P = dict(
    handle_min=5, handle_max=25,        # handle length (trading days)
    handle_depth=(0.03, 0.15),          # pullback from right lip
    cup_min=30, cup_max=250,            # cup length left lip -> right lip
    cup_depth=(0.12, 0.40),
    lip_ratio=(0.90, 1.08),             # right lip / left lip
    bottom_pos=(0.20, 0.80),            # where bottom sits within the cup
    lower_half_frac=0.25,               # share of cup days in lower half (U not V)
    prior_up=0.25,                      # rise into left lip over prior 120d
    min_turnover=5e7,                   # 50d avg 売買代金 >= 5000万円
    breakout_max=0.07,                  # allow up to +7% above pivot
)

def detect(c, v, p=P):
    c = np.asarray(c, float); v = np.asarray(v, float)
    T = len(c) - 1
    if T < 300 or np.isnan(c[-260:]).any(): return None
    if np.nanmean(c[-50:] * v[-50:]) < p['min_turnover']: return None
    best = None
    for h in range(p['handle_min'], p['handle_max'] + 1):
        r = T - h
        R = c[r]
        # right lip must be the max of the last (h+10) days up to r, and handle after it
        if R < c[r-10:r+1].max(): continue
        handle = c[r+1:T+1]
        if len(handle)==0: continue
        breakout = c[T] > R
        hz = handle[:-1] if breakout else handle
        if len(hz)==0 or hz.max() > R: continue
        hlow = hz.min()
        hdep = (R - hlow) / R
        if not (p['handle_depth'][0] <= hdep <= p['handle_depth'][1]): continue
        if breakout and c[T] > R * (1 + p['breakout_max']): continue
        # left lip: scan back
        for l in range(r - p['cup_min'], max(r - p['cup_max'], 130) - 1, -1):
            L = c[l]
            inner = c[l+1:r]
            if inner.max() > max(L, R) * 1.0: continue
            if not (p['lip_ratio'][0] <= R / L <= p['lip_ratio'][1]): continue
            b = l + 1 + inner.argmin(); B = c[b]
            depth = (L - B) / L
            if not (p['cup_depth'][0] <= depth <= p['cup_depth'][1]): continue
            pos = (b - l) / (r - l)
            if not (p['bottom_pos'][0] <= pos <= p['bottom_pos'][1]): continue
            mid = B + 0.5 * (L - B)
            if (inner < mid).mean() < p['lower_half_frac']: continue
            if hlow < mid: continue          # handle in upper half of cup
            pre = c[max(0, l-120):l]
            if len(pre)==0 or L / pre.min() - 1 < p['prior_up']: continue
            # L should be a genuine local high (max of 20d before)
            if L < c[max(0,l-20):l+1].max(): continue
            vol_dry = np.nanmean(v[r+1:T+1]) / np.nanmean(v[l:r+1])
            res = dict(left_lip_i=l, bottom_i=b, right_lip_i=r, L=L, B=B, R=R,
                       cup_days=r-l, cup_depth=depth, handle_days=h, handle_depth=hdep,
                       pivot=R, last=c[T], dist_to_pivot=c[T]/R-1,
                       status='ブレイクアウト' if breakout else 'ハンドル形成中',
                       handle_vol_ratio=vol_dry, ma200_ok=c[T] > np.nanmean(c[-200:]))
            # prefer longest valid cup for this handle (first found is shortest) -> keep scanning? take first
            return res
    return best


