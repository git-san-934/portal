#!/usr/bin/env python3
"""取り込みの成功・失敗を系列ごとに記録する。run_daily.sh で取得の後・analyze.py の前に実行する。

- last_fetch.json（今回の errors）と data/ の CSV から、系列ごとの状態を reports/status.json に書く
    new       今回、新しい観測期の値が入った
    unchanged 取得は成功したが新しい値は無い（公表待ち）
    error     今回の取得でその系列（またはその取得元）が失敗した
    stale     しばらく新しい値が来ていない（STALE_DAYS 超）。取得元の形式変更などで黙って止まっている疑い
- 実行ごとの結果を reports/fetch_history.csv に1行ずつ追記する
- error か stale の系列があれば、内容を表示して終了コード 1 を返す（run_daily.sh の終了コードに反映）
標準ライブラリのみ。
"""
import csv, datetime as dt, json, os

from fetch import ROOT, load_series, csv_path, read_csv, load_summary
import fetch_estat, fetch_stat

REPORTS = os.path.join(ROOT, "reports")
STATUS = os.path.join(REPORTS, "status.json")
HISTORY = os.path.join(REPORTS, "fetch_history.csv")
# 新しい値が最後に入ってからこの日数を超えたら stale。公表の間隔＋祝日・公表の遅れの余裕
STALE_DAYS = {"D": 8, "M": 50, "Q": 110}
OTHER_DBS = ("MOF", "CPI", "STAT", "ESTAT")  # 日銀API以外（fetch.py の外で取る）
# "STAT 東京都区部CPI: ..." のような取得元単位のエラーと、その取得元の系列コードの接頭辞
SOURCE_PREFIXES = {f"{db} {name}": prefixes
                   for db, mod in (("STAT", fetch_stat), ("ESTAT", fetch_estat))
                   for name, _, prefixes in mod.SOURCES}


def hits(s, err):
    """エラー文 err がこの系列の失敗を指すか。エラー文の先頭の書き方は fetch*.py に合わせている。"""
    db, code = s["db"], s["code"]
    head = err.split(":", 1)[0]
    if head in (db, f"{db}/{code}", f"{db}/{s['freq']}"):
        return True
    if head == "BOJ":  # fetch.py 全体が落ちたとき
        return db not in OTHER_DBS
    if head.startswith(f"{db} "):  # 取得元単位（"ESTAT 貿易統計" など）。国別推移など系列の外のファイルの失敗は除く
        return head in SOURCE_PREFIXES and code.startswith(SOURCE_PREFIXES[head])
    return False


def main():
    now = dt.datetime.now().astimezone()
    today = now.date().isoformat()
    summary = load_summary()
    errors = summary["errors"]
    try:
        with open(STATUS, encoding="utf-8") as f:
            prev = json.load(f).get("series", {})
    except (OSError, ValueError):
        prev = {}

    out, counts = {}, {"new": 0, "unchanged": 0, "error": 0, "stale": 0}
    for s in load_series():
        sid = os.path.basename(csv_path(s["db"], s["code"]))[:-4]
        p = prev.get(sid, {})
        rows = read_csv(csv_path(s["db"], s["code"]))
        latest = max(rows) if rows else None
        errs = [e for e in errors if hits(s, e)]
        # 新しい値の到着は、前回記録した最新の観測期と比べて判定する（初めて見る系列は今日を起点にする）
        is_new = bool(latest) and p.get("latest") is not None and latest > p["latest"]
        last_new = today if is_new or not p.get("last_new") else p["last_new"]
        if errs:
            state = "error"
        elif (dt.date.fromisoformat(today) - dt.date.fromisoformat(last_new)).days > STALE_DAYS.get(s["freq"], 50):
            state = "stale"
        else:
            state = "new" if is_new else "unchanged"
        counts[state] += 1
        out[sid] = {
            "name": s["name"], "db": s["db"], "code": s["code"], "freq": s["freq"], "state": state,
            "latest": latest, "last_new": last_new,
            "last_ok": p.get("last_ok") if errs else today,  # 最後に取得が成功した日
            "fail_streak": p.get("fail_streak", 0) + 1 if errs else 0,  # 連続で失敗した回数
            "error": errs[0] if errs else None,
        }

    os.makedirs(REPORTS, exist_ok=True)
    result = {"checked_at": now.isoformat(timespec="minutes"), "date": today, "counts": counts,
              "errors": errors, "series": out}
    with open(STATUS + ".tmp", "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    os.replace(STATUS + ".tmp", STATUS)

    first = not os.path.exists(HISTORY)
    with open(HISTORY, "a", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        if first:
            w.writerow(["checked_at", "new", "unchanged", "error", "stale", "errors"])
        w.writerow([result["checked_at"], counts["new"], counts["unchanged"], counts["error"], counts["stale"],
                    " / ".join(errors)])

    print(f"取り込み状況: 新しい値 {counts['new']} / 変化なし {counts['unchanged']} / "
          f"失敗 {counts['error']} / 長く更新なし {counts['stale']}（全{len(out)}系列）")
    for e in errors:
        print(f"  取得エラー: {e}")
    for v in out.values():
        if v["state"] == "stale":
            print(f"  長く更新なし: {v['name']}（{v['db']}/{v['code']}、最新 {v['latest']}、最後に新しい値が入った日 {v['last_new']}）")
    return 1 if errors or counts["stale"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
