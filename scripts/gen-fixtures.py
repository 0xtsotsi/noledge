#!/usr/bin/env python3
"""Generate minimal-but-valid RAG extraction fixtures for every supported file
type. Office formats are real OOXML/ODF zip containers; images are generated via
sharp in a sibling Node script. Run from the repo root:

    python3 scripts/gen-fixtures.py

Each fixture embeds a unique sentinel phrase so extraction tests can assert that
the format-specific text actually round-trips through officeparser.
"""

import os
import zipfile

FIXTURES = os.path.join(
    os.path.dirname(__file__), "..", "src", "lib", "ai", "rag", "__fixtures__"
)
os.makedirs(FIXTURES, exist_ok=True)


def out(name):
    return os.path.join(FIXTURES, name)


def write_zip(name, entries):
    """Write a zip container. `entries` is a list of (arcname, bytes/str)."""
    path = out(name)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for arcname, data in entries:
            if isinstance(data, str):
                data = data.encode("utf-8")
            z.writestr(arcname, data)
    print(f"wrote {name}")


CONTENT_TYPES_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="{target}"/>'
    "</Relationships>"
)


# ---------- DOCX ----------
def gen_docx():
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>"
    )
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body>"
        "<w:p><w:r><w:t>Docx fixture sentinel: the quick brown fox.</w:t></w:r></w:p>"
        "<w:p><w:r><w:t>Second paragraph with WORDMARKER text.</w:t></w:r></w:p>"
        "</w:body></w:document>"
    )
    write_zip(
        "sample.docx",
        [
            ("[Content_Types].xml", content_types),
            ("_rels/.rels", CONTENT_TYPES_RELS.format(target="word/document.xml")),
            ("word/document.xml", document),
        ],
    )


# ---------- PPTX ----------
def gen_pptx():
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
        '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        "</Types>"
    )
    presentation = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>'
        "</p:presentation>"
    )
    pres_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>'
        "</Relationships>"
    )
    slide = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
        "<p:cSld><p:spTree>"
        "<p:sp><p:txBody>"
        "<a:p><a:r><a:t>Pptx fixture sentinel: SLIDEMARKER on slide one.</a:t></a:r></a:p>"
        "</p:txBody></p:sp>"
        "</p:spTree></p:cSld></p:sld>"
    )
    write_zip(
        "sample.pptx",
        [
            ("[Content_Types].xml", content_types),
            ("_rels/.rels", CONTENT_TYPES_RELS.format(target="ppt/presentation.xml")),
            ("ppt/presentation.xml", presentation),
            ("ppt/_rels/presentation.xml.rels", pres_rels),
            ("ppt/slides/slide1.xml", slide),
        ],
    )


# ---------- XLSX ----------
def gen_xlsx():
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
        "</Types>"
    )
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>'
        "</workbook>"
    )
    wb_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'
        "</Relationships>"
    )
    shared = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">'
        "<si><t>Xlsx fixture sentinel</t></si>"
        "<si><t>CELLMARKER value</t></si>"
        "</sst>"
    )
    sheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        "<sheetData>"
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
        "</sheetData></worksheet>"
    )
    write_zip(
        "sample.xlsx",
        [
            ("[Content_Types].xml", content_types),
            ("_rels/.rels", CONTENT_TYPES_RELS.format(target="xl/workbook.xml")),
            ("xl/workbook.xml", workbook),
            ("xl/_rels/workbook.xml.rels", wb_rels),
            ("xl/sharedStrings.xml", shared),
            ("xl/worksheets/sheet1.xml", sheet),
        ],
    )


# ---------- ODF (odt / odp / ods) ----------
ODF_MANIFEST = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">'
    '<manifest:file-entry manifest:full-path="/" manifest:media-type="{mime}"/>'
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>'
    "</manifest:manifest>"
)

ODF_NS = (
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
    'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
    'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"'
)


def gen_odf(name, mime, body):
    content = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f"<office:document-content {ODF_NS} office:version=\"1.2\">"
        "<office:body>"
        f"{body}"
        "</office:body></office:document-content>"
    )
    # mimetype must be the first entry and stored (uncompressed) per ODF spec.
    path = out(name)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(zipfile.ZipInfo("mimetype"), mime, compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/manifest.xml", ODF_MANIFEST.format(mime=mime))
        z.writestr("content.xml", content)
    print(f"wrote {name}")


def gen_odt():
    body = (
        "<office:text>"
        "<text:p>Odt fixture sentinel: TEXTMARKER paragraph.</text:p>"
        "</office:text>"
    )
    gen_odf("sample.odt", "application/vnd.oasis.opendocument.text", body)


def gen_odp():
    body = (
        "<office:presentation>"
        '<draw:page draw:name="page1">'
        "<draw:frame><draw:text-box>"
        "<text:p>Odp fixture sentinel: PRESENTMARKER on a page.</text:p>"
        "</draw:text-box></draw:frame>"
        "</draw:page>"
        "</office:presentation>"
    )
    gen_odf("sample.odp", "application/vnd.oasis.opendocument.presentation", body)


def gen_ods():
    body = (
        "<office:spreadsheet>"
        "<table:table table:name=\"Sheet1\">"
        "<table:table-row>"
        "<table:table-cell><text:p>Ods fixture sentinel</text:p></table:table-cell>"
        "<table:table-cell><text:p>SPREADMARKER</text:p></table:table-cell>"
        "</table:table-row>"
        "</table:table>"
        "</office:spreadsheet>"
    )
    gen_odf("sample.ods", "application/vnd.oasis.opendocument.spreadsheet", body)


# ---------- RTF ----------
def gen_rtf():
    rtf = (
        r"{\rtf1\ansi\deff0{\fonttbl{\f0 Times New Roman;}}"
        r"\f0\fs24 Rtf fixture sentinel: RICHMARKER text body.\par}"
    )
    with open(out("sample.rtf"), "w", encoding="ascii") as f:
        f.write(rtf)
    print("wrote sample.rtf")


# ---------- HTML ----------
def gen_html():
    html = (
        "<!doctype html><html><head><title>HTML fixture</title>"
        "<style>.x{color:red}</style><script>var a=1;</script></head>"
        "<body><h1>Html fixture sentinel</h1>"
        "<p>A paragraph containing HTMLMARKER content.</p></body></html>"
    )
    with open(out("sample.html"), "w", encoding="utf-8") as f:
        f.write(html)
    print("wrote sample.html")


# ---------- CSV ----------
def gen_csv():
    csv = "name,note\nCsv fixture sentinel,CSVMARKER\nrow two,more data\n"
    with open(out("sample.csv"), "w", encoding="utf-8") as f:
        f.write(csv)
    print("wrote sample.csv")


# ---------- JSON ----------
def gen_json():
    j = '{"sentinel": "Json fixture sentinel", "marker": "JSONMARKER", "n": 42}'
    with open(out("sample.json"), "w", encoding="utf-8") as f:
        f.write(j)
    print("wrote sample.json")


if __name__ == "__main__":
    gen_docx()
    gen_pptx()
    gen_xlsx()
    gen_odt()
    gen_odp()
    gen_ods()
    gen_rtf()
    gen_html()
    gen_csv()
    gen_json()
    print("done")
