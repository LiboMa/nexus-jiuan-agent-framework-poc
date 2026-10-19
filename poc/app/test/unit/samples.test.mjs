import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLES_DIR, loadSamples } from '../../nexus/samples.mjs';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
async function dirWith(manifest, files = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'poc-samples-'));
  if (manifest !== undefined) await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(dir, name), bytes);
  return dir;
}

test('按 manifest.json 读出示例附件：列表不带内容，取单个时带 base64 内容；类型按附件规则判定', async () => {
  const dir = await dirWith([{ id: 'invoice-png', file: '发票.png', description: '住宿发票图片（虚构）', document: 'FYBX-POC-001' },
    { id: 'policy-md', file: '制度.md', description: '差旅制度（虚构）' }], { '发票.png': PNG, '制度.md': Buffer.from('# 差旅住宿标准') });
  const samples = await loadSamples(dir);
  assert.deepEqual(samples.list(), [
    { id: 'invoice-png', name: '发票.png', mimeType: 'image/png', size: PNG.length, description: '住宿发票图片（虚构）', document: 'FYBX-POC-001' },
    { id: 'policy-md', name: '制度.md', mimeType: 'text/markdown', size: Buffer.byteLength('# 差旅住宿标准'), description: '差旅制度（虚构）', document: null },
  ]);
  assert.equal(samples.get('invoice-png').data, PNG.toString('base64'));
  assert.equal(samples.get('none'), null);
});

test('没有 manifest.json：空的示例库', async () => {
  const samples = await loadSamples(await dirWith(undefined));
  assert.deepEqual(samples.list(), []);
});

test('manifest 里的条目不合规（编号、文件在目录外、文件不合附件规则）：启动时就报错，而不是悄悄少一个', async () => {
  await assert.rejects(loadSamples(await dirWith([{ id: 'Bad Id', file: 'a.md', description: 'x' }], { 'a.md': Buffer.from('x') })), { code: 'POC_SAMPLE_INVALID' });
  await assert.rejects(loadSamples(await dirWith([{ id: 'escape', file: '../a.md', description: 'x' }])), { code: 'POC_SAMPLE_INVALID' });
  await assert.rejects(loadSamples(await dirWith([{ id: 'fake-png', file: 'a.png', description: 'x' }], { 'a.png': Buffer.from('%PDF-1.7') })),
    { code: 'POC_ATTACHMENT_TYPE_MISMATCH' });
});

test('随 PoC 发布的示例附件全部合规，覆盖发票图片、PDF、JSON、Excel、Markdown 与 Word', async () => {
  assert.equal(SAMPLES_DIR, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../samples'));
  const samples = await loadSamples(SAMPLES_DIR);
  const types = new Set(samples.list().map(item => item.mimeType));
  for (const type of ['image/png', 'application/pdf', 'application/json', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/markdown', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']) assert.ok(types.has(type), type);
  const total = samples.list().reduce((sum, item) => sum + item.size, 0);
  assert.ok(total < 2 * 1024 * 1024, `示例附件合计 ${total} 字节`);
});
