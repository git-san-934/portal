"""一時的な確認用: Actions 上で貿易統計の取り込みを動かし、結果を書き出す"""
import os, sys, json
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_estat as f
res = f.trade(out)
with open(os.path.join(out, "result.txt"), "w") as w:
    for k, v in sorted(res.items()):
        w.write(f"{k} {sorted(v.items())[-3:]}\n")
    w.write(f"SIDE_ERRORS {f.SIDE_ERRORS}\n")
