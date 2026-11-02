import test from 'node:test';
import assert from 'node:assert/strict';
import { withOriginalsFirst } from '../../originals-first.mjs';

// 九安的流水线调适配器的 run（agent-runner.mjs），plan / validate / modes 也照用：形状要和九安的适配器一样
const adapterOf = calls => Object.freeze({ modes: ['incremental'], lanes: null, validate: () => calls.push('validate'),
  plan: async () => { calls.push('plan'); return { wouldSelect: 1 }; }, run: async ctx => { calls.push(`run ${ctx.trigger}`); return { outcome: 'complete' }; } });

test('先读原件再交给九安的适配器：九安调的是 run，plan、validate、modes 原样', async () => {
  const calls = [];
  const wrapped = withOriginalsFirst(adapterOf(calls), { readOriginals: async () => { calls.push('originals'); } });
  assert.deepEqual(wrapped.modes, ['incremental']);
  wrapped.validate({});
  assert.deepEqual(await wrapped.plan({}), { wouldSelect: 1 });
  assert.deepEqual(await wrapped.run({ trigger: 'upstream' }), { outcome: 'complete' });
  assert.deepEqual(calls, ['validate', 'plan', 'originals', 'run upstream']);
});

test('读原件出错不挡这一轮：记下错误码，照常交给九安的适配器（Agent 会如实说原件未能核验）', async () => {
  const calls = [], logged = [];
  const wrapped = withOriginalsFirst(adapterOf(calls), { readOriginals: async () => { throw Object.assign(new Error('x'), { code: 'ANALYSIS_DB_DOWN' }); },
    log: code => logged.push(code) });
  assert.deepEqual(await wrapped.run({ trigger: 'manual' }), { outcome: 'complete' });
  assert.deepEqual(calls, ['run manual']);
  assert.deepEqual(logged, ['POC_ORIGINALS_FIRST_FAILED ANALYSIS_DB_DOWN']);
});
