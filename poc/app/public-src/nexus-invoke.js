/**
 * 「Nexus Agent」页的调用测试与调用记录的展示（nexus-poc.js 引用，scripts/build-public.mjs 一并放进 app/public/）。
 *   - 调用经 A2A：选一个发布，用自由文本、某张单据的审批建议输入，或按 Agent 自己的能力清单选任务；
 *   - 可以带附件（发票图片、PDF、Excel、Word、Markdown、JSON 等），作为辅助数据随请求交给 Agent；
 *   - 返回结果按任务归纳要点，原始返回放在可展开的区块里。
 * 浏览器里先按附件规则挡一道（规则来自服务端 /poc/nexus/agents 的 attachmentPolicy），服务端与 Nexus 还会再查。
 */

const MB = 1024 * 1024;
export const CONFIDENCE = Object.freeze({ high: '高', medium: '中', low: '低' });
const SOURCE_LABEL = Object.freeze({ jiuan: '九安 AI 建议', invoke: '调用测试' });
const TASK_LABEL = Object.freeze({ advisory: '审批建议', draftEvidence: '草稿核验', text: '自由文本' });
const VALIDATION_LABEL = Object.freeze({ passed: ['九安校验通过', 'green'], failed: ['九安校验未通过', 'red'], not_run: ['未到校验', ''], not_applicable: ['不校验', ''] });
const LAYER = Object.freeze({ company: '公司层', department: '部门层', personal: '个人层' });
const DEPARTMENT_SOURCE = Object.freeze({ applicant_department: '申请部门', cost_center: '成本中心', form_field: '表单字段' });
const AI_ERROR_HINT = Object.freeze({
  AI_AUTH_INVALID: '调用密钥无效、已停用，或发布已暂停：在 Nexus 网页恢复发布或重新签发调用密钥，写进 infra/secrets.env 后运行 deploy.sh --code-only。',
  AI_RATE_LIMIT: 'Nexus 限流或并发已满，稍后再试。',
  AI_UNAVAILABLE: 'Nexus 暂不可用、发布者额度用尽，或超过 180 秒没有答完。',
  AI_INVALID_RESPONSE: 'Agent 的输出不符合九安的格式要求，见下方原始返回。',
  AI_NETWORK: '连不上 Nexus，或返回流中断。',
  AI_OUTPUT_TRUNCATED: 'Agent 的回答没有完整结束。',
  AI_REQUEST_INVALID: 'Nexus 不接受这次请求：内容太长，或附件的类型、大小不合 Nexus 的规则（见「Nexus 错误码」）。',
  AI_CANCELLED: '这次调用已取消。',
});
const MODE_GROUPS = [
  ['文字', mode => mode === 'text/plain' || mode === 'application/json'], ['图片', mode => mode.startsWith('image/')], ['PDF', mode => mode === 'application/pdf'],
  ['Excel / CSV', mode => /spreadsheet|ms-excel|text\/csv/.test(mode)], ['Word', mode => /wordprocessing|msword|rtf/.test(mode)],
  ['Markdown / HTML / XML / YAML', mode => /markdown|html|xml|yaml|sql/.test(mode)],
];

/** 按任务调用时预填的输入（知识 Agent；全部虚构，select 用种子单据 FYBX-POC-001）。能力清单里的任务没有示例时，用清单里的字段说明当模板。 */
export const KNOWLEDGE_EXAMPLES = Object.freeze({
  answer: { question: '甲公司员工去北京出差，住宿每晚最多能报多少？超标怎么办？', companyId: 'poc-company-a' },
  select: { document: { companyId: 'poc-company-a', number: 'FYBX-POC-001', documentType: 'employee_reimbursement', formName: '差旅费报销单', expenseType: '差旅费',
    amount: '1280', currency: 'CNY', departmentName: '销售一部（虚构）', fields: [{ label: '出差事由', value: '拜访客户，确认续约条款' }],
    description: '北京客户拜访差旅：高铁往返与一晚住宿（虚构）' } },
  suggest_rules: { companyId: 'poc-company-a', topic: '差旅住宿标准与超标说明' },
  propose: { text: '（把制度原文粘贴在这里）', companyId: 'poc-company-a', layer: 'company' },
});

export const seconds = ms => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} 秒` : '—');

/** 后台调用（Agent 一轮 30–60 秒，冷启动更久）：前 30 次每 2 秒看一次，之后每 5 秒，约 8 分钟后停；服务端 5 分钟超时会先落到「AI 失败」。 */
export function pollDelay(attempt) {
  if (attempt <= 30) return 2000;
  if (attempt <= 120) return 5000;
  return null;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

/** 浏览器里先挡一道：类型 → 单个大小 → 个数 → 合计。incoming 按顺序检查，[{ name, size, … }] 原样分进 accepted / rejected（rejected 带 reason）。 */
export function checkAttachments(current, incoming, policy) {
  if (!policy) return { accepted: [...incoming], rejected: [] };
  const exts = new Set(policy.types.map(type => type.ext));
  const accepted = [], rejected = [];
  let count = current.length, total = current.reduce((sum, item) => sum + item.size, 0);
  for (const item of incoming) {
    const dot = item.name.lastIndexOf('.');
    const ext = dot > 0 ? item.name.slice(dot + 1).toLowerCase() : '';
    const reason = !exts.has(ext) ? '不支持这种类型'
      : item.size > policy.maxFileBytes ? `超过单个 ${formatBytes(policy.maxFileBytes)} 的上限`
        : count >= policy.maxFiles ? `最多 ${policy.maxFiles} 个附件`
          : total + item.size > policy.maxTotalBytes ? `加上它合计会超过 ${formatBytes(policy.maxTotalBytes)}` : null;
    if (reason) { rejected.push({ ...item, reason }); continue; }
    accepted.push(item);
    count += 1;
    total += item.size;
  }
  return { accepted, rejected };
}

export function inputModeLabels(modes) {
  return MODE_GROUPS.filter(([, matches]) => (modes ?? []).some(mode => typeof mode === 'string' && matches(mode))).map(([label]) => label);
}

const unwrapFence = text => {
  const trimmed = String(text ?? '').trim();
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/u.exec(trimmed);
  return match ? match[1].trim() : trimmed;
};

/** 按任务调用的返回（{"task": …} 的 JSON）→ { task, blocks: [[标题, [行…]]] }；不是这种 JSON 时返回 null（例如审批建议、自由文本）。 */
export function taskSummary(rawText) {
  let value;
  try { value = JSON.parse(unwrapFence(rawText)); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.task !== 'string') return null;
  const list = item => (Array.isArray(item) ? item.filter(entry => entry !== null && entry !== undefined) : []);
  const blocks = [];
  const add = (title, lines) => { const kept = lines.filter(line => typeof line === 'string' && line); if (kept.length) blocks.push([title, kept]); };
  if (value.error) add('错误', [`${value.error.code ?? '—'}：${value.error.message ?? ''}`]);
  if (value.task === 'describe') {
    add('能力清单', list(value.tasks).map(task => `${task.name}：${task.purpose ?? ''}`));
    add('后续提供', list(value.planned).map(item => `${item.name}：${item.purpose ?? ''}（${item.status ?? '待定'}）`));
  } else if (value.task === 'answer') {
    add('回答', [value.answer]);
    add('引用', list(value.citations).map(item => `${item.id}：${item.quote ?? ''}`));
    add('把握', [CONFIDENCE[value.confidence] ?? value.confidence]);
    add('还缺', list(value.gaps));
  } else if (value.task === 'select') {
    add('识别出的部门', list(value.departments).map(item => `${item.name}（${DEPARTMENT_SOURCE[item.source] ?? item.source}：${item.evidence ?? ''}）`));
    add('相关知识', list(value.items).map(item => `${item.id}（${LAYER[item.layer] ?? item.layer}）：${item.why ?? ''}`));
    add('冲突', list(value.conflicts).map(item => `${list(item.ids).join(' × ')}：${item.note ?? ''}`));
    add('给审核 Agent 的关注点', list(value.focus));
  } else if (value.task === 'suggest_rules') {
    add('规则草稿', list(value.suggestions).map(item => `${item.draft?.name ?? '—'}（${item.draft?.kind ?? '—'} · ${item.draft?.documentType ?? '—'}）：${item.why ?? ''}；依据 ${list(item.basedOn).join('、') || '—'}`));
  } else if (value.task === 'propose') {
    add('整理出的知识', list(value.proposals).map(item => `${item.action === 'update' ? `修改 ${item.targetId ?? '—'}` : '新增'}：${item.title ?? ''}`));
    add('说明', [value.notice]);
  }
  add('读到的附件', list(value.attachmentsRead).map(item => `${item.name}：${item.summary ?? ''}`));
  return { task: value.task, blocks };
}

export function runView(run) {
  const task = typeof run.task === 'string' && run.task.startsWith('task:') ? `任务 ${run.task.slice(5)}` : TASK_LABEL[run.task] ?? run.task ?? '—';
  return {
    source: SOURCE_LABEL[run.source] ?? run.source ?? '—',
    task,
    result: run.status === 'running' ? ['进行中', 'blue'] : run.status === 'ok' ? ['成功', 'green'] : ['失败', 'red'],
    validation: VALIDATION_LABEL[run.validation] ?? ['—', ''],
    latency: seconds(run.latencyMs),
    errorCode: run.errorCode || '—',
    fenced: run.fenced ? '有' : '无',
    attachments: Array.isArray(run.attachments) && run.attachments.length ? `${run.attachments.length} 个` : '—',
  };
}

export function runResult(run, ctx) {
  const { element, tag, facts } = ctx.ui;
  const view = runView(run);
  const summary = taskSummary(run.rawText);
  const attachments = Array.isArray(run.attachments) ? run.attachments : [];
  return [
    element('div', { class: 'poc-tags' }, tag(view.result[0], view.result[1]), tag(view.validation[0], view.validation[1]),
      run.fenced ? tag('输出带代码围栏（已去掉一层）', 'amber') : null),
    facts([['发布', run.publishId ?? '—'], ['任务', view.task], ['单据', run.documentNumber ?? '—'], ['用时', view.latency], ['错误码', view.errorCode],
      ...(run.detail?.code ? [['Nexus 错误码', String(run.detail.code)]] : [])]),
    run.errorCode && AI_ERROR_HINT[run.errorCode] ? element('p', { class: 'quiet-note' }, AI_ERROR_HINT[run.errorCode]) : null,
    attachments.length ? element('section', { class: 'poc-result-block' }, element('h4', {}, `这次带的附件（${attachments.length} 个）`),
      element('ul', {}, attachments.map(item => element('li', {}, `${item.name} · ${item.mimeType} · ${formatBytes(item.size)}`)))) : null,
    summary ? element('section', { class: 'poc-result-block' }, summary.blocks.map(([title, lines]) => element('div', {},
      element('h4', {}, title), element('ul', {}, lines.map(line => element('li', {}, line)))))) : null,
    run.rawText
      ? element('details', { class: 'poc-raw-details', open: summary ? null : true }, element('summary', {}, '原始返回'), element('pre', { class: 'poc-raw' }, run.rawText))
      : element('p', { class: 'quiet-note' }, '没有收到原始返回。'),
  ];
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function cardText(publication) {
  const card = publication?.card;
  if (!card) return '名片：未读取（这个发布没有配调用密钥，或刷新还没完成）。';
  if (card.error) return `名片：没读到（${card.error}），仍可以调用。`;
  const modes = inputModeLabels(card.inputModes);
  return `名片（A2A ${card.protocolVersion ?? '—'}${card.streaming ? '，流式' : ''}）：接受 ${modes.length ? modes.join('、') : '文字'}。`;
}

export function createInvokePanel(publications, ctx, hooks = {}) {
  const { element, panel, button } = ctx.ui;
  const policy = hooks.policy ?? null;
  const callable = publications.filter(publication => publication.canInvoke);
  const byId = new Map(callable.map(publication => [publication.publishId, publication]));
  const manifests = new Map(hooks.manifests ?? []);
  const current = () => byId.get(target.value) ?? callable[0] ?? null;
  const target = element('select', { id: 'poc-invoke-target', on: { change: () => syncTarget() } },
    callable.map(publication => element('option', { value: publication.publishId }, `${publication.displayName}（${publication.publishId}）`)));
  const cardLine = element('p', { class: 'quiet-note' });
  const radio = (value, checked) => element('input', { type: 'radio', name: 'poc-invoke-mode', id: `poc-invoke-mode-${value}`, value, checked, on: { change: () => syncMode() } });
  const modes = { text: radio('text', true), advisory: radio('advisory', false), task: radio('task', false) };
  const mode = () => Object.keys(modes).find(key => modes[key].checked) ?? 'text';

  const text = element('textarea', { id: 'poc-invoke-text', rows: '5', maxlength: '8000', placeholder: '输入要发给 Agent 的内容，例如：请对照附件里的发票，说明住宿是否超标。' });
  const textField = element('div', { class: 'field' }, element('label', { for: 'poc-invoke-text' }, '内容'), text);
  const documentSelect = element('select', { id: 'poc-invoke-document' }, element('option', { value: '' }, '选择后读取单据列表…'));
  const documentField = element('div', { class: 'field', hidden: true },
    element('label', { for: 'poc-invoke-document' }, '单据（按九安审批建议的格式组装输入，并用九安的校验函数检查输出）'), documentSelect);
  const taskSelect = element('select', { id: 'poc-invoke-task', on: { change: () => fillTemplate() } });
  const taskPurpose = element('p', { class: 'quiet-note' }, '先读取这个 Agent 的能力清单。');
  const taskInput = element('textarea', { id: 'poc-invoke-task-input', rows: '10', spellcheck: 'false' });
  const loadManifestButton = button('读取能力清单', () => { void loadManifest(); }, { quiet: true, iconName: 'sync',
    title: '经 A2A 发 {"task": "describe"}，约 20 秒，记一次调用' });
  const taskField = element('div', { class: 'field poc-task-field', hidden: true },
    element('label', { for: 'poc-invoke-task' }, '任务（来自 Agent 的能力清单）'), element('div', { class: 'poc-actions' }, loadManifestButton), taskSelect, taskPurpose,
    element('label', { for: 'poc-invoke-task-input' }, '任务输入（JSON）'), taskInput);

  let attachments = [];
  const attachmentList = element('ul', { class: 'poc-attachments' });
  const attachmentNote = element('p', { class: 'form-error', role: 'alert' });
  const fileInput = element('input', { type: 'file', id: 'poc-invoke-files', multiple: true, accept: policy?.accept ?? '', hidden: true,
    on: { change: () => { void addFiles([...(fileInput.files ?? [])]); fileInput.value = ''; } } });
  const dropzone = element('div', { class: 'poc-dropzone', on: {
    dragover: event => { event.preventDefault(); dropzone.classList.add('poc-dropzone-over'); },
    dragleave: () => dropzone.classList.remove('poc-dropzone-over'),
    drop: event => { event.preventDefault(); dropzone.classList.remove('poc-dropzone-over'); void addFiles([...(event.dataTransfer?.files ?? [])]); },
  } }, '把文件拖到这里，或', button('选择文件', () => fileInput.click(), { quiet: true }), fileInput);
  const samplesRow = element('div', { class: 'poc-samples' });
  const limits = policy ? `最多 ${policy.maxFiles} 个，单个不超过 ${formatBytes(policy.maxFileBytes)}，合计不超过 ${formatBytes(policy.maxTotalBytes)}。` : '';
  const attachmentsField = element('div', { class: 'field poc-attach' }, element('label', { for: 'poc-invoke-files' }, '附件（可选）'),
    element('p', { class: 'quiet-note' }, `作为辅助数据随请求交给 Agent：发票图片、PDF、Excel、Word、Markdown、JSON 等。${limits}`),
    dropzone, samplesRow, attachmentList, attachmentNote);

  const output = element('div', { class: 'poc-result', 'aria-live': 'polite' });
  let busy = false, documentsLoaded = false;
  const send = button('发送', () => { void submit(); }, { primary: true, disabled: !callable.length, iconName: 'arrow' });

  function syncTarget() {
    cardLine.replaceChildren(cardText(current()));
    showManifest();
  }
  function syncMode() {
    textField.hidden = mode() !== 'text';
    documentField.hidden = mode() !== 'advisory';
    taskField.hidden = mode() !== 'task';
    if (mode() === 'advisory' && !documentsLoaded) void loadDocuments();
  }
  function showManifest() {
    const manifest = manifests.get(current()?.publishId);
    const tasks = (manifest?.tasks ?? []).filter(task => task?.name && task.name !== 'describe');
    taskSelect.replaceChildren(...tasks.map(task => element('option', { value: task.name }, `${task.name}：${task.purpose ?? ''}`)));
    if (!tasks.length) { taskPurpose.replaceChildren('先读取这个 Agent 的能力清单。'); taskInput.value = ''; return; }
    fillTemplate();
  }
  function fillTemplate() {
    const manifest = manifests.get(current()?.publishId);
    const name = taskSelect.value || manifest?.tasks?.find(task => task.name !== 'describe')?.name;
    const task = manifest?.tasks?.find(item => item.name === name);
    if (!task) return;
    taskPurpose.replaceChildren(`${task.purpose ?? ''}${task.output ? `；返回：${Object.keys(task.output).join('、')}` : ''}`);
    taskInput.value = JSON.stringify(KNOWLEDGE_EXAMPLES[name] ?? task.input ?? {}, null, 2);
  }
  async function loadDocuments() {
    documentsLoaded = true;
    try {
      const page = await ctx.api('/documents?limit=50');
      documentSelect.replaceChildren(...(page.items ?? []).map(item => element('option', { value: item.id }, `${item.number} · ${item.formName ?? ''} · ${item.companyName ?? ''}`)));
    } catch (error) {
      documentsLoaded = false;
      documentSelect.replaceChildren(element('option', { value: '' }, ctx.ui.errorMessage(error)));
    }
  }
  async function loadSamples() {
    try {
      const { items = [] } = await ctx.api('/poc/nexus/samples');
      samplesRow.replaceChildren(...(items.length ? [element('span', { class: 'quiet-note' }, '示例附件（虚构）：'),
        ...items.map(item => button(item.name, () => { void addSample(item); }, { quiet: true, title: item.description }))] : []));
    } catch { samplesRow.replaceChildren(); }
  }
  function renderAttachments() {
    attachmentList.replaceChildren(...attachments.map((item, index) => element('li', {},
      item.preview ? element('img', { src: item.preview, alt: '', class: 'poc-thumb' }) : null,
      element('span', { class: 'poc-attachment-name' }, item.name), element('span', { class: 'quiet-note' }, `${item.type || '—'} · ${formatBytes(item.size)}`),
      button('移除', () => { attachments.splice(index, 1); renderAttachments(); }, { quiet: true }))));
  }
  function push(item) {
    attachments.push({ ...item, preview: item.type?.startsWith('image/') ? `data:${item.type};base64,${item.data}` : null });
    renderAttachments();
  }
  function explain(rejected) {
    attachmentNote.replaceChildren(rejected.map(item => `${item.name}：${item.reason}`).join('；'));
  }
  async function addFiles(files) {
    const { accepted, rejected } = checkAttachments(attachments, files.map(file => ({ name: file.name, size: file.size, file })), policy);
    explain(rejected);
    for (const item of accepted) {
      try { push({ name: item.name, type: item.file.type, size: item.size, data: await readAsBase64(item.file) }); }
      catch { explain([{ name: item.name, reason: '读取失败' }]); }
    }
  }
  async function addSample(item) {
    const { accepted, rejected } = checkAttachments(attachments, [item], policy);
    explain(rejected);
    if (!accepted.length) return;
    try {
      const sample = await ctx.api(`/poc/nexus/samples/${item.id}`);
      push({ name: sample.name, type: sample.mimeType, size: sample.size, data: sample.data });
    } catch (error) { explain([{ name: item.name, reason: ctx.ui.errorMessage(error) }]); }
  }
  async function waitForRun(runId) {
    for (let attempt = 1; ; attempt += 1) {
      if (!ctx.isCurrent()) return null;
      const run = await ctx.api(`/poc/nexus/runs/${runId}`);
      if (run.status !== 'running') return run;
      const delay = pollDelay(attempt);
      if (delay === null) {
        output.replaceChildren(element('p', { class: 'quiet-note' }, '还在运行，稍后在下方的调用记录里查看结果。'));
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  async function invoke(body, waiting) {
    busy = true;
    send.disabled = true;
    loadManifestButton.disabled = true;
    output.replaceChildren(element('p', { class: 'quiet-note' }, waiting));
    try {
      const { runId } = await ctx.api('/poc/nexus/invoke', { method: 'POST', body });
      const run = await waitForRun(runId);
      if (run) output.replaceChildren(...runResult(run, ctx));
      hooks.onFinished?.();
      return run;
    } catch (error) {
      if (error.status === 401) { ctx.onAuthLost(error.message); return null; }
      output.replaceChildren(element('div', { class: 'inline-message error', role: 'alert' }, ctx.ui.errorMessage(error)));
      return null;
    } finally {
      busy = false;
      send.disabled = !callable.length;
      loadManifestButton.disabled = false;
    }
  }
  async function loadManifest() {
    const publication = current();
    if (busy || !publication) return;
    const run = await invoke({ publishId: publication.publishId, mode: 'text', text: JSON.stringify({ task: 'describe' }) }, '正在经 A2A 读取能力清单（约 20 秒）…');
    let manifest = null;
    try { manifest = JSON.parse(unwrapFence(run?.rawText)); } catch { /* 不是能力清单 */ }
    if (manifest?.task === 'describe' && Array.isArray(manifest.tasks)) {
      manifests.set(publication.publishId, manifest);
      showManifest();
    } else if (run) {
      taskPurpose.replaceChildren('这个 Agent 没有返回能力清单（不认识 describe 任务），请用自由文本调用。');
    }
  }
  async function submit() {
    const publication = current();
    if (busy || !publication) return;
    const base = { publishId: publication.publishId, ...(attachments.length ? { attachments: attachments.map(({ name, type, data }) => ({ name, type, data })) } : {}) };
    let body;
    if (mode() === 'advisory') body = { ...base, mode: 'advisory', documentId: documentSelect.value };
    else if (mode() === 'task') {
      let input;
      try { input = JSON.parse(taskInput.value || '{}'); } catch { input = null; }
      if (!taskSelect.value || !input || typeof input !== 'object' || Array.isArray(input)) {
        output.replaceChildren(element('div', { class: 'inline-message error', role: 'alert' }, '先读取能力清单并选择任务；任务输入要是一个 JSON 对象。'));
        return;
      }
      body = { ...base, mode: 'text', text: JSON.stringify({ task: taskSelect.value, input }) };
    } else body = { ...base, mode: 'text', text: text.value };
    await invoke(body, '已经发送，等待 Nexus 返回（通常 30–60 秒，带附件会慢一些）…');
  }

  const node = panel('调用测试', '经 A2A 调用，记在 Nexus 发布者名下（每次约 0.05 美元）；每个账号每分钟最多 5 次。', element('div', { class: 'poc-invoke', id: 'poc-invoke' },
    callable.length ? null : element('div', { class: 'note-block amber' }, '目前没有可调用的发布：需要已发布、打开 A2A，并在 infra/secrets.env 填好调用密钥。'),
    element('div', { class: 'field' }, element('label', { for: 'poc-invoke-target' }, '调用哪个发布'), target), cardLine,
    element('fieldset', { class: 'poc-choice' }, element('legend', {}, '输入方式'),
      element('label', { for: 'poc-invoke-mode-text' }, modes.text, '自由文本'),
      element('label', { for: 'poc-invoke-mode-advisory' }, modes.advisory, '审批建议（选一张单据）'),
      element('label', { for: 'poc-invoke-mode-task' }, modes.task, '按任务（读取能力清单）')),
    textField, documentField, taskField, attachmentsField, element('div', { class: 'poc-actions' }, send), output));
  syncTarget();
  void loadSamples();
  return {
    node,
    select(publishId) {
      if ([...(target.options ?? [])].some(option => option.value === publishId)) target.value = publishId;
      syncTarget();
      const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      node.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
      target.focus();
    },
  };
}
