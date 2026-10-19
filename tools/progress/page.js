// 开发进度看板的页面脚本。同一份脚本给两种页面用：
//   实时（serve.mjs）：先读 /api/state，再订阅 /api/events，清单或测试一变就重画；
//   快照（snapshot.mjs）：读页面里嵌好的状态。
// 页面上的文字一律用 textContent 写入，不拼 HTML。
(() => {
  const LABEL = { todo: '未开始', doing: '进行中', testing: '测试中', done: '已完成', blocked: '受阻' };
  const ICON = { todo: '○', doing: '◐', testing: '◑', done: '✓', blocked: '✗' };
  const STACK_ORDER = ['done', 'testing', 'doing', 'todo', 'blocked'];
  const COLOR = { todo: 'var(--s-todo)', doing: 'var(--s-doing)', testing: 'var(--s-testing)', done: 'var(--s-done)', blocked: 'var(--s-blocked)' };
  const mode = document.documentElement.dataset.mode;
  const $ = id => document.getElementById(id);
  const ui = { state: null, selected: null, view: 'map', hover: null, statuses: new Set(Object.keys(LABEL)), milestone: 'all', owner: 'all', query: '', last: new Map() };

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'style') for (const [name, v] of Object.entries(value)) node.style.setProperty(name, v);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }
  // replaceChildren 会把 null 变成文字「null」、把数组变成字符串：先摊平、去掉空的
  const put = (node, ...children) => node.replaceChildren(...children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false));
  const time = iso => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
  const pct = value => `${Math.round(value * 100)}%`;
  const modules = () => (ui.state?.capabilities ?? []).flatMap(capability => capability.modules.map(module => ({ ...module, capabilityName: capability.name })));
  const byId = () => new Map(modules().map(module => [module.id, module]));
  const milestoneName = id => ui.state?.milestones.find(item => item.id === id)?.name ?? id ?? '—';
  const matches = module => ui.statuses.has(module.status) && (ui.milestone === 'all' || module.milestone === ui.milestone)
    && (ui.owner === 'all' || module.owner === ui.owner)
    && (!ui.query || `${module.id} ${module.name} ${module.notes ?? ''} ${module.capabilityName ?? ''}`.toLowerCase().includes(ui.query));
  const testsText = tests => (!tests ? null : tests.files === 0 ? '测试没跑到' : `${tests.fail ? '✗' : '✓'} 测试 ${tests.pass}/${tests.pass + tests.fail}`);

  // ---------- 抬头与信号
  function renderHead() {
    const s = ui.state;
    $('project').textContent = s.project ?? '';
    const signals = s.signals ?? {};
    const items = [];
    const suite = (label, result) => {
      if (!result) return items.push(['none', '·', label, '没有数据']);
      if (result.error) return items.push(['bad', '✗', label, '运行出错']);
      const total = result.pass + result.fail;
      items.push([result.fail ? 'bad' : 'ok', result.fail ? '✗' : '✓', label, `${result.pass}/${total}${result.skip ? `，跳过 ${result.skip}` : ''}`]);
    };
    suite('单元测试', signals.unit);
    suite('命令行测试', signals.python);
    const e2e = signals.e2e;
    if (!e2e || e2e.error) items.push(['none', '·', '端到端', e2e?.error ? '读不到结果' : '还没有记录']);
    else items.push([e2e.fail ? 'bad' : 'ok', e2e.fail ? '✗' : '✓', '端到端', `${e2e.pass} 通过 · ${e2e.fail} 失败 · ${e2e.skip} 跳过（${time(e2e.at)}）`]);
    const docs = signals.docs;
    if (!docs || docs.error) items.push(['none', '·', '文档', '没有数据']);
    else items.push([docs.stale.length ? 'warn' : 'ok', docs.stale.length ? '!' : '✓', '文档', docs.stale.length ? `${docs.stale.length} 份 HTML 过期` : `${docs.checked} 份都是最新的`]);
    const health = signals.health;
    if (!health || health.error) items.push(['none', '·', '线上', '没有检查']);
    else items.push([health.ok ? 'ok' : 'bad', health.ok ? '✓' : '✗', '线上', health.ok ? `正常（${time(health.at)}）` : `异常：${health.reason}`]);
    if (s.totals?.conflicts) items.push(['warn', '!', '冲突', `${s.totals.conflicts} 个模块声称完成但测试没过`]);
    put($('signals'), ...items.map(([tone, icon, label, value]) => el('li', { class: `signal ${tone}` }, el('span', { class: 'i', text: icon }), el('b', { text: label }), value)));
    const problems = [];
    if (s.problems?.errors?.length) problems.push(el('div', { class: 'problems', role: 'alert' }, el('b', { text: 'progress.json 有错误，看板停在上一次的正确版本：' }), el('ul', {}, s.problems.errors.map(text => el('li', { text })))));
    if (s.problems?.warnings?.length) problems.push(el('div', { class: 'problems warnings' }, el('b', { text: '提醒：' }), el('ul', {}, s.problems.warnings.map(text => el('li', { text })))));
    put($('problems'), ...problems);
    const generated = s.signals?.collectedAt ?? s.generatedAt;
    const modeNode = $('mode');
    if (mode === 'snapshot') { modeNode.className = 'mode'; put(modeNode, el('span', { class: 'dot' }), `快照 · ${time(s.generatedAt)}`); }
    else put(modeNode, el('span', { class: 'dot' }), modeNode.classList.contains('stale') ? '实时连接断开，正在重连' : `实时 · ${time(generated)}`);
  }

  // ---------- 总览
  function renderSummary() {
    const totals = ui.state.totals ?? {};
    const sizes = totals.sizeByStatus ?? {};
    const total = Object.values(sizes).reduce((a, b) => a + b, 0) || 1;
    const count = status => modules().filter(module => module.status === status).length;
    put($('hero'), el('span', { class: 'n' }, String(totals.percent ?? 0), el('small', { text: '%' })),
      el('span', { class: 'l', text: `按范围加权的完成度 · ${totals.modules ?? 0} 个模块 · 范围合计 ${totals.size ?? 0}` }));
    put($('stack'), ...STACK_ORDER.filter(status => sizes[status]).map(status => el('span', {
      style: { width: `${(sizes[status] / total) * 100}%`, background: COLOR[status] }, title: `${LABEL[status]}：范围 ${sizes[status]}，${count(status)} 个模块` })));
    put($('legend'), ...STACK_ORDER.map(status => el('li', {},
      el('span', { class: `sw s-${status}` }), `${ICON[status]} ${LABEL[status]} ${count(status)}`)),
      el('li', {}, el('span', { class: 'sw', style: { background: 'var(--s-conflict)' } }), '! 声称完成但测试没过'));
    put($('milestones'), ...(ui.state.milestones ?? []).map(item => el('li', { class: 'milestone' },
      el('span', {}, item.name, item.due ? el('span', { style: { color: 'var(--ink-3)' } }, ` · ${item.due}`) : null, el('span', { style: { color: 'var(--ink-3)' } }, ` · ${item.modules} 个`)),
      el('span', { class: 'pct', text: `${item.percent}%` }),
      el('span', { class: 'bar' }, el('i', { style: { width: `${item.percent}%` } })))));
  }

  // ---------- 筛选
  function renderFilters() {
    const milestone = $('f-milestone');
    milestone.replaceChildren(el('option', { value: 'all', text: '全部里程碑' }), ...(ui.state.milestones ?? []).map(item => el('option', { value: item.id, text: item.name })));
    milestone.value = ui.milestone;
    const owners = [...new Set(modules().map(module => module.owner).filter(Boolean))];
    const owner = $('f-owner');
    owner.replaceChildren(el('option', { value: 'all', text: '全部负责人' }), ...owners.map(name => el('option', { value: name, text: name })));
    owner.value = owners.includes(ui.owner) ? ui.owner : 'all';
    put($('f-status'), ...Object.keys(LABEL).map(status => el('button', { class: 'chip', type: 'button', 'aria-pressed': String(ui.statuses.has(status)),
      onclick: () => { ui.statuses.has(status) ? ui.statuses.delete(status) : ui.statuses.add(status); renderAll(); } },
      el('span', { class: `sw s-${status}` }), LABEL[status])));
    for (const button of document.querySelectorAll('.views button')) button.setAttribute('aria-pressed', String(button.dataset.view === ui.view));
  }

  // ---------- 色块地图
  function blockTitle(module) {
    const parts = [`${module.name}（${module.id}）`, `${ICON[module.status]} ${LABEL[module.status]} · 范围 ${module.size} · ${pct(module.progress)}`];
    if (module.tests) parts.push(testsText(module.tests));
    if (module.waitingOn.length) parts.push(`还在等：${module.waitingOn.join('、')}`);
    if (module.blockedReason) parts.push(`受阻：${module.blockedReason}`);
    if (module.conflict) parts.push('声称完成，但测试没过');
    return parts.join('\n');
  }
  function renderMap() {
    const changed = new Set();
    for (const module of modules()) {
      const before = ui.last.get(module.id);
      if (before && before !== `${module.status}|${module.conflict}`) changed.add(module.id);
      ui.last.set(module.id, `${module.status}|${module.conflict}`);
    }
    put($('map'), ...ui.state.capabilities.map(capability => el('section', { class: 'zone', 'aria-label': capability.name },
      el('div', { class: 'zone-head' }, el('h2', { text: capability.name }), el('span', { class: 'pct', text: pct(capability.progress) }),
        capability.goal ? el('p', { class: 'goal', text: capability.goal }) : null),
      el('div', { class: 'zone-bar' }, el('i', { style: { width: pct(capability.progress) } })),
      el('div', { class: 'blocks' }, capability.modules.map(module => {
        const shown = matches({ ...module, capabilityName: capability.name });
        const classes = ['block', `s-${module.status}`, module.conflict ? 'conflict' : '', shown ? '' : 'dim', ui.selected === module.id ? 'selected' : '', changed.has(module.id) ? 'changed' : ''];
        return el('button', { type: 'button', class: classes.filter(Boolean).join(' '), style: { '--size': String(module.size) }, 'data-id': module.id,
          'aria-label': blockTitle(module).replace(/\n/g, '；'), tabindex: shown ? null : '-1',
          onclick: () => select(module.id), onmouseenter: event => hover(module.id, event), onmousemove: moveTip, onmouseleave: () => hover(null), onfocus: () => hover(module.id), onblur: () => hover(null) },
          el('span', { class: 'name', text: module.name }),
          el('span', { class: 'meta' },
            el('span', { text: `${ICON[module.status]} ${LABEL[module.status]}` }),
            module.tests && module.tests.files ? el('span', { class: `badge${module.tests.fail ? ' fail' : ''}`, text: testsText(module.tests) }) : null,
            module.waitingOn.length ? el('span', { class: 'badge wait', text: `等 ${module.waitingOn.length}` }) : null));
      })))));
    applyHover();
  }

  function hover(id, event) {
    ui.hover = id;
    const tip = $('tooltip');
    if (!id) { tip.hidden = true; applyHover(); return; }
    const module = byId().get(id);
    tip.textContent = blockTitle(module);
    tip.style.whiteSpace = 'pre-line';
    tip.hidden = false;
    if (event) moveTip(event);
    else { const box = document.querySelector(`.block[data-id="${CSS.escape(id)}"]`)?.getBoundingClientRect(); if (box) place(box.left, box.bottom + 8); }
    applyHover();
  }
  function moveTip(event) { place(event.clientX + 14, event.clientY + 16); }
  function place(x, y) {
    const tip = $('tooltip');
    const width = tip.offsetWidth || 280, height = tip.offsetHeight || 80;
    tip.style.left = `${Math.min(x, window.innerWidth - width - 8)}px`;
    tip.style.top = `${Math.min(y, window.innerHeight - height - 8)}px`;
  }
  // 悬停：它依赖的（上游）实线框，依赖它的（下游）虚线框，其余变淡
  function applyHover() {
    const focus = ui.hover ? byId().get(ui.hover) : null;
    const up = new Set(focus?.dependsOn ?? []), down = new Set(focus?.dependents ?? []);
    for (const node of document.querySelectorAll('.block')) {
      const id = node.dataset.id;
      node.classList.toggle('up', up.has(id));
      node.classList.toggle('down', down.has(id));
      node.classList.toggle('faded', Boolean(focus) && id !== focus.id && !up.has(id) && !down.has(id) && !node.classList.contains('dim'));
    }
  }

  // ---------- 表格视图
  function renderTable() {
    const rows = modules().map(module => el('tr', { class: matches(module) ? '' : 'dim', onclick: () => select(module.id) },
      el('td', { text: module.capabilityName }), el('td', {}, el('b', { text: module.name }), el('br'), el('code', { text: module.id })),
      el('td', { text: `${ICON[module.status]} ${LABEL[module.status]}${module.conflict ? '（测试没过）' : ''}` }),
      el('td', { class: 'num', text: String(module.size) }), el('td', { class: 'num', text: pct(module.progress) }),
      el('td', { text: module.tests ? testsText(module.tests) : '—' }),
      el('td', { text: module.dependsOn.join('、') || '—' }), el('td', { text: milestoneName(module.milestone) }), el('td', { text: module.owner ?? '—' })));
    put($('table'), el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['能力', '模块', '状态', '范围', '进度', '测试', '依赖', '里程碑', '负责人'].map(text => el('th', { text })))),
      el('tbody', {}, rows))));
  }

  // ---------- 详情
  function select(id) {
    ui.selected = id;
    renderMap();
    renderPanel();
    if (ui.view === 'table') renderTable();
  }
  function moduleLinks(ids) {
    const index = byId();
    if (!ids.length) return el('p', { class: 'empty', text: '无' });
    return el('ul', {}, ids.map(id => {
      const module = index.get(id);
      return el('li', {}, el('span', { class: 'icon', text: module ? ICON[module.status] : '?' }),
        module ? el('button', { class: 'link', type: 'button', text: module.name, onclick: () => select(id) }) : el('span', { text: id }),
        module ? el('span', { style: { color: 'var(--ink-3)' } }, ` ${LABEL[module.status]}`) : null);
    }));
  }
  function renderPanel() {
    const module = ui.selected ? byId().get(ui.selected) : null;
    const panel = $('panel');
    if (!module) {
      put(panel, el('p', { class: 'crumb', text: '详情' }), el('h3', { text: '点一个色块看详情' }),
        el('p', { class: 'empty', text: '每个色块是一个模块：面积是范围大小，颜色是阶段。悬停看依赖：实线框是它依赖的，虚线框是依赖它的。' }));
      return;
    }
    const tone = module.status === 'done' || module.status === 'blocked' ? '#fff' : 'var(--ink)';
    put(panel, 
      el('p', { class: 'crumb', text: module.capabilityName }),
      el('h3', { text: module.name }),
      el('span', { class: `tag s-${module.status}`, style: { color: tone } }, `${ICON[module.status]} ${LABEL[module.status]}`),
      module.conflict ? el('span', { class: 'tag', style: { background: 'var(--s-conflict)' } }, '! 测试没过') : null,
      el('div', { class: 'progress' }, el('i', { style: { width: pct(module.progress) } })),
      el('dl', {},
        el('dt', { text: '编号' }), el('dd', {}, el('code', { text: module.id })),
        el('dt', { text: '进度' }), el('dd', { text: `${pct(module.progress)}${module.tasks.length ? `（${module.tasks.filter(task => task.status === 'done').length}/${module.tasks.length} 项）` : ''}` }),
        el('dt', { text: '范围' }), el('dd', { text: String(module.size) }),
        el('dt', { text: '里程碑' }), el('dd', { text: milestoneName(module.milestone) }),
        el('dt', { text: '负责人' }), el('dd', { text: module.owner ?? '—' }),
        el('dt', { text: '测试' }), el('dd', { text: module.tests ? `${testsText(module.tests)}${module.tests.missing ? `，${module.tests.missing} 个文件没跑到` : ''}` : module.testFiles.length ? '还没收集' : '没有声明测试' })),
      module.blockedReason ? el('p', { class: 'note blocked' }, el('b', { text: '受阻：' }), module.blockedReason) : null,
      module.conflict ? el('p', { class: 'note conflict', text: '清单里写的是完成，但这个模块的测试没有全部通过：先修测试，或把状态改回「进行中」。' }) : null,
      module.notes ? el('p', { class: 'note', text: module.notes }) : null,
      module.evidence ? el('p', { class: 'note' }, el('b', { text: '证据：' }), module.evidence) : null,
      module.tasks.length ? [el('h4', { text: '细项' }), el('ul', {}, module.tasks.map(task => el('li', {}, el('span', { class: 'icon', text: ICON[task.status] }), el('span', { text: task.title }), el('span', { style: { color: 'var(--ink-3)' } }, ` ${LABEL[task.status]}`))))] : null,
      el('h4', { text: '它依赖的' }), moduleLinks(module.dependsOn),
      el('h4', { text: '依赖它的' }), moduleLinks(module.dependents),
      module.waitingOn.length ? [el('h4', { text: '还在等（依赖没完成）' }), moduleLinks(module.waitingOn)] : null,
      module.testFiles.length ? [el('h4', { text: '测试文件' }), el('ul', {}, module.testFiles.map(file => el('li', {}, el('code', { text: file }))))] : null,
      (module.paths ?? []).length ? [el('h4', { text: '代码' }), el('ul', {}, module.paths.map(file => el('li', {}, el('code', { text: file }))))] : null);
  }

  function renderAll() {
    renderHead();
    renderSummary();
    renderFilters();
    $('map').hidden = ui.view !== 'map';
    $('table').hidden = ui.view !== 'table';
    if (ui.view === 'map') renderMap(); else renderTable();
    renderPanel();
  }

  // ---------- 事件
  $('f-milestone').addEventListener('change', event => { ui.milestone = event.target.value; renderAll(); });
  $('f-owner').addEventListener('change', event => { ui.owner = event.target.value; renderAll(); });
  $('f-query').addEventListener('input', event => { ui.query = event.target.value.trim().toLowerCase(); renderAll(); });
  for (const button of document.querySelectorAll('.views button')) button.addEventListener('click', () => { ui.view = button.dataset.view; renderAll(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && ui.selected) select(null); });

  function load(state) {
    ui.state = state;
    if (ui.selected && !byId().has(ui.selected)) ui.selected = null;
    renderAll();
  }
  if (mode === 'snapshot') {
    load(JSON.parse($('progress-state').textContent));
  } else {
    const modeNode = $('mode');
    fetch('/api/state').then(res => res.json()).then(load).catch(() => {});
    const source = new EventSource('/api/events');
    source.addEventListener('state', event => { modeNode.className = 'mode live'; load(JSON.parse(event.data)); });
    source.addEventListener('open', () => { modeNode.className = 'mode live'; if (ui.state) renderHead(); });
    source.addEventListener('error', () => { modeNode.className = 'mode stale'; if (ui.state) renderHead(); });
  }
})();
