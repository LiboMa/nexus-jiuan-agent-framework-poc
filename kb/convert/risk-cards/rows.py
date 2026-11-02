"""cards.json → 一张卡一行（入库版只留适用的卡）。被 make_xlsx.py / make_docx.mjs 的数据准备共用。"""
import collections
import json
import sys

HEAD = ['卡片编号', '费用类型', '一级分类', '费用编码', '审核线', '风险等级', '结论', '判断依据', '缺什么', '坚持通过时审批人认可的是', '定级理由', '一期可行性']


def rows(path):
    items = json.load(open(path, encoding='utf-8'))['items']
    dup = {code for code, n in collections.Counter(i['code'] for i in items).items() if n > 1}
    out = []
    for it in items:
        for c in it['cards']:
            line = '业务' if c['line'] == '业务线' else '财务'
            side = it['category'][:2] if it['code'] in dup else ''  # 共用编码：加「付款 / 收款」区分
            card_id = '-'.join(x for x in (it['code'], side, line) if x)
            na = c['verdict'] == '不适用'
            out.append({'卡片编号': card_id, '费用类型': it['name'], '一级分类': it['category'], '费用编码': it['code'], '审核线': c['line'],
                        '风险等级': c['level'] or '不适用', '结论': c['verdict'], '判断依据': c['basis'] or ('—' if na else ''),
                        '缺什么': c['missing'] or '—', '坚持通过时审批人认可的是': c['accepts'] or '—', '定级理由': it['why'],
                        '一期可行性': it['availability'], '_na': na})
    return out


if __name__ == '__main__':
    r = rows(sys.argv[1])
    print(len(r), sum(1 for x in r if not x['_na']))
    json.dump({'head': HEAD, 'rows': r}, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False)
