#!/usr/bin/env python3
"""e-Stat の新着（政府統計コード・公開日）から、その日に公表された表を探して中身をテキストにする。

- released(toukei, day): ファイル一覧（新しい順）から公開日が day の表を返す。
  [{"title", "path", "period", "url", "type", "pdf"}]。Excel → CSV の順に1つ選ぶ（無ければ url は None）。PDF があれば pdf に URL
- table_text(url, type): Excel（xlsx）と CSV を「列をタブで区切った行」のテキストにする（分析の材料）。
  シートが多い・行が長い表は先頭から上限まで。古い Excel 形式（xls）は標準ライブラリでは読めないので None
標準ライブラリのみ（xlsx は xlsx.py）。
"""
import csv, html, io, os, re, shutil, subprocess, tempfile, urllib.request

import xlsx

ESTAT = "https://www.e-stat.go.jp"
LIST = ESTAT + "/stat-search/files?page={page}&layout=dataset&toukei={toukei}"
TYPE_ORDER = {"EXCEL": 0, "CSV": 1}
MAX_SHEETS = 4
MAX_ROWS = 80
MAX_CHARS = 12000


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "boj-stats-collector/1.0"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.read()


def _text(x):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", x))).strip()


def released(toukei, day, pages=2):
    """公開（更新）日が day のファイルを、一覧の並び（新しい順）で返す。"""
    out = []
    for page in range(1, pages + 1):
        s = _get(LIST.format(page=page, toukei=toukei)).decode("utf-8", "replace")
        arts = [a.split("</article>")[0] for a in re.split(r'<article class="stat-resource_list-item', s)[1:]]
        older = False
        for a in arts:
            d = re.search(r"公開（更新）日&nbsp;&nbsp;</span>\s*([\d-]+)", a)
            if not d:
                continue
            if d.group(1) != day:
                older = older or d.group(1) < day
                continue
            items = [_text(x) for x in re.findall(r'<li class="stat-resource_list-detail-item">(.*?)</li>', a, re.S)]
            period = re.search(r"調査年月&nbsp;&nbsp;</span>\s*([^<]+)", a)
            title = _text(a.split("</ul>")[-1]) if "</ul>" in a else ""
            title = re.sub(r"^(EXCEL|CSV|PDF|DB|API|XML|ZIP|その他|\s)+", "", title).strip()
            dls = re.findall(r'file-download\?statInfId=(\d+)&(?:amp;)?fileKind=(\d)".*?data-file_type="(\w+)"', a, re.S)
            dls.sort(key=lambda x: TYPE_ORDER.get(x[2], 9))
            best = next((x for x in dls if x[2] in TYPE_ORDER), None)
            out.append({
                "title": title or (items[0] if items else ""),
                "path": items[1] if len(items) > 1 else "",
                "period": period.group(1).strip() if period else "",
                "url": f"{ESTAT}/stat-search/file-download?statInfId={best[0]}&fileKind={best[1]}" if best else None,
                "type": best[2] if best else (dls[0][2] if dls else ""),
                # Excel・CSV が無い表は PDF の URL（日次チェックでダウンロードして読む）
                "pdf": next((f"{ESTAT}/stat-search/file-download?statInfId={u}&fileKind={k}" for u, k, t in dls if t == "PDF"), None),
            })
        if older or not arts:
            break
    return out


def _cell(c):
    c = (c or "").strip()
    if re.fullmatch(r"-?\d+\.\d{6,}", c):  # Excel の浮動小数の誤差（2.2999999999）を丸める
        c = f"{float(c):.4g}" if abs(float(c)) < 1e4 else str(round(float(c), 1))
    return c


def _rows_text(rows):
    lines = []
    for r in rows:
        cells = [_cell(c) for c in r]
        while cells and not cells[-1]:
            cells.pop()
        if any(cells):
            lines.append("\t".join(cells))
        if len(lines) >= MAX_ROWS:
            lines.append("…（以下省略）")
            break
    return "\n".join(lines)


def table_text(url, type_, limit=MAX_CHARS):
    if not url:
        return None
    body = _get(url)
    if type_ == "CSV" or not body.startswith(b"PK"):
        if body[:8].startswith(b"\xd0\xcf\x11\xe0"):  # 旧形式の Excel（xls）
            return None
        for enc in ("utf-8-sig", "cp932"):
            try:
                text = body.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        else:
            return None
        return _rows_text(csv.reader(io.StringIO(text)))[:limit]
    parts = []
    for i in range(MAX_SHEETS):
        try:
            rows = xlsx.read_sheet(body, i)
        except Exception:
            break
        t = _rows_text(rows)
        if t:
            parts.append(f"## シート{i + 1}\n{t}")
        if sum(len(p) for p in parts) > limit:
            break
    return "\n\n".join(parts)[:limit] or None


def pdf_text(url, pages=4, limit=MAX_CHARS):
    """PDF の先頭ページをテキストにする（pdftotext があるときだけ。無ければ None で、PDF を直接読む）。"""
    if not url or not shutil.which("pdftotext"):
        return None
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "a.pdf")
        with open(path, "wb") as f:
            f.write(_get(url))
        r = subprocess.run(["pdftotext", "-layout", "-l", str(pages), path, "-"], capture_output=True, timeout=120)
    text = re.sub(r"[ \t]{3,}", "  ", r.stdout.decode("utf-8", "replace"))
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text[:limit] or None


if __name__ == "__main__":
    import sys
    for t in released(sys.argv[1], sys.argv[2]):
        print(t)
        if len(sys.argv) > 3:
            print((table_text(t["url"], t["type"]) or "")[:1500])
