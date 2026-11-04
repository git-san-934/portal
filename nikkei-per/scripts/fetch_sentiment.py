"""需給・過熱感のデータ(信用取引残高・日経平均VI)を取り、../data/sentiment.json に書く。

取得元:
  信用取引残高 : JPX「信用取引現在高過去推移表」 https://www.jpx.co.jp/markets/statistics-equities/margin/05.html
                 (ページにある .xls/.xlsx をすべて読み、週ごとの売り残・買い残を集める)
  日経平均VI   : 日経平均プロフィル(いくつかの置き場所を順に試す)

使い方:
  python fetch_sentiment.py --check   # 取れるかの確認だけ。中身の形を表示し、ファイルは書かない
  python fetch_sentiment.py           # 取れた分を sentiment.json に書く
"""

import argparse
import io
import json
import re
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
JPX = "https://www.jpx.co.jp"
MARGIN_PAGE = JPX + "/markets/statistics-equities/margin/05.html"
NK = "https://indexes.nikkei.co.jp/nkave"
VI_CANDIDATES = [
    NK + "/statistics/dataload?list=vi&year={y}&month={m}",
    NK + "/statistics/dataload?list=nk225vi&year={y}&month={m}",
    NK + "/archives/data?list=vi",
    NK + "/index/profile?idx=nk225vi",
]
OUT = Path(__file__).resolve().parent.parent / "data" / "sentiment.json"
JST = timezone(timedelta(hours=9))


def get(url: str, binary=False):
    last = None
    for a in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ja", "Referer": NK + "/archives/data"})
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
            if binary:
                return raw
            for enc in ("utf-8", "cp932"):
                try:
                    return raw.decode(enc)
                except UnicodeDecodeError:
                    pass
            return raw.decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (a + 1))
    raise RuntimeError(f"{url}: {last}")


def sheet_rows(raw: bytes, name: str):
    """xls / xlsx を行のリスト(セルの値のリスト)にする。"""
    if name.endswith(".xlsx"):
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        for ws in wb.worksheets:
            yield ws.title, [list(r) for r in ws.iter_rows(values_only=True)]
    else:
        import xlrd
        wb = xlrd.open_workbook(file_contents=raw)
        for sh in wb.sheets():
            rows = []
            for i in range(sh.nrows):
                row = []
                for j in range(sh.ncols):
                    c = sh.cell(i, j)
                    if c.ctype == xlrd.XL_CELL_DATE:
                        row.append(xlrd.xldate.xldate_as_datetime(c.value, wb.datemode))
                    else:
                        row.append(c.value)
                rows.append(row)
            yield sh.name, rows


def to_date(v):
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, str):
        m = re.search(r"(\d{4})\s*[./\-年]\s*(\d{1,2})\s*[./\-月]\s*(\d{1,2})", v)
        if m:
            try:
                return date(int(m[1]), int(m[2]), int(m[3])).isoformat()
            except ValueError:
                return None
    return None


def num(v):
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        t = v.replace(",", "").strip()
        try:
            return float(t)
        except ValueError:
            return None
    return None


def margin(check: bool) -> dict:
    page = get(MARGIN_PAGE)
    links = sorted(set(re.findall(r'href="([^"]+\.xlsx?)"', page)))
    print(f"信用取引: ファイル {len(links)} 個: {links}")
    weeks = {}
    for href in links:
        url = href if href.startswith("http") else JPX + href
        name = url.rsplit("/", 1)[-1]
        try:
            raw = get(url, binary=True)
        except RuntimeError as e:
            print(f"  {name}: 取得失敗 {e}")
            continue
        for title, rows in sheet_rows(raw, name):
            dated = [(to_date(r[0]) if r else None, r) for r in rows]
            dated = [(d, r) for d, r in dated if d]
            print(f"  {name} / {title}: {len(rows)} 行、日付のある行 {len(dated)}"
                  + (f"({dated[0][0]}〜{dated[-1][0]})" if dated else ""))
            if check:
                # 見出しのあたりと、日付のある最初と最後の行を見せる
                for r in rows[:8]:
                    print("    見出し?", [c for c in r if c not in (None, "")][:14])
                for d, r in dated[:2] + dated[-2:]:
                    print("    行", d, [c for c in r[1:] if c not in (None, "")][:14])
            for d, r in dated:
                vals = [num(c) for c in r[1:]]
                weeks.setdefault(d, {"date": d, "file": name, "sheet": title, "vals": vals})
    return {"rows": [weeks[d] for d in sorted(weeks)]}


def vi(check: bool) -> dict:
    today = datetime.now(JST).date()
    for tpl in VI_CANDIDATES:
        url = tpl.format(y=today.year, m=today.month)
        try:
            page = get(url)
        except RuntimeError as e:
            print(f"日経VI: {url} 失敗 {e}")
            continue
        trs = re.findall(r"<tr[^>]*>(.*?)</tr>", page, flags=re.S | re.I)
        dates = re.findall(r"\d{4}[./]\d{1,2}[./]\d{1,2}", page)
        print(f"日経VI: {url} → {len(page)} 文字、tr {len(trs)}、日付らしき文字 {len(dates)}")
        if check:
            print("   先頭:", re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", page))[:400])
        csv = re.findall(r'href="([^"]+\.csv)"', page)
        if csv:
            print("   CSV:", csv[:10])
    return {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    out = {"updated": datetime.now(JST).isoformat(timespec="minutes")}
    try:
        out["margin"] = margin(args.check)
    except Exception as e:  # noqa: BLE001
        print(f"信用取引: 失敗 {e}", file=sys.stderr)
    try:
        vi(args.check)
    except Exception as e:  # noqa: BLE001
        print(f"日経VI: 失敗 {e}", file=sys.stderr)
    if not args.check and out.get("margin", {}).get("rows"):
        OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":"), default=str) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
