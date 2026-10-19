"""生成调用测试用的示例附件（全部虚构，与种子单据对得上），写到 app/samples/，并写 manifest.json。

在本机运行一次，生成的文件随 PoC 一起发布；内容固定，重复运行得到同样的文件。依赖 Pillow、reportlab、openpyxl、python-docx：
    <有这些库的 python> -I audit-nexus/poc/tools/make-samples.py audit-nexus/poc/app/samples

FYBX-POC-001（示例子公司甲，销售一部，北京客户拜访差旅 1,280 元）= 高铁往返 2 × 350 元 + 北京住宿 1 晚 580 元。
DGZF-POC-002（示例子公司乙，信息系统运维服务尾款 52,000 元）配一份运维服务验收报告。
"""
import datetime
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else 'app/samples')
FIXED = datetime.datetime(2026, 10, 15, 9, 0, 0)
FONT = '/System/Library/Fonts/Hiragino Sans GB.ttc'

HOTEL = {
    'title': '电子发票（普通发票）（虚构样例）',
    'number': '26110000000000001234（虚构）',
    'date': '2026年10月11日',
    'buyer': '示例子公司甲（虚构）',
    'buyerTaxId': '91000000MA00000000（虚构）',
    'seller': '示例酒店管理有限公司北京分公司（虚构）',
    'sellerTaxId': '91110000MA00000001（虚构）',
    'item': '*住宿服务*住宿费（2026-10-10 入住，2026-10-11 离店，1 晚）',
    'amount': '547.17', 'taxRate': '6%', 'tax': '32.83', 'total': '580.00', 'totalCn': '伍佰捌拾圆整',
    'remark': '入住人：张晓明（虚构）；房型：商务大床房',
}
TRAINS = [
    {'date': '2026-10-10', 'train': 'G112', 'from': '济南西', 'to': '北京南', 'seat': '二等座', 'fare': '350.00'},
    {'date': '2026-10-11', 'train': 'G117', 'from': '北京南', 'to': '济南西', 'seat': '二等座', 'fare': '350.00'},
]


def invoice_png(path):
    width, height = 1400, 860
    image = Image.new('RGB', (width, height), 'white')
    draw = ImageDraw.Draw(image)
    big, mid, small = (ImageFont.truetype(FONT, size) for size in (40, 26, 22))
    ink, brown = (30, 30, 30), (150, 70, 40)
    draw.rectangle([30, 30, width - 30, height - 30], outline=brown, width=3)
    draw.text((width // 2, 70), HOTEL['title'], font=big, fill=brown, anchor='mm')
    draw.text((width - 60, 120), f"发票号码：{HOTEL['number']}", font=small, fill=ink, anchor='rm')
    draw.text((width - 60, 155), f"开票日期：{HOTEL['date']}", font=small, fill=ink, anchor='rm')
    draw.rectangle([60, 190, width - 60, 330], outline=brown, width=2)
    draw.line([width // 2, 190, width // 2, 330], fill=brown, width=2)
    draw.text((80, 210), '购买方', font=mid, fill=brown)
    draw.text((80, 250), f"名称：{HOTEL['buyer']}", font=small, fill=ink)
    draw.text((80, 285), f"统一社会信用代码：{HOTEL['buyerTaxId']}", font=small, fill=ink)
    draw.text((width // 2 + 20, 210), '销售方', font=mid, fill=brown)
    draw.text((width // 2 + 20, 250), f"名称：{HOTEL['seller']}", font=small, fill=ink)
    draw.text((width // 2 + 20, 285), f"统一社会信用代码：{HOTEL['sellerTaxId']}", font=small, fill=ink)
    columns = [(80, '项目名称'), (760, '数量'), (860, '金额'), (1010, '税率'), (1120, '税额')]
    draw.rectangle([60, 350, width - 60, 560], outline=brown, width=2)
    for x, label in columns:
        draw.text((x, 370), label, font=mid, fill=brown)
    for x, value in zip([c[0] for c in columns], [HOTEL['item'], '1 晚', HOTEL['amount'], HOTEL['taxRate'], HOTEL['tax']]):
        draw.text((x, 430), value, font=small, fill=ink)
    draw.text((80, 600), f"价税合计（大写）：{HOTEL['totalCn']}", font=mid, fill=ink)
    draw.text((width - 80, 600), f"（小写）¥{HOTEL['total']}", font=mid, fill=ink, anchor='ra')
    draw.text((80, 660), f"备注：{HOTEL['remark']}", font=small, fill=ink)
    draw.text((80, 720), '开票人：李娜（虚构）', font=small, fill=ink)
    draw.text((width // 2, height - 70), '虚构样例 · 仅供 PoC 测试 · 不是真实发票', font=mid, fill=(200, 40, 40), anchor='mm')
    image.save(path, 'PNG', optimize=True)


def invoice_pdf(path):
    from reportlab.lib.pagesizes import A5, landscape
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfgen import canvas
    pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
    width, height = landscape(A5)
    page = canvas.Canvas(str(path), pagesize=(width, height), invariant=1)
    page.setTitle('住宿费电子发票（虚构样例）')
    page.setFont('STSong-Light', 16)
    page.drawCentredString(width / 2, height - 40, HOTEL['title'])
    page.setFont('STSong-Light', 10)
    lines = [
        f"发票号码：{HOTEL['number']}    开票日期：{HOTEL['date']}",
        f"购买方：{HOTEL['buyer']}    统一社会信用代码：{HOTEL['buyerTaxId']}",
        f"销售方：{HOTEL['seller']}    统一社会信用代码：{HOTEL['sellerTaxId']}",
        f"项目：{HOTEL['item']}",
        f"数量：1 晚    金额：{HOTEL['amount']}    税率：{HOTEL['taxRate']}    税额：{HOTEL['tax']}",
        f"价税合计：{HOTEL['totalCn']}（¥{HOTEL['total']}）",
        f"备注：{HOTEL['remark']}",
        '虚构样例，仅供 PoC 测试，不是真实发票。',
    ]
    y = height - 80
    for line in lines:
        page.drawString(36, y, line)
        y -= 22
    page.showPage()
    page.save()


def invoice_json(path):
    data = {
        'note': '虚构样例，仅供 PoC 测试，不是真实票据。',
        'document': 'FYBX-POC-001',
        'invoices': [
            {'type': '电子发票（普通发票）', 'number': HOTEL['number'], 'issueDate': '2026-10-11', 'buyer': HOTEL['buyer'], 'seller': HOTEL['seller'],
             'item': '住宿费', 'city': '北京', 'nights': 1, 'checkIn': '2026-10-10', 'checkOut': '2026-10-11',
             'amountExcludingTax': 547.17, 'taxRate': 0.06, 'tax': 32.83, 'total': 580.00, 'currency': 'CNY'},
            *[{'type': '铁路电子客票', 'number': f'E2026101{index}000000（虚构）', 'issueDate': trip['date'], 'passenger': '张晓明（虚构）',
               'train': trip['train'], 'from': trip['from'], 'to': trip['to'], 'seat': trip['seat'], 'total': float(trip['fare']), 'currency': 'CNY'}
              for index, trip in enumerate(TRAINS, start=1)],
        ],
        'sum': 1280.00,
    }
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def expense_xlsx(path):
    from openpyxl import Workbook
    from openpyxl.styles import Font
    book = Workbook()
    sheet = book.active
    sheet.title = '报销明细'
    sheet.append(['单据号', '日期', '费用类型', '明细', '城市', '票据', '金额（元）', '备注'])
    for cell in sheet[1]:
        cell.font = Font(bold=True)
    for trip in TRAINS:
        sheet.append(['FYBX-POC-001', trip['date'], '差旅费', f"高铁 {trip['train']} {trip['from']}→{trip['to']}（{trip['seat']}）", '北京',
                      '铁路电子客票', float(trip['fare']), '拜访客户（虚构）'])
    sheet.append(['FYBX-POC-001', '2026-10-10', '差旅费', '住宿 1 晚（2026-10-10 至 2026-10-11）', '北京', '电子发票（普通发票）', 580.00, '商务大床房'])
    sheet.append(['', '', '', '合计', '', '', '=SUM(G2:G4)', ''])
    for column, width in zip('ABCDEFGH', [16, 12, 10, 44, 8, 22, 12, 18]):
        sheet.column_dimensions[column].width = width
    notes = book.create_sheet('说明')
    for row in [['本表为虚构样例，仅供 PoC 测试。'], ['申请人：张晓明（虚构），销售一部（虚构）'], ['出差事由：拜访客户，确认续约条款（虚构）']]:
        notes.append(row)
    book.properties.creator = 'andon-finance PoC'
    book.properties.created = FIXED
    book.properties.modified = FIXED
    book.save(path)


POLICY_MD = """# 差旅与住宿报销制度（示例子公司甲，虚构）

> 虚构样例，仅供 PoC 测试，不是任何公司的真实制度。

## 一、住宿标准

| 城市 | 每晚上限（含税） |
|---|---|
| 北京、上海、广州、深圳 | 600 元 |
| 其他城市 | 450 元 |

1. 超标部分由员工自理。
2. 确因会议主办方指定酒店而超标的，须附会议通知。
3. 住宿发票的入住人、入住与离店日期须与出差行程一致。

## 二、交通标准

1. 城际交通优先乘坐高铁二等座；乘坐一等座或飞机须事先说明理由。
2. 市内交通凭票据实报销，单日不超过 100 元。

## 三、报销时限与材料

1. 费用发生后 90 天内提交报销；超过 90 天的，须写明原因并由部门负责人另行签字。
2. 报销须附出差事由、行程与全部票据；电子票据须附电子文件或可核验的票据信息。
"""


def acceptance_docx(path):
    from docx import Document
    document = Document()
    document.core_properties.author = 'andon-finance PoC'
    document.core_properties.created = FIXED
    document.core_properties.modified = FIXED
    document.add_heading('信息系统运维服务验收报告（虚构样例）', level=1)
    document.add_paragraph('虚构样例，仅供 PoC 测试，不是真实文件。')
    table = document.add_table(rows=0, cols=2)
    for label, value in [('委托方', '示例子公司乙（虚构）'), ('受托方', '示例信息技术有限公司（虚构）'), ('合同', '技术服务合同（虚构），合同总价 50,000.00 元（含税）'),
                         ('服务期间', '2026 年 1 月 1 日至 2026 年 9 月 30 日'), ('费用承担部门', '信息技术部（虚构）'),
                         ('验收日期', '2026 年 10 月 12 日'), ('验收结论', '合格'), ('本次申请付款', '尾款 52,000.00 元')]:
        cells = table.add_row().cells
        cells[0].text, cells[1].text = label, value
    document.add_heading('验收意见', level=2)
    document.add_paragraph('运维期间系统可用率 99.95%，故障均在约定时限内处理完毕；当期服务报告已提交。')
    document.add_paragraph('注：本次申请付款 52,000.00 元与合同总价 50,000.00 元不一致，需核对是否有补充协议。')
    document.add_paragraph('验收人：周婷（虚构）    审核人：吴昊（虚构）')
    document.save(path)


SAMPLES = [
    ('hotel-invoice-png', '住宿发票-FYBX-POC-001.png', '住宿费电子发票图片：北京 1 晚 580 元（虚构）', 'FYBX-POC-001', invoice_png),
    ('hotel-invoice-pdf', '住宿发票-FYBX-POC-001.pdf', '同一张住宿费发票的 PDF（虚构）', 'FYBX-POC-001', invoice_pdf),
    ('invoice-data-json', '票据数据-FYBX-POC-001.json', '高铁票与住宿发票的结构化数据，合计 1,280 元（虚构）', 'FYBX-POC-001', invoice_json),
    ('expense-lines-xlsx', '报销明细-FYBX-POC-001.xlsx', '报销明细表：高铁往返与住宿三行（虚构）', 'FYBX-POC-001', expense_xlsx),
    ('travel-policy-md', '差旅与住宿报销制度-示例子公司甲.md', '差旅与住宿报销制度（虚构）', None, lambda path: path.write_text(POLICY_MD, encoding='utf-8')),
    ('acceptance-docx', '运维服务验收报告-DGZF-POC-002.docx', '运维服务验收报告：尾款 52,000 元与合同总价不一致（虚构）', 'DGZF-POC-002', acceptance_docx),
]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = []
    for sample_id, name, description, document, build in SAMPLES:
        build(OUT / name)
        entry = {'id': sample_id, 'file': name, 'description': description}
        if document:
            entry['document'] = document
        manifest.append(entry)
        print(f'{name}: {(OUT / name).stat().st_size} bytes')
    (OUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
