#!/bin/sh
# 日次ルーチンから呼ぶ: 取得 → 取り込み状況の記録 → 変化検知。ログは logs/ に残す
# 取得元が1つ失敗しても残りは続けて動かし、最後に終了コード 1 で失敗を知らせる。
# 失敗の内容は last_fetch.json の errors、系列ごとの状態は reports/status.json、実行ごとの記録は reports/fetch_history.csv
cd "$(dirname "$0")" || exit 1
mkdir -p logs
d=$(date +%F)
rc=0
: > "logs/$d.fetch.log"
for s in fetch.py fetch_mof.py fetch_cpi.py fetch_stat.py fetch_estat.py; do
  python3 "$s" >> "logs/$d.fetch.log" 2>&1 || rc=1
done
python3 status.py > "logs/$d.status.log" 2>&1 || rc=1
python3 analyze.py > "logs/$d.analyze.log" 2>&1 || { echo "analyze.py が失敗しました"; cat "logs/$d.analyze.log"; rc=1; }
cat last_fetch.json
cat "logs/$d.status.log"
exit $rc
