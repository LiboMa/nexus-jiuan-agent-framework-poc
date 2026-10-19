/**
 * 调用测试的附件：先在 PoC 服务端按同一份规则检查，再作为 A2A 文件 Part 发给 Nexus（Nexus 自己还会再查一遍）。
 * 类型以扩展名为准，图片、PDF 与 Office 文件再核对文件头；文本类必须是 UTF-8。内容只在这一次调用里用，不保存。
 * 合计上限比 Nexus 的 40 MB 小得多：这套 Nexus 环境的 /a2a 经前端反代转发，请求体超过 10 MB 会被截断（base64 还要再大三分之一）。
 */
import { createHash } from 'node:crypto';
import { fail } from '../http.mjs';

const MB = 1024 * 1024;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], JPEG = [0xff, 0xd8, 0xff], GIF = [0x47, 0x49, 0x46, 0x38];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d], ZIP = [0x50, 0x4b, 0x03, 0x04], OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const startsWith = (bytes, magic, offset = 0) => magic.every((value, index) => bytes[offset + index] === value);
const isWebp = bytes => startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
const TEXT = 'text';

/** 扩展名 → [规范 MIME, 文件头检查]；与 Nexus 网关的白名单（nexus_utils/publication_gateway/attachments.py）取交集。 */
const TYPES = Object.freeze({
  png: ['image/png', bytes => startsWith(bytes, PNG)], jpg: ['image/jpeg', bytes => startsWith(bytes, JPEG)],
  jpeg: ['image/jpeg', bytes => startsWith(bytes, JPEG)], gif: ['image/gif', bytes => startsWith(bytes, GIF)], webp: ['image/webp', isWebp],
  pdf: ['application/pdf', bytes => startsWith(bytes, PDF)],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes => startsWith(bytes, ZIP)],
  xls: ['application/vnd.ms-excel', bytes => startsWith(bytes, OLE)],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes => startsWith(bytes, ZIP)],
  csv: ['text/csv', TEXT], md: ['text/markdown', TEXT], markdown: ['text/markdown', TEXT], txt: ['text/plain', TEXT],
  json: ['application/json', TEXT], yaml: ['application/yaml', TEXT], yml: ['application/yaml', TEXT], xml: ['application/xml', TEXT],
  html: ['text/html', TEXT], htm: ['text/html', TEXT],
});

export const ATTACHMENT_POLICY = Object.freeze({
  maxFiles: 5, maxFileBytes: 5 * MB, maxTotalBytes: 6 * MB, maxNameChars: 120,
  types: Object.freeze(Object.entries(TYPES).map(([ext, [mimeType]]) => Object.freeze({ ext, mimeType }))),
  accept: Object.keys(TYPES).map(ext => `.${ext}`).join(','),
});

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const invalid = () => fail('POC_ATTACHMENT_INVALID', 400);

function cleanName(value) {
  if (typeof value !== 'string') invalid();
  const base = value.split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f:*?"<>|]/gu, '').replace(/\s+/gu, ' ').trim();
  if (!base) invalid();
  const chars = [...base];
  if (chars.length <= ATTACHMENT_POLICY.maxNameChars) return base;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot) : '';
  return [...base.slice(0, base.length - ext.length)].slice(0, ATTACHMENT_POLICY.maxNameChars - [...ext].length).join('') + ext;
}

function decode(data) {
  if (typeof data !== 'string' || !data || data.length % 4 !== 0 || !BASE64.test(data)) invalid();
  if (data.length > Math.ceil(ATTACHMENT_POLICY.maxFileBytes / 3) * 4 + 4) fail('POC_ATTACHMENT_TOO_LARGE', 400);
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.toString('base64') !== data) invalid();
  return bytes;
}

function unique(name, taken) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let index = 2; ; index += 1) if (!taken.has(`${stem} (${index})${ext}`)) return `${stem} (${index})${ext}`;
}

/** [{ name, type?, data: base64 }] → [{ name, mimeType, bytes, size, sha256 }]；不合规抛 400，错误码见下。 */
export function normalizeAttachments(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) invalid();
  if (list.length > ATTACHMENT_POLICY.maxFiles) fail('POC_ATTACHMENT_TOO_MANY', 400);
  const taken = new Set();
  let total = 0;
  return list.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['name', 'type', 'data'].includes(key))) invalid();
    const name = cleanName(item.name);
    const dot = name.lastIndexOf('.');
    const type = dot > 0 ? TYPES[name.slice(dot + 1).toLowerCase()] : undefined;
    if (!type) fail('POC_ATTACHMENT_TYPE_NOT_SUPPORTED', 400);
    const bytes = decode(item.data);
    if (bytes.length > ATTACHMENT_POLICY.maxFileBytes) fail('POC_ATTACHMENT_TOO_LARGE', 400);
    total += bytes.length;
    if (total > ATTACHMENT_POLICY.maxTotalBytes) fail('POC_ATTACHMENT_TOTAL_TOO_LARGE', 400);
    const [mimeType, check] = type;
    if (check === TEXT) {
      let text;
      try { text = utf8.decode(bytes); } catch { invalid(); }
      if (text.includes('\u0000')) invalid();
    } else if (!check(bytes)) fail('POC_ATTACHMENT_TYPE_MISMATCH', 400);
    const unused = unique(name, taken);
    taken.add(unused);
    return { name: unused, mimeType, bytes, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
}

/** 运行记录里只留这些，不留内容。 */
export const attachmentMeta = files => files.map(({ name, mimeType, size, sha256 }) => ({ name, mimeType, size, sha256 }));
