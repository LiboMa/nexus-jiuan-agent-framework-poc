// 入库版 .docx：标题 + 两段说明 + 一张表（适用的卡，一张卡一行）。给测试台「知识库 › 上传制度」用（只收 .docx）。
// 用法：node make_docx.mjs <rows.json> <out.docx>
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, ShadingType, PageOrientation, HeadingLevel, BorderStyle } = require('docx');

const [, , input, output] = process.argv;
const { head, rows } = JSON.parse(readFileSync(input, 'utf8'));
const cards = rows.filter(row => !row._na);
const widths = [1300, 1300, 1100, 1000, 650, 700, 750, 2400, 1700, 2300, 1500, 698];
const total = widths.reduce((a, b) => a + b, 0);
const FONT = { ascii: 'Arial', eastAsia: 'Microsoft YaHei', hAnsi: 'Arial' };
const run = (text, opts = {}) => new TextRun({ text: String(text), font: FONT, size: opts.size ?? 17, bold: opts.bold, color: opts.color });
const border = { style: BorderStyle.SINGLE, size: 4, color: 'D9DDE3' };
const borders = { top: border, bottom: border, left: border, right: border };
const cell = (text, i, header = false) => new TableCell({
  width: { size: widths[i], type: WidthType.DXA }, borders,
  shading: header ? { type: ShadingType.CLEAR, color: 'auto', fill: 'EEF3FF' } : undefined,
  margins: { top: 40, bottom: 40, left: 60, right: 60 },
  children: [new Paragraph({ children: [run(text, { bold: header })] })],
});

const table = new Table({
  width: { size: total, type: WidthType.DXA }, columnWidths: widths,
  rows: [
    new TableRow({ tableHeader: true, children: head.map((h, i) => cell(h, i, true)) }),
    ...cards.map(row => new TableRow({ cantSplit: true, children: head.map((h, i) => cell(row[h], i)) })),
  ],
});

const para = (text, opts = {}) => new Paragraph({ spacing: { after: 120 }, children: [run(text, { size: opts.size ?? 20, bold: opts.bold })] });
const doc = new Document({
  creator: '九安审单测试台', title: '审批风险判断卡',
  sections: [{
    properties: { page: { size: { width: 11906, height: 16838, orientation: PageOrientation.LANDSCAPE }, margin: { top: 720, bottom: 720, left: 720, right: 720 } } },
    children: [
      new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 160 }, children: [run('审批风险判断卡（265 个末级费用类型 · 业务线与财务线）', { size: 32, bold: true })] }),
      para('每个末级费用类型给业务线与财务线各一张卡：先给结论（过不过），说清缺什么，说清签字认的是什么。审批人只做一个动作：认还是不认。'),
      para('风险等级是规则命中时的严重程度，不是「这么多单会被拦」。一期是旁路不阻断：结论「不过」的实际动作是进复核队列并推提示，不阻断提交。判断依据里的 {金额}、{应到层级} 等是单据字段的占位符，审单时代入。「一期可行性」写着「需接口」「需补字段」等的卡，一期按判断依据里写的限制执行（不少写明「本条一期不上线」）。'),
      para(`下表一行是一张卡，共 ${cards.length} 张（业务线不适用的 ${rows.length - cards.length} 张不列）。卡片编号是「费用编码-业务 / 费用编码-财务」。`),
      table,
    ],
  }],
});
writeFileSync(output, await Packer.toBuffer(doc));
console.log('saved', output, 'cards', cards.length);
