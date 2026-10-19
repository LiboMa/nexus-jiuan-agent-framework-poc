/**
 * 拼出看板页面：样式（page.css）和脚本（page.js）都内联，快照就是一个能单独打开的文件。
 *   pageHtml({ mode: 'live' })              实时：页面自己读 /api/state、订阅 /api/events
 *   pageHtml({ mode: 'snapshot', state })   快照：状态嵌在 <script type="application/json"> 里
 */
import { readFile } from 'node:fs/promises';

const asset = name => readFile(new URL(`./${name}`, import.meta.url), 'utf8');
// 嵌进 <script> 的 JSON：把 < > & 和两个行分隔符换成 \u 转义，任何字符串都跳不出脚本标签。
const safeJson = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

export async function pageHtml({ mode = 'live', state = null } = {}) {
  const [css, js] = await Promise.all([asset('page.css'), asset('page.js')]);
  const embedded = mode === 'snapshot' ? `<script id="progress-state" type="application/json">${safeJson(state)}</script>\n` : '';
  return `<!doctype html>
<html lang="zh-CN" data-mode="${mode === 'snapshot' ? 'snapshot' : 'live'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<link rel="icon" href="data:,">
<title>开发进度 · 九安 × Nexus PoC</title>
<style>${css}</style>
</head>
<body>
<div class="page">
  <header class="head">
    <div>
      <h1>开发进度</h1>
      <p class="project" id="project"></p>
    </div>
    <span class="mode" id="mode" role="status"><span class="dot"></span>正在读取</span>
    <ul class="signals" id="signals" aria-label="自动信号"></ul>
  </header>
  <div id="problems"></div>
  <section class="summary" aria-label="总览">
    <div class="hero" id="hero"></div>
    <div>
      <div class="stack" id="stack" role="img" aria-label="各阶段占的范围"></div>
      <ul class="legend" id="legend" aria-label="图例"></ul>
    </div>
    <ul class="milestones" id="milestones" aria-label="里程碑"></ul>
  </section>
  <div class="filters" role="group" aria-label="筛选">
    <label>里程碑 <select id="f-milestone"></select></label>
    <span class="chips" id="f-status" aria-label="阶段"></span>
    <label>负责人 <select id="f-owner"></select></label>
    <label>搜索 <input type="search" id="f-query" placeholder="模块名、编号"></label>
    <span class="views" role="group" aria-label="视图">
      <button type="button" data-view="map" aria-pressed="true">色块地图</button>
      <button type="button" data-view="table" aria-pressed="false">表格</button>
    </span>
  </div>
  <div class="layout">
    <main>
      <div class="map" id="map"></div>
      <div id="table" hidden></div>
    </main>
    <aside class="panel" id="panel" aria-live="polite"></aside>
  </div>
  <footer>数据来源：<code>progress.json</code>（清单，人或编码工具维护）+ 自动信号（单元测试、端到端、文档、线上健康）。实时看：<code>node tools/progress/serve.mjs</code>；快照：<code>node tools/progress/snapshot.mjs</code>。</footer>
</div>
<div class="tooltip" id="tooltip" role="tooltip" hidden></div>
${embedded}<script>
${js}
</script>
</body>
</html>
`;
}
