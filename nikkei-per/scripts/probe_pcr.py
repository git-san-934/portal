"""一時的: PCR 取得の確認。"""
import sys
sys.path.insert(0, "nikkei-per/scripts")
import fetch_sentiment as f
d = f.pcr_daily({})
ks = sorted(d)
print("DAILY", len(ks), ks[:1], ks[-1:])
for k in ks[:5] + ks[-25:]: print("  D", k, d[k], round(d[k][0] / d[k][1], 3))
m = f.pcr_monthly()
mk = sorted(m)
print("MONTHLY", len(mk), mk[:1], mk[-1:])
for k in mk[:3] + mk[-14:]: print("  M", k, m[k], round(m[k][0] / m[k][1], 3))
# 月の合計と日次の合計を比べる
from collections import defaultdict
s = defaultdict(lambda: [0, 0])
for k, v in d.items():
    if v[4] == "m": s[k[:7]][0] += v[0]; s[k[:7]][1] += v[1]
for k in sorted(s)[-6:]: print("  CMP", k, s[k], m.get(k))
import json
print("JSONDUMP" + json.dumps({"pcr": d, "pcr_m": m}, ensure_ascii=False, separators=(",", ":")))
