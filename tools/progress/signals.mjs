/**
 * 进度看板的自动信号：能验证的事实，叠加在清单声明的状态上。
 * - 单元测试：用自带的报告器（reporter.mjs）跑 node --test，按文件数通过、失败、跳过；Python 测试解析 unittest -v 的输出。
 * - 文档：Markdown 比同名 HTML 新，就算 HTML 过期。
 * - 线上健康：GET 健康检查地址，200 算 ok。
 * - 端到端：读 run.sh 记下的结果（每行一条用例）。
 * 要跑哪些测试、查哪个地址，都写在 progress.json 的 signals 里。
 */
import { spawn } from 'node:child_process';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPORTER = pathToFileURL(fileURLToPath(new URL('./reporter.mjs', import.meta.url))).href;
const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');
const blank = () => ({ pass: 0, fail: 0, skip: 0 });

// 子进程不继承 NODE_TEST_CONTEXT：否则在 node --test 里调用时，子进程会把结果交给外层的测试运行器，而不是交给我们的报告器。
function run(command, args, { cwd, timeoutMs = 300_000, env = process.env }) {
  const { NODE_TEST_CONTEXT, ...cleanEnv } = env;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: cleanEnv, timeout: timeoutMs });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

function tally(entries) {
  const files = {}, total = blank();
  for (const { file, status } of entries) {
    files[file] ??= blank();
    files[file][status] += 1;
    total[status] += 1;
  }
  return { files, ...total };
}

export async function runNodeTests({ root, cwd, patterns, nodeBin = process.execPath, timeoutMs }) {
  const { stdout } = await run(nodeBin, ['--test', `--test-reporter=${REPORTER}`, '--test-reporter-destination=stdout', ...patterns], { cwd, timeoutMs });
  const realRoot = await realpath(root);   // 报告器给的是解析过符号链接的绝对路径（macOS 上 /var → /private/var）
  const entries = stdout.split('\n').filter(Boolean).flatMap(line => {
    try { const item = JSON.parse(line); return item.file ? [{ file: rel(realRoot, item.file), status: item.status }] : []; } catch { return []; }
  });
  return { ...tally(entries), at: new Date().toISOString() };
}

export function parsePythonUnittest(output, testsDir) {
  const entries = [];
  for (const match of output.matchAll(/^\S+ \(([\w]+)\.[\w.]+\) \.\.\. (ok|FAIL|ERROR|skipped.*|expected failure|unexpected success)$/gm)) {
    const status = match[2] === 'ok' || match[2] === 'expected failure' ? 'pass' : match[2].startsWith('skipped') ? 'skip' : 'fail';
    entries.push({ file: `${testsDir}/${match[1]}.py`, status });
  }
  return tally(entries);
}

export async function runPythonTests({ root, dir, python = 'python3', timeoutMs }) {
  const { stderr } = await run(python, ['-B', '-m', 'unittest', 'discover', '-s', dir, '-v'], { cwd: root, timeoutMs });
  return { ...parsePythonUnittest(stderr, dir), at: new Date().toISOString() };
}

export async function docsFreshness({ root, dir = 'docs' }) {
  const stale = [];
  let checked = 0;
  async function walk(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.name.endsWith('.md')) continue;
      const html = full.slice(0, -3) + '.html';
      let htmlStat;
      try { htmlStat = await stat(html); } catch { continue; }
      checked += 1;
      if ((await stat(full)).mtimeMs > htmlStat.mtimeMs) stale.push(rel(root, full));
    }
  }
  await walk(path.join(root, dir));
  return { checked, stale: stale.sort() };
}

export async function checkHealth({ url, fetchImpl = globalThis.fetch, timeoutMs = 5000 }) {
  const at = new Date().toISOString();
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    return res.status === 200 ? { ok: true, status: 200, at, url } : { ok: false, status: res.status, reason: `HTTP ${res.status}`, at, url };
  } catch (error) {
    return { ok: false, status: null, reason: error?.cause?.code || error?.name || '请求失败', at, url };
  }
}

export async function readE2eSummary(file) {
  let text, info;
  try { [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]); } catch { return null; }
  const entries = text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const summary = { pass: 0, fail: 0, skip: 0, failures: [], at: info.mtime.toISOString() };
  for (const entry of entries) {
    if (!(entry.status in summary)) continue;
    summary[entry.status] += 1;
    if (entry.status === 'fail') summary.failures.push(`${path.basename(entry.file ?? '?')}：${entry.name}`);
  }
  return summary;
}

/** 按 progress.json 的 signals 配置收集全部信号；单项出错只记在那一项上，不影响别的。 */
export async function collectSignals({ root, config = {}, fetchImpl, skipTests = false }) {
  const signals = { tests: {}, unit: null, python: null, docs: null, health: null, e2e: null, collectedAt: new Date().toISOString() };
  const guard = async (name, task) => { try { return await task(); } catch (error) { return { error: String(error?.message ?? error) }; } };
  if (!skipTests) {
    for (const suite of config.nodeTests ?? []) {
      const result = await guard('unit', () => runNodeTests({ root, cwd: path.join(root, suite.cwd ?? '.'), patterns: suite.patterns }));
      Object.assign(signals.tests, result.files ?? {});
      signals.unit = merge(signals.unit, result);
    }
    for (const suite of config.pythonTests ?? []) {
      const result = await guard('python', () => runPythonTests({ root, dir: suite.dir }));
      Object.assign(signals.tests, result.files ?? {});
      signals.python = merge(signals.python, result);
    }
  }
  if (config.docs) signals.docs = await guard('docs', () => docsFreshness({ root, dir: config.docs }));
  if (config.health) signals.health = await guard('health', () => checkHealth({ url: config.health, fetchImpl }));
  if (config.e2e) signals.e2e = await guard('e2e', () => readE2eSummary(path.join(root, config.e2e)));
  return signals;
}

function merge(previous, next) {
  if (next?.error) return { ...(previous ?? {}), error: next.error };
  if (!previous) return { pass: next.pass, fail: next.fail, skip: next.skip, at: next.at };
  return { pass: previous.pass + next.pass, fail: previous.fail + next.fail, skip: previous.skip + next.skip, at: next.at };
}
