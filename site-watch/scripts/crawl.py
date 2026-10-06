"""持ち株サイトの新着ページ(site-watch)のデータを作る。

持ち株(日本株)の公式サイト全体を巡回して、ページ・PDF の URL をすべて記録し、
前回までに見たことのない URL を「新しく見つかったページ」として一覧にする。

URL の集め方:
- サイトマップ: robots.txt に書かれたサイトマップ(なければ /sitemap.xml と /sitemap_index.xml)。
  サイトマップの目次(sitemapindex)もたどる。サイト全体を一番確実に、少ない負担で拾える。
- リンクの巡回: トップページと news/data/sources.json のニュース一覧ページから、同じサイト内のリンクをたどる。
  1回あたり最大 MAX_PAGES ページまで。サイトマップに載らないページや PDF もここで拾う。

マナー:
- robots.txt を守る(禁止されたページは読まない。Crawl-delay があればそれに合わせる)。
- 同じサイトへのアクセスは REQUEST_DELAY 秒以上あける。

銘柄は持ち株チェックと共通(holdings/data/holdings.json)。日本株(currency が無いか JPY)だけを見る。
公式サイトの URL は持ち株の新着情報と共通(news/data/sources.json の home と pages)。
data/sites.json で銘柄ごとに上書きできる(home / starts / exclude / skip)。

結果:
- data/seen/<コード>.txt — これまでに見つけた URL(1行1つ、並べ替え済み)。初回はこれを作るだけで、新着には載せない
- data/new_pages.json — ページが読むデータ。新しく見つかったページ(直近 KEEP_DAYS 日)と、各サイトの巡回状況

GitHub Actions(.github/workflows/update-site-watch.yml)から毎日実行する。
"""

import gzip
import json
import re
import sys
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlencode, urljoin, urlparse, urlunparse
from urllib.robotparser import RobotFileParser
from xml.etree import ElementTree as ET

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
SEEN_DIR = DATA_DIR / "seen"
OUT_PATH = DATA_DIR / "new_pages.json"
SITES_PATH = DATA_DIR / "sites.json"
HOLDINGS_PATH = ROOT.parent / "holdings" / "data" / "holdings.json"
SOURCES_PATH = ROOT.parent / "news" / "data" / "sources.json"

JST = timezone(timedelta(hours=9))
NOW = datetime.now(JST)

AGENT = "portal-site-watch"
HEADERS = {
    "User-Agent": f"Mozilla/5.0 (compatible; {AGENT}/1.0; +https://git-san-934.github.io/portal/site-watch/)",
    "Accept-Language": "ja,en;q=0.8",
}
REQUEST_DELAY = 1.5  # 同じサイトへのアクセスの間隔(秒)。robots.txt の Crawl-delay が長ければそちら
MAX_DELAY = 10.0  # Crawl-delay がこれより長くても、この秒数で打ち切る(そのぶん読むページを減らす)
MAX_PAGES = 200  # 1サイト・1回あたりにリンクをたどって読むページ数
MAX_SITEMAPS = 300  # 1サイトで読むサイトマップのファイル数
MAX_URLS = 60000  # 1サイトで記録する URL の上限
TIME_BUDGET = 25 * 60  # 1サイトにかける時間の上限(秒)
MAX_TITLES = 40  # 新しく見つかったページのうち、タイトルを取りに行く数(1サイト・1回)
MAX_ITEMS_PER_RUN = 300  # 1サイト・1回で一覧に載せる数。超えたぶんは数だけ記録する(サイト改修など)
KEEP_DAYS = 90  # 一覧に残す日数
MAX_ITEMS = 4000  # 一覧全体の上限

# 拾わないファイル(画像・動画・スタイルなど)。PDF や Excel は拾う
SKIP_EXT = re.compile(
    r"\.(?:jpe?g|png|gif|webp|svg|ico|bmp|tiff?|avif|css|js|mjs|json|map|woff2?|ttf|otf|eot|"
    r"mp4|m4v|mov|webm|avi|wmv|mp3|wav|m4a|ogg|zip|gz|tgz|rar|7z|exe|dmg|iso|swf|rss|atom)$",
    re.I,
)
DOC_EXT = re.compile(r"\.(?:pdf|xlsx?|docx?|pptx?|csv)$", re.I)
# 作りかけのテンプレートが残ったリンクなど、URL として壊れているもの(<mt:...> や {{ ... }}、引用符入り)
BROKEN_URL = re.compile(r"[<>\"{}]|%3C|%3E|%7B|%7D", re.I)
# 追跡用などの、ページの中身を変えないクエリ
DROP_PARAMS = re.compile(r"^(?:utm_.*|fbclid|gclid|yclid|msclkid|mc_[ce]id|_ga|_gl|sessionid|sid|phpsessid|jsessionid)$", re.I)


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def base_domain(host):
    host = host.lower().split(":")[0]
    return host[4:] if host.startswith("www.") else host


def normalize(url, https=True):
    """比べるための URL の形にそろえる。拾わない URL なら None。"""
    url = url.strip().replace(" ", "%20")
    if BROKEN_URL.search(url):
        return None
    try:
        p = urlparse(url)
    except ValueError:
        return None
    if p.scheme not in ("http", "https") or not p.netloc:
        return None
    scheme = "https" if https else p.scheme
    host = p.hostname or ""
    if p.port and p.port not in (80, 443):
        host = f"{host}:{p.port}"
    path = re.sub(r";jsessionid=[^/?#]*", "", p.path, flags=re.I) or "/"
    if SKIP_EXT.search(unquote(path)):
        return None
    query = urlencode(sorted((k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if not DROP_PARAMS.match(k)))
    return urlunparse((scheme, host.lower(), path, "", query, ""))


def kind_of(url):
    m = DOC_EXT.search(unquote(urlparse(url).path))
    return m.group(0)[1:].lower() if m else "page"


class Site:
    def __init__(self, code, name, cfg):
        self.code = code
        self.name = name
        self.home = cfg["home"]
        self.domain = base_domain(urlparse(self.home).netloc)
        self.https = urlparse(self.home).scheme == "https"
        self.starts = [self.home] + [u for u in cfg.get("starts", []) if u.startswith("http")]
        self.exclude = [re.compile(x) for x in cfg.get("exclude", [])]
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self.delay = REQUEST_DELAY
        self.last = 0.0
        self.started = time.monotonic()
        self.robots = RobotFileParser()
        self.log = []

    def in_scope(self, url):
        host = (urlparse(url).hostname or "").lower()
        if not (host == self.domain or host.endswith("." + self.domain)):
            return False
        return not any(x.search(url) for x in self.exclude)

    def allowed(self, url):
        return self.robots.can_fetch(AGENT, url)

    def out_of_time(self):
        return time.monotonic() - self.started > TIME_BUDGET

    def get(self, url, **kw):
        wait = self.last + self.delay - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        try:
            return self.session.get(url, timeout=30, **kw)
        except requests.RequestException as e:
            self.log.append(f"{url}: {type(e).__name__}")
            return None
        finally:
            self.last = time.monotonic()

    def read_robots(self):
        """robots.txt を読む。読めなければ理由を返す(その回は巡回しない)。"""
        p = urlparse(self.home)
        r = self.get(f"{p.scheme}://{p.netloc}/robots.txt")
        if r is None:
            return "サイトに接続できませんでした"
        if r.status_code >= 500 or r.status_code == 429:
            return f"robots.txt を読めませんでした(HTTP {r.status_code})"
        if r.status_code >= 400:
            self.robots.parse([])  # robots.txt が無い → すべて読んでよい
        else:
            self.robots.parse(r.text.splitlines())
        cd = self.robots.crawl_delay(AGENT)
        if cd:
            self.delay = min(max(self.delay, float(cd)), MAX_DELAY)
        if not self.allowed(self.home):
            return "robots.txt でクローラーが禁止されています"
        return None

    def read_sitemaps(self):
        """サイトマップに載っている URL → 最終更新日(lastmod)。"""
        p = urlparse(self.home)
        queue = deque(self.robots.site_maps() or [f"{p.scheme}://{p.netloc}/sitemap.xml", f"{p.scheme}://{p.netloc}/sitemap_index.xml"])
        done, urls = set(), {}
        while queue and len(done) < MAX_SITEMAPS and len(urls) < MAX_URLS and not self.out_of_time():
            sm = queue.popleft()
            if sm in done or not self.allowed(sm):
                continue
            done.add(sm)
            r = self.get(sm)
            if r is None or r.status_code != 200:
                continue
            body = r.content
            if body[:2] == b"\x1f\x8b":
                try:
                    body = gzip.decompress(body)
                except OSError:
                    continue
            try:
                root = ET.fromstring(body)
            except ET.ParseError:
                # テキスト形式のサイトマップ(1行1URL)。HTML が返ってきたときは何も拾わない
                for line in body.decode("utf-8", "replace").splitlines():
                    u = normalize(line, self.https) if line.startswith("http") else None
                    if u and self.in_scope(u):
                        urls.setdefault(u, None)
                continue
            tag = root.tag.rsplit("}", 1)[-1]
            for entry in root:
                loc = lastmod = None
                for child in entry:
                    name = child.tag.rsplit("}", 1)[-1]
                    if name == "loc" and child.text:
                        loc = child.text.strip()
                    elif name == "lastmod" and child.text:
                        lastmod = child.text.strip()[:10]
                if not loc:
                    continue
                if tag == "sitemapindex":
                    if self.in_scope(loc):
                        queue.append(loc)
                else:
                    u = normalize(loc, self.https)
                    if u and self.in_scope(u) and len(urls) < MAX_URLS:
                        urls[u] = lastmod
        return urls, len(done)

    def crawl_links(self):
        """トップページなどからリンクをたどる。見つけた URL → リンクの文字、読んだページ → タイトル。"""
        found, titles = {}, {}
        queue = deque()
        queued = set()
        for s in self.starts:
            u = normalize(s, self.https)
            if u and u not in queued:
                queued.add(u)
                queue.append((u, s))
        pages = 0
        while queue and pages < MAX_PAGES and not self.out_of_time():
            key, url = queue.popleft()
            if not self.allowed(url):
                continue
            r = self.get(url)
            pages += 1
            if r is None or r.status_code != 200:
                if r is not None and pages == 1:
                    self.log.append(f"{url}: HTTP {r.status_code}")
                continue
            final = normalize(r.url, self.https)
            if not final or not self.in_scope(final):
                continue
            found.setdefault(final, "")
            if "html" not in r.headers.get("Content-Type", "html"):
                continue
            soup = BeautifulSoup(r.content, "html.parser")
            if soup.title and soup.title.string:
                titles[final] = clean(soup.title.string)
            for a in soup.find_all("a", href=True):
                href = urljoin(r.url, a["href"])
                u = normalize(href, self.https)
                if not u or not self.in_scope(u) or len(found) >= MAX_URLS:
                    continue
                if not found.get(u):
                    found[u] = clean(a.get_text(" ", strip=True))[:120]
                if kind_of(u) == "page" and u not in queued:
                    queued.add(u)
                    queue.append((u, href))
        return found, titles, pages

    def title_of(self, url):
        if not self.allowed(url) or self.out_of_time():
            return ""
        r = self.get(url)
        if r is None or r.status_code != 200 or "html" not in r.headers.get("Content-Type", ""):
            return ""
        soup = BeautifulSoup(r.content, "html.parser")
        return clean(soup.title.string) if soup.title and soup.title.string else ""


def clean(s):
    return re.sub(r"\s+", " ", s or "").strip()


def file_name(url):
    path = unquote(urlparse(url).path).rstrip("/")
    return path.rsplit("/", 1)[-1] or url


def check(site, prev):
    """1サイトを巡回して、状況と新しく見つかった項目を返す。"""
    status = {
        "code": site.code,
        "name": site.name,
        "home": site.home,
        "checked_at": NOW.isoformat(timespec="seconds"),
        "baseline_on": prev.get("baseline_on"),
        "last_ok_at": prev.get("last_ok_at"),
        "known": prev.get("known", 0),
        "sitemap_urls": prev.get("sitemap_urls"),
    }
    err = site.read_robots()
    if err:
        status["status"] = err
        return status, []

    sitemap, n_maps = site.read_sitemaps()
    links, titles, pages = site.crawl_links()
    status.update(sitemap_files=n_maps, sitemap_urls=len(sitemap), crawled_pages=pages)
    current = set(sitemap) | set(links)
    if not current:
        reason = site.log[0].split(": ", 1)[-1] if site.log else ""
        if reason in ("HTTP 401", "HTTP 403"):
            status["status"] = f"サイトにアクセスを断られました({reason})"
        else:
            status["status"] = "ページを読めませんでした" + (f"({reason})" if reason else "")
        return status, []

    seen_path = SEEN_DIR / f"{site.code}.txt"
    first = not seen_path.exists()
    seen = set() if first else set(filter(None, seen_path.read_text(encoding="utf-8").splitlines()))
    new = sorted(current - seen)
    seen_path.write_text("".join(u + "\n" for u in sorted(seen | current)), encoding="utf-8")
    status.update(status="ok", last_ok_at=status["checked_at"], known=len(seen | current), new=0 if first else len(new))
    if first:
        # 初回はサイトの今の姿を記録するだけ(全部を「新着」にしない)
        status["baseline_on"] = NOW.date().isoformat()
        return status, []

    if sitemap and not prev.get("sitemap_urls"):
        # 前回はサイトマップが読めず、今回はじめて読めた → サイトマップだけに載っているものは記録だけにする
        new = [u for u in new if u in links]
    # 新しいもの: 最終更新日の新しい順 → URL 順
    new.sort(key=lambda u: sitemap.get(u) or "", reverse=True)
    if len(new) > MAX_ITEMS_PER_RUN:
        status["note"] = f"一度に {len(new)} 件増えました(サイトの作り替えかもしれません)。一覧には {MAX_ITEMS_PER_RUN} 件だけ載せています"
        new = new[:MAX_ITEMS_PER_RUN]

    items, asked = [], 0
    for u in new:
        title = titles.get(u, "")
        if not title and kind_of(u) == "page" and asked < MAX_TITLES:
            asked += 1
            title = site.title_of(u)
        via = "both" if u in sitemap and u in links else ("sitemap" if u in sitemap else "link")
        items.append({
            "code": site.code,
            "url": u,
            "title": title or links.get(u) or file_name(u),
            "link_text": links.get(u) or "",
            "kind": kind_of(u),
            "lastmod": sitemap.get(u),
            "via": via,
            "found_at": NOW.isoformat(timespec="seconds"),
        })
    return status, items


def run(site, prev):
    try:
        status, items = check(site, prev)
    except Exception as e:  # 1サイトの失敗で全体を止めない
        status, items = {
            "code": site.code, "name": site.name, "home": site.home,
            "checked_at": NOW.isoformat(timespec="seconds"),
            "baseline_on": prev.get("baseline_on"), "last_ok_at": prev.get("last_ok_at"),
            "known": prev.get("known", 0), "sitemap_urls": prev.get("sitemap_urls"), "status": f"エラー: {type(e).__name__}",
        }, []
    print(f"{site.code} {site.name}: {status['status']} 既知 {status.get('known', 0)} / "
          f"サイトマップ {status.get('sitemap_urls', '-')} / 巡回 {status.get('crawled_pages', '-')} / 新規 {len(items)}", flush=True)
    for line in site.log[:5]:
        print("   ", line)
    return status, items


def main():
    holdings = load_json(HOLDINGS_PATH, {}).get("stocks", [])
    sources = load_json(SOURCES_PATH, {})
    overrides = load_json(SITES_PATH, {})
    old = load_json(OUT_PATH, {})
    prev = {s["code"]: s for s in old.get("sites", [])}

    sites, statuses = [], []
    for h in holdings:
        if h.get("currency", "JPY") != "JPY":
            continue
        code = h["code"]
        src = sources.get(code, {})
        cfg = {"home": src.get("home"), "starts": [p for p in src.get("pages", []) if p.startswith("http")]}
        cfg.update(overrides.get(code, {}))
        if cfg.get("skip"):
            statuses.append({"code": code, "name": h["name"], "home": cfg.get("home"), "status": f"巡回しません({cfg['skip']})"})
            continue
        if not cfg.get("home"):
            statuses.append({"code": code, "name": h["name"], "home": None, "status": "公式サイトの URL が未登録です(news/data/sources.json に追加してください)"})
            continue
        sites.append(Site(code, h["name"], cfg))

    if not sites:
        sys.exit("巡回するサイトがありません")

    with ThreadPoolExecutor(max_workers=len(sites)) as ex:  # サイトごとに並行(同じサイトへは1本ずつ)
        results = list(ex.map(lambda s: run(s, prev.get(s.code, {})), sites))

    order = {h["code"]: i for i, h in enumerate(holdings)}
    statuses += [s for s, _ in results]
    statuses.sort(key=lambda s: order.get(s["code"], 999))

    cutoff = (NOW - timedelta(days=KEEP_DAYS)).isoformat()
    known_codes = {s["code"] for s in statuses}
    items = [it for _, its in results for it in its]
    have = {(it["code"], it["url"]) for it in items}
    items += [it for it in old.get("items", []) if it["found_at"] >= cutoff and it["code"] in known_codes and (it["code"], it["url"]) not in have]
    items.sort(key=lambda it: (it["found_at"], it.get("lastmod") or ""), reverse=True)

    out = {"updated_at": NOW.isoformat(timespec="seconds"), "keep_days": KEEP_DAYS, "sites": statuses, "items": items[:MAX_ITEMS]}
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    # 使われなくなった銘柄の記録は消す(銘柄リストから外したとき)
    for p in SEEN_DIR.glob("*.txt"):
        if p.stem not in known_codes:
            p.unlink()

    if all(s["status"] != "ok" for s in statuses):
        sys.exit("どのサイトも巡回できませんでした")


if __name__ == "__main__":
    main()
