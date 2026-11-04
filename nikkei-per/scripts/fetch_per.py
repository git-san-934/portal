"""日経平均の日次PERと終値を日経平均プロフィル(日経公式)から取り、../data/per_daily.json に追記する。

GitHub Actions(.github/workflows/update-nikkei-per.yml)から平日の夕方と夜に実行される。

取得元: 日経平均プロフィル https://indexes.nikkei.co.jp/nkave/
  - PER  : /nkave/statistics/dataload?list=per&year=YYYY&month=M   (月ごとの日次表)
  - 終値 : /nkave/statistics/dataload?list=daily&year=YYYY&month=M
  - 当月分は /nkave/archives/data?list=per と list=daily のページにも同じ表がある(上が取れないときの予備)

PER の表には「加重平均」と「指数ベース」の2列がある(時期によって1列のこともある)。
列名ごとにそのまま保存し、どの列を分析に使うかは analyze.py で決める。

使い方:
  python fetch_per.py                       # 当月と前月を取り直して追記(データが空のときは 1986-01 からさかのぼる)
  python fetch_per.py --backfill 2004-01    # 指定の月から当月まで1か月ずつ取る(初回用。数分かかる)
  python fetch_per.py --check               # 取得と検証だけ行い、ファイルは書き換えない(PR での確認用)

取れた値がおかしいとき(既存データと食い違う、PER が 3〜2000 倍の外、終値が1日で20%超動く)は
その日を上書きせず、終了コード1で終わる。何も取れなかったときも終了コード1。
"""

import argparse
import html
import json
import re
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

BASE = "https://indexes.nikkei.co.jp/nkave"
DATALOAD = BASE + "/statistics/dataload?list={kind}&year={y}&month={m}"
ARCHIVE = BASE + "/archives/data?list={kind}"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "per_daily.json"
JST = timezone(timedelta(hours=9))
RETRIES = 3
# 2009年春は利益が大きく落ちて加重平均でも約290倍、指数ベースは800倍を超えた(本当の値)。それより桁違いの値だけを誤りとみなす
PER_RANGE = (3.0, 2000.0)
MAX_DAILY_MOVE = 0.2  # 日経平均の過去最大の下落は1日 −14.9%(1987年)
MATCH_TOLERANCE = 0.005
FIRST_BACKFILL = "1986-01"


def http_get(url: str) -> str:
    last = None
    for attempt in range(1, RETRIES + 1):
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": UA,
                    "Accept-Language": "ja",
                    "X-Requested-With": "XMLHttpRequest",
                    "Referer": BASE + "/archives/data",
                },
            )
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
            for enc in ("utf-8", "cp932"):
                try:
                    return raw.decode(enc)
                except UnicodeDecodeError:
                    continue
            return raw.decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            last = e
            print(f"  取得失敗 ({attempt}/{RETRIES}) {url}: {e}", file=sys.stderr)
            time.sleep(3 * attempt)
    raise RuntimeError(f"{url} を取得できませんでした: {last}")


def cell_text(s: str) -> str:
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def parse_date(text: str):
    m = re.search(r"(\d{4})\s*[./\-年]\s*(\d{1,2})\s*[./\-月]\s*(\d{1,2})", text)
    if not m:
        return None
    try:
        return date(int(m[1]), int(m[2]), int(m[3])).isoformat()
    except ValueError:
        return None


def parse_num(text: str):
    t = text.replace(",", "").replace("倍", "").strip()
    try:
        return float(t)
    except ValueError:
        return None


def parse_table(page: str) -> tuple[list[str], dict[str, list]]:
    """表から (見出し, {日付: [数値...]}) を取り出す。日付で始まる行だけを使う。"""
    headers: list[str] = []
    rows: dict[str, list] = {}
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", page, flags=re.S | re.I):
        ths = [cell_text(c) for c in re.findall(r"<th[^>]*>(.*?)</th>", tr, flags=re.S | re.I)]
        tds = [cell_text(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", tr, flags=re.S | re.I)]
        cells = ths + tds if ths and tds else (tds or ths)
        if not cells:
            continue
        d = parse_date(cells[0])
        if d is None:
            if ths and not tds and len(ths) >= 2 and not headers:
                headers = ths
            continue
        rows[d] = [parse_num(c) for c in cells[1:]]
    return headers, rows


def per_columns(headers: list[str], ncols: int) -> list[str]:
    """PER 表の数値列に名前をつける。見出しが取れないときは列数で推定する。"""
    names = []
    for h in headers[1:]:
        if "指数" in h:
            names.append("index_based")
        elif "加重" in h:
            names.append("weighted")
        else:
            names.append(h or f"col{len(names)}")
    if len(names) == ncols:
        return names
    # 見出しが無い・合わないとき: 2列なら「加重平均, 指数ベース」の順、1列なら加重平均
    return ["weighted", "index_based"][:ncols] if ncols <= 2 else [f"col{i}" for i in range(ncols)]


def fetch_month(kind: str, y: int, m: int, current: bool) -> tuple[list[str], dict]:
    page = http_get(DATALOAD.format(kind=kind, y=y, m=m))
    headers, rows = parse_table(page)
    if not rows and current:
        page = http_get(ARCHIVE.format(kind=kind))
        headers, rows = parse_table(page)
    # 別の月の行が混ざっていたら落とす
    prefix = f"{y:04d}-{m:02d}-"
    return headers, {d: v for d, v in rows.items() if d.startswith(prefix)}


def months_between(start: tuple[int, int], end: tuple[int, int]):
    y, m = start
    while (y, m) <= end:
        yield y, m
        m += 1
        if m == 13:
            y, m = y + 1, 1


def load_existing() -> dict:
    if OUT_PATH.exists():
        return json.loads(OUT_PATH.read_text(encoding="utf-8"))
    return {"name": "日経平均 日次PER・終値", "source": BASE, "rows": []}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill", help="YYYY-MM から当月まで取る")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    today = datetime.now(JST).date()
    end = (today.year, today.month)
    if not args.backfill and not args.check and not load_existing()["rows"]:
        # 初回はさかのぼれるだけ取る(日経のサイトにどこまで古い月があるかは取ってみて確かめる)
        args.backfill = FIRST_BACKFILL
        print(f"データが空なので {FIRST_BACKFILL} からさかのぼって取ります")
    if args.backfill:
        y, m = map(int, args.backfill.split("-"))
        start = (y, m)
    else:
        prev = today.replace(day=1) - timedelta(days=1)
        start = (prev.year, prev.month)

    fetched: dict[str, dict] = {}
    for y, m in months_between(start, end):
        current = (y, m) == end
        try:
            ph, prow = fetch_month("per", y, m, current)
            dh, drow = fetch_month("daily", y, m, current)
        except RuntimeError as e:
            print(f"{y}-{m:02d}: {e}", file=sys.stderr)
            continue
        names = per_columns(ph, max((len(v) for v in prow.values()), default=0))
        for d, vals in prow.items():
            rec = fetched.setdefault(d, {"date": d})
            for n, v in zip(names, vals):
                if v is not None:
                    rec[n] = v
        # 終値の表は「日付, 終値, 始値, 高値, 安値」。見出しに「終値」があればその列、無ければ先頭の数値
        ci = next((i - 1 for i, h in enumerate(dh) if i > 0 and "終値" in h), 0)
        for d, vals in drow.items():
            if len(vals) > ci and vals[ci] is not None:
                fetched.setdefault(d, {"date": d})["close"] = vals[ci]
        print(f"{y}-{m:02d}: PER {len(prow)}日 / 終値 {len(drow)}日 (PER列: {names})")
        if args.backfill and (prow or drow):
            time.sleep(1.0)

    if not fetched:
        print("PER も終値も1日分も取れませんでした", file=sys.stderr)
        return 1

    data = load_existing()
    by_date = {r["date"]: r for r in data["rows"]}
    problems = 0
    for d in sorted(fetched):
        rec = fetched[d]
        bad = [k for k in ("weighted", "index_based") if k in rec and not (PER_RANGE[0] <= rec[k] <= PER_RANGE[1])]
        if bad:
            print(f"  {d}: PER がありえない値 {rec} — 使いません", file=sys.stderr)
            problems += 1
            continue
        old = by_date.get(d)
        if old:
            for k, v in rec.items():
                if k != "date" and k in old and abs(old[k] - v) > abs(old[k]) * MATCH_TOLERANCE:
                    print(f"  {d}: {k} が既存 {old[k]} と取得 {v} で食い違います — 既存を残します", file=sys.stderr)
                    problems += 1
            merged = {**rec, **old}
        else:
            merged = rec
        by_date[d] = merged

    rows = [by_date[d] for d in sorted(by_date)]
    prev_close = None
    for r in rows:
        c = r.get("close")
        if c is not None and prev_close is not None and abs(c / prev_close - 1) > MAX_DAILY_MOVE:
            print(f"  {r['date']}: 終値 {c} が前日 {prev_close} から20%超動いています — 確認してください", file=sys.stderr)
            problems += 1
        if c is not None:
            prev_close = c

    added = len(rows) - len(data["rows"])
    print(f"合計 {len(rows)}日(新しく {added}日)。最新: {rows[-1]}")
    if args.check:
        return 1 if problems else 0
    data["rows"] = rows
    data["updated"] = datetime.now(JST).isoformat(timespec="minutes")
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
