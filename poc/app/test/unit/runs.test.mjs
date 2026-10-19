import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunLog } from '../../nexus/runs.mjs';

test('记录按时间倒序，超过上限丢掉最旧的；列表不带原始返回', () => {
  const log = createRunLog({ limit: 2, now: () => '2026-10-16T00:00:00.000Z' });
  const first = log.start({ source: 'invoke', task: 'text' });
  log.finish(first, { status: 'ok', rawText: 'hello' });
  const second = log.start({ source: 'jiuan', task: 'advisory' });
  const third = log.start({ source: 'jiuan', task: 'advisory' });
  assert.deepEqual(log.list().map(run => run.id), [third, second]);
  assert.equal(log.get(first), null);
  log.finish(third, { status: 'ok', rawText: 'x', detail: { a: 1 } });
  const [top] = log.list();
  assert.equal(top.status, 'ok');
  assert.equal(top.rawText, undefined);
  assert.equal(top.detail, undefined);
  assert.equal(top.hasRawText, true);
  assert.equal(log.get(third).rawText, 'x');
  assert.equal(log.get(third).finishedAt, '2026-10-16T00:00:00.000Z');
});

test('编号符合路由要求的格式；get 返回副本', () => {
  const log = createRunLog();
  const id = log.start({ source: 'invoke', task: 'text' });
  assert.match(id, /^run_[a-z0-9]+_[a-z0-9]+$/);
  const run = log.get(id);
  run.status = 'changed';
  assert.equal(log.get(id).status, 'running');
});
