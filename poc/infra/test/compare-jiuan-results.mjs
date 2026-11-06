#!/usr/bin/env node
/**
 * 九安 v0.7.10 自带测试的结果（远端跑，remote-jiuan-tests.sh）：
 *   node compare-jiuan-results.mjs --from-junit <junit.xml> --root <远端目录>   junit 报告 → JSON 打到标准输出
 *   node compare-jiuan-results.mjs <基线.json> <这次.json> [<去掉的测试.json>]    基线里 pass 的这次不是 pass 就列出来、退出 1
 * JSON 形如 { "tests/x.test.mjs": { "<测试名>": "pass"|"fail"|"skip" } }；嵌套的测试名是「外层 > 里层」，同一文件里重名的第二个起加「 #2」。
 * 去掉的测试（换库时专测 MySQL 模块、改写或删掉的）：数组，元素是 "tests/x.test.mjs"（整个文件）或 "tests/x.test.mjs#<测试名>"。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = text => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
  if (code[0] === '#') return String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
  return ENTITIES[code.toLowerCase()] ?? whole;
});
const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, name, value]) => [name, unescape(value)]));

/** junit 报告 → { 文件: { 测试名: 状态 } }；文件去掉 root 前缀。 */
export function parseJunit(xml, root = '') {
  const result = {};
  const suites = [];
  let open = null;   // 还没闭合的 <testcase>（有子元素的那种）
  const record = (testcase, status) => {
    const file = (testcase.file ?? '').startsWith(`${root}/`) ? testcase.file.slice(root.length + 1) : (testcase.file ?? '?');
    const base = [...suites, testcase.name].join(' > ');
    const tests = (result[file] ??= {});
    let name = base;
    for (let n = 2; Object.hasOwn(tests, name); n += 1) name = `${base} #${n}`;
    tests[name] = status;
  };
  for (const [tag] of xml.matchAll(/<\/?(?:testsuite|testcase|skipped|failure|error)\b[^>]*>/g)) {
    if (tag.startsWith('</testsuite')) { suites.pop(); continue; }
    if (tag.startsWith('<testsuite')) { if (!tag.endsWith('/>')) suites.push(attributes(tag).name); continue; }
    if (tag.startsWith('<testcase')) {
      const testcase = attributes(tag);
      if (tag.endsWith('/>')) record(testcase, 'pass');
      else open = { testcase, status: 'pass' };
      continue;
    }
    if (tag.startsWith('</testcase')) { if (open) record(open.testcase, open.status); open = null; continue; }
    if (!open) continue;
    if (tag.startsWith('<skipped')) open.status = 'skip';
    else if (tag.startsWith('<failure') || tag.startsWith('<error')) open.status = 'fail';
  }
  return result;
}

/** 基线里 pass、这次不是 pass（fail、skip、不见了 = missing）的，按基线的顺序。 */
export function compareResults(baseline, current, { removed = [] } = {}) {
  const gone = new Set(removed);
  const regressions = [];
  for (const [file, tests] of Object.entries(baseline)) {
    if (gone.has(file)) continue;
    for (const [test, was] of Object.entries(tests)) {
      if (was !== 'pass' || gone.has(`${file}#${test}`)) continue;
      const now = current[file]?.[test] ?? 'missing';
      if (now !== 'pass') regressions.push({ file, test, was, now });
    }
  }
  return regressions;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--from-junit') {
    const rootAt = args.indexOf('--root');
    process.stdout.write(`${JSON.stringify(parseJunit(readFileSync(args[1], 'utf8'), rootAt > 0 ? args[rootAt + 1] : ''), null, 2)}\n`);
  } else {
    const [baselineFile, currentFile, removedFile] = args;
    const load = file => JSON.parse(readFileSync(file, 'utf8'));
    const regressions = compareResults(load(baselineFile), load(currentFile), { removed: removedFile ? load(removedFile) : [] });
    if (regressions.length) {
      for (const item of regressions) console.log(`${item.file} :: ${item.test}: ${item.was} → ${item.now}`);
      console.log(`有 ${regressions.length} 条回退`);
      process.exit(1);
    }
    const count = Object.values(load(baselineFile)).reduce((sum, tests) => sum + Object.values(tests).filter(status => status === 'pass').length, 0);
    console.log(`没有回退（基线里 ${count} 条 pass 都还 pass）`);
  }
}
