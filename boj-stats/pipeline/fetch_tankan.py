#!/usr/bin/env python3
"""日銀「短観（概要）」の zip（Excel）から判断DIなどを取り、data/tankan.json に蓄積する。

短観は四半期（3・6・9・12月調査、公表は4月初・7月初・10月初・12月中旬）。毎回の実行では
今の5年分の一覧ページ（https://www.boj.or.jp/statistics/tk/gaiyo/2026/index.htm など）だけを見て、
まだ取り込んでいない回の zip があれば取る。JSON が無いとき（初回）は zip のある 2021年3月調査以降をすべて取る。

取り込むもの（どれも「調査回 → 値」）:
- 業況判断DI（「良い」−「悪い」）: 業種別 × 規模（大企業・中堅企業・中小企業）と全規模合計、最近と先行き
- 需給・在庫・価格判断（大企業・中小企業）、生産・営業用設備判断、雇用人員判断、
  資金繰り・金融機関の貸出態度・借入金利水準判断、企業の物価見通し（販売価格・物価全般の 1/3/5年後）
各回の値はその回の公表値（前回分の改定は採らない）。2021年3月調査の zip に載る前回（2020年12月調査）だけは前回欄から入れる。
結果は last_fetch.json の errors に「TANKAN: …」で残る（fetch.py の後に実行する前提）。
"""
import datetime as dt, io, json, os, re, unicodedata, urllib.request, zipfile
import xlsx
from fetch import ROOT, RAW, load_summary, save_summary, guarded

BASE = "https://www.boj.or.jp"
OUT = os.path.join(ROOT, "data", "tankan.json")
SIZES = {"大企業": "大企業", "中堅企業": "中堅企業", "中小企業": "中小企業", "全規模合計": "全規模合計"}
UA = {"User-Agent": "boj-stats-collector/1.0"}


def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def index_urls(year):
    """5年ごとの一覧ページ（2001, 2006, …, 2026）の URL。year を含むページ"""
    return f"{BASE}/statistics/tk/gaiyo/{year - (year - 2001) % 5}/index.htm"


def zip_links(html):
    """一覧ページの zip → {"2026-09": URL}"""
    out = {}
    for path in re.findall(r'href="(/statistics/tk/gaiyo/\d{4}/tka(\d{2})(\d{2})\.zip)"', html):
        p, yy, mm = path
        out[f"20{yy}-{mm}"] = BASE + p
    return out


def clean(s):
    """空白を除き、全角の数字・括弧を半角にする（「１年後」→「1年後」）"""
    return re.sub(r"\s", "", unicodedata.normalize("NFKC", s or ""))


def num(s):
    s = (s or "").strip()
    if not s or s in ("―", "-", "－", "*", "x", "X"):
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    return round(v, 1) if v != int(v) else int(v)


def prev_survey(s):
    y, m = int(s[:4]), int(s[5:])
    m -= 3
    if m <= 0:
        y, m = y - 1, m + 12
    return f"{y}-{m:02d}"


def di_groups(row):
    """「最近」「先行き」の見出し行から、[(前回最近, 前回先行き, 今回最近, 今回先行き), …] の列番号を返す。
    1つの表は「前回 最近・先行き / 今回 最近・(変化幅)・先行き」で、今回の先行きが無い表（在庫・資金繰りなど）もある"""
    labs = [(j, clean(c)) for j, c in enumerate(row) if clean(c) in ("最近", "先行き")]
    groups, cur = [], []
    for j, c in labs:
        if c == "最近" and sum(1 for _, x in cur if x == "最近") == 2:
            groups.append(cur)
            cur = []
        cur.append((j, c))
    if cur:
        groups.append(cur)
    out = []
    for g in groups:
        rec = [j for j, c in g if c == "最近"]
        fc = [j for j, c in g if c == "先行き"]
        if len(rec) != 2:
            raise ValueError(f"最近・先行きの見出しが想定と違う: {g}")
        prev_f = next((j for j in fc if j < rec[1]), None)
        cur_f = next((j for j in fc if j > rec[1]), None)
        out.append((rec[0], prev_f, rec[1], cur_f))
    return out


class Store:
    def __init__(self, survey):
        self.survey, self.prev = survey, prev_survey(survey)
        self.rows = []  # (survey, item, size, industry, kind, value)

    def add(self, row, cols, item, size, industry):
        p_r, p_f, c_r, c_f = cols
        g = lambda j: num(row[j]) if j is not None and j < len(row) else None
        for s, kind, j in ((self.survey, "最近", c_r), (self.survey, "先行き", c_f),
                           (self.prev, "最近", p_r), (self.prev, "先行き", p_f)):
            v = g(j)
            if v is not None:
                self.rows.append((s, item, size, industry, kind, v))


def size_of(s):
    s = clean(s)
    return SIZES.get(s)


def parse_business(rows, st):
    """計表1 業況判断: 業種 × 大企業・中堅企業・中小企業、下に全規模合計（製造業・非製造業・全産業）"""
    h = next(i for i, r in enumerate(rows) if sum(clean(c) in ("最近", "先行き") for c in r) >= 8)
    groups = di_groups(rows[h])
    size_row = rows[h - 2]
    sizes = []
    for g in groups:
        name = next((size_of(size_row[j]) for j in range(g[0], min(g[0] + 6, len(size_row))) if size_of(size_row[j])), None)
        if not name:
            raise ValueError("業況判断の規模の見出しが見つからない")
        sizes.append(name)
    i = h + 1
    while i < len(rows):
        r = rows[i]
        ind = clean(r[0]) if r else ""
        if ind:
            for g, sz in zip(groups, sizes):
                st.add(r, g, "業況判断", sz, ind)
        i += 1
        if ind == "全産業":
            break
    # 全規模合計（「全 国 企 業」の見出しの下）
    for r in rows[i:]:
        ind = clean(r[0]) if r else ""
        if ind in ("製造業", "非製造業", "全産業"):
            st.add(r, groups[0], "業況判断", "全規模合計", ind)


ITEMS2 = [("国内での製商品・サービス需給判断", "国内需給"), ("海外での製商品需給判断", "海外需給"),
          ("製商品流通在庫水準判断", "流通在庫"), ("製商品在庫水準判断", "製品在庫"),
          ("販売価格判断", "販売価格"), ("仕入価格判断", "仕入価格")]


def item2(s):
    s = clean(s)
    for k, v in ITEMS2:
        if k in s:
            return v
    return None


def parse_supply(rows, st):
    """計表2 需給・在庫・価格判断: 左に大企業、右に中小企業。各判断は 製造業・うち素材・加工・(非製造業) の行のまとまり"""
    h = next(i for i, r in enumerate(rows) if i > 10 and sum(clean(c) in ("最近", "先行き") for c in r) >= 6)
    groups = di_groups(rows[h])
    size_row = rows[h - 2]
    for g in groups:
        sz = next((size_of(size_row[j]) for j in range(max(0, g[0] - 2), min(g[0] + 6, len(size_row))) if size_of(size_row[j])), None)
        if not sz:
            raise ValueError("需給・価格判断の規模の見出しが見つからない")
        # 判断名は、左隣の表の右端から業種名の列までのどこか
        prev_end = max((x[3] or x[2]) for x in groups if x[0] < g[0]) + 1 if any(x[0] < g[0] for x in groups) else 0
        # 業種名の列: 値の列の左2列（「製造業」「うち」と「素材業種」「加工業種」）
        c1, c2 = g[0] - 2, g[0] - 1
        block, blocks = [], []
        for r in rows[h + 1:]:
            lab1 = clean(r[c1]) if len(r) > c1 else ""
            lab2 = clean(r[c2]) if len(r) > c2 else ""
            if lab1 == "製造業":
                if block:
                    blocks.append(block)
                block = []
            if lab1 or lab2:
                block.append(r)
        if block:
            blocks.append(block)
        for b in blocks:
            name = next((item2(r[j]) for r in b for j in range(prev_end, c1) if j < len(r) and item2(r[j])), None)
            if not name:
                continue
            for r in b:
                lab1, lab2 = clean(r[c1]), clean(r[c2]) if len(r) > c2 else ""
                ind = lab2 if lab2 else lab1
                if ind in ("製造業", "非製造業", "素材業種", "加工業種"):
                    st.add(r, g, name, sz, ind)


def parse_triplets(rows, st, item, hrow, g, size_col, ind_col):
    """規模ごとに 製造業・非製造業・全産業 の3行が並ぶ表（規模名は真ん中の行）"""
    r0 = hrow + 1
    block = []
    for r in rows[r0:r0 + 20]:
        ind = clean(r[ind_col]) if len(r) > ind_col else ""
        if ind not in ("製造業", "非製造業", "全産業"):
            continue
        block.append(r)
        if ind == "全産業":
            sz = next((size_of(x[size_col]) for x in block if len(x) > size_col and size_of(x[size_col])), None)
            if not sz:
                raise ValueError(f"{item}の規模名が見つからない")
            for x in block:
                st.add(x, g, item, sz, clean(x[ind_col]))
            block = []
            if sz == "全規模合計":
                break


def find_title(rows, text, col_from=0):
    for i, r in enumerate(rows):
        for j, c in enumerate(r):
            if j >= col_from and text in clean(c):
                return i, j
    raise ValueError(f"「{text}」が見つからない")


def header_after(rows, i, col_lo, col_hi):
    for k in range(i, i + 6):
        r = rows[k]
        if any(clean(c) == "最近" for c in r[col_lo:col_hi]):
            return k
    raise ValueError("最近・先行きの見出しが見つからない")


def sub_groups(row, col_lo, col_hi):
    r = [c if col_lo <= j < col_hi else "" for j, c in enumerate(row)]
    return di_groups(r)


def parse_equipment(rows, st):
    """計表5 右側 生産・営業用設備判断"""
    i, j = find_title(rows, "生産・営業用設備判断")
    h = header_after(rows, i, j, j + 12)
    g = sub_groups(rows[h], j, j + 12)[0]
    parse_triplets(rows, st, "設備", h, g, j, j + 1)


def parse_employment(rows, st):
    """計表6 左側 雇用人員判断"""
    i, j = find_title(rows, "雇用人員判断")
    h = header_after(rows, i, 0, 10)
    g = sub_groups(rows[h], 0, 10)[0]
    parse_triplets(rows, st, "雇用人員", h, g, 1, 2)


def parse_finance(rows, st):
    """計表6 右側 資金繰り・貸出態度・借入金利水準判断（全産業、規模別と全規模の製造業・非製造業）"""
    for title, item in (("資金繰り判断", "資金繰り"), ("貸出態度判断", "貸出態度"), ("借入金利水準判断", "借入金利水準")):
        i, j = find_title(rows, title, 9)
        h = header_after(rows, i, j, j + 10)
        g = sub_groups(rows[h], j, j + 10)[0]
        lab = g[0] - 1
        n = 0
        for r in rows[h + 1:h + 12]:
            name = clean(r[lab]) if len(r) > lab else ""
            if name in SIZES:
                st.add(r, g, item, SIZES[name], "全産業")
                n += 1
            elif name in ("製造業", "非製造業"):
                st.add(r, g, item, "全規模合計", name)
                n += 1
            if n == 6:
                break
        if n < 4:
            raise ValueError(f"{title}の行が足りない")


def parse_prices(rows, st):
    """計表7 企業の物価見通し（見通しの平均、今回）: 販売価格・物価全般 × 1・3・5年後"""
    size = ind = hz = None
    cols = None
    for r in rows:
        cells = [clean(c) for c in r]
        if cols is None and any("販売価格の見通し" in c for c in cells):
            cols = (next(j for j, c in enumerate(cells) if "販売価格の見通し" in c),
                    next(j for j, c in enumerate(cells) if "物価全般の見通し" in c))
            continue
        if cols is None or len(cells) < 4:
            continue
        if cells[0]:
            size = SIZES.get(cells[0])
        if cells[1]:
            ind = cells[1]
        if cells[2]:
            hz = cells[2]
        if cells[3] != "今回" or not (size and ind and hz):
            continue
        for j, item in zip(cols, ("物価見通し 販売価格", "物価見通し 物価全般")):
            v = num(r[j]) if j < len(r) else None
            if v is not None:
                st.rows.append((st.survey, item, size, ind, hz, v))
        if size == "全規模合計" and hz == "5年後":
            break


def parse(book, survey):
    """GA_J1.xlsx → [(survey, item, size, industry, kind, value)]"""
    names = xlsx.sheet_names(book)
    sheet = {n: i for i, n in enumerate(names)}
    st = Store(survey)
    parse_business(xlsx.read_sheet(book, sheet["計表1"]), st)
    parse_supply(xlsx.read_sheet(book, sheet["計表2"]), st)
    parse_equipment(xlsx.read_sheet(book, sheet["計表5"]), st)
    s6 = xlsx.read_sheet(book, sheet["計表6"])
    parse_employment(s6, st)
    parse_finance(s6, st)
    parse_prices(xlsx.read_sheet(book, sheet["計表7"]), st)
    # 最低限の確認: 大企業製造業の業況判断（最近）が入っていること
    if not any(r[0] == survey and r[1:5] == ("業況判断", "大企業", "製造業", "最近") for r in st.rows):
        raise ValueError("業況判断（大企業・製造業）が読めない（形式が変わった可能性）")
    return st.rows


def merge(data, survey, rows, url):
    """今回の回の値を入れる。前回欄の値は、その回の zip が無い（まだ入っていない）ときだけ使う"""
    series = data.setdefault("series", {})
    have = set(data.get("surveys", []))
    for s, item, size, ind, kind, v in rows:
        if s != survey and s in have:
            continue
        key = f"{item}|{size}|{ind}"
        series.setdefault(key, {}).setdefault(kind, {})[s] = v
    data["sources"][survey] = url
    surveys = set(data.get("surveys", [])) | {survey}
    surveys |= {s for s, *_ in rows if s != survey and s not in have}
    data["surveys"] = sorted(surveys)


def main():
    summary = load_summary()
    today = dt.date.today()
    try:
        with open(OUT, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {"updated": None, "latest": None, "surveys": [], "sources": {}, "series": {}}
    first = not data["sources"]
    years = range(2021, today.year + 1, 5) if first else [today.year]
    rawdir = os.path.join(RAW, today.isoformat(), "tankan")
    added = []
    try:
        links = {}
        pages = {index_urls(y) for y in years} | {index_urls(today.year)}
        for url in sorted(pages):
            links.update(zip_links(get(url).decode("utf-8", "replace")))
        if not links:
            raise ValueError("一覧ページに zip が無い（形式が変わった可能性）")
        for survey in sorted(links):
            if survey in data["sources"]:
                continue
            body = get(links[survey])
            os.makedirs(rawdir, exist_ok=True)
            with open(os.path.join(rawdir, os.path.basename(links[survey])), "wb") as f:
                f.write(body)
            z = zipfile.ZipFile(io.BytesIO(body))
            name = next(n for n in z.namelist() if n.lower().endswith(".xlsx"))
            rows = parse(z.read(name), survey)
            merge(data, survey, rows, links[survey])
            added.append(survey)
            print(f"短観 {survey}: {len(rows)}件")
    except Exception as e:
        summary["errors"].append(f"TANKAN: 短観（概要） {type(e).__name__}: {e}")
        save_summary(summary)
        if not added:
            return 1
    if added:
        data["latest"] = max(data["sources"])
        data["updated"] = today.isoformat()
        tmp = OUT + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        os.replace(tmp, OUT)
        summary["updated"].append({"db": "TANKAN", "code": "gaiyo", "new": len(added), "revised": 0, "latest": data["latest"]})
        save_summary(summary)
    else:
        print(f"短観: 新しい回なし（最新 {data['latest']}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(guarded("TANKAN", main))
