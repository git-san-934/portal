"""ページの「銘柄リストの編集」から作られた GitHub Issue の本文を読み、
../data/holdings.json を書き換える。

Issue 本文の ```json ... ``` の中に {"stocks": [{"code": ..., "name": ...}, ...]} がある前提。
中身は形式をすべて確かめてから書き込み、おかしいときは何も書かずに終了コード1で終わる。
GitHub Actions(.github/workflows/apply-holdings-list.yml)から、リポジトリ所有者の Issue でだけ実行される。

使い方: ISSUE_BODY 環境変数に本文を入れて実行。結果の説明を summary.txt に書く。
"""

import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

LIST_PATH = Path(__file__).resolve().parent.parent / "data" / "holdings.json"
SUMMARY_PATH = Path("summary.txt")
MAX_STOCKS = 50
JP_CODE = re.compile(r"^[0-9][0-9A-Z]{3}$")
US_CODE = re.compile(r"^[A-Z][A-Z0-9.-]{0,9}$")
JST = timezone(timedelta(hours=9))


def fail(msg):
    SUMMARY_PATH.write_text(msg, encoding="utf-8")
    print(msg, file=sys.stderr)
    sys.exit(1)


def parse(body):
    m = re.search(r"```json\s*(\{.*?\})\s*```", body, re.S)
    if not m:
        fail("本文に銘柄リスト(```json ... ```)が見つかりませんでした。")
    try:
        data = json.loads(m.group(1))
    except ValueError as e:
        fail(f"銘柄リストの JSON が読めませんでした: {e}")
    stocks = data.get("stocks") if isinstance(data, dict) else None
    if not isinstance(stocks, list) or not 1 <= len(stocks) <= MAX_STOCKS:
        fail(f"銘柄は1〜{MAX_STOCKS}件にしてください。")

    out = []
    seen = set()
    for i, s in enumerate(stocks, 1):
        if not isinstance(s, dict):
            fail(f"{i}件目の形式が違います。")
        code = str(s.get("code", "")).strip().upper()
        name = str(s.get("name", "")).strip()
        currency = s.get("currency") or "JPY"
        if not name or len(name) > 40 or any(c in name for c in "\n\r\t"):
            fail(f"{i}件目({code})の銘柄名が空か長すぎます。")
        if currency == "JPY":
            if not JP_CODE.match(code):
                fail(f"{i}件目: 日本株のコード {code!r} は4桁(例: 7203、285A)にしてください。")
            entry = {"code": code, "name": name}
        elif currency == "USD":
            if not US_CODE.match(code):
                fail(f"{i}件目: 米国株のティッカー {code!r} が正しくありません。")
            entry = {"code": code, "name": name, "ticker": code.replace(".", "-"), "currency": "USD"}
        else:
            fail(f"{i}件目: 通貨 {currency!r} には対応していません(JPY か USD)。")
        if code in seen:
            fail(f"{code} が2回出てきます。")
        seen.add(code)
        out.append(entry)
    return out


def dump(stocks):
    today = datetime.now(JST).strftime("%Y-%m-%d")
    row = lambda s: "{" + ", ".join(f"{json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}" for k, v in s.items()) + "}"
    return (
        "{\n"
        f'  "updated_at": "{today}",\n'
        '  "stocks": [\n' + ",\n".join(f"    {row(s)}" for s in stocks) + "\n  ]\n}\n"
    )


def main():
    stocks = parse(os.environ.get("ISSUE_BODY", ""))
    before = json.loads(LIST_PATH.read_text(encoding="utf-8"))["stocks"] if LIST_PATH.exists() else []
    old = {s["code"]: s["name"] for s in before}
    new = {s["code"]: s["name"] for s in stocks}
    added = [f"{n}({c})" for c, n in new.items() if c not in old]
    removed = [f"{n}({c})" for c, n in old.items() if c not in new]
    renamed = [f"{old[c]} → {n}" for c, n in new.items() if c in old and old[c] != n]
    parts = []
    if added:
        parts.append("追加: " + "、".join(added))
    if removed:
        parts.append("削除: " + "、".join(removed))
    if renamed:
        parts.append("名前の修正: " + "、".join(renamed))
    if not parts and [s["code"] for s in before] == [s["code"] for s in stocks]:
        SUMMARY_PATH.write_text("変更はありませんでした。", encoding="utf-8")
        print("no change")
        return
    LIST_PATH.write_text(dump(stocks), encoding="utf-8")
    summary = " / ".join(parts) or "並び順の変更"
    SUMMARY_PATH.write_text(summary, encoding="utf-8")
    print(summary)


if __name__ == "__main__":
    main()
