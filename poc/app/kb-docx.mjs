/**
 * 「公司制度」上传的 .docx（两种知识库方式共用）：请求体是 .docx 原文，X-File-Name 为 encodeURIComponent 后的文件名。
 * 只看 zip 的目录、不解压、不解析（解析在知识库 Agent 那一侧）；原文件存 <uploadsDir>/<sha256>.docx（目录 0700，文件 0600）。
 * 不合格抛 { code, status }：KB_UPLOAD_INVALID（400）、KB_UPLOAD_TOO_LARGE（413）；文案在 DOCX_MESSAGES。
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const DOCX_MESSAGES = Object.freeze({
  KB_UPLOAD_INVALID: '只收审批矩阵格式的 Word 文档（.docx）：这个文件不是有效的 .docx，或者解压后太大、条目太多。',
  KB_UPLOAD_TOO_LARGE: '文件超过 20 MB。',
});
const fail = (code, status) => { throw Object.assign(new Error(code), { code, status }); };

async function readBody(req, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) { req.destroy?.(); fail('KB_UPLOAD_TOO_LARGE', 413); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** 请求体里的 .docx：Content-Type 是 .docx、文件名以 .docx 结尾、不超过 maxBytes、zip 目录合格（checkDocx）。→ { name, bytes, sha256 } */
export async function readDocxUpload(req, maxBytes) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  let name = '';
  try { name = path.basename(decodeURIComponent(String(req.headers['x-file-name'] || ''))).slice(0, 200); } catch { name = ''; }
  if (type !== DOCX || !/\.docx$/iu.test(name)) fail('KB_UPLOAD_INVALID', 400);
  const bytes = await readBody(req, maxBytes);
  if (!checkDocx(bytes)) fail('KB_UPLOAD_INVALID', 400);
  return { name, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** 原文件存 <uploadsDir>/<sha256>.docx（目录 0700，文件 0600）。 */
export async function storeDocx(uploadsDir, { sha256, bytes }) {
  await mkdir(uploadsDir, { recursive: true, mode: 0o700 });
  const file = path.join(uploadsDir, `${sha256}.docx`);
  await writeFile(file, bytes, { mode: 0o600 });
  return file;
}

/** 只看 zip 的目录，不解压：本地文件头、中央目录在、条目数和解压后总大小不超限、里面有 word/document.xml。 */
function checkDocx(buffer, { entries = 2000, uncompressed = 100 * 1024 * 1024 } = {}) {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) return false;
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > buffer.length) return false;
  const total = buffer.readUInt16LE(end + 10), size = buffer.readUInt32LE(end + 12), offset = buffer.readUInt32LE(end + 16);
  if (total > entries || offset + size > buffer.length) return false;
  let position = offset, sum = 0, document = false;
  for (let index = 0; index < total; index += 1) {
    if (position + 46 > buffer.length || buffer.readUInt32LE(position) !== 0x02014b50) return false;
    const nameLength = buffer.readUInt16LE(position + 28);
    sum += buffer.readUInt32LE(position + 24);
    if (sum > uncompressed) return false;
    if (buffer.toString('utf8', position + 46, position + 46 + nameLength) === 'word/document.xml') document = true;
    position += 46 + nameLength + buffer.readUInt16LE(position + 30) + buffer.readUInt16LE(position + 32);
  }
  return document;
}
