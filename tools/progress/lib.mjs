/**
 * 开发进度看板的核心：校验 progress.json，把清单和自动信号算成页面要的状态。纯函数，不读文件、不发请求。
 * 清单结构：capabilities[]（能力，地图上的分区）→ modules[]（模块或任务块，地图上的色块）→ 可选的 tasks[]（细项）。
 * 色块面积 = size（1–8 的整数，表示范围大小）；进度按 size 加权。
 */
export const STATUS_LABEL = Object.freeze({ todo: '未开始', doing: '进行中', testing: '测试中', done: '已完成', blocked: '受阻' });
const STATUS_WEIGHT = Object.freeze({ todo: 0, doing: 0.5, testing: 0.75, done: 1, blocked: 0 });
const known = status => Object.hasOwn(STATUS_LABEL, status);

export function validateManifest(manifest, { exists = () => true } = {}) {
  const errors = [], warnings = [];
  if (!manifest || typeof manifest.project !== 'string' || !manifest.project.trim()) errors.push('缺少 project（项目名）');
  if (!Array.isArray(manifest?.capabilities)) { errors.push('缺少 capabilities（能力列表）'); return { errors, warnings }; }
  const milestones = new Set((manifest.milestones ?? []).map(item => item?.id));
  const seen = new Set(), modules = [];
  const claim = id => { if (seen.has(id)) errors.push(`重复的编号 ${id}`); seen.add(id); };
  manifest.capabilities.forEach((capability, index) => {
    if (!capability?.id || !capability?.name) { errors.push(`第 ${index + 1} 个能力缺少 id 或 name`); return; }
    claim(capability.id);
    (capability.modules ?? []).forEach((module, position) => {
      if (!module?.id || !module?.name) { errors.push(`${capability.id} 的第 ${position + 1} 个模块缺少 id 或 name`); return; }
      claim(module.id);
      modules.push(module);
    });
  });
  const ids = new Set(modules.map(module => module.id));
  for (const module of modules) {
    if (module.status !== undefined && !known(module.status)) errors.push(`${module.id} 的状态 ${module.status} 不认识（可用：${Object.keys(STATUS_LABEL).join('、')}）`);
    for (const task of module.tasks ?? []) {
      if (!known(task?.status)) errors.push(`${module.id} 的任务「${task?.title ?? '?'}」的状态 ${task?.status} 不认识`);
    }
    if (module.status === undefined && !(module.tasks ?? []).length) errors.push(`${module.id} 既没有 status，也没有 tasks`);
    if (module.size !== undefined && !(Number.isInteger(module.size) && module.size >= 1 && module.size <= 8)) errors.push(`${module.id} 的范围 size 应是 1–8 的整数`);
    for (const dep of module.dependsOn ?? []) if (!ids.has(dep)) errors.push(`${module.id} 依赖了不存在的 ${dep}`);
    if (module.milestone !== undefined && !milestones.has(module.milestone)) errors.push(`${module.id} 的里程碑 ${module.milestone} 不存在`);
    for (const file of module.paths ?? []) if (!exists(file)) warnings.push(`${module.id} 的代码文件不存在：${file}`);
    for (const file of module.tests ?? []) if (!exists(file)) warnings.push(`${module.id} 的测试文件不存在：${file}`);
  }
  // 依赖成环：按清单顺序做深度优先，每个环只报一次
  const byId = new Map(modules.map(module => [module.id, module]));
  const state = new Map(), reported = new Set();
  const visit = (id, trail) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') {
      const cycle = [...trail.slice(trail.indexOf(id)), id];
      const key = [...cycle].slice(0, -1).sort().join('|');
      if (!reported.has(key)) { reported.add(key); errors.push(`依赖成环：${cycle.join(' → ')}`); }
      return;
    }
    state.set(id, 'open');
    for (const dep of byId.get(id)?.dependsOn ?? []) if (byId.has(dep)) visit(dep, [...trail, id]);
    state.set(id, 'done');
  };
  for (const module of modules) visit(module.id, []);
  return { errors, warnings };
}

function statusFromTasks(tasks) {
  const statuses = tasks.map(task => task.status);
  if (statuses.every(status => status === 'done')) return 'done';
  if (statuses.includes('blocked')) return 'blocked';
  const open = statuses.filter(status => status !== 'done');
  if (open.every(status => status === 'testing')) return 'testing';
  if (statuses.some(status => status !== 'todo')) return 'doing';
  return 'todo';
}

function testsOf(module, tests) {
  if (!tests || !(module.tests ?? []).length) return null;
  const summary = { pass: 0, fail: 0, files: 0, missing: 0 };
  for (const file of module.tests) {
    const result = tests[file];
    if (!result) { summary.missing += 1; continue; }
    summary.files += 1;
    summary.pass += result.pass;
    summary.fail += result.fail;
  }
  return summary;
}

const weighted = modules => {
  const total = modules.reduce((sum, module) => sum + module.size, 0);
  return total ? modules.reduce((sum, module) => sum + module.size * module.progress, 0) / total : 0;
};
const percent = value => Math.round(value * 100);

export function deriveState(manifest, signals = {}) {
  const dependents = new Map();
  for (const capability of manifest.capabilities) for (const module of capability.modules ?? []) {
    for (const dep of module.dependsOn ?? []) dependents.set(dep, [...(dependents.get(dep) ?? []), module.id]);
  }
  const capabilities = manifest.capabilities.map(capability => ({
    id: capability.id, name: capability.name, goal: capability.goal ?? '',
    modules: (capability.modules ?? []).map(module => {
      const tasks = module.tasks ?? [];
      const status = module.status ?? statusFromTasks(tasks);
      const progress = tasks.length ? tasks.filter(task => task.status === 'done').length / tasks.length : STATUS_WEIGHT[status];
      return { ...module, capability: capability.id, size: module.size ?? 1, status, progress, tasks, dependsOn: module.dependsOn ?? [],
        dependents: dependents.get(module.id) ?? [], testFiles: module.tests ?? [], tests: testsOf(module, signals.tests) };
    }),
  }));
  const all = capabilities.flatMap(capability => capability.modules);
  const statusOf = new Map(all.map(module => [module.id, module.status]));
  for (const module of all) {
    module.waitingOn = module.dependsOn.filter(dep => statusOf.get(dep) !== 'done');
    module.conflict = Boolean(module.tests && module.tests.fail > 0 && (module.status === 'done' || module.status === 'testing'));
  }
  for (const capability of capabilities) capability.progress = weighted(capability.modules);
  const sizeByStatus = Object.fromEntries(Object.keys(STATUS_LABEL).map(status => [status, 0]));
  for (const module of all) sizeByStatus[module.status] += module.size;
  return {
    project: manifest.project, description: manifest.description ?? '',
    milestones: (manifest.milestones ?? []).map(milestone => {
      const members = all.filter(module => module.milestone === milestone.id);
      return { ...milestone, modules: members.length, percent: percent(weighted(members)) };
    }),
    capabilities,
    totals: { modules: all.length, size: all.reduce((sum, module) => sum + module.size, 0), percent: percent(weighted(all)), sizeByStatus,
      conflicts: all.filter(module => module.conflict).length, blocked: all.filter(module => module.status === 'blocked').length },
    signals: { unit: signals.unit ?? null, python: signals.python ?? null, e2e: signals.e2e ?? null, health: signals.health ?? null,
      docs: signals.docs ?? null, collectedAt: signals.collectedAt ?? null },
  };
}
