#!/usr/bin/env python3
"""合成グラフ用に、日々の取り込みより前の過去分（1995年ごろ〜）を一度だけ埋める。

日々の取り込み（fetch*.py）は既存の CSV に値を足していく（rows.update）ので、ここで足した過去の行はそのまま残る。
既にある日付の値は書き換えない（最近の値は日々の取り込みの公表値を優先）。何度実行しても結果は同じ。

  python3 backfill_history.py            # 全部
  python3 backfill_history.py acm cpi    # 一部だけ（acm / cpi / trade / trade_total / hs）

- acm   … 営業毎旬報告は日銀サイトに2016年分からしかないため、日銀勘定の月末残高（時系列統計 BS01、月次）で
          それより前を補う。旬次の系列とは別の data/history/ACM_<CODE>.csv（日付は月末日）に置き、合成グラフだけが使う
- cpi   … 消費者物価 全国・東京都区部: 2020年基準の長期時系列（e-Stat、1970年〜の指数）から前年同月比を作る
- trade … 国・地域別の輸出入額: 税関「輸出入額の推移」の地域別・月別 CSV（1979年〜、千円）。前年同月比も作る
- trade_total … 輸出額・輸入額・差引（世界計）: 同じく世界・月別 CSV
- hs    … 台湾向けの品目（品別国別表、e-Stat 1988年〜）: 2015年までの年を読む。半導体等製造装置(8486)・
          メモリ(854232…)は HS2007 で新設された番号のため2007年から
BOJ 時系列統計 API の系列は series.json の "since" と fetch.py --backfill で取る（ここでは扱わない）。
"""
import calendar, csv, html, io, os, re, sys, time, urllib.request
from fetch import api, csv_path, read_csv, write_csv, load_series, DATA

START = 1995  # 表示したい最初の年（前年同月比のため指数・金額は前年から読む）
UA = {"User-Agent": "Mozilla/5.0"}


def get(url):
    for n in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                return r.read()
        except Exception:
            if n == 3:
                raise
            time.sleep(5 * (n + 1))


def fill(path, past, label):
    """past の日付のうち CSV に無いものだけ足す。"""
    rows = read_csv(path)
    add = {d: v for d, v in past.items() if d not in rows}
    rows.update(add)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    write_csv(path, rows)
    print(f"{label}: +{len(add)}行 {min(add) if add else ''}〜{max(add) if add else ''}")


def yoy(values, digits=1):
    """{YYYY-MM: 値} → {YYYY-MM: 前年同月比(%)}"""
    out = {}
    for d, v in values.items():
        p = f"{int(d[:4]) - 1}{d[4:]}"
        if p in values and values[p] > 0:
            out[d] = str(round((v / values[p] - 1) * 100, digits) + 0.0)
    return out


# ---- 日銀の B/S（月末） ----
# 営業毎旬報告の系列 → 日銀勘定（BS01）の系列。貸出支援基金は BS01 に無いので補わない
ACM_BS01 = {"TOTAL": "MABJMTA", "JGB": "MABJMA5", "TBILL": "MABJMA5A", "ETF": "MABJMA003", "REIT": "MABJMA004",
            "CORP_BOND": "MABJMA002", "LOANS": "MABJMA32", "FX": "MABJMA12", "BANKNOTES": "MABJML1",
            "CURRENT_DEP": "MABJML11", "OTHER_DEP": "MABJML4", "GOV_DEP": "MABJML3", "REPO": "MABJML8",
            "PROVISIONS": "MABJML7"}


def acm():
    res = api("getDataCode", db="BS01", code=",".join(ACM_BS01.values()), startDate=f"{START}01")
    if str(res.get("STATUS")) != "200":
        raise RuntimeError(f"BS01: {res.get('MESSAGE')}")
    by = {}
    for d in res.get("RESULTSET") or []:
        v = d["VALUES"]
        by[d["SERIES_CODE"]] = {str(k): x for k, x in zip(v["SURVEY_DATES"], v["VALUES"]) if x not in (None, "")}
    for code, bs in ACM_BS01.items():
        first = min(read_csv(csv_path("ACM", code)))  # 営業毎旬報告の最初の回（2016-01-10）
        past = {}
        for ym, x in by.get(bs, {}).items():
            y, m = int(ym[:4]), int(ym[4:6])
            d = f"{y}-{m:02d}-{calendar.monthrange(y, m)[1]:02d}"
            if d < first:
                past[d] = f"{float(x):.1f}"
        fill(os.path.join(DATA, "history", f"ACM_{code}.csv"), past, f"ACM_{code}（BS01 {bs}）")


# ---- 消費者物価 ----
CPI_LONG = "https://www.e-stat.go.jp/stat-search/file-download?statInfId={}&fileKind=1"
CPI_FILES = {"CPI": ("000032103842", "zmi2020s.csv"), "STAT": ("000032103981", "tmi2020s.csv")}  # 全国・東京都区部 月次
CPI_COLS = {"ALL": "総合", "CORE": "生鮮食品を除く総合", "CORECORE": "生鮮食品及びエネルギーを除く総合"}


def cpi():
    for db, (sid, name) in CPI_FILES.items():
        rows = list(csv.reader(io.StringIO(get(CPI_LONG.format(sid)).decode("cp932"))))
        head = rows[0]
        for key, col in CPI_COLS.items():
            i = head.index(col)
            idx = {f"{r[0][:4]}-{r[0][4:]}": float(r[i]) for r in rows
                   if r and re.fullmatch(r"\d{6}", r[0]) and len(r) > i and r[i] and int(r[0][:4]) >= START - 1}
            code = f"CPI_{key}_YOY" if db == "CPI" else f"CPI_TKY_{key}_YOY"
            path = csv_path(db, code)
            first = min(read_csv(path))
            fill(path, {d: v for d, v in yoy(idx).items() if d < first}, f"{db}_{code}（{name}）")


# ---- 国・地域別の輸出入（税関） ----
CUSTOMS = "https://www.customs.go.jp/toukei/suii/html/data/{}.csv"
# 系列コードの末尾 → (ファイル, 列の国コード。Total は地域の合計)
REGIONS = {"USA": ("d42ma003", "304"), "CHINA": ("d42ma001", "105"), "TAIWAN": ("d42ma001", "106"),
           "EU": ("d42ma010", "Total"), "ASEAN": ("d42ma012", "Total")}


def trade():
    files = {}
    for key, (fn, col) in REGIONS.items():
        if fn not in files:
            rows = list(csv.reader(io.StringIO(get(CUSTOMS.format(fn)).decode("cp932"))))
            files[fn] = rows
        rows = files[fn]
        head = rows[2]
        for side, pre in (("EX", "Exp"), ("IM", "Imp")):
            name = f"{pre}-{col}"
            if name not in head:
                continue  # 台湾は輸出だけ
            code = f"TRADE_{side}_{key}"
            if not os.path.exists(csv_path("ESTAT", code)):
                continue
            i = head.index(name)
            val = {}
            for r in rows[4:]:
                if r and re.fullmatch(r"\d{4}/\d\d", r[0]) and int(r[0][:4]) >= START - 1 and r[i].strip() not in ("", "0"):
                    val[r[0].replace("/", "-")] = int(r[i])
            path = csv_path("ESTAT", code)
            have = read_csv(path)
            first = min(have)
            fill(path, {d: str(round(v / 1e5)) for d, v in val.items() if d < first and d >= f"{START}-01"},
                 f"ESTAT_{code}（税関 {fn}）")
            # 前年同月比: 金額（足した過去分と既存の値）から、まだ無い月だけ
            allv = {d: float(v) for d, v in read_csv(path).items()}
            ypath = csv_path("ESTAT", code + "_YOY")
            if os.path.exists(ypath):
                yfirst = min(read_csv(ypath))
                fill(ypath, {d: v for d, v in yoy(allv).items() if d < yfirst}, f"ESTAT_{code}_YOY")


def trade_total():
    """輸出額・輸入額・差引（世界計）。税関の世界・月別"""
    rows = list(csv.reader(io.StringIO(get(CUSTOMS.format("d41ma")).decode("cp932"))))
    head = rows[2]
    val = {"EXPORTS": {}, "IMPORTS": {}}
    for r in rows[4:]:
        if r and re.fullmatch(r"\d{4}/\d\d", r[0]) and int(r[0][:4]) >= START - 1 and r[1].strip() not in ("", "0"):
            d = r[0].replace("/", "-")
            val["EXPORTS"][d] = int(r[head.index("Exp-Total")])
            val["IMPORTS"][d] = int(r[head.index("Imp-Total")])
    val["BALANCE"] = {d: v - val["IMPORTS"][d] for d, v in val["EXPORTS"].items() if d in val["IMPORTS"]}
    for key, x in val.items():
        code = f"TRADE_{key}"
        path = csv_path("ESTAT", code)
        first = min(read_csv(path))
        fill(path, {d: str(round(v / 1e5)) for d, v in x.items() if d < first and d >= f"{START}-01"}, f"ESTAT_{code}（税関 d41ma）")
        ypath = csv_path("ESTAT", code + "_YOY")
        if os.path.exists(ypath):
            allv = {d: float(v) for d, v in read_csv(path).items()}
            yfirst = min(read_csv(ypath))
            fill(ypath, {d: v for d, v in yoy(allv).items() if d < yfirst}, f"ESTAT_{code}_YOY")


# ---- 台湾向けの品目（品別国別表） ----
HS_LIST = ("https://www.e-stat.go.jp/stat-search/files?page=1&layout=datalist&cycle=1&toukei=00350300"
           "&tstat=000001013141&tclass1=000001013180&tclass2=000001013181&tclass3val=0")
HS_LAST_YEAR = 2015  # 日々の取り込みは2016年から


def _hs_files(y, month):
    """その年の輸出の表ファイル (statInfId, 項の範囲 lo, hi)。新しい年は類（84-85類）、古い年は項（8540-8548項）ごと"""
    p = get(f"{HS_LIST}&year={y}0&month={month}").decode("utf-8", "replace")
    out = []
    for mm in re.finditer(r"file-download\?statInfId=(\d+)&(?:amp;)?fileKind=1", p):
        text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", p[max(0, mm.start() - 600):mm.start()])))
        t = re.findall(r"品別国別表 \(輸出[^)]*\) \S+ (\d{2,4})(?:-(\d{2,4}))?(類|項)", text)
        if not t:
            continue
        lo, hi, kind = t[-1]
        hi = hi or lo
        if kind == "類":
            lo, hi = lo + "00", hi + "99"
        out.append((mm.group(1), lo, hi))
    return out


def hs():
    wanted = [s for s in load_series() if s["db"] == "ESTAT" and s.get("trade", {}).get("table") == "hs_ex"
              and s["trade"].get("calc") == "value"]
    heads = {s["trade"]["hs"][0][:4] for s in wanted}
    page = get(HS_LIST).decode("utf-8", "replace")
    years = sorted(set(re.findall(r"year=(\d{4})0&(?:amp;)?month=(\d{8})", page)))
    vals = {s["code"]: {} for s in wanted}
    for y, month in years:
        if not (START - 1 <= int(y) <= HS_LAST_YEAR):
            continue
        for sid, lo, hi in _hs_files(y, month):
            if not any(lo <= h <= hi for h in heads):
                continue
            body = get(f"https://www.e-stat.go.jp/stat-search/file-download?statInfId={sid}&fileKind=1")
            rows = csv.reader(io.StringIO(body.decode("utf-8-sig", "replace")))
            head = next(rows)
            vcol = [i for i, h in enumerate(head) if h.startswith("Value-") and h != "Value-Year"]
            seen = {}
            for r in rows:
                code = r[2].strip("' ")
                for s in wanted:
                    t = s["trade"]
                    if any(code.startswith(p) for p in t["hs"]):
                        seen[s["code"]] = True
                        if r[3].strip() != t["country"]:
                            continue
                        dst = vals[s["code"]]
                        for k, i in enumerate(vcol):
                            d = f"{y}-{k + 1:02d}"
                            dst[d] = dst.get(d, 0) + int(r[i] or 0)
            for c in seen:  # 表に品目がある年は、台湾向けが無い月を0で埋める
                for k in range(12):
                    vals[c].setdefault(f"{y}-{k + 1:02d}", 0)
            time.sleep(1)
        print(y, {c: sum(v for d, v in x.items() if d.startswith(y)) for c, x in vals.items()})
    for c, x in vals.items():
        path = csv_path("ESTAT", c)
        first = min(read_csv(path))
        fill(path, {d: str(round(v / 1e5, 1)) for d, v in x.items() if d < first and d >= f"{START}-01"}, f"ESTAT_{c}")
        allv = {d: float(v) for d, v in read_csv(path).items()}
        ypath = csv_path("ESTAT", c + "_YOY")
        if os.path.exists(ypath):
            yfirst = min(read_csv(ypath))
            fill(ypath, {d: v for d, v in yoy(allv).items() if d < yfirst}, f"ESTAT_{c}_YOY")


if __name__ == "__main__":
    jobs = {"acm": acm, "cpi": cpi, "trade": trade, "trade_total": trade_total, "hs": hs}
    for name in sys.argv[1:] or jobs:
        jobs[name]()
