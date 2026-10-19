#!/usr/bin/env node
/**
 * 不经界面、直接调 PoC 后端接口测试 Nexus 上的 Agent（与页面上的「调用测试」同一条路：PoC 服务端 → A2A → Nexus）。
 *
 *   node scripts/try-agent.mjs --list
 *   node scripts/try-agent.mjs --publication pub_… --text "请看附件里的发票" --attach 发票.png
 *   node scripts/try-agent.mjs --publication pub_… --task select --input select.json --sample hotel-invoice-png
 *   node scripts/try-agent.mjs --publication pub_… --document FYBX-POC-001 --sample hotel-invoice-pdf
 *
 * 选项：--base 站点（缺省 https://andon-finance.tinyboat.blog）；--secrets 密钥配置文件（缺省 ../infra/secrets.env，从中读口令）；
 *       --account poc-reviewer | poc-checker；--input 是 JSON 串或 JSON 文件；--attach 本机文件、--sample 示例附件编号，都可以重复；
 *       --json 输出完整运行记录。每次调用约 0.05 美元，记在 Nexus 发布者名下。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPocClient, parseAnswer, readSecret } from './poc-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VALUED = new Set(['base', 'secrets', 'account', 'publication', 'text', 'task', 'input', 'document', 'attach', 'sample']);
const REPEATED = new Set(['attach', 'sample']);
const FLAGS = new Set(['list', 'json']);
const PASSWORD_KEY = { 'poc-reviewer': 'REVIEWER_PASSWORD', 'poc-checker': 'CHECKER_PASSWORD' };

export function parseArgs(argv) {
  const options = { base: 'https://andon-finance.tinyboat.blog', secrets: path.resolve(HERE, '../../infra/secrets.env'), account: 'poc-reviewer',
    attach: [], sample: [], list: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index].replace(/^--/, '');
    if (FLAGS.has(name)) { options[name] = true; continue; }
    if (!argv[index].startsWith('--') || !VALUED.has(name)) throw new Error(`不认识的选项：${argv[index]}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${argv[index]} 缺少值`);
    if (REPEATED.has(name)) options[name].push(value); else options[name] = value;
    index += 1;
  }
  if (options.list) return options;
  const ways = ['text', 'task', 'document'].filter(name => options[name] !== undefined);
  if (ways.length > 1) throw new Error('--text、--task 与 --document 只能选一种');
  if (!options.publication || !ways.length) throw new Error('需要 --publication，以及 --text、--task 或 --document 之一（--list 列出可调用的发布）');
  return options;
}

function readInput(value) {
  const text = value === undefined ? '{}' : existsSync(value) ? readFileSync(value, 'utf8') : value;
  let input;
  try { input = JSON.parse(text); } catch { input = null; }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('--input 要是一个 JSON 对象（JSON 串或 JSON 文件）');
  return input;
}

export function requestBody(options, { documents, files }) {
  const base = { publishId: options.publication, ...(files.length ? { attachments: files } : {}) };
  if (options.document !== undefined) {
    const document = documents.find(item => item.number === options.document);
    if (!document) throw new Error(`找不到单据 ${options.document}`);
    return { ...base, mode: 'advisory', documentId: document.id };
  }
  if (options.task !== undefined) return { ...base, mode: 'text', text: JSON.stringify({ task: options.task, input: readInput(options.input) }) };
  return { ...base, mode: 'text', text: options.text };
}

async function main(argv) {
  const options = parseArgs(argv);
  const password = readSecret(options.secrets, PASSWORD_KEY[options.account] ?? '');
  if (!password) throw new Error(`在 ${options.secrets} 里找不到 ${options.account} 的口令`);
  const client = createPocClient({ base: options.base });
  await client.login(options.account, password);
  if (options.list) {
    const view = await client.me();
    for (const item of view.publications.filter(entry => entry.enablement)) console.log(`已启用（${item.enablement.status}）  ${item.publishId}  ${item.displayName}`);
    for (const item of view.system) console.log(`系统提供  ${item.publishId}  ${item.displayName}`);
    for (const item of await client.samples()) console.log(`示例附件  ${item.id}  ${item.name}（${item.size} 字节）${item.description}`);
    return;
  }
  const files = [];
  for (const file of options.attach) files.push({ name: path.basename(file), type: '', data: readFileSync(file).toString('base64') });
  for (const id of options.sample) { const sample = await client.sample(id); files.push({ name: sample.name, type: sample.mimeType, data: sample.data }); }
  const body = requestBody(options, { documents: options.document === undefined ? [] : await client.documents(), files });
  const runId = await client.invoke(body);
  console.error(`已发起 ${runId}，等待 Nexus 返回…`);
  const run = await client.waitRun(runId);
  if (options.json) { console.log(JSON.stringify(run, null, 2)); return; }
  console.log(`结果：${run.status}  用时：${Math.round((run.latencyMs ?? 0) / 100) / 10} 秒  任务：${run.task}  校验：${run.validation}${run.errorCode ? `  错误码：${run.errorCode}` : ''}`);
  for (const item of run.attachments ?? []) console.log(`附件：${item.name}（${item.mimeType}，${item.size} 字节）`);
  const answer = parseAnswer(run.rawText);
  console.log(answer ? JSON.stringify(answer, null, 2) : run.rawText ?? '（没有返回）');
  if (run.status !== 'ok') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 2; });
}
