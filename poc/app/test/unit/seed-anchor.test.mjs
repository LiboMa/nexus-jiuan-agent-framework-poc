import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadSeedAnchor } from '../../seed-anchor.mjs';

test('种子的时间锚点第一次算出来就存下，换了天重启也不变（否则详情和库里的对不上，原件读不出来）；删掉文件才重算', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'anchor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'seed-anchor.json');
  const first = await loadSeedAnchor(file, { now: () => new Date('2026-10-25T15:00:00Z') });   // 北京时间 10-25 23:00
  assert.equal(new Date(first).toISOString(), '2026-10-24T04:00:00.000Z');                      // 昨天中午（北京时间 10-24 12:00）
  const nextDay = await loadSeedAnchor(file, { now: () => new Date('2026-10-26T03:00:00Z') });  // 北京时间 10-26 11:00，过了零点
  assert.equal(nextDay, first);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).anchor, '2026-10-24T04:00:00.000Z');
  await rm(file);
  assert.equal(new Date(await loadSeedAnchor(file, { now: () => new Date('2026-10-26T03:00:00Z') })).toISOString(), '2026-10-25T04:00:00.000Z');
});
