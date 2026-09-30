"""標準ライブラリだけで .xlsx のシートを読む最小実装（openpyxl が入れられない環境用）。

read_sheet(path_or_bytes, index=0) → 行のリスト（各行はセル文字列のリスト、空セルは ""）。
数式の結果・数値・共有文字列・インライン文字列に対応。書式や日付の変換はしない。
"""
import io, re, zipfile
import xml.etree.ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"


def _col(ref):
    n = 0
    for ch in re.match(r"[A-Z]+", ref).group():
        n = n * 26 + ord(ch) - 64
    return n - 1


def sheet_names(src):
    z = zipfile.ZipFile(io.BytesIO(src) if isinstance(src, bytes) else src)
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    return [s.get("name") for s in wb.find("m:sheets", NS)]


def read_sheet(src, index=0):
    z = zipfile.ZipFile(io.BytesIO(src) if isinstance(src, bytes) else src)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            shared.append("".join(t.text or "" for t in si.iter("{%s}t" % NS["m"])))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rid = wb.find("m:sheets", NS)[index].get(REL)
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    target = next(r.get("Target") for r in rels if r.get("Id") == rid)
    target = target.lstrip("/")
    if not target.startswith("xl/"):
        target = "xl/" + target
    rows = []
    for row in ET.fromstring(z.read(target)).iter("{%s}row" % NS["m"]):
        cells = {}
        for c in row.findall("m:c", NS):
            t, v = c.get("t"), c.find("m:v", NS)
            if t == "s" and v is not None:
                val = shared[int(v.text)]
            elif t == "inlineStr":
                val = "".join(x.text or "" for x in c.iter("{%s}t" % NS["m"]))
            else:
                val = v.text if v is not None else ""
            cells[_col(c.get("r"))] = val
        r = int(row.get("r")) - 1
        while len(rows) < r:
            rows.append([])
        rows.append([cells.get(i, "") for i in range(max(cells) + 1)] if cells else [])
    return rows
