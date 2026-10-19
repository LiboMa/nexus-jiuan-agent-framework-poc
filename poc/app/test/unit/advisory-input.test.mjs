import test from 'node:test';
import assert from 'node:assert/strict';
import { captureAdvisoryInput } from '../../nexus/advisory-input.mjs';
import { actorFor } from '../../poc-app.mjs';
import { validateAdvisoryInput } from '../../jiuan.mjs';
import { PASSWORDS, startApp } from './helpers/app.mjs';

test('截获的就是九安会发给模型的那份输入，而且不留下任何建议记录', async t => {
  const { app, client } = await startApp(t);
  const document = app.documents.find(item => item.number === 'DGZF-POC-001');
  const actor = actorFor(app.config.accounts.find(account => account.id === 'poc-reviewer'));
  const input = await captureAdvisoryInput({ runtime: app.registry.get(document.companyId), tenantId: 'poc-tenant', actor, document });
  assert.equal(input.facts.number, 'DGZF-POC-001');
  assert.equal(input.facts.evidenceCoverage.originalPageTextAvailable, true);
  assert.equal(input.dataContext.environment, 'prod');
  assert.equal('signal' in input, false);
  assert.doesNotThrow(() => validateAdvisoryInput(input));
  const http = client();
  await http.login('poc-reviewer', PASSWORDS.get('poc-reviewer'));
  assert.equal((await http.api(`/documents/${document.id}/advice`)).body.data.status, 'not_run');
});
