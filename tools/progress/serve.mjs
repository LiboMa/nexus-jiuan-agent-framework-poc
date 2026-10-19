/**
 * 本机实时看板：node tools/progress/serve.mjs [--port 4310] [--no-tests]
 * - 只监听 127.0.0.1，并核对 Host 头（挡住 DNS 重绑定）；
 * - progress.json 一改（监视所在目录，编辑器替换文件也能看到），马上把新状态推给所有打开的页面（SSE /api/events）；
 * - 代码或测试一改（poc/app、skills、tools/progress），稍等片刻重跑测试再推；线上健康每分钟查一次；
 * - 清单写错时保留上一次的正确状态，页面顶上列出错误。
 */
import { watch } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MANIFEST, ROOT, composeState, loadProject } from './project.mjs';
import { pageHtml } from './render.mjs';
import { collectSignals } from './signals.mjs';

const IGNORED = /(^|[\\/])(node_modules|public|\.git|__pycache__)([\\/]|$)|\.DS_Store$/;

export function createProgressServer({ root = ROOT, manifestFile = MANIFEST, host = '127.0.0.1', port = 4310, healthEveryMs = 60_000, codeWatch = true,
  debounceMs = 1500, collect = (config, options) => collectSignals({ root, config, ...options }), log = () => {} } = {}) {
  let good = null, signals = {}, problems = { errors: [], warnings: [] }, current = null, server = null;
  const clients = new Set(), closers = [];
  const publish = () => {
    if (!good) return;
    current = composeState({ manifest: good, signals, ...problems });
    const message = `event: state\ndata: ${JSON.stringify(current)}\n\n`;
    for (const res of clients) res.write(message);
  };
  async function reloadManifest() {
    const { manifest, errors, warnings } = await loadProject({ root, manifestFile });
    problems = { errors, warnings };
    if (!errors.length) good = manifest;
    publish();
  }
  // 同一时间只跑一轮；跑的时候又有改动，跑完再来一轮
  let running = null, again = false;
  async function refreshSignals({ skipTests = false } = {}) {
    if (running) { again = again || !skipTests; return running; }
    running = (async () => {
      try {
        const next = await collect(good?.signals ?? {}, { skipTests });
        signals = skipTests ? { ...signals, docs: next.docs ?? signals.docs, health: next.health ?? signals.health, e2e: next.e2e ?? signals.e2e, collectedAt: next.collectedAt } : next;
        publish();
      } catch (error) { log(`信号收集失败：${error?.message ?? error}`); }
    })().finally(() => { running = null; if (again) { again = false; void refreshSignals(); } });
    return running;
  }
  const debounce = (fn, ms) => { let timer = null; return () => { clearTimeout(timer); timer = setTimeout(fn, ms); }; };

  function handle(req, res) {
    const expected = new Set([`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`]);
    if (!expected.has(req.headers.host)) { res.writeHead(421).end(); return; }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    // 每次现拼页面：改了 page.css / page.js，刷新一下就能看到
    if (url.pathname === '/') { void pageHtml({ mode: 'live' }).then(html => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html)); return; }
    if (url.pathname === '/api/state') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(current)); return; }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      if (current) res.write(`event: state\ndata: ${JSON.stringify(current)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    res.writeHead(404).end();
  }

  return {
    async start() {
      await reloadManifest();
      server = createServer(handle);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      const onManifest = debounce(() => { void reloadManifest(); }, 150);
      const manifestWatcher = watch(path.dirname(manifestFile), (event, name) => { if (!name || name === path.basename(manifestFile)) onManifest(); });
      closers.push(() => manifestWatcher.close());
      if (codeWatch) {
        const onCode = debounce(() => { void refreshSignals(); }, debounceMs);
        const onLight = debounce(() => { void refreshSignals({ skipTests: true }); }, 400);
        for (const dir of ['poc/app', 'skills', 'tools/progress']) {
          try { const watcher = watch(path.join(root, dir), { recursive: true }, (event, name) => { if (name && !IGNORED.test(name)) onCode(); }); closers.push(() => watcher.close()); } catch { /* 目录不存在 */ }
        }
        for (const dir of ['docs', 'evidence']) {
          try { const watcher = watch(path.join(root, dir), { recursive: true }, (event, name) => { if (name && !IGNORED.test(name)) onLight(); }); closers.push(() => watcher.close()); } catch { /* 目录不存在 */ }
        }
      }
      if (healthEveryMs) { const timer = setInterval(() => { void refreshSignals({ skipTests: true }); }, healthEveryMs); closers.push(() => clearInterval(timer)); }
      const ping = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25_000);
      closers.push(() => clearInterval(ping));
      await refreshSignals();
    },
    async stop() {
      for (const close of closers.splice(0)) close();
      for (const res of clients) res.end();
      clients.clear();
      if (server) await new Promise(resolve => server.close(resolve));
    },
    address: () => server.address(),
    port: () => server.address().port,
    state: () => current,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const port = Number(args[args.indexOf('--port') + 1]) || 4310;
  const noTests = args.includes('--no-tests');
  const server = createProgressServer({ port, log: message => console.error(message),
    collect: (config, options) => collectSignals({ root: ROOT, config, skipTests: noTests || options.skipTests }) });
  const started = server.start();
  started.then(() => console.log(`开发进度看板：http://127.0.0.1:${server.port()}/（Ctrl+C 退出）`)).catch(error => { console.error(error.message); process.exit(1); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void server.stop().finally(() => process.exit(0)); });
}
