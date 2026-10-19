/**
 * 生成前端副本 app/public/：从九安开发包复制前端文件，按 PATCHES 做少量修改，再放入 PoC 自己的 nexus-poc.js 与 nexus-poc.css。
 * 九安原文件不动。每个补丁要求锚点恰好出现指定次数：九安前端一变，这里就报错，而不是悄悄漏改。补丁按顺序执行。
 */
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JIUAN_PUBLIC_DIR } from '../jiuan-path.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COPIED_FILES = Object.freeze(['analysis.html', 'analysis.js', 'analysis.css', 'platform-center.js', 'platform-center.css', 'platform-ops.js',
  'workspace-ui.js', 'workspace-theme.css', 'favicon.svg', 'date-format.js', 'audit-terms.js']);
const EXTRA_FILES = Object.freeze(['nexus-poc.js', 'nexus-invoke.js', 'nexus-poc.css']);
const JS = 'analysis.js', HTML = 'analysis.html';

export const PATCHES = Object.freeze([
  { name: '导入 PoC 扩展（登录与审批）', file: JS,
    anchor: "import { renderPlatformOps, saveMiddleware, saveAgentSettings, probeConnector, runAgentOnce, pauseAll } from './platform-ops.js';",
    replacement: "import { renderPlatformOps, saveMiddleware, saveAgentSettings, probeConnector, runAgentOnce, pauseAll } from './platform-ops.js';\nimport { POC_SAFE_ERRORS, passwordLoginForm, mountApprovalPanel, fillApprovalStatuses } from './nexus-poc.js';" },
  { name: '导航只保留 PoC 有后端的页面', file: JS,
    anchor: "  const groups = [{ label: '日常使用', items: ['overview', 'documents', 'analytics', 'payments'] }];\n  if (capabilities.ruleWorkspace !== false) groups.push({ label: '审核规则', items: ['rules'] });\n  if (capabilities.platformView === true) groups.push({ label: '平台运行', items: ['platform', 'platformAgents', 'platformSchedule'] });\n  if (capabilities.platformAdmin === true) groups.push({ label: '后台配置', items: ['adminConfig'] });",
    replacement: "  // PoC：没有同步、付款与平台中心的后端，导航只保留单据、规则（以及 Nexus Agent 页）。\n  const groups = [{ label: '日常使用', items: ['overview', 'documents', 'analytics'] }];\n  if (capabilities.ruleWorkspace !== false) groups.push({ label: '审核规则', items: ['rules'] });" },
  { name: 'PoC 错误文案', file: JS,
    anchor: "  UPSTREAM_ERROR: '平台未能读取：上游服务未返回有效错误。',",
    replacement: "  UPSTREAM_ERROR: '平台未能读取：上游服务未返回有效错误。',\n  ...POC_SAFE_ERRORS," },
  { name: '扩展上下文 nexusCtx', file: JS,
    anchor: "const api = createAnalysisClient({ csrfToken: () => state.session?.csrfToken || '' });",
    replacement: "const api = createAnalysisClient({ csrfToken: () => state.session?.csrfToken || '' });\n// PoC 扩展（nexus-poc.js）经这个上下文使用本页的请求函数与界面小工具，不直接读写本页状态。\nconst nexusCtx = (revision = state.revision) => ({ api, session: state.session, isCurrent: () => revision === state.revision && !!state.session,\n  onAuthLost: message => resetSession(message), reload: () => loadPage(), openDetail: id => openDetail(id), onLoggedIn: () => bootstrap(), loginErrorMessage,\n  ui: { element, button, tag, panel, facts, loading, empty, errorPanel, errorMessage, icon, announce, dateText } });" },
  { name: '单据卡片标识', file: JS,
    anchor: "  return element('article', { class: 'document-card' }, ",
    replacement: "  return element('article', { class: 'document-card', 'data-document-id': data.id }, " },
  { name: '单据卡片审批状态位', file: JS,
    anchor: "element('h2', { class: 'document-title' }, cleanText(data.number, `${FIELD_UNAVAILABLE}单据号`)), tag(sourceStatus(data.status), ['1004', '1005'].includes(String(data.status)) ? 'green' : '')),",
    replacement: "element('h2', { class: 'document-title' }, cleanText(data.number, `${FIELD_UNAVAILABLE}单据号`)), tag(sourceStatus(data.status), ['1004', '1005'].includes(String(data.status)) ? 'green' : ''), element('span', { class: 'poc-approval-slot', 'data-approval-status': '' }))," },
  { name: '单据卡片填入审批状态', file: JS,
    anchor: "    content.replaceChildren(pageNode);\n    announce(`${page.title}已更新`);",
    replacement: "    content.replaceChildren(pageNode);\n    if (['overview', 'documents'].includes(state.route)) void fillApprovalStatuses(content, result.items, nexusCtx(revision), { route: state.route });\n    announce(`${page.title}已更新`);" },
  { name: '详情页审批流卡片', file: JS,
    anchor: "    element('div', { class: 'detail-precheck' }, verdictPanel(precheckEnvelopeState(data, precheckEnvelope, precheckError).available ? precheckEnvelope.verdict : null)),",
    replacement: "    element('div', { class: 'detail-precheck' }, verdictPanel(precheckEnvelopeState(data, precheckEnvelope, precheckError).available ? precheckEnvelope.verdict : null)),\n    element('div', { class: 'detail-precheck', 'data-approval-panel': '' }, panel('审批流', 'Agent 只给建议；通过或退回由审核员决定，复核人确认。', element('p', { class: 'quiet-note' }, '正在读取审批流…')))," },
  { name: '详情页挂载审批流', file: JS,
    anchor: "      const job = mountAnalysisJobPanel(kind, data, target, onAccessLost); state.detailJobs.push(job); void job.refresh();\n    }",
    replacement: "      const job = mountAnalysisJobPanel(kind, data, target, onAccessLost); state.detailJobs.push(job); void job.refresh();\n    }\n    const approvalTarget = body.querySelector('[data-approval-panel]');\n    if (approvalTarget && request === state.detailRevision) {\n      const analysisJobs = [...state.detailJobs];\n      state.detailJobs.push(mountApprovalPanel(approvalTarget, data, { ...nexusCtx(), isCurrent: () => request === state.detailRevision && !!state.session,\n        onAccessLost, refreshAnalysis: () => { for (const job of analysisJobs) void job.refresh(); } }));\n    }" },
  { name: '登录卡片换成口令登录', file: JS,
    anchor: "  else loginCard.append(element('div', { class: 'note-block' }, '钉钉实名入口尚未启用。本机管理员可使用专用访问入口进入，其他人员需先完成身份绑定与主体授权。'));",
    replacement: "  else loginCard.append(passwordLoginForm(nexusCtx()));" },
  { name: '登录卡片说明', file: JS,
    anchor: "'请通过已授权的实名入口访问。登录后按公司与岗位权限展示真实单据。'",
    replacement: "'PoC 测试环境：用审核员或复核人的虚构账号登录，单据均为虚构数据。'" },
  { name: '测试环境横幅', file: JS, count: 2,
    anchor: "'\\u6d4b\\u8bd5\\u73af\\u5883 \\u00b7 \\u6570\\u636e\\u6765\\u81ea\\u6c47\\u8054\\u6613\\u6d4b\\u8bd5\\u73af\\u5883\\uff0c\\u89c4\\u5219\\u4e0e\\u7ed3\\u8bba\\u4e0d\\u5f71\\u54cd\\u6b63\\u5f0f\\u73af\\u5883'",
    replacement: "'PoC 测试环境 · 单据均为虚构数据，审批结果不写回任何系统'" },
  { name: '页脚说明', file: JS,
    anchor: "'正式系统真实数据 · 只读采集 · 平台结论不改变源系统业务流程 · 建议通过不等于审批通过'",
    replacement: "'PoC 演示 · 单据为虚构数据 · Agent 只给建议，审批由人决定'" },
  { name: 'PoC 样式表', file: HTML,
    anchor: '    <link rel="stylesheet" href="/workspace-theme.css">',
    replacement: '    <link rel="stylesheet" href="/workspace-theme.css">\n    <link rel="stylesheet" href="/nexus-poc.css">' },
  { name: 'Nexus Agent 路由', file: JS,
    anchor: "  compare: { title: 'AI / Agent 对比', icon: 'compare', description: '在相同证据上比较通用 AI 与规则 Agent 的审核表现。' },",
    replacement: "  compare: { title: 'AI / Agent 对比', icon: 'compare', description: '在相同证据上比较通用 AI 与规则 Agent 的审核表现。' },\n  nexusAgents: { title: 'Nexus Agent', icon: 'agent', description: '查看 Nexus 上的 Agent 与发布状态，在线调用测试，查看最近的调用记录。' }," },
  { name: 'Nexus Agent 导航名称', file: JS,
    anchor: "platformAgents: 'Agent 中心', platformSchedule: '任务面板',",
    replacement: "platformAgents: 'Agent 中心', platformSchedule: '任务面板', nexusAgents: 'Nexus Agent'," },
  { name: 'Nexus Agent 导航分组', file: JS,
    anchor: "  if (capabilities.ruleWorkspace !== false) groups.push({ label: '审核规则', items: ['rules'] });",
    replacement: "  if (capabilities.ruleWorkspace !== false) groups.push({ label: '审核规则', items: ['rules'] });\n  groups.push({ label: 'Nexus', items: ['nexusAgents'] });" },
  { name: '导入 Agent 页', file: JS,
    anchor: "import { POC_SAFE_ERRORS, passwordLoginForm, mountApprovalPanel, fillApprovalStatuses } from './nexus-poc.js';",
    replacement: "import { POC_SAFE_ERRORS, passwordLoginForm, mountApprovalPanel, fillApprovalStatuses } from './nexus-poc.js';\nimport { loadNexusAgentsPage, nexusAgentsPage } from './nexus-poc.js';" },
  { name: 'Agent 页不显示公司范围', file: JS,
    anchor: "if (!platformRoute && !['sync', 'adminConfig', 'overview'].includes(state.route)) main.append(scopeBar());",
    replacement: "if (!platformRoute && !['sync', 'adminConfig', 'overview', 'nexusAgents'].includes(state.route)) main.append(scopeBar());" },
  { name: 'Agent 页取数', file: JS,
    anchor: "    if (state.route === 'platform') result = await api('/platform/overview');",
    replacement: "    if (state.route === 'nexusAgents') result = await loadNexusAgentsPage(api);\n    else if (state.route === 'platform') result = await api('/platform/overview');" },
  { name: 'Agent 页渲染', file: JS,
    anchor: "    const pageNode = state.route === 'platform' ? withPause(",
    replacement: "    const pageNode = state.route === 'nexusAgents' ? nexusAgentsPage(result, nexusCtx(revision)) : state.route === 'platform' ? withPause(" },
]);

export function applyPatch(source, { name, anchor, replacement, count = 1 }) {
  const found = source.split(anchor).length - 1;
  if (found !== count) throw new Error(`补丁「${name}」的锚点出现 ${found} 次，应为 ${count} 次：九安前端可能已更新，请核对后改补丁`);
  return source.split(anchor).join(replacement);
}

export async function buildPublic({ sourceDir = JIUAN_PUBLIC_DIR, outDir = path.join(APP_DIR, 'public'), extraDir = path.join(APP_DIR, 'public-src') } = {}) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  for (const file of COPIED_FILES) {
    let text = await readFile(path.join(sourceDir, file), 'utf8');
    for (const patch of PATCHES.filter(item => item.file === file)) text = applyPatch(text, patch);
    await writeFile(path.join(outDir, file), text);
  }
  for (const file of EXTRA_FILES) await copyFile(path.join(extraDir, file), path.join(outDir, file));
  return { outDir, files: [...COPIED_FILES, ...EXTRA_FILES] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { outDir } = await buildPublic();
  console.log(`前端副本已生成：${outDir}`);
}
