#!/bin/sh
# 貿易統計だけを取り直す（trade.html の「このページを更新」から。.github/workflows/request-boj-trade-update.yml）
# e-Stat の貿易統計・税関の速報 → 貿易の系列だけ取り込み状況を記録 → 変化検知。他の取得元には触れない
cd "$(dirname "$0")" || exit 1
mkdir -p logs
d=$(date +%F)
rc=0
python3 fetch_estat.py --only trade > "logs/$d.trade.fetch.log" 2>&1 || rc=1
python3 status.py --only ESTAT_TRADE_ > "logs/$d.trade.status.log" 2>&1 || rc=1
python3 analyze.py > "logs/$d.trade.analyze.log" 2>&1 || { echo "analyze.py が失敗しました"; cat "logs/$d.trade.analyze.log"; rc=1; }
cat "logs/$d.trade.fetch.log"
cat last_fetch.json
cat "logs/$d.trade.status.log"
exit $rc
