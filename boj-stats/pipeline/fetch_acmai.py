#!/usr/bin/env python3
"""日銀「営業毎旬報告」（日銀の貸借対照表、毎月10日・20日・月末現在、旬末の2営業日後ごろ公表）を取り込む。

日銀の時系列統計APIには旬次が無い（BS01 は月末のみ）ため、公表ページ
https://www.boj.or.jp/statistics/boj/other/acmai/release/<年>/acYYMMDD.htm の HTML 表を読む。2016年1月10日現在〜。
- data/BOJ_ACMAI.csv … 全項目の縦持ち（date, table, item, value 億円）。表の項目は年によって増減する。これが蓄積で、
  ここに無い回だけ公表ページを読む（取得した HTML は raw/acmai/ にも残す）。公表後の訂正を入れ直すときは該当日の行を消す
- data/ACM_<CODE>.csv … series.json の db "ACM" の系列（ITEMS の対応）。analyze.py・status.py はこれを見る
単位は公表値の千円を億円に換算（÷100,000、小数1桁）。
"""
import csv, datetime as dt, html, os, re, sys, time, urllib.request
from fetch import load_series, csv_path, read_csv, write_csv, load_summary, save_summary, guarded

BASE = "https://www.boj.or.jp/statistics/boj/other/acmai/release/"
D = os.path.dirname(os.path.abspath(__file__))
RAWDIR = os.path.join(D, "raw", "acmai")
OUT = os.path.join(D, "data", "BOJ_ACMAI.csv")
UA = {"User-Agent": "Mozilla/5.0"}
FIRST_YEAR = 2016

TABLES = {"資産": "資産", "負債および純資産": "負債・純資産", "資産項目中の「国債」の内訳": "国債内訳",
          "「貸出支援基金」の内訳": "貸出支援基金", "別表3": "別表3"}
BETSU3 = "共通担保オペ等による貸付金"  # 別表3 の長い見出し（対象オペの列挙が年ごとに変わる）をまとめる名前

# series.json の ACM 系列のコード → (表, 項目)。計算で作る系列は関数
ITEMS = {
    "TOTAL": ("資産", "合計"),
    "JGB": ("資産", "国債"),
    "JGB_LONG": ("国債内訳", "長期国債"),
    "TBILL": ("国債内訳", "国庫短期証券"),
    "ETF": ("資産", "金銭の信託（信託財産指数連動型上場投資信託）"),
    "REIT": ("資産", "金銭の信託（信託財産不動産投資信託）"),
    "CORP_BOND": ("資産", "社債"),
    "CP": ("資産", "コマーシャル・ペーパー等"),
    "LOANS": ("資産", "貸付金"),
    "LSF": ("貸出支援基金", "合計"),
    "FX": ("資産", "外国為替"),
    "BANKNOTES": ("負債・純資産", "発行銀行券"),
    "CURRENT_DEP": ("負債・純資産", "当座預金"),
    "OTHER_DEP": ("負債・純資産", "その他預金"),
    "GOV_DEP": ("負債・純資産", "政府預金"),
    "REPO": ("負債・純資産", "売現先勘定"),
    "PROVISIONS": ("負債・純資産", "引当金勘定"),
}


def get(url):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return r.read()
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 ** (attempt + 1))


def clean(s):
    return re.sub(r"\s+", "", html.unescape(re.sub(r"<sup>.*?</sup>|<[^>]+>", "", s, flags=re.S)))


def parse(text):
    """1回分の HTML → [(表, 項目, 千円)]。"""
    out = []
    for cap, body in re.findall(r"<caption[^>]*>(.*?)</caption>(.*?)</table>", text, re.S):
        m = re.search(r"<span[^>]*>(.*?)</span>", cap, re.S)  # 年度末の回の「前年比増減とその背景」の表は span が無い
        table = TABLES.get(clean(m.group(1))) if m else None
        if table is None:
            continue
        for th, td in re.findall(r"<th[^>]*>(.*?)</th>\s*<td[^>]*>(.*?)</td>", body, re.S):
            item, v = clean(th), clean(td).replace(",", "")
            if table == "別表3":
                item = BETSU3
            if re.fullmatch(r"-?\d+", v):
                out.append((table, item, int(v)))
    if not any(t == "資産" and i == "合計" for t, i, _ in out):
        raise RuntimeError("資産の合計が見つからない（ページの形式が変わった可能性）")
    return out


def date_of(fn):
    m = re.match(r"ac(\d\d)(\d\d)(\d\d)\.htm$", fn)
    return f"20{m.group(1)}-{m.group(2)}-{m.group(3)}"


def load_long():
    """蓄積済みの縦持ち CSV → {日付: [(表, 項目, 億円)]}。"""
    out = {}
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as f:
            for r in csv.DictReader(f):
                out.setdefault(r["date"], []).append((r["table"], r["item"], float(r["value"])))
    return out


def page(y, fn):
    """1回分の HTML。raw/acmai/ にあればそれを、無ければ取得して保存する（portal では raw/ を持たない）。"""
    p = os.path.join(RAWDIR, fn)
    if os.path.exists(p):
        with open(p, "rb") as f:
            return f.read().decode("utf-8", "replace")
    body = get(f"{BASE}{y}/{fn}")
    text = body.decode("utf-8", "replace")
    parse(text)  # 形式を確かめてから保存する
    with open(p, "wb") as f:
        f.write(body)
    time.sleep(0.3)
    return text


def main():
    os.makedirs(RAWDIR, exist_ok=True)
    summary = load_summary()
    store = load_long()  # 蓄積済みの回はそのまま使う（公表後の訂正を入れ直すときは該当日の行を消して再実行）
    new = []
    if "--offline" not in sys.argv:
        today = dt.date.today()
        # 1回も入っていない年（初回は2016年から全部）と、今年（1月は前年末の回のため前年も）の一覧を見る
        years = sorted({y for y in range(FIRST_YEAR, today.year + 1) if not any(d.startswith(str(y)) for d in store)}
                       | {today.year, (today - dt.timedelta(days=20)).year})
        try:
            for y in years:
                idx = get(f"{BASE}{y}/index.htm").decode("utf-8", "replace")
                for fn in sorted(set(re.findall(rf"/release/{y}/(ac\d{{6}}\.htm)", idx))):
                    d = date_of(fn)
                    if d not in store:
                        store[d] = [(t, i, round(v / 100000, 1)) for t, i, v in parse(page(y, fn))]
                        new.append(d)
        except Exception as e:  # 取れた回までは保存する
            summary["errors"].append(f"ACM: {type(e).__name__}: {e}")
            print("ACM:", e)

    by_item = {}
    tmp = OUT + ".tmp"
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["date", "table", "item", "value"])
        for d in sorted(store):
            for table, item, v in store[d]:
                w.writerow([d, table, item, v])
                by_item.setdefault((table, item), {})[d] = v
    os.replace(tmp, OUT)

    for s in load_series():
        if s["db"] != "ACM" or s["code"] not in ITEMS:
            continue
        rows = {d: f"{v:.1f}" for d, v in by_item.get(ITEMS[s["code"]], {}).items()}
        if not rows:
            summary["errors"].append(f"ACM/{s['code']}: 項目が見つからない {ITEMS[s['code']]}")
            continue
        path = csv_path("ACM", s["code"])
        before = read_csv(path)
        write_csv(path, rows)
        added = set(rows) - set(before)
        revised = [k for k in before if k in rows and rows[k] != before[k]]
        if added or revised:
            summary["updated"].append({"db": "ACM", "code": s["code"], "new": len(added),
                                       "revised": len(revised), "latest": max(rows)})
    save_summary(summary)
    print(f"営業毎旬報告: 新規 {len(new)} 回 {new[-5:]}, 計 {len(store)} 回, 最新 {max(store) if store else None}")
    return 1 if any(e.startswith("ACM") for e in summary["errors"]) else 0


if __name__ == "__main__":
    raise SystemExit(guarded("ACM", main))
