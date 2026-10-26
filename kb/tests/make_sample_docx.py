"""生成仿真审批矩阵文档 kb/tests/fixtures/sample-matrix.docx（内容全部虚构，结构照 parse_rules.py 适配的格式）。

    python3 -B kb/tests/make_sample_docx.py      # 重新生成；输出是确定的（固定时间戳），重跑不产生改动

单元测试和页面测试只用这份；客户的真实制度只在本机和测试台的知识库里，不进仓库。
"""
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

OUT = Path(__file__).resolve().parent / "fixtures" / "sample-matrix.docx"
NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

PREFACE = [
    "某虚构集团财务审批授权办法（仿真样例，内容虚构）",
    "制度说明",
    "（一）目的：为规范虚构集团的财务审批，明确各事项的审批路径与最终审批人。",
    "（二）适用范围：甲板块、乙板块、丙板块的全部财务事项。",
    "图例说明",
    "①②③ 表示审批顺序，数字相同表示同步处理；√ 表示该行最后一道审批；▲ 表示审批完成后办理，不占审批顺序。",
]
# 每章：标题、章说明、表头、行；行里的 None 表示与上一行纵向合并（vMerge continue）
CHAPTERS = [
    ("一、立项审批", "立项审批以立项报告为准，金额按项目总投资计。",
     ["序号", "业务事项", "板块", "金额档 / 触发情形", "经办人", "部门主管", "财务经理", "总经理", "适用范围与控制要点"],
     [["1.1", "新产品立项", "甲板块", "总投资≤50 万", "①", "②", "③√", "", "需附立项报告"],
      ["1.2", None, "甲板块", "总投资＞50 万", "①", "②", "③", "④√", "需附可行性研究报告"],
      ["1.3", "设备更新立项", "乙板块", "不限金额", "①", "②√", "▲", "", "设备清单与报价单"],
      ["1.4", "设备更新立项", "丙板块", "不适用", "不适用", "不适用", "不适用", "不适用", ""]]),
    ("三、合同用印审批", "合同用印以法务审核意见为前提，纸质合同由行政部归档。",
     ["序号", "业务事项", "板块", "金额档 / 触发情形", "经办人", "法务审核", "财务经理", "总经理", "适用范围与控制要点"],
     [["3.1", "采购合同用印", "甲板块", "总金额≤20 万", "①", "②", "③√", "", "合同文本与比价记录"],
      ["3.2", None, "甲板块", "总金额＞20 万", "①", "②", "③", "④√", "合同文本、比价记录与付款计划"],
      ["3.3", "租赁合同用印", "乙板块", "不限金额", "①", "②", "③√", "", "租赁物权属证明"]]),
    ("五、付款审批", "付款审批以合同和发票为依据，单笔金额按本次付款计。",
     ["序号", "业务事项", "板块", "金额档 / 触发情形", "经办人", "部门主管", "财务经理", "总经理", "备注", "适用范围与控制要点"],
     [["5.1", "供应商货款", "甲板块", "单笔≤1 万", "①", "②√", "", "", "月结", "合同、发票、入库单一致"],
      ["5.2", None, "甲板块", "单笔 ＞1 万", "①", "②", "③√", "", "月结", "合同、发票、入库单一致"],
      ["5.3", "办公场地租金", "乙板块", "不限金额", "①", "②", "③", "④√", "", "租赁合同与发票"],
      ["5.4", "税款缴纳", "全部板块", "单笔 ＞1 万", "①", "", "②√", "▲", "", "税务通知书"],
      ["5.5", "员工借款", "丙板块", "不适用", "不适用", "不适用", "不适用", "不适用", "", ""]]),
]


def para(text):
    return f'<w:p><w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>'


def cell(text, merge=None):
    pr = f'<w:tcPr><w:vMerge w:val="{merge}"/></w:tcPr>' if merge == "restart" else ('<w:tcPr><w:vMerge/></w:tcPr>' if merge == "continue" else "")
    return f"<w:tc>{pr}{para(text or '')}</w:tc>"


def table(header, rows):
    out = ["<w:tbl>", "<w:tr>" + "".join(cell(h) for h in header) + "</w:tr>"]
    for i, row in enumerate(rows):
        cells = []
        for j, value in enumerate(row):
            next_continues = i + 1 < len(rows) and rows[i + 1][j] is None
            if value is None:
                cells.append(cell("", "continue"))
            else:
                cells.append(cell(value, "restart" if next_continues else None))
        out.append("<w:tr>" + "".join(cells) + "</w:tr>")
    out.append("</w:tbl>")
    return "".join(out)


def document_xml():
    body = [para(t) for t in PREFACE]
    for title, note, header, rows in CHAPTERS:
        body += [para(title), para(note), table(header, rows)]
    return f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {NS}><w:body>{"".join(body)}</w:body></w:document>'


PARTS = {
    "[Content_Types].xml": ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                            '<Default Extension="xml" ContentType="application/xml"/>'
                            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                            '</Types>'),
    "_rels/.rels": ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
                    '</Relationships>'),
}


def build(path=OUT):
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, text in [*PARTS.items(), ("word/document.xml", document_xml())]:
            info = zipfile.ZipInfo(name, date_time=(2026, 10, 26, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, text.encode("utf-8"))
    return path


if __name__ == "__main__":
    print(build(Path(sys.argv[1]) if len(sys.argv) > 1 else OUT))
