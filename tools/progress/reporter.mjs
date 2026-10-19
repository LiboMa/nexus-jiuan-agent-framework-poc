/**
 * node --test 的报告器：每个顶层用例一行 JSON（文件、名字、结果）。进度看板用它按文件数测试；run.sh 也用它记下端到端测试的结果。
 *   node --test --test-reporter=<本文件> --test-reporter-destination=stdout …
 */
export default async function* progressReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const data = event.data ?? {};
    if (data.nesting !== 0) continue;
    const skipped = (data.skip !== undefined && data.skip !== false) || (data.todo !== undefined && data.todo !== false);
    const status = event.type === 'test:fail' ? 'fail' : skipped ? 'skip' : 'pass';
    yield `${JSON.stringify({ file: data.file ?? null, name: data.name, status })}\n`;
  }
}
