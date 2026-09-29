"""SBI日本株4.3ブル(協会コード 8931317C)の基準価額を取得し、../data/nav.json に追記する。

GitHub Actions(.github/workflows/update-nikkei43.yml)から平日の夜と朝に実行される。

取得元(上から順に試す):
  1. 投信総合検索ライブラリー(投資信託協会)の基準価額CSV — 設定来の全データ
  2. Yahoo!ファイナンスの時系列ページ — 直近分のみ

どちらも取れないとき、または取れた値が既存データと食い違うときは nav.json を
上書きせずに終了コード1で終わる(壊れたデータでアドバイスを出さないため)。

`--check` を付けると取得と検証だけ行い、nav.json は書き換えない(PR での確認用)。
"""

import json
import re
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ISIN = "JP90C000FSK4"
FUND_CODE = "8931317C"
TOUSHIN_URL = (
    "https://toushin-lib.fwg.ne.jp/FdsWeb/FDST030000/csv-file-download"
    f"?isinCd={ISIN}&associFundCd={FUND_CODE}"
)
YAHOO_URL = "https://finance.yahoo.co.jp/quote/{code}/history?from={frm}&to={to}&timeFrame=d&page={page}"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "nav.json"
JST = timezone(timedelta(hours=9))
RETRIES = 3
# 既存データと重なる日の値がこれ以上ずれていたら、取得元の誤りとみなして使わない
MATCH_TOLERANCE = 0.005
# 4.3倍でも1日でこれ以上動くことはまずない(日経平均 -12% の日でも約 -52%)。超えたら誤データ扱い
MAX_DAILY_MOVE = 0.6


def http_get(url: str) -> bytes:
    last = None
    for attempt in range(1, RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ja"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 — 取得元ごとの失敗はまとめて扱う
            last = e
            print(f"  取得失敗 ({attempt}/{RETRIES}): {e}", file=sys.stderr)
            time.sleep(3 * attempt)
    raise RuntimeError(f"{url} を取得できませんでした: {last}")


def parse_date(text: str):
    m = re.match(r"\s*(\d{4})\s*[年/\-]\s*(\d{1,2})\s*[月/\-]\s*(\d{1,2})", text)
    if not m:
        return None
    try:
        return date(int(m[1]), int(m[2]), int(m[3])).isoformat()
    except ValueError:
        return None


def from_toushin() -> dict:
    raw = http_get(TOUSHIN_URL)
    for enc in ("cp932", "utf-8-sig", "utf-8"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise RuntimeError("CSVの文字コードを判別できませんでした")
    out = {}
    for line in text.splitlines():
        cols = [c.strip().strip('"') for c in line.split(",")]
        if len(cols) < 2:
            continue
        d = parse_date(cols[0])
        num = cols[1].replace(",", "")
        if d and re.fullmatch(r"\d+(\.\d+)?", num):
            out[d] = int(round(float(num)))
    if len(out) < 100:
        raise RuntimeError(f"CSVから読めた行が少なすぎます({len(out)}行)")
    return out


def from_yahoo(since: str) -> dict:
    """Yahoo!ファイナンスの時系列ページから直近の基準価額を読む。

    ページ内の埋め込みJSONに「日付」と「基準価額」が並んで入っているので、
    日付のすぐ後ろに出てくる数値(カンマ区切り可)を基準価額として拾う。
    """
    today = datetime.now(JST).date()
    frm = (date.fromisoformat(since) - timedelta(days=10)).strftime("%Y%m%d")
    to = today.strftime("%Y%m%d")
    out = {}
    for page in range(1, 6):
        html = http_get(YAHOO_URL.format(code=FUND_CODE, frm=frm, to=to, page=page)).decode("utf-8", "replace")
        found = 0
        for m in re.finditer(
            r"(\d{4})(?:年|/)(\d{1,2})(?:月|/)(\d{1,2})日?(?:\([^)]{1,3}\))?[^0-9]{1,120}?([1-9]\d{0,2}(?:,\d{3})+|[1-9]\d{3,5})(?!\d)",
            html,
        ):
            try:
                d = date(int(m[1]), int(m[2]), int(m[3])).isoformat()
            except ValueError:
                continue
            if d not in out:
                out[d] = int(m[4].replace(",", ""))
                found += 1
        if found < 20:
            break
    if not out:
        raise RuntimeError("Yahoo!ファイナンスのページから基準価額を読めませんでした")
    return out


def validate(existing: dict, fetched: dict, name: str) -> None:
    overlap = [d for d in fetched if d in existing]
    bad = [d for d in overlap if abs(fetched[d] / existing[d] - 1) > MATCH_TOLERANCE]
    if not overlap:
        raise RuntimeError(f"{name}: 既存データと重なる日がなく、正しい値か確かめられません")
    if len(bad) > max(2, len(overlap) * 0.01):
        sample = ", ".join(f"{d}: 既存{existing[d]} / 取得{fetched[d]}" for d in bad[:3])
        raise RuntimeError(f"{name}: 既存データと食い違う日が {len(bad)} 日あります({sample})")


def main() -> int:
    check_only = "--check" in sys.argv
    data = json.loads(OUT_PATH.read_text(encoding="utf-8"))
    existing = dict(zip(data["dates"], data["nav"]))
    last_date = data["dates"][-1]

    merged = None
    source = None
    errors = []
    for name, fn in (("投信総合検索ライブラリー", from_toushin), ("Yahoo!ファイナンス", lambda: from_yahoo(last_date))):
        print(f"{name} から取得中...")
        try:
            fetched = fn()
            validate(existing, fetched, name)
        except Exception as e:  # noqa: BLE001
            print(f"  {e}", file=sys.stderr)
            errors.append(f"{name}: {e}")
            continue
        # 新しい日に加えて、既存データの抜け(過去の取得漏れ)も埋める
        new = {d: v for d, v in fetched.items() if d not in existing and date.fromisoformat(d).weekday() < 5}
        print(f"  {len(fetched)} 日分を取得。追加する日: {sorted(new) or 'なし'}")
        merged = dict(existing)
        merged.update(new)
        source = name
        break

    if merged is None:
        print("どの取得元からも基準価額を取れませんでした", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    dates = sorted(merged)
    navs = [merged[d] for d in dates]
    for i in range(1, len(navs)):
        if abs(navs[i] / navs[i - 1] - 1) > MAX_DAILY_MOVE:
            print(f"{dates[i]} の値動きが大きすぎます({navs[i - 1]} → {navs[i]})。書き込みを中止します", file=sys.stderr)
            return 1

    if check_only:
        print(f"確認のみ: 最新 {dates[-1]} {navs[-1]}円(取得元: {source})")
        return 0

    if dates == data["dates"]:
        print("新しいデータはありません")
        return 0
    data.update(
        dates=dates,
        nav=navs,
        source=source,
        updated=datetime.now(JST).isoformat(timespec="minutes"),
    )
    OUT_PATH.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"更新しました: 最新 {dates[-1]} {navs[-1]}円(取得元: {source})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
