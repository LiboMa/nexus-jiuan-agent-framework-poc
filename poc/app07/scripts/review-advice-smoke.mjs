/**
 * review_advice@1 冒烟测试：用九安 v0.7.10 构件里自己的 A2A 客户端和契约检查（providers/nexus-a2a.mjs、src/agent-contract），
 * 先读名片（九安「Agent 接入」启用时做的同一项检查），再把 smoke-cases.json 里的虚构单据逐张发给发布，核对结论。
 * 九安不核对 kind 为 rule 的依据，所以这里把 Agent 引用的规则编号列出来，由 review-advice-smoke.sh 去知识库里逐个核对。
 * 调用密钥只从环境变量 NEXUS_SMOKE_KEY 读，不打印。用法：node review-advice-smoke.mjs [--only id,id] [--probe-only]
 * 输出：每张用例一行 JSON，最后一行 RULE_IDS <编号,…>。全部符合预期时退出码 0。
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { citedRuleIds, judge } from './smoke-judge.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const JIUAN = path.resolve(process.env.JIUAN07_DIR || path.join(here, '../../../.build/jiuan07'));
const ORIGIN = process.env.NEXUS_ORIGIN || 'https://nxs-beine1013.tinyboat.blog';
const PUBLISH_ID = process.env.PUBLISH_ID || 'pub_5c53e70d8dc7ddea';

const { createAgentClient } = await import(pathToFileURL(path.join(JIUAN, 'providers/nexus-a2a.mjs')).href);
const { loadContract } = await import(pathToFileURL(path.join(JIUAN, 'src/agent-contract/checks.mjs')).href);

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const only = flag('--only') ? (args[args.indexOf('--only') + 1] ?? '').split(',').filter(Boolean) : [];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sortKeys = value => (Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])])) : value);

async function main() {
  const contract = loadContract({ root: path.join(JIUAN, 'src/agent-contract') });
  const key = process.env.NEXUS_SMOKE_KEY;
  const client = createAgentClient({ nexusOrigin: ORIGIN, getKey: async () => key, contract });
  const card = await client.probe({ publishId: PUBLISH_ID });
  const cardOk = card.ok && card.tasks.includes('review_advice@1');
  console.log(JSON.stringify({ probe: { ok: card.ok, tasks: card.tasks, problems: card.problems.map(item => item.message) } }));
  if (flag('--probe-only')) process.exit(cardOk ? 0 : 1);
  if (!key) throw new Error('缺少环境变量 NEXUS_SMOKE_KEY');

  const { cases } = JSON.parse(await readFile(path.join(here, 'smoke-cases.json'), 'utf8'));
  let failed = cardOk ? 0 : 1;
  const allIds = new Set();
  for (const item of cases.filter(entry => !only.length || only.includes(entry.id))) {
    const input = { document: item.document, evidence: item.evidence };
    const request = { envelope: 'jiuan.agent/v1', task: 'review_advice', taskVersion: 1, requestId: randomUUID(),
      context: { tenantId: 'poc-tenant', scope: 'company', companyId: 'poc-company-a',
        subject: { kind: 'document', id: `smoke-${item.id}`, version: sha256(JSON.stringify(input)) }, locale: 'zh-CN' }, input };
    const started = Date.now();
    let outcome;
    try {
      const result = await client.call({ publishId: PUBLISH_ID, request, inputFingerprint: sha256(JSON.stringify(sortKeys(input))) });
      outcome = { status: result.status, output: result.output, declined: result.declined, repaired: result.call.repaired,
        agentVersion: result.call.agentVersion, latencyMs: Date.now() - started };
    } catch (error) {
      outcome = { error: `${error?.code ?? 'ERROR'} ${JSON.stringify(error?.detail ?? {}).slice(0, 600)}`, latencyMs: Date.now() - started };
    }
    const problems = judge(item.expect, outcome);
    citedRuleIds(outcome.output).forEach(id => allIds.add(id));
    if (problems.length) failed += 1;
    console.log(JSON.stringify({ id: item.id, ok: !problems.length, problems, ...outcome }));
  }
  console.log(`RULE_IDS ${[...allIds].join(',')}`);
  process.exit(failed ? 1 : 0);
}

await main();
