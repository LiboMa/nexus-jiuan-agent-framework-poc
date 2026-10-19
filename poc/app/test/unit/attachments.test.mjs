import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ATTACHMENT_POLICY, attachmentMeta, normalizeAttachments } from '../../nexus/attachments.mjs';

const MB = 1024 * 1024;
const b64 = bytes => Buffer.from(bytes).toString('base64');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png')]);
const PDF = Buffer.from('%PDF-1.7\n% fictitious\n');
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('fake-office')]);
const XLS = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from('fake-xls')]);
const file = (name, bytes, extra = {}) => ({ name, type: 'application/octet-stream', data: b64(bytes), ...extra });
const code = expected => error => error?.code === expected && error?.status === 400;

test('合格的附件：按扩展名给出规范类型，记下大小与 sha256，类型以扩展名为准而不是浏览器声明的类型', () => {
  const files = normalizeAttachments([
    file('发票.png', PNG), file('住宿发票.PDF', PDF), file('报销明细.xlsx', ZIP), file('旧表.xls', XLS),
    file('制度.md', Buffer.from('# 差旅住宿标准\n每晚不超过 600 元。')),
  ]);
  assert.deepEqual(files.map(item => [item.name, item.mimeType]), [
    ['发票.png', 'image/png'], ['住宿发票.PDF', 'application/pdf'],
    ['报销明细.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], ['旧表.xls', 'application/vnd.ms-excel'],
    ['制度.md', 'text/markdown'],
  ]);
  assert.equal(files[0].size, PNG.length);
  assert.equal(files[0].sha256, createHash('sha256').update(PNG).digest('hex'));
  assert.ok(Buffer.isBuffer(files[0].bytes) && files[0].bytes.equals(PNG));
});

test('没有附件时返回空数组', () => {
  assert.deepEqual(normalizeAttachments(undefined), []);
  assert.deepEqual(normalizeAttachments([]), []);
});

test('文件名去掉路径与控制字符；同名文件改成「名 (2).扩展名」', () => {
  const files = normalizeAttachments([file('../../etc/发票.png', PNG), file('C:\\票据\\发票.png', PNG), file('a\u0000b:c?.json', Buffer.from('{}'))]);
  assert.deepEqual(files.map(item => item.name), ['发票.png', '发票 (2).png', 'abc.json']);
});

test('超过 120 个字的文件名截短主名，保留扩展名', () => {
  const [item] = normalizeAttachments([file(`${'长'.repeat(200)}.md`, Buffer.from('正文'))]);
  assert.equal([...item.name].length, ATTACHMENT_POLICY.maxNameChars);
  assert.ok(item.name.endsWith('.md'));
});

test('个数、单个大小与合计大小超限', () => {
  const six = Array.from({ length: 6 }, (_, index) => file(`${index}.txt`, Buffer.from('x')));
  assert.throws(() => normalizeAttachments(six), code('POC_ATTACHMENT_TOO_MANY'));
  assert.throws(() => normalizeAttachments([file('大.pdf', Buffer.concat([PDF, Buffer.alloc(5 * MB)]))]), code('POC_ATTACHMENT_TOO_LARGE'));
  const big = () => Buffer.concat([PDF, Buffer.alloc(Math.floor(3.5 * MB))]);
  assert.throws(() => normalizeAttachments([file('一.pdf', big()), file('二.pdf', big())]), code('POC_ATTACHMENT_TOTAL_TOO_LARGE'));
});

test('不支持的类型、内容与扩展名不符', () => {
  assert.throws(() => normalizeAttachments([file('setup.exe', Buffer.from('MZ'))]), code('POC_ATTACHMENT_TYPE_NOT_SUPPORTED'));
  assert.throws(() => normalizeAttachments([file('没有扩展名', Buffer.from('x'))]), code('POC_ATTACHMENT_TYPE_NOT_SUPPORTED'));
  assert.throws(() => normalizeAttachments([file('发票.png', PDF)]), code('POC_ATTACHMENT_TYPE_MISMATCH'));
  assert.throws(() => normalizeAttachments([file('合同.docx', PDF)]), code('POC_ATTACHMENT_TYPE_MISMATCH'));
  assert.throws(() => normalizeAttachments([file('制度.md', Buffer.from([0xff, 0xfe, 0x00, 0x41]))]), code('POC_ATTACHMENT_INVALID'));
});

test('格式不对：不是数组、多出字段、空内容、不是规范的 base64', () => {
  assert.throws(() => normalizeAttachments({ name: 'a.txt' }), code('POC_ATTACHMENT_INVALID'));
  assert.throws(() => normalizeAttachments([{ ...file('a.txt', Buffer.from('x')), url: 'https://example.invalid/a.txt' }]), code('POC_ATTACHMENT_INVALID'));
  assert.throws(() => normalizeAttachments([file('a.txt', Buffer.alloc(0))]), code('POC_ATTACHMENT_INVALID'));
  assert.throws(() => normalizeAttachments([{ name: 'a.txt', data: '不是base64' }]), code('POC_ATTACHMENT_INVALID'));
  assert.throws(() => normalizeAttachments([{ name: 'a.txt', data: 'eA' }]), code('POC_ATTACHMENT_INVALID'));
  assert.throws(() => normalizeAttachments([{ name: '', data: b64('x') }]), code('POC_ATTACHMENT_INVALID'));
});

test('attachmentMeta 只留名称、类型、大小与 sha256，不带内容', () => {
  const meta = attachmentMeta(normalizeAttachments([file('发票.png', PNG)]));
  assert.deepEqual(Object.keys(meta[0]).sort(), ['mimeType', 'name', 'sha256', 'size']);
});

test('附件规则给前端用：上限与可选类型（含 accept 串）', () => {
  assert.deepEqual([ATTACHMENT_POLICY.maxFiles, ATTACHMENT_POLICY.maxFileBytes, ATTACHMENT_POLICY.maxTotalBytes], [5, 5 * MB, 6 * MB]);
  for (const ext of ['png', 'jpg', 'pdf', 'xlsx', 'xls', 'csv', 'docx', 'md', 'txt', 'json', 'yaml', 'xml', 'html']) {
    assert.ok(ATTACHMENT_POLICY.types.some(type => type.ext === ext), ext);
  }
  assert.match(ATTACHMENT_POLICY.accept, /\.pdf/);
  assert.ok(Object.isFrozen(ATTACHMENT_POLICY));
});
