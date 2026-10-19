import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProgressServer } from '../serve.mjs';

const manifest = status => ({ version: 1, project: '测试项目', milestones: [], capabilities: [
  { id: 'cap', name: '能力', modules: [{ id: 'cap.a', name: '模块 A', size: 2, status, tests: ['a.test.mjs'] }] }] });

// 读 SSE：等到满足条件的那一条 state 事件
async function nextState(url, predicate, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        const data = block.split('\n').find(line => line.startsWith('data: '));
        if (block.includes('event: state') && data) { const state = JSON.parse(data.slice(6)); if (predicate(state)) return state; }
      }
    }
    throw new Error('事件流结束了');
  } finally { clearTimeout(timer); controller.abort(); }
}

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'progress-serve-'));
  const file = path.join(root, 'progress.json');
  await writeFile(file, JSON.stringify(manifest('doing')));
  let collected = 0;
  const server = createProgressServer({ root, manifestFile: file, port: 0, healthEveryMs: 0, codeWatch: false,
    collect: async () => { collected += 1; return { tests: { 'a.test.mjs': { pass: 3, fail: 0 } }, unit: { pass: 3, fail: 0, skip: 0 }, collectedAt: new Date().toISOString() }; } });
  await server.start();
  t.after(() => server.stop());
  return { root, file, server, base: `http://127.0.0.1:${server.port()}`, collected: () => collected };
}

test('实时服务：首页是实时页面；/api/state 是算好的状态（带测试信号）；只监听 127.0.0.1', async t => {
  const { base, server } = await setup(t);
  const page = await (await fetch(`${base}/`)).text();
  assert.match(page, /data-mode="live"/);
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.capabilities[0].modules[0].status, 'doing');
  assert.deepEqual(state.capabilities[0].modules[0].tests, { pass: 3, fail: 0, files: 1, missing: 0 });
  assert.equal(server.address().address, '127.0.0.1');
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

test('实时服务：改了 progress.json，订阅者马上收到新状态；清单写错时保留上一次的正确状态并报出错误', async t => {
  const { base, file } = await setup(t);
  const waiting = nextState(`${base}/api/events`, state => state.capabilities[0].modules[0].status === 'done');
  await new Promise(resolve => setTimeout(resolve, 200));
  await writeFile(file, JSON.stringify(manifest('done')));
  assert.equal((await waiting).totals.percent, 100);
  const broken = nextState(`${base}/api/events`, state => (state.problems?.errors ?? []).length > 0);
  await new Promise(resolve => setTimeout(resolve, 200));
  await writeFile(file, '{ "version": 1, "project": ');
  const state = await broken;
  assert.match(state.problems.errors[0], /progress\.json/);
  assert.equal(state.capabilities[0].modules[0].status, 'done');
});
