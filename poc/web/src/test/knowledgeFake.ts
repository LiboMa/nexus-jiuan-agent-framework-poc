// 知识库和我的规则测试用的假测试台：外壳的 /poc/kb/*（kb-steward-routes.mjs）和 /poc/custom-rules*（custom-rules.mjs）。有状态：
// 下线 / 恢复 / 删除改清单，上传记一条「入库中」，由测试 finish() 收尾。制度、规则、文件名全部虚构（规则编号 R-xx、名字带「虚构」），没有真实制度原文。
import type { Role } from '../api/session';
import { fakeApi, sessionBody, type FakeCall, type FakeReply, type FakeRoute } from './fakeApi';

const KB = '/api/analysis/v1/poc/kb';
const RULES = '/api/analysis/v1/poc/custom-rules';
export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface FakeSource {
  source_id: string; title: string; source_version: string; file_name: string; doc_hash: string; rules_total: number; status: string; ingested_at: string; updated_at: string;
}
export const SOURCES: FakeSource[] = [
  { source_id: 'fin-approval', title: '虚构财务审批办法V4.docx', source_version: 'V4.0 虚构版', file_name: '虚构财务审批办法V4.docx', doc_hash: 'a'.repeat(64),
    rules_total: 128, status: 'active', ingested_at: '2026-10-29T02:00:00.000Z', updated_at: '2026-10-29T02:10:00.000Z' },
  { source_id: 'travel-rules', title: '虚构差旅制度', source_version: 'V1', file_name: 'travel-rules.docx', doc_hash: 'b'.repeat(64),
    rules_total: 12, status: 'inactive', ingested_at: '2026-10-20T01:00:00.000Z', updated_at: '2026-10-28T03:00:00.000Z' },
];
export const PG_OPS = ['describe', 'ingest', 'list', 'detail', 'delete', 'check', 'search', 'preview'];
export const ALL_OPS = ['describe', 'ingest', 'list', 'detail', 'deactivate', 'restore', 'delete', 'check', 'search', 'preview'];
export const HITS = [
  { rule_id: 'R-07', rule_type: 'matrix', chapter_no: 5, segments: ['九安', '柯顿'], amt_kind: 'range', source_id: 'fin-approval', text: 'R-07 虚构付款审批：10–20 万元，部门负责人 → 财务经理 → 分管副总裁。', distance: 0.1234 },
  { rule_id: 'R-02', rule_type: 'general', chapter_no: 1, segments: ['*'], amt_kind: null, source_id: 'fin-approval', text: 'R-02 虚构总则：付款须附合同。', distance: 0.4 },
];

export interface FakeUpload {
  id: number; at: string; fileName: string; size: number; sha256: string; by: string; sourceId: string; sourceVersion: string; title: string; status: string;
  rulesTotal: number | null; written: number | null; removed: number | null; unchanged: number | null; conflicts: string[]; report: unknown; finishedAt: string | null;
  elapsedMs: number | null; error: { code: string; message: string; suggestion?: string } | null;
}
export function uploadOf(id: number, over: Partial<FakeUpload> = {}): FakeUpload {
  return { id, at: '2026-10-30T01:00:00.000Z', fileName: '虚构财务审批办法V4.docx', size: 40_000, sha256: 'c'.repeat(64), by: 'u-admin', sourceId: 'fin-approval',
    sourceVersion: 'V4.0 虚构版', title: '虚构财务审批办法V4.docx', status: 'ingested', rulesTotal: 128, written: 3, removed: 1, unchanged: 124, conflicts: [], report: null,
    finishedAt: '2026-10-30T01:01:30.000Z', elapsedMs: 90_000, error: null, ...over };
}

export interface FakeRule { id: string; title: string; format: string; chars: number; uploadedAt: string; text: string }
export const RULE_TEXT = '# 运维费须附验收单（虚构）\n\n运维服务费付款时，原件里要有甲方签字的验收单。';
export const OWN_RULES: FakeRule[] = [
  { id: 'r-1', title: '运维费规则（虚构）.md', format: 'md', chars: 1200, uploadedAt: '2026-10-29T03:00:00.000Z', text: RULE_TEXT },
  { id: 'r-2', title: '合同金额核对（虚构）.docx', format: 'docx', chars: 34, uploadedAt: '2026-10-29T04:00:00.000Z', text: '合同金额与付款金额不一致时不建议通过（虚构）。' },
];

const ok = (data: unknown, status = 200): FakeReply => ({ status, body: { data } });
const refuse = (status: number, code: string, message: string): FakeReply => ({ status, body: { error: { code, message } } });

export interface KbOptions {
  role?: Role;
  mode?: { mode: string; configured: boolean; ready: boolean; ops: string[] };
  sources?: FakeSource[];
  uploads?: FakeUpload[];
  rules?: FakeRule[];
  overrides?: Record<string, FakeRoute>;
}

/** 假测试台。overrides 里的路由（「方法 路径」）优先。 */
export function fakeKb({ role = 'admin', mode = { mode: 'pg', configured: true, ready: true, ops: ALL_OPS }, sources = SOURCES.map(s => ({ ...s })),
  uploads = [] as FakeUpload[], rules = OWN_RULES.map(r => ({ ...r })), overrides = {} as Record<string, FakeRoute> }: KbOptions = {}) {
  const state = { sources, uploads, rules, nextUpload: 1 + Math.max(0, ...uploads.map(u => u.id)), nextRule: 10, fetchedAt: '2026-11-03T01:00:00.000Z' };
  const routes: Record<string, FakeRoute> = {
    'GET /api/analysis/v1/session': { body: sessionBody(role) },
    [`GET ${KB}/mode`]: () => ok(mode),
    // 外壳把清单存在库里：平时回存着的那份和读到的时间；?refresh=1 是重新问了 Agent
    [`GET ${KB}/sources`]: call => {
      if (new URLSearchParams(call.search).get('refresh') === '1') state.fetchedAt = '2026-11-03T02:30:00.000Z';
      return ok({ success: true, sources: state.sources, fetched_at: state.fetchedAt });
    },
    [`GET ${KB}/uploads`]: () => ok({ items: [...state.uploads].sort((a, b) => b.id - a.id).slice(0, 50) }),
    [`POST ${KB}/sources`]: call => {
      const params = new URLSearchParams(call.search);
      const sourceId = params.get('sourceId') ?? '';
      if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(sourceId)) return refuse(400, 'KB_REQUEST_INVALID', '请求不完整：制度标识只能用小写字母、数字和连字符（2–63 位），版本说明不超过 64 字，文档名不超过 200 字。');
      if (state.uploads.some(u => u.status === 'ingesting')) return refuse(409, 'KB_INGEST_BUSY', '已经有一份文档在入库，等它完成再试。');
      const item = uploadOf(state.nextUpload, { fileName: decodeURIComponent(call.headers.get('X-File-Name') ?? ''), size: (call.body as File)?.size ?? 0, sourceId,
        sourceVersion: params.get('sourceVersion') ?? '', title: params.get('title') ?? '', status: 'ingesting', rulesTotal: null, written: null, removed: null, unchanged: null,
        finishedAt: null, elapsedMs: null });
      state.nextUpload += 1;
      state.uploads.push(item);
      register();
      return ok({ id: item.id, status: 'ingesting' }, 202);
    },
    [`GET ${KB}/search`]: call => {
      const q = new URLSearchParams(call.search).get('q') ?? '';
      if (!q.trim()) return refuse(400, 'KB_QUESTION_INVALID', '请写一个问题（不超过 2000 字）；板块不超过 40 字，金额写以元为单位的数字，条数 1–20。');
      return ok({ success: true, filter: {}, results: HITS });
    },
    [`GET ${RULES}`]: () => ok({ items: state.rules.map(({ text: _text, ...rest }) => rest), usedChars: state.rules.reduce((sum, r) => sum + r.chars, 0), limitChars: null, limitFiles: 10 }),
    [`POST ${RULES}`]: async (call: FakeCall) => {
      const name = decodeURIComponent(call.headers.get('X-File-Name') ?? '');
      if (!/\.(md|docx)$/i.test(name)) return refuse(400, 'CUSTOM_RULES_TYPE', '只收 Markdown（.md）或 Word（.docx）文件。');
      if (state.rules.length >= 10) return refuse(409, 'CUSTOM_RULES_FILE_LIMIT', '每人最多 10 份规则：先删掉一份再上传。');
      const text = (await (call.body as File).text()).trim();
      const size = Array.from(text).length;
      // 合计字数不设上限（外壳 custom-rules.mjs）：只核对份数
      const rule = { id: `r-${state.nextRule}`, title: name, format: name.endsWith('.md') ? 'md' : 'docx', chars: size, uploadedAt: '2026-10-30T05:00:00.000Z', text };
      state.nextRule += 1;
      state.rules.push(rule);
      register();
      return ok(rule, 201);
    },
  };
  function register() {
    for (const s of state.sources) {
      const base = `${KB}/sources/${encodeURIComponent(s.source_id)}`;
      routes[`GET ${base}`] ??= () => {
        const now = state.sources.find(x => x.source_id === s.source_id);
        return now ? ok({ success: true, source: now, rule_ids: ['R-01', 'R-02', 'R-07'] }) : ok({ success: false, error_type: 'not_found', message: '没有这个制度标识（虚构）。' });
      };
      for (const op of ['deactivate', 'restore', 'delete']) {
        routes[`POST ${base}/${op}`] ??= () => {
          const at = state.sources.findIndex(x => x.source_id === s.source_id);
          if (at < 0) return ok({ success: false, error_type: 'not_found', message: '没有这个制度标识（虚构）。' });
          const affected = state.sources[at].rules_total;
          if (op === 'delete') state.sources.splice(at, 1);
          else state.sources[at] = { ...state.sources[at], status: op === 'deactivate' ? 'inactive' : 'active' };
          return ok({ success: true, source_id: s.source_id, affected });
        };
      }
    }
    for (const u of state.uploads) routes[`GET ${KB}/uploads/${u.id}`] ??= () => ok(state.uploads.find(x => x.id === u.id));
    for (const r of state.rules) {
      routes[`GET ${RULES}/${r.id}`] ??= () => {
        const now = state.rules.find(x => x.id === r.id);
        return now ? ok(now) : refuse(404, 'CUSTOM_RULES_NOT_FOUND', '找不到这份规则，刷新后再试。');
      };
      routes[`POST ${RULES}/${r.id}/delete`] ??= () => {
        const at = state.rules.findIndex(x => x.id === r.id);
        if (at < 0) return refuse(404, 'CUSTOM_RULES_NOT_FOUND', '找不到这份规则，刷新后再试。');
        state.rules.splice(at, 1);
        return ok({ id: r.id, deleted: true });
      };
    }
    Object.assign(routes, overrides);
  }
  register();
  const server = fakeApi(routes);
  /** 让一条「入库中」的上传记录收尾（状态和结果照外壳 outcome() 的样子）。 */
  function finish(id: number, patch: Partial<FakeUpload>) {
    const at = state.uploads.findIndex(u => u.id === id);
    state.uploads[at] = { ...state.uploads[at], finishedAt: '2026-10-30T01:02:00.000Z', elapsedMs: 62_000, ...patch };
  }
  return { ...server, state, finish };
}

export { deferred } from './documentsFake';

export const docxFile = (name = 'fin-approval.docx', size = 2048) => new File([new Uint8Array(size)], name, { type: DOCX });
export const mdFile = (name: string, text: string) => new File([text], name, { type: 'text/markdown' });
