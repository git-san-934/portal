"""投資分析ページ(cf/<コード>/)の銘柄について、TDnet に出た決算短信のサマリーの XBRL を読む。

TDnet の公開ページ(www.release.tdnet.info)は直近1か月分の開示しか載せないので、毎日動かして取りこぼさないようにする。
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

TDNET = "https://www.release.tdnet.info/inbs/"
JST = timezone(timedelta(hours=9))
DAYS = int(os.environ.get("TANSHIN_DAYS", 31))
CF_DIR = Path(__file__).resolve().parent.parent
RAW_DIR = CF_DIR / "build" / "tanshin_raw"  # 一時: 要素の確認用
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
            cells = {k: v for k, v in CELL_RE.findall(tr)}
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
        base = name.split("/")[-1]
        if "/Summary/" not in name or not base.endswith("ixbrl.htm"):
            continue
        text = z.read(name).decode("utf-8", "replace")
        for attrs, body in NUM_RE.findall(text):
            a = dict(ATTR_RE.findall(attrs))
            facts.append((a.get("name", ""), a.get("contextRef", ""), number(a, body)))
        for attrs, body in TEXT_RE.findall(text):
            a = dict(ATTR_RE.findall(attrs))
            if a.get("name", "").split(":")[-1] in TEXTS:
                facts.append((a.get("name", ""), a.get("contextRef", ""), html.unescape(TAG_RE.sub("", body)).strip()))
    return facts, sorted(z.namelist())


def main():
    codes = set(target_codes())
    today = datetime.now(JST).date()
    found, samples = {}, {}
    for i in range(DAYS):
        d = today - timedelta(days=i)
        if d.weekday() >= 5:
            continue
        try:
            rows = list_day(d)
        except Exception as e:  # noqa: BLE001
            log(f"{d}: {e}")
            continue
        n = 0
        for t, code, name, title, xbrl in rows:
            if code in codes and "決算短信" in title and xbrl:
                found.setdefault(code, []).append({"date": d.isoformat(), "time": t, "title": title, "xbrl": xbrl})
                n += 1
            elif "決算短信" in title and xbrl:  # 一時: 形式の違いを見るための見本
                kind = re.sub(r"\d+", "#", title)
                if samples.get(kind, 0) < 2 and len(found.get("_sample", [])) < 60:
                    samples[kind] = samples.get(kind, 0) + 1
                    found.setdefault("_sample", []).append({"date": d.isoformat(), "time": t, "code": code, "title": title, "xbrl": xbrl})
        log(f"{d}: 開示 {len(rows)} 件, 対象の決算短信 {n} 件")
    log(f"決算短信が見つかった銘柄: {len(found) - ('_sample' in found)} / {len(codes)}")
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    for code, docs in sorted(found.items()):
        for doc in docs:
            try:
                doc["facts"], doc["files"] = read_summary(doc["xbrl"])
            except Exception as e:  # noqa: BLE001
                log(f"  {code} {doc['xbrl']}: {e}")
            time.sleep(1)
        (RAW_DIR / f"{code}.json").write_text(json.dumps(docs, ensure_ascii=False, indent=0), encoding="utf-8")
        log(f"  {code}: {[d['title'] for d in docs]}")


if __name__ == "__main__":
    main()
