"""投資分析ページ(cf/<コード>/)の銘柄について、TDnet に出た決算短信のサマリーの XBRL を読み、
「最新の決算短信」の節の数字(cf/data/tanshin.json)を作る(数字の取り出し方は tanshin.py)。

TDnet の公開ページ(www.release.tdnet.info)は直近1か月分の開示しか載せないので、毎日動かして取りこぼさないようにする。
一度読んだ短信は tanshin.json の seen に残し、次からは読まない。
GitHub Actions(.github/workflows/update-cf-tanshin.yml)から実行される。
"""

import html
import io
import json
import os
import re
import time
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

import tanshin

TDNET = "https://www.release.tdnet.info/inbs/"
JST = timezone(timedelta(hours=9))
DAYS = int(os.environ.get("TANSHIN_DAYS", 31))
CF_DIR = Path(__file__).resolve().parent.parent
OUT_PATH = CF_DIR / "data" / "tanshin.json"
HEADERS = {"User-Agent": "Mozilla/5.0 (portal-cf-tanshin)"}

ROW_RE = re.compile(r"<tr>(.*?)</tr>", re.S)
CELL_RE = re.compile(r'<td[^>]*class="[^"]*kj(\w+)"[^>]*>(.*?)</td>', re.S)
HREF_RE = re.compile(r'href="([^"]+)"')
TAG_RE = re.compile(r"<[^>]+>")
# nonNumeric は中に nonFraction を含むことがあるので、別々に探す
NUM_RE = re.compile(r"<ix:nonFraction\b([^>]*?)(?:/>|>(.*?)</ix:nonFraction>)", re.S)
TEXT_RE = re.compile(r"<ix:nonNumeric\b([^>]*)>(.*?)</ix:nonNumeric>", re.S)
TEXTS = ("DocumentName", "FiscalYearEnd", "QuarterlyPeriod", "AccountingStandards", "FilingDate")
ATTR_RE = re.compile(r'([\w:]+)="([^"]*)"')


def log(*a):
    print(*a, flush=True)


def get(url, retries=4):
    last = None
    for attempt in range(1, retries + 1):
        try:
            r = requests.get(url, headers=HEADERS, timeout=60)
            if r.status_code == 404:
                return None
            if r.status_code == 200:
                return r
            last = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            last = e
        time.sleep(3 * attempt)
    raise RuntimeError(f"{url}: {last}")


def load(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def target_codes():
    return sorted(p.name for p in CF_DIR.iterdir() if p.is_dir() and re.fullmatch(r"\d{3}[0-9A-Z]", p.name) and (p / "index.html").exists())


def list_day(d):
    """その日の開示一覧を [(時刻, コード4桁, 社名, 表題, xbrl の URL)] で返す"""
    out = []
    for page in range(1, 200):
        r = get(f"{TDNET}I_list_{page:03d}_{d:%Y%m%d}.html")
        if r is None:
            break
        r.encoding = "utf-8"
        rows = 0
        for tr in ROW_RE.findall(r.text):
            cells = dict(CELL_RE.findall(tr))
            if "Code" not in cells:
                continue
            rows += 1
            xbrl = HREF_RE.search(cells.get("Xbrl", ""))
            text = lambda k: html.unescape(TAG_RE.sub("", cells.get(k, ""))).strip()
            out.append((text("Time"), text("Code")[:4], text("Name"), text("Title"), TDNET + xbrl.group(1) if xbrl else None))
        if rows < 100:
            break
    return out


def number(attrs, text):
    t = TAG_RE.sub("", text).strip().replace(",", "")
    if attrs.get("xsi:nil") == "true" or t in ("", "-", "－", "―"):
        return None
    try:
        v = float(t)
    except ValueError:
        return None
    v *= 10 ** int(attrs.get("scale", "0"))
    return -v if attrs.get("sign") == "-" else v


def read_summary(url):
    """決算短信の zip からサマリーの数字を [(要素名, コンテキスト, 値)] で返す"""
    r = get(url)
    if r is None or r.content[:2] != b"PK":
        raise RuntimeError(f"{url}: zip ではない応答")
    z = zipfile.ZipFile(io.BytesIO(r.content))
    facts = []
    for name in z.namelist():
        if "/Summary/" not in name or not name.endswith("ixbrl.htm"):
            continue
        text = z.read(name).decode("utf-8", "replace")
        for attrs, body in NUM_RE.findall(text):
            a = dict(ATTR_RE.findall(attrs))
            facts.append((a.get("name", ""), a.get("contextRef", ""), number(a, body)))
        for attrs, body in TEXT_RE.findall(text):
            a = dict(ATTR_RE.findall(attrs))
            if a.get("name", "").split(":")[-1] in TEXTS:
                facts.append((a.get("name", ""), a.get("contextRef", ""), html.unescape(TAG_RE.sub("", body)).strip()))
    return facts


def main():
    codes = set(target_codes())
    out = load(OUT_PATH, {})
    if out.get("v") != tanshin.VERSION:
        out = {"v": tanshin.VERSION, "companies": {}, "seen": []}
    comp = out["companies"]
    seen = set(out["seen"])
    today = datetime.now(JST).date()
    todo = []
    for i in range(DAYS):
        d = today - timedelta(days=i)
        if d.weekday() >= 5:
            continue
        try:
            rows = list_day(d)
        except Exception as e:  # noqa: BLE001
            log(f"{d}: {e}")
            continue
        for t, code, _, title, xbrl in rows:
            if code in codes and "決算短信" in title and xbrl and xbrl.rsplit("/", 1)[-1] not in seen:
                todo.append({"code": code, "date": d.isoformat(), "time": t, "title": title, "xbrl": xbrl})
    log(f"新しく読む決算短信: {len(todo)} 件")
    changed = 0
    for doc in sorted(todo, key=lambda x: (x["date"], x["time"])):
        name = doc["xbrl"].rsplit("/", 1)[-1]
        try:
            facts = read_summary(doc["xbrl"])
        except Exception as e:  # noqa: BLE001
            log(f"  {doc['code']} {name}: {e}")
            continue
        seen.add(name)
        if not facts:
            continue
        rec = tanshin.extract(facts, doc["title"])
        rec.update({"date": doc["date"], "time": doc["time"], "title": doc["title"], "doc": name})
        old = comp.get(doc["code"])
        # 訂正で古い期の短信が出直すこともあるので、決算期・四半期が同じか新しいものだけ使う
        if tanshin.usable(rec) and (old is None or tanshin.order(rec) >= tanshin.order(old)):
            comp[doc["code"]] = rec
            changed += 1
            log(f"  {doc['code']}: {doc['date']} {doc['title']}")
        time.sleep(1)
    for code in list(comp):
        if code not in codes:
            del comp[code]
    # TDnet から消えた短信は二度と一覧に出ないので、覚えておくのは直近の分だけでよい
    limit = (today - timedelta(days=DAYS + 10)).strftime("%Y%m%d")
    out["seen"] = sorted(s for s in seen if s[4:12] >= limit)
    if changed or "updated" not in out:
        out["updated"] = today.isoformat()
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n", encoding="utf-8")
    log(f"{changed} 社の短信を新しくしました。{len(comp)} 社の短信があります")


if __name__ == "__main__":
    main()
