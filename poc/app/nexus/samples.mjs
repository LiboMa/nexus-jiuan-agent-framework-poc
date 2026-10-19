/**
 * 调用测试的示例附件（全部虚构，与种子单据对得上）：app/samples/ 下的文件，清单在 manifest.json。
 * 由 poc/tools/make-samples.py 生成；启动时读一次，并按用户上传附件的同一套规则检查，不合规就在启动时报错。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeAttachments } from './attachments.mjs';

export const SAMPLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../samples');
const ID = /^[a-z0-9-]{1,60}$/;
const invalid = () => { throw Object.assign(new Error('POC_SAMPLE_INVALID'), { code: 'POC_SAMPLE_INVALID' }); };

export async function loadSamples(dir = SAMPLES_DIR) {
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') manifest = []; else invalid(); }
  if (!Array.isArray(manifest)) invalid();
  const items = [];
  for (const entry of manifest) {
    if (!entry || typeof entry !== 'object' || !ID.test(entry.id ?? '') || typeof entry.file !== 'string' || entry.file !== path.basename(entry.file)
      || typeof entry.description !== 'string' || entry.description.length > 200 || items.some(item => item.id === entry.id)
      || (entry.document !== undefined && typeof entry.document !== 'string')) invalid();
    let bytes;
    try { bytes = await readFile(path.join(dir, entry.file)); } catch { invalid(); }
    const [file] = normalizeAttachments([{ name: entry.file, data: bytes.toString('base64') }]);
    items.push({ id: entry.id, name: file.name, mimeType: file.mimeType, size: file.size, description: entry.description,
      document: entry.document ?? null, data: bytes.toString('base64') });
  }
  return Object.freeze({
    list: () => items.map(({ data, ...summary }) => ({ ...summary })),
    get: id => { const found = items.find(item => item.id === id); return found ? { ...found } : null; },
  });
}
