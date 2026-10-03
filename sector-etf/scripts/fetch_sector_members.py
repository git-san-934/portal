"""東証上場銘柄一覧(JPX)から TOPIX-17業種ごとの個別銘柄を取り出し、
../data/sector_members.json に書き出す。

業種チャートを押したときに開く「個別銘柄一覧」ページ(sector.html)が読む。
JPX の一覧は月1回程度の更新なので、内容が変わらなければファイルも変わらない
(生成時刻は書き込まない)。
"""

import io
import json
import sys
import time
import urllib.request
from pathlib import Path

import pandas as pd

JPX_URL = "https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls"
OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "sector_members.json"
RETRIES = 3
MIN_STOCKS = 3000  # これより少なければ取得失敗とみなして上書きしない

# TOPIX-17 業種コード → 業種名(fetch_etf.py の ETFS と同じ並び。1617〜1633 に対応)
SECTOR17 = {
    1: "食品", 2: "エネルギー資源", 3: "建設・資材", 4: "素材・化学", 5: "医薬品",
    6: "自動車・輸送機", 7: "鉄鋼・非鉄", 8: "機械", 9: "電機・精密",
    10: "情報通信・サービスその他", 11: "電力・ガス", 12: "運輸・物流",
    13: "商社・卸売", 14: "小売", 15: "銀行", 16: "金融(除く銀行)", 17: "不動産",
}


def download() -> bytes:
    last_err = None
    for attempt in range(1, RETRIES + 1):
        try:
            req = urllib.request.Request(JPX_URL, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=60) as res:
                return res.read()
        except Exception as e:  # noqa: BLE001
            last_err = e
            print(f"download attempt {attempt} failed: {e}", file=sys.stderr)
            time.sleep(10 * attempt)
    raise RuntimeError(f"download failed: {last_err}")


def clean(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    s = str(v).strip()
    if s.endswith(".0") and s[:-2].isdigit():  # Excel の数値セル(1301.0 など)
        s = s[:-2]
    return None if s in ("", "-", "nan") else s


def main():
    df = pd.read_excel(io.BytesIO(download()), dtype=str)
    required = ["日付", "コード", "銘柄名", "市場・商品区分", "33業種区分", "17業種コード", "規模区分"]
    missing = [c for c in required if c not in df.columns]
    if missing:
        sys.exit(f"JPX の一覧に想定した列がありません: {missing} / 実際の列: {list(df.columns)}")

    sectors = {str(k): {"name": v, "stocks": []} for k, v in SECTOR17.items()}
    as_of = None
    count = 0
    for row in df.itertuples(index=False):
        rec = dict(zip(df.columns, row))
        s17 = clean(rec["17業種コード"])
        if not s17 or not s17.isdigit() or int(s17) not in SECTOR17:
            continue  # ETF・REIT・出資証券など業種のないもの
        market = clean(rec["市場・商品区分"]) or ""
        market = market.replace("（内国株式）", "").replace("（外国株式）", "(外国株)")
        sectors[str(int(s17))]["stocks"].append(
            {
                "c": clean(rec["コード"]),
                "n": clean(rec["銘柄名"]),
                "m": market,
                "s33": clean(rec["33業種区分"]),
                "sz": clean(rec["規模区分"]),
            }
        )
        as_of = as_of or clean(rec["日付"])
        count += 1

    for k, s in sectors.items():
        print(f"{k:>2} {s['name']}: {len(s['stocks'])} 銘柄")
    if count < MIN_STOCKS:
        sys.exit(f"銘柄数が少なすぎます({count})。sector_members.json は更新しません")

    out = {
        "as_of": as_of,
        "source": "日本取引所グループ「東証上場銘柄一覧」",
        "sectors": sectors,
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {OUT_PATH} ({count} stocks, as of {as_of})")


if __name__ == "__main__":
    main()
