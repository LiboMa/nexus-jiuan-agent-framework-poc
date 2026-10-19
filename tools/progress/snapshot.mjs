/**
 * 静态快照：node tools/progress/snapshot.mjs [--out docs/progress.html] [--no-tests] [--offline]
 * 跑一遍信号（测试、文档、端到端、线上健康），把状态嵌进一个能单独打开的 HTML。清单有错误时不出快照。
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, composeState, loadProject } from './project.mjs';
import { pageHtml } from './render.mjs';
import { collectSignals } from './signals.mjs';

export async function writeSnapshot({ root = ROOT, out = path.join(root, 'docs', 'progress.html'), skipTests = false, offline = false, collect = collectSignals } = {}) {
  const project = await loadProject({ root });
  if (project.errors.length) return { ok: false, errors: project.errors };
  const config = { ...(project.manifest.signals ?? {}) };
  if (offline) delete config.health;
  const signals = await collect({ root, config, skipTests });
  const state = composeState({ manifest: project.manifest, signals, errors: [], warnings: project.warnings });
  await writeFile(out, await pageHtml({ mode: 'snapshot', state }), { mode: 0o644 });
  return { ok: true, out, state };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const result = await writeSnapshot({ out: outIndex >= 0 ? path.resolve(args[outIndex + 1]) : undefined, skipTests: args.includes('--no-tests'), offline: args.includes('--offline') });
  if (!result.ok) { console.error(`progress.json 有错误，没有出快照：\n- ${result.errors.join('\n- ')}`); process.exit(1); }
  const { totals, signals } = result.state;
  console.log(`已生成 ${path.relative(process.cwd(), result.out)}：完成度 ${totals.percent}%，${totals.modules} 个模块，单元测试 ${signals.unit ? `${signals.unit.pass}/${signals.unit.pass + signals.unit.fail}` : '没跑'}，冲突 ${totals.conflicts}`);
}
