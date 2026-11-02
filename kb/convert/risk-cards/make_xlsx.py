"""整理表 .xlsx：「风险判断卡」一张卡一行（530 行，含业务线不适用的卡）+「说明」（来源、口径、计数用公式）。
用法：python make_xlsx.py <rows.json> <out.xlsx> <源文件名>"""
import json
import sys
from datetime import date

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

data = json.load(open(sys.argv[1], encoding='utf-8'))
head, rows = data['head'], data['rows']
FONT = 'Arial'
thin = Side(style='thin', color='D9DDE3')
wb = Workbook()
ws = wb.active
ws.title = '风险判断卡'
ws.append(head)
for r in rows:
    ws.append([r[h] for h in head])
widths = {'卡片编号': 20, '费用类型': 22, '一级分类': 18, '费用编码': 12, '审核线': 8, '风险等级': 9, '结论': 10, '判断依据': 48,
          '缺什么': 30, '坚持通过时审批人认可的是': 44, '定级理由': 36, '一期可行性': 16}
for i, h in enumerate(head, start=1):
    ws.column_dimensions[get_column_letter(i)].width = widths[h]
hfill = PatternFill('solid', start_color='EEF3FF')
for cell in ws[1]:
    cell.font = Font(name=FONT, bold=True, color='0E1B33')
    cell.fill = hfill
    cell.alignment = Alignment(vertical='center', wrap_text=True)
    cell.border = Border(bottom=thin)
tone = {'高风险': 'C4373C', '中风险': '9A6312', '低风险': '0B7A55'}
for row in ws.iter_rows(min_row=2):
    for cell in row:
        cell.font = Font(name=FONT, color='0E1B33')
        cell.alignment = Alignment(vertical='top', wrap_text=True)
        cell.border = Border(bottom=thin)
    lv = row[head.index('风险等级')]
    if lv.value in tone:
        lv.font = Font(name=FONT, bold=True, color=tone[lv.value])
    if row[head.index('结论')].value == '不适用':
        for cell in row:
            cell.font = Font(name=FONT, color='8A97AB')
ws.freeze_panes = 'C2'
ws.auto_filter.ref = f"A1:{get_column_letter(len(head))}{len(rows) + 1}"
ws.row_dimensions[1].height = 30

notes = wb.create_sheet('说明')
n = len(rows) + 1
lv_col, vd_col, line_col = (get_column_letter(head.index(h) + 1) for h in ('风险等级', '结论', '审核线'))
notes.column_dimensions['A'].width = 30
notes.column_dimensions['B'].width = 16
notes.column_dimensions['C'].width = 70
lines = [
    ('来源', sys.argv[3], '原页面只读解析，未改动原文；本表由测试台工具生成'),
    ('生成日期', date.today().isoformat(), ''),
    ('', '', ''),
    ('计数（公式，随表更新）', '', ''),
    ('卡片总数', f"=COUNTA('风险判断卡'!A2:A{n})", '每个末级费用类型业务线、财务线各一张'),
    ('费用类型数', f"=SUMPRODUCT(1/COUNTIFS('风险判断卡'!B2:B{n},'风险判断卡'!B2:B{n},'风险判断卡'!C2:C{n},'风险判断卡'!C2:C{n}))",
     '按「费用类型 + 一级分类」去重（同名费用在付款、收款各算一个）'),
    ('业务线 不适用', f"=COUNTIFS('风险判断卡'!{line_col}2:{line_col}{n},\"业务线\",'风险判断卡'!{vd_col}2:{vd_col}{n},\"不适用\")",
     '原页面「业务线不适用·不打扰他」；入库版 Word 不收这些卡'),
    ('高风险', f"=COUNTIF('风险判断卡'!{lv_col}2:{lv_col}{n},\"高风险\")", '规则命中时的严重程度，不是「这么多单会被拦」'),
    ('中风险', f"=COUNTIF('风险判断卡'!{lv_col}2:{lv_col}{n},\"中风险\")", ''),
    ('低风险', f"=COUNTIF('风险判断卡'!{lv_col}2:{lv_col}{n},\"低风险\")", ''),
    ('结论：不过', f"=COUNTIF('风险判断卡'!{vd_col}2:{vd_col}{n},\"不过\")", '一期旁路不阻断：「不过」= 进复核队列并推提示'),
    ('结论：补件后过', f"=COUNTIF('风险判断卡'!{vd_col}2:{vd_col}{n},\"补件后过\")", ''),
    ('结论：过·留痕', f"=COUNTIF('风险判断卡'!{vd_col}2:{vd_col}{n},\"过·留痕\")", ''),
    ('', '', ''),
    ('口径', '', ''),
    ('判断依据', '', '花括号 {金额}{应到层级} 等是单据字段的占位符，审单时代入，原样保留'),
    ('卡片编号', '', '费用编码-业务 / 费用编码-财务；同一编码用在付款和收款两个费用类型时，中间加「付款 / 收款」'),
    ('原页面的说法', '', '页头写「262 个末级费用类型」，实际卡片是 265 个费用类型（文件名「265项」）；以卡片为准'),
]
for a, b, c in lines:
    notes.append([a, b, c])
for row in notes.iter_rows():
    for cell in row:
        cell.font = Font(name=FONT, color='0E1B33', bold=cell.column == 1 and cell.value in ('计数（公式，随表更新）', '口径'))
        cell.alignment = Alignment(vertical='top', wrap_text=True)
wb.save(sys.argv[2])
print('saved', sys.argv[2])
