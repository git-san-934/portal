"""持ち株の新着情報(news)のデータを作る。

集めるもの:
- 公式サイト: 各社のニュース・IRニュース一覧のページ(data/sources.json)から、日付つきのリンクを拾う。
  RSS/Atom でもよい。一覧が取れないときは、トップページからニュース一覧らしいページを探す。
- EDINET(日本株): 各社が出した書類(有価証券報告書・臨時報告書など)と、他社が出したその会社の大量保有報告書。
  EDINET_API_KEY(環境変数)があるときだけ。
- SEC EDGAR(米国株): 8-K・10-Q・10-K などの提出書類。EDINET の米国版。

銘柄は持ち株チェックと共通(holdings/data/holdings.json)。
結果は data/news.json。前回の news.json を読んで、はじめて見つけた時刻(first_seen)を引き継ぐ。
GitHub Actions(.github/workflows/update-news.yml)から 1日4回(1:00 / 8:30 / 12:45 / 15:45 JST)実行する。
"""

import io
import json
import os
import re
import sys
import time
import unicodedata
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse
from xml.etree import ElementTree as ET

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUT_PATH = DATA_DIR / "news.json"
SOURCES_PATH = DATA_DIR / "sources.json"
EDINET_CACHE_PATH = DATA_DIR / "edinet_cache.json"
HOLDINGS_PATH = ROOT.parent / "holdings" / "data" / "holdings.json"

EDINET_API = "https://api.edinet-fsa.go.jp/api/v2"
EDINET_CODELIST = "https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip"
EDINET_VIEW = "https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?"
SEC_TICKERS = "https://www.sec.gov/files/company_tickers.json"
SEC_SUBMISSIONS = "https://data.sec.gov/submissions/CIK{cik:010d}.json"

JST = timezone(timedelta(hours=9))
NOW = datetime.now(JST)
TODAY = NOW.date()
KEEP_DAYS = 180  # これより古い記事は載せない
MAX_PER_SOURCE = 20  # 1銘柄・1情報源あたりの最大件数(1回の取得)
MAX_PER_STOCK = 60  # 1銘柄で残す最大件数
EDINET_DAYS = 90  # EDINET を遡る日数
SEC_DAYS = 120
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; portal-news/1.0; +https://git-san-934.github.io/portal/news/)",
    "Accept-Language": "ja,en;q=0.8",
}
# SEC はアクセス元の連絡先を User-Agent に書くよう求めている
SEC_HEADERS = {"User-Agent": "portal-news git-san-934@users.noreply.github.com"}

# SEC の書類のうち載せるもの(Form 4 などの役員売買は件数が多いので除く)
SEC_FORMS = {
    "8-K": "臨時報告(8-K)", "10-Q": "四半期報告書(10-Q)", "10-K": "年次報告書(10-K)",
    "6-K": "臨時報告(6-K)", "20-F": "年次報告書(20-F)", "DEF 14A": "株主総会招集通知(DEF 14A)",
    "S-1": "上場届出書(S-1)", "S-3": "発行登録書(S-3)", "424B4": "目論見書(424B4)",
    "SC 13G": "大量保有報告(13G)", "SC 13G/A": "大量保有報告・変更(13G/A)",
    "SC 13D": "大量保有報告(13D)", "SC 13D/A": "大量保有報告・変更(13D/A)",
}
SEC_8K_ITEMS = {
    "1.01": "重要な契約", "1.02": "契約の終了", "2.01": "買収・売却の完了", "2.02": "決算発表",
    "2.03": "債務の発生", "2.05": "リストラ費用", "2.06": "減損", "3.02": "株式の発行",
    "5.02": "役員の異動", "5.03": "定款の変更", "5.07": "株主総会の結果", "7.01": "情報開示",
    "8.01": "その他の出来事",
}

MONTHS = {m: i + 1 for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}
DATE_PATTERNS = [
    (re.compile(r"(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日"), "ymd"),
    (re.compile(r"(20\d{2})[./\-](\d{1,2})[./\-](\d{1,2})(?!\d)"), "ymd"),
    (re.compile(r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})", re.I), "mdy"),
    (re.compile(r"\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(20\d{2})", re.I), "dmy"),
    (re.compile(r"(?<!\d)(\d{1,2})[./](\d{1,2})[./](20\d{2})(?!\d)"), "mdy_num"),
]
# 一覧・案内のリンクなど、記事ではないもの
SKIP_TITLES = re.compile(
    r"^(一覧|もっと見る|more|read more|view all|詳しく|詳細|pdf|html|new|ニュース|ニュースリリース|お知らせ|"
    r"news|press releases?|トップ|top|home|次へ|前へ|next|prev(ious)?|\d+)$",
    re.I,
)
NEWS_HINT = re.compile(r"ニュース|お知らせ|リリース|ir\s*ニュース|ir情報|適時開示|news|press|release|announcement", re.I)


def log(msg):
    print(msg, flush=True)


def get(url, headers=None, retries=2, **kw):
    last = None
    for attempt in range(1, retries + 1):
        try:
            r = requests.get(url, headers=headers or HEADERS, timeout=40, **kw)
            if r.status_code == 200:
                return r
            last = f"HTTP {r.status_code}"
            if r.status_code in (401, 403, 404, 410):
                break
        except requests.RequestException as e:
            last = type(e).__name__
        time.sleep(2 * attempt)
    raise RuntimeError(last)


def clean(text):
    text = unicodedata.normalize("NFKC", text or "")
    return re.sub(r"\s+", " ", text).strip()


def make_date(y, m, d):
    try:
        return date(int(y), int(m), int(d))
    except ValueError:
        return None


def find_date(text):
    """文字列の中の最初の日付。(date, 一致した部分)"""
    for pat, kind in DATE_PATTERNS:
        m = pat.search(text)
        if not m:
            continue
        g = m.groups()
        if kind == "ymd":
            d = make_date(g[0], g[1], g[2])
        elif kind == "mdy":
            d = make_date(g[2], MONTHS[g[0][:3].lower()], g[1])
        elif kind == "dmy":
            d = make_date(g[2], MONTHS[g[1][:3].lower()], g[0])
        else:
            d = make_date(g[2], g[0], g[1])
        if d:
            return d, m.group(0)
    return None, None


def plausible(d):
    return d is not None and TODAY - timedelta(days=KEEP_DAYS) <= d <= TODAY + timedelta(days=2)


def strip_date(text, matched):
    if matched:
        text = text.replace(matched, " ")
    text = re.sub(r"^[\s|・:：\-–—/]+|[\s|・:：\-–—/]+$", "", clean(text))
    return text


# ---------------------------------------------------------------------------
# 公式サイト
# ---------------------------------------------------------------------------


def parse_feed(content, base):
    """RSS / Atom を読む。読めなければ None"""
    try:
        root = ET.fromstring(content)
    except ET.ParseError:
        return None
    tag = root.tag.lower()
    if not (tag.endswith("rss") or tag.endswith("feed") or tag.endswith("rdf")):
        return None
    items = []
    for el in root.iter():
        name = el.tag.split("}")[-1].lower()
        if name not in ("item", "entry"):
            continue
        fields = {}
        for ch in el:
            n = ch.tag.split("}")[-1].lower()
            if n == "link":
                fields.setdefault("link", ch.get("href") or (ch.text or "").strip())
            elif n in ("title", "pubdate", "date", "published", "updated"):
                fields.setdefault(n, (ch.text or "").strip())
        title = clean(fields.get("title"))
        link = fields.get("link")
        raw = fields.get("pubdate") or fields.get("date") or fields.get("published") or fields.get("updated") or ""
        d = None
        m = re.match(r"(\d{4})-(\d{2})-(\d{2})", raw)
        if m:
            d = make_date(*m.groups())
        else:
            d, _ = find_date(raw)
        if title and link and plausible(d):
            items.append({"date": d.isoformat(), "title": title[:200], "url": urljoin(base, link)})
    return items


def parse_html(soup, base):
    """ページの中から「日付 + リンク」の組を拾う"""
    items, seen = [], set()
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href or href.startswith(("#", "javascript:", "mailto:", "tel:")):
            continue
        url = urljoin(base, href)
        if url in seen or url.rstrip("/") == base.rstrip("/"):
            continue
        anchor = clean(a.get_text(" "))
        d, matched, context = None, None, anchor
        t = a.find("time")
        if t and t.get("datetime"):
            d, _ = find_date(t["datetime"])
            matched = clean(t.get_text(" ")) or None
        node = a
        for _ in range(4):
            if d:
                break
            text = clean(node.get_text(" "))
            if len(text) > 400:
                break
            tm = node.find("time") if hasattr(node, "find") else None
            if tm is not None and tm.get("datetime"):
                d, _ = find_date(tm["datetime"])
            if not d:
                d, matched = find_date(text)
            context = text
            node = node.parent
            if node is None or node.name in ("body", "html"):
                break
        if not plausible(d):
            continue
        title = strip_date(anchor, matched)
        if len(title) < 6 or SKIP_TITLES.match(title):
            title = strip_date(context, matched)
        # 日付やカテゴリーだけのリンク、ナビゲーションは除く
        if len(title) < 6 or SKIP_TITLES.match(title):
            continue
        seen.add(url)
        items.append({"date": d.isoformat(), "title": title[:200], "url": url})
    return items


def feed_links(soup, base):
    out = []
    for link in soup.find_all("link", href=True):
        typ = (link.get("type") or "").lower()
        if "rss" in typ or "atom" in typ:
            out.append(urljoin(base, link["href"]))
    return out


def fetch_page(url):
    """1ページ(RSS も可)から記事を拾う。(記事, soup)"""
    r = get(url)
    ctype = r.headers.get("Content-Type", "").lower()
    if "xml" in ctype or r.content.lstrip()[:5] in (b"<?xml", b"<rss ", b"<feed"):
        items = parse_feed(r.content, r.url)
        if items is not None:
            return items, None
    if not r.encoding or r.encoding.lower() == "iso-8859-1":
        r.encoding = r.apparent_encoding
    soup = BeautifulSoup(r.text, "html.parser")
    return parse_html(soup, r.url), soup


def discover(home):
    """トップページからニュース一覧らしいページ(と RSS)を探す"""
    try:
        r = get(home)
    except RuntimeError as e:
        log(f"    トップページ {home}: {e}")
        return []
    if not r.encoding or r.encoding.lower() == "iso-8859-1":
        r.encoding = r.apparent_encoding
    soup = BeautifulSoup(r.text, "html.parser")
    host = urlparse(r.url).netloc.split(":")[0]
    cands = feed_links(soup, r.url)
    for a in soup.find_all("a", href=True):
        text = clean(a.get_text(" "))
        url = urljoin(r.url, a["href"])
        if urlparse(url).netloc.split(":")[0].split(".")[-2:] != host.split(".")[-2:]:
            continue
        if len(text) <= 20 and NEWS_HINT.search(text) and url not in cands:
            cands.append(url)
    return cands[:6]


def fetch_official(code, conf):
    """公式サイトから記事を集める。(記事, 取得できたページ, 失敗メモ)"""
    items, ok_pages, errors = [], [], []
    tried = set()

    def try_page(url):
        tried.add(url)
        try:
            got, soup = fetch_page(url)
        except Exception as e:  # noqa: BLE001 — 1ページの失敗で止めない
            errors.append(f"{url}: {e}")
            return None
        log(f"    {url}: {len(got)} 件")
        if got:
            ok_pages.append(url)
            items.extend(got)
        return soup

    for url in conf.get("pages", []):
        soup = try_page(url)
        # ページに RSS があれば、それも読む(HTML より確実なことが多い)
        if soup is not None:
            for f in feed_links(soup, url)[:2]:
                if f not in tried:
                    try_page(f)
    if not items and conf.get("home"):
        log("    一覧から取れなかったので、トップページから探します")
        for url in discover(conf["home"]):
            if url not in tried:
                try_page(url)
            if len(items) >= 5:
                break
    for e in errors:
        log(f"    失敗 {e}")
    return items, ok_pages, errors


# ---------------------------------------------------------------------------
# EDINET
# ---------------------------------------------------------------------------


def edinet_codes(sec_codes):
    """証券コード(5桁) -> EDINET コード。大量保有報告書を対象会社で拾うのに使う"""
    try:
        r = get(EDINET_CODELIST)
        z = zipfile.ZipFile(io.BytesIO(r.content))
        raw = z.read(z.namelist()[0]).decode("cp932", "replace")
    except Exception as e:  # noqa: BLE001
        log(f"  EDINET コード一覧: {e}")
        return {}
    import csv

    rows = list(csv.reader(io.StringIO(raw)))
    header = rows[1] if len(rows) > 1 else []
    try:
        i_code, i_sec = header.index("ＥＤＩＮＥＴコード"), header.index("証券コード")
    except ValueError:
        i_code, i_sec = 0, 11
    out = {}
    for row in rows[2:]:
        if len(row) > max(i_code, i_sec) and row[i_sec].strip() in sec_codes:
            out[row[i_code].strip()] = row[i_sec].strip()
    return out


def fetch_edinet(stocks):
    """{code: [記事]}。EDINET_API_KEY が無ければ None"""
    key = os.environ.get("EDINET_API_KEY", "").strip()
    if not key:
        log("EDINET_API_KEY が未設定のため、EDINET は取得しません")
        return None
    sec_to_code = {s["code"] + "0": s["code"] for s in stocks if re.fullmatch(r"\d{3}[0-9A-Z]", s["code"])}
    if not sec_to_code:
        return {}
    edinet_to_sec = edinet_codes(set(sec_to_code))
    log(f"EDINET: 対象 {len(sec_to_code)} 社(EDINET コード {len(edinet_to_sec)} 社)")
    watch = sorted(sec_to_code)
    try:
        cache = json.loads(EDINET_CACHE_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        cache = {}
    # 持ち株が変わったら、その日の結果は使えないので読み直す
    if cache.get("watch") != watch:
        cache = {"watch": watch, "days": {}}
    days = cache.setdefault("days", {})
    start = TODAY - timedelta(days=EDINET_DAYS)
    fetched, failed = 0, 0
    d = start
    while d <= TODAY:
        ds = d.isoformat()
        # 3日より前の日は確定しているのでキャッシュを使う
        if ds in days and d < TODAY - timedelta(days=3):
            d += timedelta(days=1)
            continue
        try:
            r = get(f"{EDINET_API}/documents.json", params={"date": ds, "type": 2, "Subscription-Key": key})
            res = r.json().get("results") or []
        except Exception as e:  # noqa: BLE001
            log(f"  EDINET {ds}: {e}")
            failed += 1
            d += timedelta(days=1)
            continue
        hits = []
        for doc in res:
            sec = (doc.get("secCode") or "").strip()
            issuer = (doc.get("issuerEdinetCode") or "").strip()
            target = sec if sec in sec_to_code else edinet_to_sec.get(issuer)
            if not target or doc.get("withdrawalStatus") == "1":
                continue
            hits.append({
                "sec": target,
                "id": doc.get("docID"),
                "time": doc.get("submitDateTime") or ds,
                "desc": clean(doc.get("docDescription")),
                "filer": clean(doc.get("filerName")),
                "own": sec == target,
            })
        days[ds] = hits
        fetched += 1
        time.sleep(0.3)
        d += timedelta(days=1)
    for ds in [k for k in days if k < start.isoformat()]:
        del days[ds]
    EDINET_CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    log(f"EDINET: {fetched} 日分を取得、{failed} 日失敗")
    if fetched == 0 and failed:
        return None
    out = {}
    for ds, hits in days.items():
        for h in hits:
            title = h["desc"]
            if not h["own"]:
                title = f"{title}(提出: {h['filer']})"
            out.setdefault(sec_to_code[h["sec"]], []).append({
                "date": h["time"][:10],
                "time": h["time"][11:16],
                "title": title,
                "url": EDINET_VIEW + h["id"],
            })
    return out


# ---------------------------------------------------------------------------
# SEC EDGAR(米国株)
# ---------------------------------------------------------------------------


def fetch_sec(stocks, sources):
    tickers = [s for s in stocks if s.get("currency") == "USD" and sources.get(s["code"], {}).get("sec", True)]
    if not tickers:
        return {}
    try:
        table = get(SEC_TICKERS, headers=SEC_HEADERS).json()
    except Exception as e:  # noqa: BLE001
        log(f"SEC: 銘柄一覧を取得できませんでした: {e}")
        return None
    cik_of = {row["ticker"].upper(): int(row["cik_str"]) for row in table.values()}
    out = {}
    since = (TODAY - timedelta(days=SEC_DAYS)).isoformat()
    for s in tickers:
        t = (s.get("ticker") or s["code"]).upper()
        cik = cik_of.get(t)
        if not cik:
            log(f"  SEC {t}: CIK が見つかりません")
            continue
        try:
            sub = get(SEC_SUBMISSIONS.format(cik=cik), headers=SEC_HEADERS).json()
        except Exception as e:  # noqa: BLE001
            log(f"  SEC {t}: {e}")
            continue
        rec = sub.get("filings", {}).get("recent", {})
        items = []
        for i, form in enumerate(rec.get("form", [])):
            fdate = rec["filingDate"][i]
            if fdate < since:
                break
            if form not in SEC_FORMS:
                continue
            title = SEC_FORMS[form]
            if form == "8-K":
                what = [SEC_8K_ITEMS[x] for x in (rec.get("items", [""] * (i + 1))[i] or "").split(",") if x in SEC_8K_ITEMS and x != "9.01"]
                if what:
                    title += ": " + "・".join(dict.fromkeys(what))
            desc = clean(rec.get("primaryDocDescription", [""] * (i + 1))[i])
            if desc and desc.upper() not in (form, form.replace(" ", "")) and len(desc) > 4:
                title += f" — {desc}"
            acc = rec["accessionNumber"][i].replace("-", "")
            doc = rec.get("primaryDocument", [""] * (i + 1))[i]
            url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc}/{doc}" if doc else \
                f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik}"
            items.append({"date": fdate, "title": title, "url": url})
        out[s["code"]] = items
        log(f"  SEC {t}: {len(items)} 件")
        time.sleep(0.2)
    return out


# ---------------------------------------------------------------------------


def main():
    stocks = json.loads(HOLDINGS_PATH.read_text(encoding="utf-8"))["stocks"]
    sources = json.loads(SOURCES_PATH.read_text(encoding="utf-8"))
    try:
        prev = json.loads(OUT_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        prev = None
    first_run = prev is None
    prev_items = {}
    if prev:
        for s in prev.get("stocks", []):
            for it in s.get("items", []):
                prev_items[(s["code"], it["url"])] = it

    now_iso = NOW.isoformat(timespec="minutes")

    official = {}
    status = {}
    for s in stocks:
        conf = sources.get(s["code"])
        if not conf:
            log(f"{s['code']} {s['name']}: sources.json に公式サイトがありません")
            status[s["code"]] = {"official": "未登録"}
            continue
        log(f"{s['code']} {s['name']}")
        items, ok_pages, errors = fetch_official(s["code"], conf)
        items.sort(key=lambda x: x["date"], reverse=True)
        official[s["code"]] = items[:MAX_PER_SOURCE]
        status[s["code"]] = {"official": "ok" if items else "取得できませんでした", "pages": ok_pages or conf.get("pages", [])[:1]}

    edinet = fetch_edinet(stocks)
    sec = fetch_sec(stocks, sources)

    out_stocks = []
    total_new = 0
    for s in stocks:
        code = s["code"]
        merged = {}
        groups = [("official", official.get(code, []))]
        if edinet is not None:
            groups.append(("edinet", sorted(edinet.get(code, []), key=lambda x: (x["date"], x.get("time", "")), reverse=True)[:MAX_PER_SOURCE]))
        if sec is not None:
            groups.append(("sec", sec.get(code, [])[:MAX_PER_SOURCE]))
        for source, items in groups:
            for it in items:
                if it["url"] in merged:
                    continue
                old = prev_items.get((code, it["url"]))
                if old:
                    first_seen = old["first_seen"]
                elif first_run:
                    # 初回は、記事の日付に見つけたことにする(古い記事が全部「新着」にならないように)
                    first_seen = f"{it['date']}T00:00+09:00"
                else:
                    first_seen = now_iso
                    total_new += 1
                merged[it["url"]] = {**it, "source": source, "first_seen": first_seen}
        # 一覧から消えた記事や、取得に失敗した情報源の記事も、KEEP_DAYS 日までは残す
        for (c, url), old in prev_items.items():
            if c == code and url not in merged and old["date"] >= (TODAY - timedelta(days=KEEP_DAYS)).isoformat():
                merged[url] = old
        items = sorted(merged.values(), key=lambda x: (x["date"], x.get("time", ""), x["first_seen"]), reverse=True)[:MAX_PER_STOCK]
        st = status.get(code, {})
        out_stocks.append({
            "code": code,
            "name": s["name"],
            "market": "US" if s.get("currency") == "USD" else "JP",
            "home": sources.get(code, {}).get("home"),
            "official_status": st.get("official"),
            "official_pages": st.get("pages", []),
            "items": items,
        })

    out = {
        "updated_at": now_iso,
        "edinet": "ok" if edinet is not None else "取得できませんでした",
        "sec": "ok" if sec is not None else "取得できませんでした",
        "stocks": out_stocks,
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    log("")
    log(f"完了: 新しく見つけた記事 {total_new} 件")
    for s in out_stocks:
        counts = {}
        for it in s["items"]:
            counts[it["source"]] = counts.get(it["source"], 0) + 1
        log(f"  {s['code']:5} {s['name']}: 公式 {counts.get('official', 0)} / EDINET {counts.get('edinet', 0)} / SEC {counts.get('sec', 0)}  ({s['official_status']})")
        for it in s["items"][:3]:
            log(f"      {it['date']} [{it['source']}] {it['title'][:60]}")
    ok_official = sum(1 for s in out_stocks if s["official_status"] == "ok")
    if ok_official == 0 and edinet is None and sec is None:
        log("どこからも取得できませんでした")
        sys.exit(1)


if __name__ == "__main__":
    main()
