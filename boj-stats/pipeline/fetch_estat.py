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
財務省 貿易統計 貿易概況（CSV、直近約25か月）: series.json で "trade" を指定した TRADE_* 系列
  （州別の総額、地域(国)別、主要商品別の輸出・輸入。億円の原数値か前年同月比）。速報→確報の改定は毎月のファイルで上書きされる。
  品目や国を足すときは series.json に1件追加するだけでよい（見出しは表の英語表記: 例 "MOTOR VEHICLES", "USA"）
ファイルの統計表IDは一覧ページから毎回探す（更新時に変わっても追随するため）。
Excel は標準ライブラリだけで読む（xlsx.py）。
"""
import csv, datetime as dt, html, io, json, os, re, time, urllib.error, urllib.request
from fetch import ROOT, RAW, load_series, csv_path, read_csv, write_csv, load_summary, save_summary, guarded
import xlsx

ESTAT = "https://www.e-stat.go.jp"
LFS_LIST = ESTAT + "/stat-search/files?tclass=000001226526&cycle=0"
LFS_TABLE = "表番号 1-a-1"
LFS_COLUMNS = {"LFS_EMPLOYED": 7, "LFS_UNEMP_RATE": 19}  # 表の列位置（就業者 男女計、完全失業率 男女計）


def get(url, tries=3):
    req = urllib.request.Request(url, headers={"User-Agent": "boj-stats-collector/1.0"})
    for n in range(tries):  # 貿易統計の初回取り込みは数百ファイルになるので、一時的な切断は再試行する
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read()
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            if n == tries - 1:
                raise
            time.sleep(5 * (n + 1))


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


TRADE_BASE = ESTAT + "/stat-search/files?page=1&layout=datalist&cycle=1&toukei=00350300&tstat=000001013137&"
# 貿易概況の時系列表（年ごとの一覧 → その年の最新月のファイル。ファイルには直近約25か月、単位千円）
TRADE_TABLES = {
    "area": ("tclass1=000001013253&tclass2val=0", "州別輸出入時系列表"),
    "country": ("tclass1=000001013254&tclass2val=0", "地域(国)別輸出入時系列表"),  # 地域ごとに複数ファイル
    "goods_ex": ("tclass1=000001013256&tclass2=000001013257&tclass3val=0", "主要商品別"),
    "goods_im": ("tclass1=000001013256&tclass2=000001013258&tclass3val=0", "主要商品別"),
}
MONTH_ABBR = {m: i for i, m in enumerate(("Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"), 1)}


def _trade_files(table, first):
    """表の CSV を古い順に返す。普段は最新年だけ、初回は2009年以降の全年。"""
    query, _ = TRADE_TABLES[table]
    page = get(TRADE_BASE + query).decode("utf-8", "replace")
    years = sorted(set(re.findall(r"year=(\d{4})0&(?:amp;)?month=(\d{8})", page)))
    if not years:
        raise RuntimeError(f"貿易統計 {table} の年一覧が見つからない")
    for y, m in (years if first else years[-1:]):
        page = get(f"{TRADE_BASE}{query}&year={y}0&month={m}").decode("utf-8", "replace")
        ids = dict.fromkeys(re.findall(r"file-download\?statInfId=(\d+)&(?:amp;)?fileKind=1", page))
        for uid in ids:
            yield get(f"{ESTAT}/stat-search/file-download?statInfId={uid}&fileKind=1")


def _trade_parse(body, table):
    """{(品目・地域名, "EX"/"IM"): {YYYY-MM: 千円}}"""
    rows = list(csv.reader(io.StringIO(body.decode("utf-8-sig", "replace"))))
    head, sub = rows[0], rows[1]
    cols = {}
    if table in ("area", "country"):  # 名前の列が輸出、次の列が輸入
        for i, name in enumerate(head):
            if name.strip() and i + 1 < len(sub) and sub[i].strip() == "Exports":
                cols[(name.strip(), "EX")] = i
                cols[(name.strip(), "IM")] = i + 1
    else:  # 名前の列が金額（次の列は数量）
        side = "EX" if table == "goods_ex" else "IM"
        for i, name in enumerate(head[2:], 2):
            if name.strip() and sub[i].strip() == "Value":
                cols[(name.strip(), side)] = i
    out = {k: {} for k in cols}
    for r in rows[2:]:
        cell = next((c.strip() for c in r[:2] if re.fullmatch(r"\d{4} [A-Z][a-z]{2}\.", c.strip())), None)
        if not cell:
            continue
        d = f"{cell[:4]}-{MONTH_ABBR[cell[5:8]]:02d}"
        for k, i in cols.items():
            if i < len(r) and r[i].strip().isdigit():
                out[k][d] = int(r[i])
    return out


# 品別国別表（HS 9桁 × 国、年ごと・部ごとのファイル。1ファイル数MB）
HS_TABLES = {"hs_ex": "tstat=000001013141&tclass1=000001013180&tclass2=000001013181&tclass3val=0",
             "hs_im": "tstat=000001013141&tclass1=000001013180&tclass2=000001013182&tclass3val=0"}
HS_FIRST_YEAR = 2016


def _hs_values(table, prefixes, first, qty=None):
    """prefixes: [HS の接頭辞のタプル] → {接頭辞: {国コード: {YYYY-MM: 千円}}}。国コード "ALL" は全世界の合計。
    表に品目がある年の公表済みの月は "ALL" に必ず入る（国の値が無い月は0）。
    普段は直近2年（前年同月比のため）、初回は HS_FIRST_YEAR 以降。
    qty に dict を渡すと数量も {接頭辞: {"units": [(単位1, 単位2)...], "q": [{国: {月: 数量1}}, {国: {月: 数量2}}]}} で入れる。"""
    base = TRADE_BASE.replace("tstat=000001013137&", "") + HS_TABLES[table]
    page = get(base).decode("utf-8", "replace")
    years = sorted(set(re.findall(r"year=(\d{4})0&(?:amp;)?month=(\d{8})", page)))
    years = [ym for ym in years if int(ym[0]) >= HS_FIRST_YEAR] if first else years[-2:]
    chapters = {p[:2] for hs in prefixes for p in hs}
    out = {hs: {} for hs in prefixes}
    for y, m in years:
        last = int(m[-2:])  # その年の公表済みの月
        page = get(f"{base}&year={y}0&month={m}").decode("utf-8", "replace")
        for mm in re.finditer(r"file-download\?statInfId=(\d+)&(?:amp;)?fileKind=1", page):
            text = html.unescape(re.sub(r"<[^>]+>", " ", page[max(0, mm.start() - 600):mm.start()]))
            rng = re.findall(r"(\d\d)(?:-(\d\d))?類", text)
            if not rng:
                continue
            lo, hi = rng[-1][0], rng[-1][1] or rng[-1][0]
            if not any(lo <= c <= hi for c in chapters):
                continue
            body = get(f"{ESTAT}/stat-search/file-download?statInfId={mm.group(1)}&fileKind=1")
            rows = csv.reader(io.StringIO(body.decode("utf-8-sig", "replace")))
            head = next(rows)
            vcol = [i for i, h in enumerate(head) if h.startswith("Value-") and h != "Value-Year"][:last]  # 年により Apr が Apl
            sums, qsums = {}, {}
            for r in rows:
                code = r[2].strip("' ")
                for hs in prefixes:
                    if code.startswith(hs):  # その年の表にこの品目がある（無い年は0で埋めない）
                        by = sums.setdefault(hs, {})
                        qby = qsums.setdefault(hs, ({}, {}))
                        if qty is not None:
                            qty.setdefault(hs, {"units": set(), "q": ({}, {})})["units"].add((r[4].strip(), r[5].strip()))
                        for c in (r[3].strip(), "ALL"):
                            arr = by.setdefault(c, [0] * last)
                            q1, q2 = (qb.setdefault(c, [0] * last) for qb in qby)
                            for k, i in enumerate(vcol):  # 数量1・数量2 は金額の2列・1列前
                                arr[k] += int(r[i] or 0)
                                q1[k] += int(r[i - 2] or 0)
                                q2[k] += int(r[i - 1] or 0)
            for hs, by in sums.items():
                for c, arr in by.items():
                    dst = out[hs].setdefault(c, {})
                    for k, v in enumerate(arr):
                        dst[f"{y}-{k + 1:02d}"] = v
                if qty is not None:
                    for qb, qd in zip(qsums[hs], qty[hs]["q"]):
                        for c, arr in qb.items():
                            dst = qd.setdefault(c, {})
                            for k, v in enumerate(arr):
                                dst[f"{y}-{k + 1:02d}"] = v
    return out


COUNTRY_JA = {
    "103": "韓国", "105": "中国", "106": "台湾", "107": "モンゴル", "108": "香港", "110": "ベトナム", "111": "タイ",
    "112": "シンガポール", "113": "マレーシア", "116": "ブルネイ", "117": "フィリピン", "118": "インドネシア",
    "120": "カンボジア", "121": "ラオス", "122": "ミャンマー", "123": "インド", "124": "パキスタン", "125": "スリランカ",
    "127": "バングラデシュ", "129": "マカオ", "133": "イラン", "134": "イラク", "137": "サウジアラビア", "138": "クウェート",
    "140": "カタール", "141": "オマーン", "143": "イスラエル", "147": "アラブ首長国連邦", "153": "カザフスタン",
    "202": "ノルウェー", "203": "スウェーデン", "204": "デンマーク", "205": "英国", "206": "アイルランド", "207": "オランダ",
    "208": "ベルギー", "209": "ルクセンブルク", "210": "フランス", "213": "ドイツ", "215": "スイス", "217": "ポルトガル",
    "218": "スペイン", "220": "イタリア", "221": "マルタ", "222": "フィンランド", "223": "ポーランド", "224": "ロシア",
    "225": "オーストリア", "227": "ハンガリー", "230": "ギリシャ", "231": "ルーマニア", "234": "トルコ", "238": "ウクライナ",
    "245": "チェコ", "246": "スロバキア", "302": "カナダ", "304": "米国", "305": "メキシコ", "312": "パナマ",
    "324": "プエルトリコ", "401": "コロンビア", "407": "ペルー", "409": "チリ", "410": "ブラジル", "413": "アルゼンチン",
    "501": "モロッコ", "506": "エジプト", "524": "ナイジェリア", "541": "ケニア", "551": "南アフリカ",
    "601": "オーストラリア", "606": "ニュージーランド",
}  # 番号は税関の国名コード（2025年の国別表の合計と照合して確認）。無い国はコードのまま出す
BY_COUNTRY = os.path.join(os.path.dirname(csv_path("ESTAT", "x")), "trade_by_country.json")


QTY_UNITS = {"NO": ("個", 1), "TH": ("個", 1000), "KG": ("kg", 1)}  # 税関の単位 → (表示の単位, 倍率)


def _qty_unit(q):
    """品目のすべての HS コード・年で同じ単位の数量列を選ぶ → (列 0|1, 単位, 倍率)。揃わなければ None"""
    if not q:
        return None
    for col in (0, 1):
        units = {u[col] for u in q["units"]}
        if len(units) == 1 and (u := units.pop()) in QTY_UNITS:
            return (col,) + QTY_UNITS[u]
    return None


def _merge_months(prev, data, fetched, conv):
    """国→月→値の蓄積に取り直した月を入れ直す（改定で0になった国を残さないよう、一度消してから入れる）"""
    out = {c: dict(v) for c, v in prev.items()}
    for c in out:
        for d in fetched:
            out[c].pop(d, None)
    for c, vals in data.items():
        for d, v in vals.items():
            if v:
                out.setdefault(c, {})[d] = conv(v)
    return {c: dict(sorted(v.items())) for c, v in sorted(out.items()) if v}


def _by_country_needs_qty():
    """数量を入れる前の trade_by_country.json なら、数量を過去分まで取り直す"""
    if not os.path.exists(BY_COUNTRY):
        return True
    return any("qty_unit" not in it for it in json.load(open(BY_COUNTRY, encoding="utf-8")).get("items", []))


def _write_by_country(items, raw, qraw, refetched=False):
    """series.json の trade_by_country の品目ごとに、全輸出先の月次輸出額（億円）と数量を JSON に蓄積する。
    数量は品目の HS コードの単位が揃うときだけ（集積回路計のように個とkgが混ざる品目は入れない）。"""
    old = json.load(open(BY_COUNTRY, encoding="utf-8")) if os.path.exists(BY_COUNTRY) else {}
    res = {"_note": "財務省 貿易統計 品別国別表（輸出、億円）。countries[国コード] は月→値（0の月は省略）。ALL は全世界。"
                    "qty は同じ形の数量（単位 qty_unit、千個は個に換算）。単価は 金額÷数量",
           "names": COUNTRY_JA, "items": []}
    olditems = {it["key"]: it for it in old.get("items", [])}
    for it in items:
        data = raw.get(tuple(it["hs"]), {})
        prev = olditems.get(it["key"], {})
        months = sorted(set(prev.get("months", [])) | set(data.get("ALL", {})))
        fetched = set(data.get("ALL", {}))
        row = {"key": it["key"], "name": it["name"], "short": it.get("short", it["name"]), "hs": it["hs"], "months": months,
               "countries": _merge_months(prev.get("countries", {}), data, fetched, lambda v: round(v / 1e5, 1))}
        q = qraw.get(tuple(it["hs"]))
        unit = _qty_unit(q)
        if unit and (refetched or prev.get("qty_unit") == unit[1]):
            col, name, mult = unit
            row["qty_unit"] = name
            row["qty"] = _merge_months(prev.get("qty", {}) if not refetched else {}, q["q"][col], fetched, lambda v: v * mult)
        elif unit is None and (refetched or "qty_unit" in prev):
            row["qty_unit"] = None  # 単位が揃わない（取り直し済みの印として None を残す）
        elif "qty_unit" in prev:
            row["qty_unit"], row["qty"] = prev["qty_unit"], prev.get("qty", {})
        res["items"].append(row)
    with open(BY_COUNTRY, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, separators=(",", ":"))

# 国別概況品別表（国 × 概況品、年ごとに1ファイル約3MB）。概況品コード → 品目名は2025年の主要商品別表の金額と照合して確認
GOODS_COUNTRY = "tstat=000001013141&tclass1=000001013198&tclass2=000001013199&tclass3val=0"
GOODS_JA = {
    "3": "鉱物性燃料", "50101": "有機化合物", "507": "医薬品", "515": "プラスチック", "603": "ゴム製品", "606": "紙類・同製品",
    "607": "織物用糸・繊維製品", "609": "非金属鉱物製品", "611": "鉄鋼", "613": "非鉄金属", "615": "金属製品",
    "70101": "原動機", "70107": "金属加工機械", "70109": "繊維機械", "70119": "建設用・鉱山用機械",
    "70123": "加熱用・冷却用機器", "70125": "ポンプ・遠心分離機", "70127": "荷役機械", "70129": "ベアリング",
    "70131": "半導体等製造装置", "7010505": "電算機類（本体）", "7010507": "電算機類の部分品",
    "70301": "重電機器", "70303": "電気回路等の機器", "70313": "音響・映像機器の部分品", "70315": "通信機",
    "70319": "電池", "70323": "半導体等電子部品", "70327": "電気計測機器", "7030903": "映像記録・再生機器",
    "70503": "自動車", "70505": "自動車の部分品", "7050701": "二輪自動車", "70511": "航空機類", "7051301": "船舶",
    "81101": "科学光学機器", "81301": "写真用・映画用材料",
}
GOODS_BY_COUNTRY = os.path.join(os.path.dirname(csv_path("ESTAT", "x")), "trade_goods_by_country.json")


def trade_goods(countries):
    """国ごとに主な品目（GOODS_JA）の月次輸出額（億円）を trade_goods_by_country.json に蓄積する。
    初回は HS_FIRST_YEAR 以降、普段は直近2年。"""
    first = not os.path.exists(GOODS_BY_COUNTRY)
    base = TRADE_BASE.replace("tstat=000001013137&", "") + GOODS_COUNTRY
    page = get(base).decode("utf-8", "replace")
    years = sorted(set(re.findall(r"year=(\d{4})0&(?:amp;)?month=(\d{8})", page)))
    years = [ym for ym in years if int(ym[0]) >= HS_FIRST_YEAR] if first else years[-2:]
    old = {} if first else json.load(open(GOODS_BY_COUNTRY, encoding="utf-8"))
    data = {c: {g: dict(v) for g, v in old.get("countries", {}).get(c, {}).items()} for c in countries}
    months = set(old.get("months", []))
    for y, m in years:
        last = int(m[-2:])
        page = get(f"{base}&year={y}0&month={m}").decode("utf-8", "replace")
        uid = re.search(r"file-download\?statInfId=(\d+)&(?:amp;)?fileKind=1", page)
        if not uid:
            continue
        rows = csv.reader(io.StringIO(get(f"{ESTAT}/stat-search/file-download?statInfId={uid.group(1)}&fileKind=1")
                                      .decode("utf-8-sig", "replace")))
        head = next(rows)
        vcol = [i for i, h in enumerate(head) if h.startswith("Value-") and h != "Value-Year"][:last]
        ms = [f"{y}-{k + 1:02d}" for k in range(last)]
        months |= set(ms)
        for c in countries:  # 取り直す月は消してから入れ直す
            for g in data[c].values():
                for d in ms:
                    g.pop(d, None)
        for r in rows:
            c, g = r[3].strip(), r[2].strip("' ")
            if c in data and g in GOODS_JA:
                for d, i in zip(ms, vcol):
                    v = int(r[i] or 0)
                    if v:
                        data[c].setdefault(g, {})[d] = round(v / 1e5, 1)
    res = {"_note": "財務省 貿易統計 国別概況品別表（輸出、億円、0の月は省略）。countries[国コード][概況品コード][YYYY-MM]",
           "names": GOODS_JA, "country_names": {c: COUNTRY_JA.get(c, c) for c in countries},
           "months": sorted(months),
           "countries": {c: {g: dict(sorted(v.items())) for g, v in sorted(gs.items()) if v} for c, gs in data.items()}}
    with open(GOODS_BY_COUNTRY, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, separators=(",", ":"))


SIDE_ERRORS = []  # 系列の他に作るファイル（国別推移など）の失敗。main() が errors に移す


def trade(rawdir):
    """財務省 貿易統計（貿易概況）から series.json の "trade" 指定の系列を作る。

    trade = {"table": area|country|goods_ex|goods_im, "item": 表の見出し（英語のまま）,
             "side": EX|IM|BAL, "calc": value（億円）|yoy（前年同月比％）}
    品別国別表なら {"table": hs_ex|hs_im, "hs": [HSコードの接頭辞...], "country": 国コード（省略で全世界）,
                  "side": EX|IM, "calc": ...}。国コードは税関の3桁（台湾 106、中国 105、米国 304 など）
    """
    wanted = [s for s in load_series() if s["db"] == "ESTAT" and "trade" in s]
    tables = {}
    for s in wanted:
        t = s["trade"]["table"]
        tables[t] = tables.get(t, False) or not os.path.exists(csv_path("ESTAT", s["code"]))
    by_country = json.load(open(os.path.join(ROOT, "series.json"), encoding="utf-8")).get("trade_by_country", [])
    if by_country:
        tables["hs_ex"] = tables.get("hs_ex", False) or _by_country_needs_qty()
    raw = {}
    for table in [t for t in tables if t in HS_TABLES]:
        prefixes = {tuple(s["trade"]["hs"]) for s in wanted if s["trade"]["table"] == table}
        if table == "hs_ex":
            prefixes |= {tuple(it["hs"]) for it in by_country}
        first = tables.pop(table)
        qraw = {}
        hsv = _hs_values(table, sorted(prefixes), first, qraw if table == "hs_ex" else None)
        side = "EX" if table == "hs_ex" else "IM"
        for s in wanted:
            t = s["trade"]
            if t["table"] == table:
                by = hsv[tuple(t["hs"])]
                c = by.get(t.get("country") or "ALL", {})
                raw[(table, (tuple(t["hs"]), t.get("country")), side)] = {d: c.get(d, 0) for d in by.get("ALL", {})}
        if table == "hs_ex" and by_country:
            try:  # 国別推移の JSON が作れなくても、系列の取り込みは続ける
                _write_by_country(by_country, hsv, qraw, first)
            except Exception as e:
                SIDE_ERRORS.append(f"ESTAT 貿易統計（国別推移 trade_by_country.json）: {type(e).__name__}: {e}")
    for table, first in tables.items():
        for n, body in enumerate(_trade_files(table, first)):
            if table == "area":
                with open(os.path.join(rawdir, "trade_area.csv"), "wb") as f:
                    f.write(body)
            for k, v in _trade_parse(body, table).items():
                raw.setdefault((table,) + k, {}).update(v)  # 新しいファイルの値で上書き（改定の反映）
    out = {}
    for s in wanted:
        t = s["trade"]
        if t["side"] == "BAL":
            ex, im = raw.get((t["table"], t["item"], "EX"), {}), raw.get((t["table"], t["item"], "IM"), {})
            x = {d: ex[d] - im[d] for d in ex if d in im}
        elif t["table"] in HS_TABLES:
            x = raw.get((t["table"], (tuple(t["hs"]), t.get("country")), t["side"]), {})
        else:
            x = raw.get((t["table"], t["item"], t["side"]), {})
        if t.get("calc") == "yoy":
            out[s["code"]] = {d: str(round((v / x[p] - 1) * 100, 1) + 0.0) for d, v in x.items()
                              if (p := f"{int(d[:4]) - 1}{d[4:]}") in x and x[p] > 0}
        else:
            nd = 1 if t["table"] in HS_TABLES else None  # 細かい品目は小さいので 0.1億円まで
            out[s["code"]] = {d: str(round(v / 1e5, nd)) for d, v in x.items()}  # 千円 → 億円
    goods_countries = json.load(open(os.path.join(ROOT, "series.json"), encoding="utf-8")).get("trade_goods_countries", [])
    if goods_countries:
        try:  # 国別の品目内訳が作れなくても、系列の取り込みは続ける
            trade_goods(goods_countries)
        except Exception as e:
            SIDE_ERRORS.append(f"ESTAT 貿易統計（国別の品目内訳 trade_goods_by_country.json）: {type(e).__name__}: {e}")
    if wanted and not any(out.values()):
        raise RuntimeError("貿易統計の表に対象の品目・地域が見つからない")
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


# (エラーに付ける名前, 取得関数, その取得元の系列コードの接頭辞)。名前と接頭辞は status.py が失敗した系列を見分けるのにも使う
SOURCES = (("労働力調査", labour, ("LFS_",)),
           ("サービス産業動態統計", services, ("SVC_",)),
           ("人口推計", population, ("POP_",)),
           ("家計調査", kakei, ("KAKEI_",)),
           ("小売物価統計", kouri, ("KOURI_",)),
           ("住民基本台帳人口移動報告", idou, ("IDOU_",)),
           ("貿易統計", trade, ("TRADE_",)))


def main():
    series = [s for s in load_series() if s["db"] == "ESTAT"]
    today = dt.date.today().isoformat()
    rawdir = os.path.join(RAW, today)
    os.makedirs(rawdir, exist_ok=True)
    summary = load_summary()
    data, failed = {}, set()
    for name, fn, prefixes in SOURCES:
        try:
            data.update(fn(rawdir))
        except Exception as e:  # 1つ失敗しても他は続ける
            summary["errors"].append(f"ESTAT {name}: {type(e).__name__}: {e}")
            failed.update(prefixes)
    summary["errors"] += SIDE_ERRORS
    for s in series:
        if s["code"] not in data:
            # 取得元は成功したのにこの系列だけ値が無い（表の見出しが変わったなど）
            if not s["code"].startswith(tuple(failed)):
                summary["errors"].append(f"ESTAT/{s['code']}: データが返らなかった（表の見出しや形式が変わった可能性）")
            continue
        path = csv_path("ESTAT", s["code"])
        rows = read_csv(path)
        before = dict(rows)
        rows.update(data[s["code"]])
        write_csv(path, rows)
        new = set(rows) - set(before)
        revised = [k for k in before if rows.get(k) != before[k]]
        if new or revised:
            summary["updated"].append({"db": "ESTAT", "code": s["code"], "new": len(new),
                                       "revised": len(revised), "latest": max(rows)})
    save_summary(summary)
    return 0 if data else 1


if __name__ == "__main__":
    raise SystemExit(guarded("ESTAT", main))
