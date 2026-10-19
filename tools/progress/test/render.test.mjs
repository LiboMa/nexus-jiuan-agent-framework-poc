import test from 'node:test';
import assert from 'node:assert/strict';
import { pageHtml } from '../render.mjs';

test('快照：状态嵌在页面里，里面的 </script> 和 <!-- 被转义，不能跳出脚本；样式和脚本都内联，单个文件就能打开', async () => {
  const state = { project: '项目 </script><script>alert(1)</script> <!--', capabilities: [], milestones: [], totals: {}, signals: {} };
  const html = await pageHtml({ state, mode: 'snapshot' });
  assert.match(html, /<html lang="zh-CN"[^>]*data-mode="snapshot"/);
  const embedded = html.match(/<script id="progress-state" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(embedded, '应有嵌入的状态');
  assert.equal(embedded[1].includes('</script>'), false);
  assert.equal(embedded[1].includes('<!--'), false);
  assert.equal(JSON.parse(embedded[1]).project, state.project);
  assert.match(html, /<style>[\s\S]+<\/style>/);
  assert.equal((html.match(/<script(?: [^>]*)?>/g) ?? []).filter(tag => !tag.includes('application/json')).length, 1, '只有一段页面脚本');
  assert.doesNotMatch(html, /<script[^>]+src=/);
});

test('实时：不嵌状态，页面自己去读 /api/state、订阅 /api/events', async () => {
  const html = await pageHtml({ mode: 'live' });
  assert.match(html, /data-mode="live"/);
  assert.doesNotMatch(html, /id="progress-state"/);
  assert.match(html, /\/api\/events/);
});
