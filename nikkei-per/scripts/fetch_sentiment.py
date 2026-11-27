"""需給・過熱感のデータを取り、../data/sentiment.json にためていく。

JPX と日経のサイトには最近の分しか置かれていないもの(裁定残・先物の投資部門別)があるので、
平日の自動更新のたびに取り、前に取った分とまとめて保存する。

取得元:
  信用取引残高 : JPX「信用取引現在高」 https://www.jpx.co.jp/markets/statistics-equities/margin/05.html
                 (2002年〜の週次の .xls と、直近の週の .xlsx。合計の売残・買残の株数と金額)
  裁定残       : JPX「プログラム売買・裁定取引」 https://www.jpx.co.jp/markets/statistics-equities/program/index.html
                 (日々の .xls。裁定取引に係る現物ポジションの売り・買いの合計 千株。置かれているのは直近の約20営業日)
  先物の投資部門別 : JPX「投資部門別取引状況」 https://www.jpx.co.jp/markets/statistics-derivatives/sector/index.html
                 (週次の CSV。商品・投資部門ごとの売り・買いの数量と金額。置かれているのは直近の約5週)
  日経平均VI   : 日経平均プロフィルの日次 CSV(2023年〜)
  日経225オプションのプット・コール(プットコールレシオ用):
    日次 : JPX「月間統計資料」の指数オプション取引状況(日別) SIOP_D_YYYYMM.xlsx(2024年1月〜、前月分まで)
           https://www.jpx.co.jp/markets/statistics-derivatives/monthly-statistics/index.html
    当月 : JPX「取引高・建玉残高」のデリバティブ建玉残高状況(概算) YYYYMMDDopen_interest.xlsx(置かれているのは前営業日の1日分)
           https://www.jpx.co.jp/markets/derivatives/trading-volume/index.html
           月間統計資料が出たら、その月の日は月間統計資料の値で置き換える
    月次 : JPX「取引総括表(月間)」 soukatsu_M.xlsx(2014年12月〜)
           https://www.jpx.co.jp/markets/statistics-derivatives/trading-volume/index.html

使い方:
  python fetch_sentiment.py --check   # 取れるかの確認だけ。件数を表示し、ファイルは書かない
  python fetch_sentiment.py           # 取れた分を sentiment.json に足して書く
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
PROGRAM_PAGE = JPX + "/markets/statistics-equities/program/index.html"
SECTOR_PAGE = JPX + "/markets/statistics-derivatives/sector/index.html"
NK = "https://indexes.nikkei.co.jp/nkave"
VI_CSV = NK + "/historical/nikkei_stock_average_vi_daily_jp.csv"
MSTAT_YEARS = JPX + "/automation/markets/statistics-derivatives/monthly-statistics/json/monthly_statistics_report_yearlist.json"
OI_PAGE = JPX + "/markets/derivatives/trading-volume/index.html"
SOUKATSU_M = JPX + "/automation/markets/statistics-derivatives/trading-volume/files/soukatsu_M.xlsx"
OUT = Path(__file__).resolve().parent.parent / "data" / "sentiment.json"
JST = timezone(timedelta(hours=9))


KEYS = ("margin", "arbitrage", "futures", "vi", "pcr", "pcr_m")


def get(url: str, binary=False):
    last = None
    for a in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ja", "Referer": NK + "/archives/data"})
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
            if binary:
                return raw
            for enc in ("utf-8-sig", "cp932"):
                try:
                    return raw.decode(enc)
                except UnicodeDecodeError:
                    pass
            return raw.decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (a + 1))
    raise RuntimeError(f"{url}: {last}")


def links(page: str, pattern: str):
    return sorted(set(x if x.startswith("http") else JPX + x for x in re.findall(r'href="([^"]+)"', page) if re.search(pattern, x)))


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
        try:
            return float(v.replace(",", "").strip())
        except ValueError:
            return None
    return None


def margin() -> dict:
    """週ごとの合計の [売残 株数, 売残 金額, 買残 株数, 買残 金額](千株・百万円)。"""
    page = get(MARGIN_PAGE)
    out = {}
    for url in links(page, r"\.xlsx?$"):
        name = url.rsplit("/", 1)[-1]
        if name.endswith("_mtgk.xls"):
            continue  # 一般・制度別の表。合計は mtsk と同じ
        # 2002年〜の表(_mtsk.xls)は合計が 9〜12 列目、直近の週の表(.xlsx)は 13〜16 列目
        at = 8 if name.endswith("_mtsk.xls") else 12
        got = 0
        for _, rows in sheet_rows(get(url, binary=True), name):
            for r in rows:
                d = to_date(r[0]) if r else None
                v = [num(c) for c in r[1 + at:5 + at]] if d else []
                if d and len(v) == 4 and all(x is not None for x in v):
                    out[d] = [int(x) for x in v]
                    got += 1
            if not got:  # 取れなかった表は、どこがずれているか分かるように先頭を出しておく
                print(f"  信用残 {name}: 0 件 先頭 {[r[:18] for r in rows[:12]]}")
            break
        print(f"  信用残 {name}: {got} 件")
    return out


def arbitrage() -> dict:
    """日ごとの裁定取引に係る現物ポジション [売り 合計, 買い 合計](千株)。ファイル名(YYMMDD)がその日。"""
    page = get(PROGRAM_PAGE)
    out = {}
    for url in links(page, r"/\d{6}\.xls$"):
        m = re.search(r"/(\d{2})(\d{2})(\d{2})\.xls$", url)
        d = date(2000 + int(m[1]), int(m[2]), int(m[3])).isoformat()
        for _, rows in sheet_rows(get(url, binary=True), url):
            pos = False
            for r in rows:
                cells = [c for c in r if c not in (None, "")]
                if cells and isinstance(cells[0], str) and "現物ポジション" in cells[0]:
                    pos = True
                elif pos and cells and isinstance(cells[0], str) and "株" in cells[0] and len(cells) >= 7:
                    out[d] = [int(num(cells[3])), int(num(cells[6]))]
                    break
            break
    return out


def futures() -> tuple[dict, list]:
    """週ごとの投資部門別の取引。{週: {"from", "to", "rows": {商品: {部門: [売 数量, 買 数量, 売 金額, 買 金額]}}}}。"""
    page = get(SECTOR_PAGE)
    out, header = {}, []
    for url in links(page, r"Tousi_DV_W_\d+_\d+\.csv$"):
        text = get(url)
        lines = text.splitlines()
        header = lines[0].split(",") if lines else header
        for ln in lines[1:]:
            c = [x.strip('"') for x in ln.split(",")]
            if len(c) < 12:
                continue
            prod, week, frm, to, inv, item = c[0], c[2], c[3], c[4], c[5], c[6]
            sell, buy = int(c[7]), int(c[9])
            w = out.setdefault(week, {"from": frm, "to": to, "rows": {}})
            v = w["rows"].setdefault(prod, {}).setdefault(inv, [0, 0, 0, 0])
            k = 0 if item == "1" else 2
            v[k], v[k + 1] = sell, buy
    return out, header


def vi() -> dict:
    out = {}
    for ln in get(VI_CSV).strip().splitlines()[1:]:
        c = [x.strip('"') for x in ln.split(",")]
        d, v = to_date(c[0]), num(c[1]) if len(c) > 1 else None
        if d and v is not None:
            out[d] = v
    return out


def _nums15(row):
    """SIOP_D の1行から 取引高・取引金額・権利行使・ギブアップ・建玉 の(プット, コール, 合計)×5 の15個を取り出す。
    最高・最低の印(◎●)は別のセルに入っているので除き、「－」は 0 とする。"""
    out = []
    for c in row[3:]:
        if isinstance(c, (int, float)):
            out.append(float(c))
        elif isinstance(c, str) and c.strip() in ("－", "-", "―"):
            out.append(0.0)
    return out


def pcr_daily(old: dict) -> dict:
    """日経225オプションの日ごとの [プット取引高, コール取引高, プット建玉, コール建玉, 出所]。
    出所 "m" は月間統計資料(確定)、"d" は日々の建玉残高状況(概算)。"""
    import json as _json
    years = _json.loads(get(MSTAT_YEARS))["TableDatas"]
    files = []
    for y in years:
        tbl = _json.loads(get(y["Jsonfile"] if y["Jsonfile"].startswith("http") else JPX + y["Jsonfile"]))["TableDatas"]
        for r in tbl:
            if "指数オプション" in r.get("Quotations", ""):
                files += [v for k, v in r.items() if k != "Quotations" and isinstance(v, str) and v.endswith(".xlsx")]
    have = {d[:7] for d, v in old.items() if len(v) > 4 and v[4] == "m"}
    files = sorted(set(files))
    out = {}
    for i, f in enumerate(files):
        m = re.search(r"_(\d{4})(\d{2})\.xlsx$", f)
        ym = f"{m[1]}-{m[2]}"
        if ym in have and i < len(files) - 1:
            continue  # 取り込み済みの月は取り直さない(最新の月だけは念のため毎回)
        for _, rows in sheet_rows(get(JPX + f, binary=True), f):
            for r in rows:
                if len(r) < 3 or r[1] != "日経225オプション":
                    continue
                # 月日は月初めの日だけ「11.1」、ほかは日だけ「2」
                t = str(int(r[0])) if isinstance(r[0], float) and r[0].is_integer() else str(r[0]).strip()
                v = _nums15(r)
                if not re.fullmatch(r"(\d{1,2}\.)?\d{1,2}", t) or len(v) < 15:
                    continue
                try:
                    d = date(int(m[1]), int(m[2]), int(t.split(".")[-1])).isoformat()
                except ValueError:
                    continue
                if abs(v[0] + v[1] - v[2]) > 0.5 or abs(v[12] + v[13] - v[14]) > 0.5:
                    print(f"pcr: {d} の列が読めませんでした(プット+コール≠合計) {v}", file=sys.stderr)
                    continue
                if v[0] + v[1] > 0:
                    out[d] = [int(v[0]), int(v[1]), int(v[12]), int(v[13]), "m"]
            break
    # 月間統計資料にまだ無い最近の日: 建玉残高状況(概算)の「プット合計」「コール合計」
    page = get(OI_PAGE)
    for url in links(page, r"open_interest\.xlsx$"):
        md = re.search(r"/(\d{4})(\d{2})(\d{2})open_interest\.xlsx$", url)
        if not md:
            continue
        d = f"{md[1]}-{md[2]}-{md[3]}"
        put = call = None
        for title, rows in sheet_rows(get(url, binary=True), url):
            if not title.startswith("別紙1"):
                continue
            for r in rows:
                for j, c in enumerate(r):
                    if isinstance(c, str) and c.strip() in ("プット合計", "コール合計") and j + 2 < len(r):
                        vals = (num(r[j + 1]), num(r[j + 2]))
                        if None not in vals:
                            if c.strip() == "プット合計":
                                put = vals
                            else:
                                call = vals
            break
        if put and call and d not in out and (old.get(d, [None] * 5)[4] != "m"):
            out[d] = [int(put[0]), int(call[0]), int(put[1]), int(call[1]), "d"]
    return out


def pcr_monthly() -> dict:
    """日経225オプションの月ごとの [プット取引高, コール取引高](2014年12月〜)。"""
    out = {}
    for _, rows in sheet_rows(get(SOUKATSU_M, binary=True), "soukatsu_M.xlsx"):
        for r in rows:
            if len(r) < 8 or r[0] != "日経225オプション" or r[2] not in ("プット", "コール"):
                continue
            try:
                ym = f"{int(float(r[4])):04d}-{int(float(r[5])):02d}"
            except (TypeError, ValueError):
                continue
            vol = num(r[7])
            if vol is not None:
                out.setdefault(ym, [None, None])[0 if r[2] == "プット" else 1] = int(vol)
        break
    return {k: v for k, v in out.items() if None not in v}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    old = {}
    if OUT.exists():
        try:
            old = json.loads(OUT.read_text(encoding="utf-8"))
        except ValueError:
            old = {}
    data = {k: old.get(k, {}) for k in KEYS}
    ok = 0
    for key, fn in (("margin", margin), ("arbitrage", arbitrage), ("futures", futures), ("vi", vi),
                    ("pcr", lambda: pcr_daily(data["pcr"])), ("pcr_m", pcr_monthly)):
        try:
            got = fn()
            if key == "futures":
                got, header = got
                print(f"先物の投資部門別: 見出し {header}")
            before = len(data[key])
            data[key].update(got)
            lo, hi = (min(got), max(got)) if got else ("", "")
            print(f"{key}: 今回 {len(got)} 件({lo}〜{hi})、合わせて {len(data[key])} 件(新しく {len(data[key]) - before} 件)")
            ok += bool(got)
        except Exception as e:  # noqa: BLE001
            print(f"{key}: 失敗 {e}", file=sys.stderr)
    if args.check:
        return 0 if ok else 1
    if not ok:
        print("どれも取れなかったので書きません", file=sys.stderr)
        return 1
    out = {
        "updated": datetime.now(JST).isoformat(timespec="minutes"),
        "units": {
            "margin": "週(申込日): [売残 株数(千株), 売残 金額(百万円), 買残 株数, 買残 金額] 合計",
            "arbitrage": "日: [売りポジション 合計(千株), 買いポジション 合計(千株)]",
            "futures": "週: 商品コード→投資部門コード→[売 数量, 買 数量, 売 金額(円), 買 金額(円)]",
            "vi": "日: 日経平均VI 終値",
            "pcr": "日: 日経225オプション [プット取引高, コール取引高, プット建玉, コール建玉, 出所 m=月間統計資料 d=建玉残高状況(概算)]",
            "pcr_m": "月: 日経225オプション [プット取引高, コール取引高]",
        },
    }
    for k in KEYS:
        out[k] = dict(sorted(data[k].items()))
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{OUT.name} を書きました({OUT.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
