#!/usr/bin/env python3
"""e-Stat（政府統計の総合窓口）のファイルから統計を取り込む。series.json の db が "ESTAT" の系列が対象。

労働力調査 長期時系列 表1-a-1（全国・月別・季節調整値）から
- LFS_UNEMP_RATE: 完全失業率（％、季節調整値、男女計）
- LFS_EMPLOYED: 就業者数（万人、季節調整値、男女計）
を取る。
サービス産業動態統計調査 時系列 第1表（売上高、前年同月比シート）から
- SVC_SALES_YOY / SVC_ICT_YOY / SVC_HOTEL_FOOD_YOY: サービス産業計・情報通信業・宿泊業飲食サービス業の売上高前年比（2014年〜）
人口推計（参考表 全国人口の推移）から
- POP_TOTAL: 総人口（各月1日、確定値。2016〜2023年は各年10月1日の値のみ）
- POP_NET_MIGRATION: 社会増減（入国者−出国者、月次）
家計調査 長期時系列 表1-1（二人以上の世帯）: KAKEI_CONS_REAL_YOY ほか実質前年比、KAKEI_CONS_AMOUNT 消費支出額
小売物価統計 第2表 東京都区部小売価格（直近13か月）: KOURI_TKY_RICE / EGG / GASOLINE
住民基本台帳人口移動報告 月報 表1: IDOU_TOKYO_AREA_NET / IDOU_TOKYO_NET 転入超過数
ファイルの統計表IDは一覧ページから毎回探す（更新時に変わっても追随するため）。
Excel は標準ライブラリだけで読む（xlsx.py）。
"""
import datetime as dt, html, json, os, re, urllib.request
from fetch import ROOT, RAW, load_series, csv_path, read_csv, write_csv
import xlsx

ESTAT = "https://www.e-stat.go.jp"
LFS_LIST = ESTAT + "/stat-search/files?tclass=000001226526&cycle=0"
LFS_TABLE = "表番号 1-a-1"
LFS_COLUMNS = {"LFS_EMPLOYED": 7, "LFS_UNEMP_RATE": 19}  # 表の列位置（就業者 男女計、完全失業率 男女計）


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "boj-stats-collector/1.0"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.read()


def find_file(list_url, table_label):
    page = get(list_url).decode("utf-8", "replace")
    for m in re.finditer(r"file-download\?statInfId=(\d+)&(?:amp;)?fileKind=(\d)", page):
        before = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", page[max(0, m.start() - 1500):m.start()])))
        # 表番号のある一覧はその後ろ、ない一覧（人口推計など）は直前の表題だけを見る
        seg = before[before.rfind("表番号"):] if "表番号" in before else before[-300:]
        if table_label in seg:
            return f"{ESTAT}/stat-search/file-download?statInfId={m.group(1)}&fileKind={m.group(2)}"
    raise RuntimeError(f"{table_label} のファイルが一覧に見つからない")


SVC_BASE = (ESTAT + "/stat-search/files?layout=datalist&cycle=1&toukei=00200546&tstat=000001217540"
            "&tclass1=000001227393&tclass2=000001227394&tclass3=000001227396&tclass4val=0")
SVC_COLUMNS = {"SVC_SALES_YOY": "サービス産業計", "SVC_ICT_YOY": "情報通信業", "SVC_HOTEL_FOOD_YOY": "宿泊業，飲食サービス業"}
MONTH_CODE = {1: "11010301", 2: "11010302", 3: "11010303", 4: "12040604", 5: "12040605", 6: "12040606",
              7: "23070907", 8: "23070908", 9: "23070909", 10: "24101210", 11: "24101211", 12: "24101212"}
POP_PAGE = "https://www.stat.go.jp/data/jinsui/new.html"


def services(rawdir):
    """最新月の時系列ファイル（直近4か月を新しい順に探す）から売上高前年比を取る。"""
    d = dt.date.today().replace(day=1)
    url = None
    for _ in range(4):
        d = (d - dt.timedelta(days=1)).replace(day=1)
        try:
            url = find_file(f"{SVC_BASE}&year={d.year}0&month={MONTH_CODE[d.month]}", "表番号 1 ＜時系列＞")
            break
        except RuntimeError:
            continue
    if not url:
        raise RuntimeError("サービス産業動態統計の時系列ファイルが見つからない")
    body = get(url)
    with open(os.path.join(rawdir, "mbss_ts1.xlsx"), "wb") as f:
        f.write(body)
    rows = xlsx.read_sheet(body, 1)  # 月次・前年同月比
    head = next(r for r in rows if "サービス産業計" in r)
    out = {}
    for code, name in SVC_COLUMNS.items():
        col = next(i for i, c in enumerate(head) if c.startswith(name))
        # B列が YYYYMM の行がデータ行
        out[code] = {f"{r[1].strip()[:4]}-{r[1].strip()[4:6]}": str(round(float(r[col]), 1))
                     for r in rows if len(r) > col and re.fullmatch(r"\d{6}", (r[1] or "").strip())
                     and r[col].strip() not in ("", "-", "…", "x", "X")}
    return out


def population(rawdir):
    page = get(POP_PAGE).decode("cp932", "replace")
    lid = re.search(r"lid=(\d+)", page).group(1)
    url = find_file(f"{ESTAT}/stat-search/files?page=1&layout=datalist&lid={lid}", "全国人口の推移")
    body = get(url)
    with open(os.path.join(rawdir, "jinsui_ref.xlsx"), "wb") as f:
        f.write(body)
    rows = xlsx.read_sheet(body, 0)
    total, mig, year = {}, {}, None
    for r in rows:
        if not r or not r[0]:
            continue
        y = re.match(r"(\d{4})年", r[0].strip())
        m = re.match(r"(\d{1,2})月", r[0].strip())
        if y:
            year = int(y.group(1))
            if len(r) > 3 and r[3]:  # 年の行は10月1日現在の人口
                total[f"{year}-10"] = r[3]
        elif m and year and len(r) > 3 and r[3]:
            key = f"{year}-{int(m.group(1)):02d}"
            total[key] = r[3]
            if len(r) > 12 and r[12]:
                mig[key] = r[12]
    return {"POP_TOTAL": total, "POP_NET_MIGRATION": mig}


KAKEI_LIST = (ESTAT + "/stat-search/files?page=1&layout=datalist&toukei=00200561&tstat=000000330001"
              "&cycle=0&tclass1=000001228280&tclass2val=0")
# 家計調査 長期時系列 表1-1（二人以上の世帯、月）の行名 → 系列コード
KAKEI_REAL = {"消費支出": "KAKEI_CONS_REAL_YOY", "財(商品)": "KAKEI_GOODS_REAL_YOY", "サービス": "KAKEI_SVC_REAL_YOY"}
KAKEI_AMOUNT = {"消費支出": "KAKEI_CONS_AMOUNT"}


def _kakei_csv(body, wanted):
    """表1-1 のCSV（cp932）。列6以降が2000年1月からの月で、年は1行目に1月の列だけ入っている。"""
    import csv, io
    rows = list(csv.reader(io.StringIO(body.decode("cp932"))))
    months, y = [], None
    for c in range(6, len(rows[3])):
        yy = re.match(r"(\d{4})年", rows[1][c] if c < len(rows[1]) else "")
        if yy:
            y = int(yy.group(1))
        mm = re.match(r"\s*(\d{1,2})月", rows[3][c])
        months.append((c, f"{y}-{int(mm.group(1)):02d}" if (y and mm) else None))
    out = {}
    for r in rows[4:]:
        if len(r) > 5 and r[5] in wanted and wanted[r[5]] not in out:
            out[wanted[r[5]]] = {k: r[c] for c, k in months if k and c < len(r) and r[c] not in ("", "-")}
    return out


def kakei(rawdir):
    out = {}
    for label, wanted, fn in (("実質増減率（2000年1月～）", KAKEI_REAL, "kakei_real.csv"),
                              ("支出金額（2000年1月～）", KAKEI_AMOUNT, "kakei_amount.csv")):
        body = get(find_file(KAKEI_LIST, label))
        with open(os.path.join(rawdir, fn), "wb") as f:
            f.write(body)
        out.update(_kakei_csv(body, wanted))
    return out


KOURI_LIST = ESTAT + "/stat-search/files?page=1&layout=dataset&toukei=00200571"
# 小売物価統計 第2表 主要品目の東京都区部小売価格（直近13か月）の銘柄符号 → 系列コード
KOURI_ITEMS = {"「1001": {"1001": "KOURI_TKY_RICE", "1341": "KOURI_TKY_EGG"},
               "「5011": {"7301": "KOURI_TKY_GASOLINE"}}


def kouri(rawdir):
    page = get(KOURI_LIST).decode("utf-8", "replace")
    titles = {}
    for blk in re.split(r'data-key="uid"', page)[1:]:
        uid = re.search(r'data-value="(\d+)"', blk).group(1)
        text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", blk)))
        titles.setdefault(uid, text[:300])
    out = {}
    for head, codes in KOURI_ITEMS.items():
        # 一覧は新しい順。最初に見つかった月のファイルを使う
        uid = next((u for u, t in titles.items() if "主要品目の東京都区部小売価格" in t and head in t), None)
        if not uid:
            raise RuntimeError(f"小売物価 東京都区部 {head}〜 のファイルが一覧に見つからない")
        body = get(f"{ESTAT}/stat-search/file-download?statInfId={uid}&fileKind=0")
        with open(os.path.join(rawdir, f"kouri_{head[1:]}.xlsx"), "wb") as f:
            f.write(body)
        rows = xlsx.read_sheet(body, 0)
        ci = next(i for i, r in enumerate(rows) if any(c.startswith("銘柄符号") for c in r))
        for j, c in enumerate(rows[ci]):
            if c in codes:
                out[codes[c]] = {f"{r[1].strip()[:4]}-{r[1].strip()[4:6]}": r[j] for r in rows[ci + 1:]
                                 if len(r) > j and re.fullmatch(r"\d{7}", r[1].strip()) and re.fullmatch(r"\d+", r[j].strip())}
    return out


IDOU_LIST = ESTAT + "/stat-search/files?layout=dataset&toukei=00200523&page="
IDOU_AREAS = {"東京圏": "IDOU_TOKYO_AREA_NET", "東京都": "IDOU_TOKYO_NET"}  # 転入超過数（総数、移動者）


def idou(rawdir):
    """住民基本台帳人口移動報告 月報 表1（1か月分ずつのファイル）。初回だけ一覧をさかのぼって過去約1年分を集める。"""
    first = not os.path.exists(csv_path("ESTAT", "IDOU_TOKYO_AREA_NET"))
    out = {c: {} for c in IDOU_AREAS.values()}
    for page_no in range(1, 16 if first else 2):
        page = get(IDOU_LIST + str(page_no)).decode("utf-8", "replace")
        for blk in re.split(r'data-key="uid"', page)[1:]:
            uid = re.search(r'data-value="(\d+)"', blk).group(1)
            text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", blk)))[:250]
            if not re.search(r"> 1 男女別都道府県内移動者数", text) or "月報" not in text:
                continue
            body = get(f"{ESTAT}/stat-search/file-download?statInfId={uid}&fileKind=0")
            for r in xlsx.read_sheet(body, 0):
                if len(r) > 15 and r[1] == "移動者" and r[5] in IDOU_AREAS and re.fullmatch(r"\d{10}", r[2]):
                    out[IDOU_AREAS[r[5]]][f"{r[2][:4]}-{r[2][-2:]}"] = r[15]
        if first and len(out["IDOU_TOKYO_AREA_NET"]) >= 13:
            break
    if not out["IDOU_TOKYO_AREA_NET"]:
        raise RuntimeError("住民基本台帳人口移動報告 表1 が一覧に見つからない")
    return out


def labour(rawdir):
    body = get(find_file(LFS_LIST, LFS_TABLE))
    with open(os.path.join(rawdir, "lfs_1-a-1.xlsx"), "wb") as f:
        f.write(body)
    rows = xlsx.read_sheet(body, 0)  # 季節調整値シート
    out = {k: {} for k in LFS_COLUMNS}
    y, m = 1953, 0
    for r in rows[10:]:
        if len(r) < 2 or not re.match(r"\d+月", r[1] or ""):
            continue
        m += 1
        if m > 12:
            y, m = y + 1, 1
        # 年の表記（西暦の列）がある行で位置合わせを確認する
        if len(r) > 0 and re.fullmatch(r"\d{4}", r[0] or "") and int(r[0]) != y:
            raise RuntimeError(f"年の位置がずれている: {r[0]} != {y}")
        for code, col in LFS_COLUMNS.items():
            if len(r) > col and r[col] not in ("", None):
                out[code][f"{y}-{m:02d}"] = str(round(float(r[col]), 1))
    return out


def main():
    series = [s for s in load_series() if s["db"] == "ESTAT"]
    today = dt.date.today().isoformat()
    rawdir = os.path.join(RAW, today)
    os.makedirs(rawdir, exist_ok=True)
    lf = os.path.join(ROOT, "last_fetch.json")
    summary = json.load(open(lf, encoding="utf-8")) if os.path.exists(lf) else {"date": today, "updated": [], "errors": []}
    data = {}
    for name, fn in (("労働力調査", labour), ("サービス産業動態統計", services), ("人口推計", population),
                     ("家計調査", kakei), ("小売物価統計", kouri),
                     ("住民基本台帳人口移動報告", idou)):
        try:
            data.update(fn(rawdir))
        except Exception as e:  # 1つ失敗しても他は続ける
            summary["errors"].append(f"ESTAT {name}: {type(e).__name__}: {e}")
    if data:
        for s in series:
            path = csv_path("ESTAT", s["code"])
            rows = read_csv(path)
            before = dict(rows)
            if s["code"] not in data:
                continue
            rows.update(data[s["code"]])
            write_csv(path, rows)
            new = set(rows) - set(before)
            revised = [k for k in before if rows.get(k) != before[k]]
            if new or revised:
                summary["updated"].append({"db": "ESTAT", "code": s["code"], "new": len(new),
                                           "revised": len(revised), "latest": max(rows)})
    with open(lf, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    return 0 if data else 1


if __name__ == "__main__":
    raise SystemExit(main())
