import test from 'node:test';
import assert from 'node:assert/strict';
import { KNOWLEDGE_EXAMPLES, checkAttachments, createInvokePanel, formatBytes, runResult, runView, taskSummary } from '../../public-src/nexus-invoke.js';
import { runView as reexported } from '../../public-src/nexus-poc.js';

const MB = 1024 * 1024;
const POLICY = { maxFiles: 5, maxFileBytes: 5 * MB, maxTotalBytes: 6 * MB, accept: '.png,.pdf,.xlsx,.md,.json',
  types: [{ ext: 'png', mimeType: 'image/png' }, { ext: 'pdf', mimeType: 'application/pdf' }, { ext: 'xlsx', mimeType: 'x' }, { ext: 'md', mimeType: 'text/markdown' },
    { ext: 'json', mimeType: 'application/json' }] };

function fakeUi() {
  const node = (tagName, attrs = {}, children = []) => ({ tagName, attrs, hidden: Boolean(attrs.hidden), value: attrs.value ?? '', options: [], disabled: Boolean(attrs.disabled),
    children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false), classList: { add() {}, remove() {} },
    replaceChildren(...next) { this.children = next.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false); },
    append(...next) { this.children.push(...next); }, focus() {}, scrollIntoView() {}, click() {} });
  return {
    element: (tagName, attrs = {}, ...children) => node(tagName, attrs, children),
    button: (label, handler, options = {}) => ({ ...node('button', { ...options }, [label]), handler }),
    tag: (text, tone = '') => node('tag', { tone }, [text]),
    panel: (title, description, body) => node('panel', { title, description }, [title, description, body]),
    facts: items => node('facts', {}, items.flat()),
    empty: (title, description) => node('empty', {}, [title, description]),
    errorMessage: error => String(error?.message ?? error),
    dateText: value => `时间(${value})`,
  };
}
const textOf = tree => (typeof tree === 'string' || typeof tree === 'number' ? String(tree)
  : Array.isArray(tree?.children) ? `${tree.attrs?.title ?? ''} ${tree.children.map(textOf).join(' ')}` : '');
const findAll = (tree, predicate, out = []) => {
  if (!tree || typeof tree !== 'object') return out;
  if (predicate(tree)) out.push(tree);
  for (const child of tree.children ?? []) findAll(child, predicate, out);
  return out;
};

test('formatBytes：B、KB、MB', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(115366), '112.7 KB');
  assert.equal(formatBytes(5 * MB), '5.0 MB');
});

test('checkAttachments：按附件规则在浏览器里先挡一道（类型、单个大小、合计、个数）', () => {
  const current = [{ name: '已选.pdf', size: 3 * MB }];
  const { accepted, rejected } = checkAttachments(current, [
    { name: '发票.PNG', size: 100 }, { name: 'setup.exe', size: 10 }, { name: '大.pdf', size: 5 * MB + 1 }, { name: '再大.pdf', size: 3 * MB },
    { name: 'a.md', size: 1 }, { name: 'b.md', size: 1 }, { name: 'c.md', size: 1 }, { name: 'd.md', size: 1 },
  ], POLICY);
  assert.deepEqual(accepted.map(item => item.name), ['发票.PNG', 'a.md', 'b.md', 'c.md']);
  assert.deepEqual(rejected.map(item => [item.name, item.reason]), [
    ['setup.exe', '不支持这种类型'], ['大.pdf', '超过单个 5.0 MB 的上限'], ['再大.pdf', '加上它合计会超过 6.0 MB'], ['d.md', '最多 5 个附件'],
  ]);
});

test('taskSummary：知识 Agent 各任务的返回按要点归纳；不是任务 JSON 时返回 null', () => {
  const answer = taskSummary('```json\n' + JSON.stringify({ task: 'answer', version: 'v', answer: '每晚不超过 600 元。', confidence: 'high',
    citations: [{ id: 'KA-C01', quote: '每晚不超过 600 元' }], gaps: ['未说明超标审批'], attachmentsRead: [{ name: '制度.md', summary: '住宿标准表' }] }) + '\n```');
  assert.equal(answer.task, 'answer');
  const text = JSON.stringify(answer.blocks);
  for (const expected of ['每晚不超过 600 元。', 'KA-C01：每晚不超过 600 元', '高', '未说明超标审批', '制度.md：住宿标准表']) assert.ok(text.includes(expected), expected);
  const select = taskSummary(JSON.stringify({ task: 'select', departments: [{ name: '市场部', source: 'applicant_department', evidence: '市场部（虚构）' }],
    items: [{ id: 'KA-C02', layer: 'company', why: '人均超标' }], conflicts: [{ ids: ['KA-C02', 'KA-D04'], note: '上限不同' }], focus: ['【公司层｜KA-C02】…'] }));
  const selectText = JSON.stringify(select.blocks);
  for (const expected of ['市场部（申请部门：市场部（虚构））', 'KA-C02（公司层）：人均超标', 'KA-C02 × KA-D04：上限不同', '【公司层｜KA-C02】…']) assert.ok(selectText.includes(expected), expected);
  const describe = taskSummary(JSON.stringify({ task: 'describe', tasks: [{ name: 'answer', purpose: '问知识库' }], planned: [{ name: 'ingest', purpose: '资料入库', status: '待平台支持存储' }] }));
  assert.ok(JSON.stringify(describe.blocks).includes('answer：问知识库'));
  assert.ok(JSON.stringify(describe.blocks).includes('ingest：资料入库（待平台支持存储）'));
  const rules = taskSummary(JSON.stringify({ task: 'suggest_rules', suggestions: [{ basedOn: ['KA-C01'], why: '住宿超标', draft: { name: '住宿标准', kind: 'manual_check', documentType: 'employee_reimbursement' } }] }));
  assert.ok(JSON.stringify(rules.blocks).includes('住宿标准（manual_check · employee_reimbursement）：住宿超标；依据 KA-C01'));
  const failed = taskSummary(JSON.stringify({ task: 'select', error: { code: 'invalid_input', message: '缺 companyId' } }));
  assert.ok(JSON.stringify(failed.blocks).includes('invalid_input：缺 companyId'));
  assert.equal(taskSummary('OK'), null);
  assert.equal(taskSummary(JSON.stringify({ recommendation: 'MANUAL_REVIEW' })), null);
});

test('runView：按任务调用的记录显示「任务 <任务名>」；nexus-poc.js 原样转出 runView', () => {
  assert.equal(runView({ task: 'task:select', status: 'ok' }).task, '任务 select');
  assert.equal(runView({ task: 'advisory', status: 'ok' }).task, '审批建议');
  assert.equal(reexported, runView);
});

test('runResult：列出这次带的附件，按任务归纳返回内容，原始返回放在可展开的区块里', () => {
  const run = { status: 'ok', validation: 'not_applicable', publishId: 'pub_k', task: 'task:answer', latencyMs: 21000,
    attachments: [{ name: '制度.md', mimeType: 'text/markdown', size: 915, sha256: 'a'.repeat(64) }],
    rawText: JSON.stringify({ task: 'answer', answer: '每晚不超过 600 元。', confidence: 'medium', citations: [], gaps: [] }) };
  const nodes = runResult(run, { ui: fakeUi() });
  const text = nodes.map(textOf).join(' ');
  for (const expected of ['制度.md', 'text/markdown', '915 B', '每晚不超过 600 元。', '任务 answer']) assert.ok(text.includes(expected), expected);
  assert.ok(findAll({ children: nodes }, item => item.tagName === 'details').length === 1);
});

test('调用测试面板：三种输入方式、附件区（上限说明、示例附件）；没有可调用的发布时说明原因', async () => {
  const calls = [];
  const ctx = { ui: fakeUi(), isCurrent: () => true, onAuthLost() {},
    api: async path => { calls.push(path); return path === '/poc/nexus/samples' ? { items: [{ id: 'hotel-invoice-png', name: '住宿发票.png', mimeType: 'image/png', size: 115366, description: '虚构' }] } : {}; } };
  const publication = { publishId: 'pub_k', displayName: '九安知识Agent（PoC）', canInvoke: true,
    card: { name: '九安知识Agent（PoC）', protocolVersion: '0.3', streaming: true, inputModes: ['text/plain', 'image/png', 'application/pdf'], skills: [], error: null } };
  const panel = createInvokePanel([publication], ctx, { policy: POLICY });
  await new Promise(resolve => setTimeout(resolve, 0));
  const text = textOf(panel.node);
  for (const expected of ['自由文本', '审批建议', '按任务', '附件', '最多 5 个', '单个不超过 5.0 MB', '合计不超过 6.0 MB', 'A2A 0.3', '图片', 'PDF']) assert.ok(text.includes(expected), expected);
  assert.deepEqual(calls, ['/poc/nexus/samples']);
  assert.ok(findAll(panel.node, item => item.tagName === 'button' && textOf(item).includes('住宿发票.png')).length === 1);
  assert.ok(findAll(panel.node, item => item.tagName === 'input' && item.attrs.type === 'file' && item.attrs.accept === POLICY.accept && item.attrs.multiple === true).length === 1);
  const none = createInvokePanel([{ ...publication, canInvoke: false }], ctx, { policy: POLICY });
  assert.match(textOf(none.node), /目前没有可调用的发布/);
});

test('按任务的示例输入：answer、select、suggest_rules、propose 都有，select 用的是种子单据 FYBX-POC-001', () => {
  assert.deepEqual(Object.keys(KNOWLEDGE_EXAMPLES).sort(), ['answer', 'propose', 'select', 'suggest_rules']);
  assert.equal(KNOWLEDGE_EXAMPLES.select.document.number, 'FYBX-POC-001');
  assert.equal(KNOWLEDGE_EXAMPLES.select.document.companyId, 'poc-company-a');
});

test('调用测试面板：hooks.manifests 预填的能力清单，不用再点「读取能力清单」就能选任务', async () => {
  const ctx = { ui: fakeUi(), isCurrent: () => true, onAuthLost() {}, api: async () => ({ items: [] }) };
  const publication = { publishId: 'pub_k', displayName: '知识', canInvoke: true, card: null };
  const panel = createInvokePanel([publication], ctx, { policy: POLICY, manifests: new Map([['pub_k', { task: 'describe', tasks: [{ name: 'describe' }, { name: 'answer', purpose: '问知识库' }] }]]) });
  const select = findAll(panel.node, item => item.tagName === 'select' && item.attrs.id === 'poc-invoke-task')[0];
  assert.deepEqual(select.children.map(option => option.attrs.value), ['answer']);
});
