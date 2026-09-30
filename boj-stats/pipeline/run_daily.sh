#!/bin/sh
# 日次ルーチンから呼ぶ: 取得 → 変化検知。ログは logs/ に残す
cd "$(dirname "$0")" || exit 1
mkdir -p logs
d=$(date +%F)
python3 fetch.py > "logs/$d.fetch.log" 2>&1; rc=$?
python3 fetch_mof.py >> "logs/$d.fetch.log" 2>&1 || rc=1
python3 fetch_cpi.py >> "logs/$d.fetch.log" 2>&1 || rc=1
python3 fetch_stat.py >> "logs/$d.fetch.log" 2>&1 || rc=1
python3 fetch_estat.py >> "logs/$d.fetch.log" 2>&1 || rc=1
python3 analyze.py > "logs/$d.analyze.log" 2>&1
cat last_fetch.json
exit $rc
