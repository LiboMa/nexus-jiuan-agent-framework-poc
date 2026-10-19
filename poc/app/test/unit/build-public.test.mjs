import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PATCHES, applyPatch, buildPublic } from '../../scripts/build-public.mjs';
import { JIUAN_PUBLIC_DIR } from '../../jiuan-path.mjs';

const run = promisify(execFile);
const sha = async file => createHash('sha256').update(await readFile(file)).digest('hex');

test('生成前端副本：每个补丁都打上，analysis.js 语法正确，九安原文件没动', async () => {
  const before = await sha(path.join(JIUAN_PUBLIC_DIR, 'analysis.js'));
  const outDir = await mkdtemp(path.join(tmpdir(), 'poc-built-'));
  const { files } = await buildPublic({ outDir });
  assert.ok(files.includes('nexus-poc.js') && files.includes('nexus-poc.css') && files.includes('nexus-invoke.js'));
  for (const patch of PATCHES) {
    const text = await readFile(path.join(outDir, patch.file), 'utf8');
    assert.ok(text.includes(patch.replacement), patch.name);
  }
  const check = path.join(outDir, 'analysis-check.mjs');
  await copyFile(path.join(outDir, 'analysis.js'), check);
  await run(process.execPath, ['--check', check]);
  assert.equal(await sha(path.join(JIUAN_PUBLIC_DIR, 'analysis.js')), before);
  assert.match(await readFile(path.join(outDir, 'analysis.html'), 'utf8'), /\/nexus-poc\.css/);
});

test('锚点出现次数不对时报错，而不是悄悄漏改', () => {
  assert.throws(() => applyPatch('abc', { name: '示例', anchor: 'x', replacement: 'y' }), /示例.*0 次/);
  assert.throws(() => applyPatch('xx', { name: '示例', anchor: 'x', replacement: 'y' }), /示例.*2 次/);
  assert.equal(applyPatch('axb', { name: '示例', anchor: 'x', replacement: 'y' }), 'ayb');
  assert.equal(applyPatch('xx', { name: '示例', anchor: 'x', replacement: 'y', count: 2 }), 'yy');
});

test('nexus-poc.js 导出了补丁里 import 的每一个名字', async () => {
  const exported = await import('../../public-src/nexus-poc.js');
  const imported = PATCHES.filter(patch => patch.file === 'analysis.js')
    .flatMap(patch => [...patch.replacement.matchAll(/import \{([^}]+)\} from '\.\/nexus-poc\.js'/g)])
    .flatMap(match => match[1].split(',').map(name => name.trim())).filter(Boolean);
  assert.ok(imported.length >= 4);
  for (const name of imported) assert.ok(name in exported, name);
});

test('前端副本里的每个 PoC 脚本都在静态文件白名单里，相对引用的模块也都在（否则浏览器会 404）', async () => {
  const { STATIC_FILES } = await import('../../poc-app.mjs');
  const served = new Set(Object.values(STATIC_FILES));
  for (const file of ['nexus-poc.js', 'nexus-poc.css', 'nexus-invoke.js']) assert.ok(served.has(file), file);
  const source = await readFile(new URL('../../public-src/nexus-poc.js', import.meta.url), 'utf8');
  for (const [, file] of source.matchAll(/from '\.\/([^']+)'/g)) assert.ok(served.has(file), file);
});
