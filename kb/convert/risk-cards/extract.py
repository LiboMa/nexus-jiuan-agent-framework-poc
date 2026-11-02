"""审批风险判断卡 HTML → JSON（只读解析，不执行页面脚本）。用法：python3 -I extract.py <in.html> <out.json>"""
import json, sys
from html.parser import HTMLParser

class P(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.items, self.lead, self.tiles = [], [], []
        self.stack, self.item, self.card, self.field, self.buf = [], None, None, None, []
        self.in_lead = self.in_tile = False
    def handle_starttag(self, tag, attrs):
        a = dict(attrs); cls = (a.get('class') or '').split()
        self.stack.append((tag, cls))
        if tag == 'p' and 'lead' in cls: self.in_lead = True; self.buf = []
        if tag == 'section' and 'item' in cls:
            self.item = {'category': a.get('data-cat', ''), 'bl': a.get('data-bl', ''), 'fl': a.get('data-fl', ''), 'cards': []}
        if self.item is None: return
        if tag == 'div' and 'card' in cls:
            self.card = {'tone': next((c for c in cls if c != 'card'), ''), 'kv': []}
        key = None
        if tag == 'h3': key = 'name'
        elif tag == 'span' and 'code' in cls: key = 'code'
        elif tag == 'span' and 'av' in cls: key = 'availability'
        elif tag == 'p' and 'why' in cls: key = 'why'
        elif self.card is not None and tag == 'span' and 'who' in cls: key = 'line'
        elif self.card is not None and tag == 'span' and 'lv' in cls: key = 'level'
        elif self.card is not None and tag == 'span' and 'vd' in cls: key = 'verdict'
        elif self.card is not None and tag == 'div' and 'basis' in cls: key = 'basis'
        elif self.card is not None and tag == 'div' and 'kv' in cls: key = 'kv'
        if key: self.field = (key, len(self.stack)); self.buf = []
    def handle_endtag(self, tag):
        depth = len(self.stack)
        if self.in_lead and tag == 'p':
            self.lead.append(''.join(self.buf).strip()); self.in_lead = False
        if self.field and depth == self.field[1]:
            key, text = self.field[0], ' '.join(''.join(self.buf).split())
            target = self.card if key in ('line', 'level', 'verdict', 'basis', 'kv') else self.item
            if key == 'kv':
                for label in ('若坚持过，你认的是', '缺'):
                    if text.startswith(label):
                        target['kv'].append((label, text[len(label):].strip())); break
                else:
                    target['kv'].append(('其他', text))
            elif key == 'why':
                target['why'] = text.replace('定这个等级的理由：', '', 1).strip()
            else:
                target[key] = text
            self.field = None
        if self.item is not None and tag == 'div' and self.card is not None and self.stack and 'card' in self.stack[-1][1]:
            self.item['cards'].append(self.card); self.card = None
        if tag == 'section' and self.item is not None and self.stack and 'item' in self.stack[-1][1]:
            self.items.append(self.item); self.item = None
        if self.stack: self.stack.pop()
    def handle_data(self, data):
        if self.field or self.in_lead: self.buf.append(data)

p = P(); p.feed(open(sys.argv[1], encoding='utf-8').read())
out = []
for it in p.items:
    cards = []
    for c in it['cards']:
        kv = dict(c['kv'])
        cards.append({'line': c.get('line', ''), 'level': c.get('level', ''), 'verdict': c.get('verdict', ''), 'basis': c.get('basis', ''),
                      'missing': kv.get('缺', ''), 'accepts': kv.get('若坚持过，你认的是', ''), 'other_kv': {k: v for k, v in kv.items() if k not in ('缺', '若坚持过，你认的是')}})
    out.append({'name': it.get('name', ''), 'category': it['category'], 'code': it.get('code', ''), 'availability': it.get('availability', ''),
                'why': it.get('why', ''), 'cards': cards})
json.dump({'lead': p.lead, 'items': out}, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('items', len(out), 'cards', sum(len(i['cards']) for i in out))
