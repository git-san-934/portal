"""持ち株(../data/holdings.json の日本株)の信用取引残高を JPX の「銘柄別信用取引残高」から取り、
../data/margin.json に書き出す。

東証は 2026-09-28 から、全銘柄の信用取引残高(株数と金額)を毎営業日公表している
(https://www.jpx.co.jp/markets/statistics-equities/margin/01.html、原則として翌営業日の16時ごろ、PDF)。
金額は建てたときの代金の合計なので、買残の金額 ÷ 買残の株数 = 信用で買った投資家の平均の買値になる。

PDF は1銘柄につき「株数 Shs.」と「金額 Val.」の2行で、どちらも
売残高 前日比 (上場比) 買残高 前日比 (上場比) 売:一般 前日比 売:制度 前日比 買:一般 前日比 買:制度 前日比
の順に並ぶ。上場比(% / * / -)は読み飛ばし、合計 = 一般 + 制度 になっているかで読み違いを検出する。

ページに載っている日付のうち margin.json にまだない日だけ読み、過去分に足していく
(銘柄リストに新しい日本株が加わったときは、載っている日付をすべて読み直す)。

GitHub Actions(.github/workflows/update-holdings-margin.yml)から平日の夕方に実行する。
ファイルを1つも読めなかったときは margin.json を上書きせずに終了コード1で終わる。
"""

import io
import json
import re
import sys
import time
import unicodedata
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pdfplumber
import requests

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
LIST_PATH = DATA_DIR / "holdings.json"
CHECK_PATH = DATA_DIR / "check.json"
OUT_PATH = DATA_DIR / "margin.json"

JPX = "https://www.jpx.co.jp"
INDEX_URL = f"{JPX}/markets/statistics-equities/margin/01.html"
START = date(2026, 9, 28)  # 日次公表の開始日
KEEP_DAYS = 400  # 残す履歴(暦日)。チャートは1年分
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; portal-holdings/1.0; +https://git-san-934.github.io/portal/)"}
JST = timezone(timedelta(hours=9))

# 「13010 JP3257200000 株数 Shs.」のように、5桁の新証券コード・ISIN・行の種類が並ぶ
ROW_RE = re.compile(r"([0-9][0-9A-Z]{3}0)\s+(JP[0-9A-Z]{10})\s+(株数|金額)\s*(?:Shs\.|Val\.)")
NUM_RE = re.compile(r"[▲△-]?[0-9][0-9,]*")
ASOF_RE = re.compile(r"(\d{4})/(\d{1,2})/(\d{1,2})\s*申込み現在")


def log(*a):
    print(*a, flush=True)


def get(url, retries=3):
    last = None
    for attempt in range(1, retries + 1):
        try:
            r = requests.get(url, headers=HEADERS, timeout=90)
            if r.status_code == 200:
                return r
            last = f"HTTP {r.status_code}"
            if r.status_code in (401, 403, 404):
                break
        except requests.RequestException as e:
            last = e
        time.sleep(3 * attempt)
    raise RuntimeError(f"{url}: {last}")


def load_codes():
    """日本株のコード(4桁)。米国株など currency が JPY 以外のものは除く"""
    path = LIST_PATH if LIST_PATH.exists() else CHECK_PATH
    stocks = json.loads(path.read_text(encoding="utf-8"))["stocks"]
    return [s["code"] for s in stocks if (s.get("currency") or "JPY") == "JPY"]


def file_links(html):
    """ページにある「YYYYMMDD_mtall.pdf」へのリンク {日付: URL}"""
    out = {}
    for href in re.findall(r'href="([^"]*?(\d{8})_mtall\.pdf)"', html):
        url, ymd = href
        out[date(int(ymd[:4]), int(ymd[4:6]), int(ymd[6:]))] = url if url.startswith("http") else JPX + url
    return out


def guess_older(links, have):
    """ページには直近の数日分しか載らないので、同じフォルダにある日次公表開始以降の古い日付も試す"""
    if not links:
        return {}
    newest = max(links)
    folder = links[newest].rsplit("/", 1)[0]
    out = {}
    d = START
    while d < min(links):
        if d.weekday() < 5 and d.isoformat() not in have:
            out[d] = f"{folder}/{d:%Y%m%d}_mtall.pdf"
        d += timedelta(days=1)
    return out


def numbers(text, count=12):
    """行の先頭から数値を count 個。▲ は負号。上場比(0.1% / * / -)などは読み飛ばす"""
    text = re.sub(r"([▲△])\s+", r"\1", text)
    vals = []
    for tok in text.split():
        if "%" in tok or not NUM_RE.fullmatch(tok):
            continue
        sign = -1 if tok[0] in "▲△-" else 1
        vals.append(sign * int(tok.lstrip("▲△-").replace(",", "")))
        if len(vals) == count:
            break
    return vals


def valid(v):
    # 売残 = 売:一般 + 売:制度、買残 = 買:一般 + 買:制度(前日比も同じ)
    return len(v) == 12 and v[0] == v[4] + v[6] and v[2] == v[8] + v[10] and v[1] == v[5] + v[7] and v[3] == v[9] + v[11]


def parse(pdf_bytes, codes):
    """PDF から {コード4桁: {"shares": [...12個], "value": [...12個]}} と基準日を返す"""
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        text = "\n".join(unicodedata.normalize("NFKC", p.extract_text() or "") for p in pdf.pages)
    m = ASOF_RE.search(text)
    asof = date(int(m[1]), int(m[2]), int(m[3])) if m else None
    want = {f"{c}0": c for c in codes}
    rows = list(ROW_RE.finditer(text))
    found, bad, total = {}, 0, 0
    for i, r in enumerate(rows):
        end = rows[i + 1].start() if i + 1 < len(rows) else len(text)
        v = numbers(text[r.end() : end])
        total += 1
        if not valid(v):
            bad += 1
            continue
        if r[1] in want:
            found.setdefault(want[r[1]], {})["shares" if r[3] == "株数" else "value"] = v
    log(f"  基準日 {asof} / {total} 行中 {bad} 行は合計が合わず読み飛ばし / 持ち株 {len(found)} 銘柄")
    if total == 0 or bad > total * 0.2:
        log("---- 1ページ目の文字(形式確認用) ----")
        log(text[:3000])
        if rows:
            log("---- 読めなかった行の例 ----")
            log(text[rows[0].start() : rows[0].start() + 600])
        raise RuntimeError(f"PDF の形式が想定と違います(行 {total}、読めない行 {bad})")
    return asof, found


def load_prev():
    try:
        return json.loads(OUT_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"dates": [], "stocks": {}}


def main():
    codes = load_codes()
    prev = load_prev()
    have = set(prev.get("dates", []))
    hist = {c: {e["date"]: e for e in prev.get("stocks", {}).get(c, [])} for c in codes}
    # 銘柄リストに新しく入った日本株があれば、取れる日付をすべて読み直す
    refetch_all = any(c not in prev.get("stocks", {}) for c in codes)

    links = file_links(get(INDEX_URL).text)
    if not links:
        log("銘柄別信用取引残高の PDF へのリンクが見つかりません")
        return 1
    log(f"ページに載っている日付: {', '.join(d.isoformat() for d in sorted(links))}")
    known = set() if refetch_all else have
    # 初回と全件読み直しのときだけ、ページから消えた古い日付も探す
    older = guess_older(links, known) if refetch_all or not have else {}
    targets = {**older, **links}
    todo = sorted(d for d in targets if d.isoformat() not in known)
    log(f"読む日付: {len(todo)} 件" + ("(新しい銘柄があるので全件)" if refetch_all else ""))

    read = 0
    for d in todo:
        try:
            pdf = get(targets[d], retries=1 if d not in links else 3).content
        except RuntimeError as e:
            if d in links:
                log(f"{d}: 取得に失敗 {e}")
                return 1
            continue  # 推測した URL は無くてもよい(休場日など)
        log(f"{d}: {targets[d]}")
        asof, found = parse(pdf, codes)
        day = (asof or d).isoformat()
        for c, rec in found.items():
            if "shares" not in rec or "value" not in rec:
                continue
            s, v = rec["shares"], rec["value"]
            hist[c][day] = {
                "date": day,
                "buy_shares": s[2],
                "buy_value": v[2],
                "sell_shares": s[0],
                "sell_value": v[0],
            }
        have.add(day)
        read += 1

    if read == 0 and not prev.get("stocks"):
        log("信用取引残高を1日分も読めませんでした")
        return 1

    cutoff = (datetime.now(JST).date() - timedelta(days=KEEP_DAYS)).isoformat()
    out = {
        "generated_at": datetime.now(JST).strftime("%Y-%m-%dT%H:%M+09:00"),
        "source": "日本取引所グループ「銘柄別信用取引残高」(東証、毎営業日公表)",
        "note": "単位は株・円。金額は建てたときの代金の合計。平均買値 = buy_value ÷ buy_shares",
        "dates": sorted(x for x in have if x >= cutoff),
        "stocks": {c: [hist[c][k] for k in sorted(hist[c]) if k >= cutoff] for c in codes},
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    for c in codes:
        last = out["stocks"][c][-1] if out["stocks"][c] else None
        if last and last["buy_shares"]:
            log(f"{c}: {last['date']} 買残 {last['buy_shares']:,}株 平均買値 {last['buy_value'] / last['buy_shares']:,.1f}円")
        else:
            log(f"{c}: データなし")
    return 0


if __name__ == "__main__":
    sys.exit(main())
