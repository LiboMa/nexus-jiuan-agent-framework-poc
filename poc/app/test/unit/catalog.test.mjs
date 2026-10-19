import test from 'node:test';
import assert from 'node:assert/strict';
import { cardView, fetchAgentCard, publicationView } from '../../nexus/catalog.mjs';
import { startFakeA2a } from './helpers/fake-a2a.mjs';

const NEXUS = 'https://nexus.example';
const publication = (id, extra = {}) => ({ publish_id: id, display_name: `发布 ${id}`, description: 'PoC（虚构）', agent_id: `agent_${id}`, effective_agent_id: `agent_${id}`,
  agent_name: `agent ${id}`, status: 'active', owner_name: 'admin', follow_updates: true, current_version: 2, pinned_version: null, model_name: null, model_id: null,
  agent_default_model: 'global.anthropic.claude-sonnet-5', channels: [{ channel: 'a2a', enabled: true, status: 'ready', ready: true, rpc_url: `${NEXUS}/a2a/${id}` }],
  calls_24h: 3, last_called_at: null, ...extra });
const CARD = { name: '九安知识Agent（PoC）', description: '审批知识服务（虚构）', url: `${NEXUS}/a2a/pub_active`, version: '1', protocolVersion: '0.3',
  capabilities: { streaming: true }, skills: [{ id: 'ask', name: '九安知识Agent（PoC）' }],
  defaultInputModes: ['text/plain', 'application/json', 'image/png', 'application/pdf'], securitySchemes: { bearer: {} } };

test('publicationView：调用地址只认 Nexus 同源；名称回落；认不出的条目返回 null', () => {
  const view = publicationView(publication('pub_elsewhere', { channels: [{ channel: 'a2a', enabled: true, ready: true, rpc_url: 'https://evil.example/a2a/pub_elsewhere' }] }), NEXUS);
  assert.equal(view.a2a.rpcUrl, `${NEXUS}/a2a/pub_elsewhere`);
  assert.equal(publicationView(publication('pub_x', { display_name: '' }), NEXUS).displayName, 'agent pub_x');
  assert.equal(publicationView({ nope: true }, NEXUS), null);
  assert.equal(publicationView(publication('pub_active'), NEXUS).a2a.ready, true);
});

test('cardView：认不出的字段丢掉，字符串截短，类型列表只留字符串', () => {
  const card = cardView({ name: 'x'.repeat(500), description: 42, protocolVersion: { evil: true }, capabilities: 'yes', skills: 'ask',
    defaultInputModes: ['text/plain', 7, null, 'y'.repeat(300)], extra: 'drop me' });
  assert.equal(card.name.length, 200);
  assert.deepEqual([card.description, card.protocolVersion, card.streaming, card.skills, card.inputModes, card.extra], ['', null, false, [], ['text/plain'], undefined]);
  assert.equal(cardView(CARD).protocolVersion, '0.3');
});

test('fetchAgentCard：读出名片 JSON；404、超过 64 KB 或不是 JSON 都抛带 code 的错误', async t => {
  const fake = await startFakeA2a(({ req, res }) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body); };
    if (req.url.startsWith('/ok')) send(200, JSON.stringify(CARD));
    else if (req.url.startsWith('/big')) send(200, JSON.stringify({ name: 'x'.repeat(70_000) }));
    else if (req.url.startsWith('/bad')) send(200, '<html>');
    else send(404, '{}');
  });
  t.after(() => fake.close());
  assert.equal((await fetchAgentCard(`${fake.origin}/ok`)).name, CARD.name);
  await assert.rejects(fetchAgentCard(`${fake.origin}/missing`), { code: 'POC_CARD_UNAVAILABLE' });
  await assert.rejects(fetchAgentCard(`${fake.origin}/big`), { code: 'POC_CARD_TOO_LARGE' });
  await assert.rejects(fetchAgentCard(`${fake.origin}/bad`), { code: 'POC_CARD_INVALID' });
  await assert.rejects(fetchAgentCard('http://127.0.0.1:9/none', { timeoutMs: 500 }), { code: 'POC_CARD_UNAVAILABLE' });
});
