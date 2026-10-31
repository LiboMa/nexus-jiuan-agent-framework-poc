/**
 * 知识库页和「上传制度」「检索」弹框要的接口：测试台外壳 /poc/kb/*（poc/app07/kb-steward-routes.mjs），规则库由 Nexus 上的知识库 Agent 经 A2A 读写。
 *   GET  /poc/kb/mode                         { mode, configured, ready, ops }（冷启动要等 describe，约 10–20 秒）
 *   GET  /poc/kb/sources · /sources/:id       制度清单、一份制度的登记和规则编号
 *   POST /poc/kb/sources/:id/(deactivate|restore|delete)
 *   POST /poc/kb/sources?sourceId&sourceVersion&title   请求体是 .docx 原文（X-File-Name）→ 202 { id, status: 'ingesting' }
 *   GET  /poc/kb/uploads · /uploads/:id       上传记录；页面轮询到 ingested / skipped / failed
 *   GET  /poc/kb/search?q&segment&amount&k    板块、金额可空（空的不传）
 * 同步的操作是一次 A2A 调用：工具自己失败时也是 HTTP 200、data.success === false（带 message / suggestion），这里当失败抛出。
 */
import { ApiError, api } from './client';

export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const POLICY_MAX_BYTES = 20 * 1024 * 1024;
/** 新上传的制度标识（同外壳 kb-steward-routes.mjs 的 TAG）。 */
export const SOURCE_ID = /^[a-z0-9][a-z0-9-]{1,62}$/u;
export const AMOUNT = /^\d{1,13}(?:\.\d{1,2})?$/u;
export const TITLE_MAX = 200;
export const VERSION_MAX = 64;
/** 上传后每 2.5 秒看一次上传记录（Ruling：2–3 秒），停在结果上。 */
export const KB_POLL_MS = 2500;
export const SEARCH_K = 8;
export const WORKING = '正在处理（约 10–20 秒）';

export type KbOp = 'deactivate' | 'restore' | 'delete';
export interface KbMode { mode: string; configured: boolean; ready: boolean; ops: string[] }
export interface KbSource {
  source_id: string; title?: string | null; source_version?: string | null; file_name?: string | null; rules_total?: number | null;
  status?: string | null; ingested_at?: string | null; updated_at?: string | null;
}
export interface KbUpload {
  id: number; at?: string; fileName?: string; size?: number; by?: string; sourceId?: string; sourceVersion?: string; title?: string;
  status: 'ingesting' | 'ingested' | 'skipped' | 'failed' | string;
  rulesTotal?: number | null; written?: number | null; removed?: number | null; unchanged?: number | null; conflicts?: string[] | null;
  finishedAt?: string | null; elapsedMs?: number | null; error?: { code?: string; message?: string; suggestion?: string } | null;
}
export interface KbHit { rule_id: string; segments?: string[] | null; source_id?: string | null; text?: string | null; distance?: number | null }

/**
 * 两种方式各自的 Agent 叫法和页面上的说明（照补丁 0005 的事实，换成审核员看得懂的话：不提 A2A、向量、数据库、连接器、工具名）。
 * lead 是放在句首、后面直接接汉字时的写法（「知识库 Agent」后空一格）。
 */
export const AGENTS = {
  pg: { name: '知识库 Agent', lead: '知识库 Agent ',
    lede: '公司制度存在知识库里，由知识库 Agent 负责写入和维护。上传审批矩阵格式的制度后，一行就是一条规则：一条审批路径，规则编号和原文的序号对应；AI 审单时按规则编号引用这里的规则。',
    search: '和 AI 审单时用的是同一个检索。关键词用空格隔开更准，例如「房租 年度框架合同 九安」：含这些词越多的规则越靠前，一样多的再按意思接近的程度排。板块、金额可空。距离越小越接近。' },
  s3vectors: { name: '知识库文档管家', lead: '知识库文档管家',
    lede: '公司制度存在知识库里，由知识库文档管家负责写入和维护。上传审批矩阵格式的制度后，一行就是一条规则：一条审批路径，规则编号和原文的序号对应；AI 审单时只查有效的规则，按规则编号引用。',
    search: '和 AI 审单时用的是同一个检索：只查有效的规则；填了板块只留这个板块和适用全部板块的规则，填了金额只留金额落在档位里的规则（不按金额分档的规则照样保留）。距离越小越接近。' },
} as const;
export type Agent = (typeof AGENTS)[keyof typeof AGENTS];
export const agentOf = (mode: string | undefined): Agent | null => (mode && Object.hasOwn(AGENTS, mode) ? AGENTS[mode as keyof typeof AGENTS] : null);
/** 还不知道方式时的叫法。 */
export const DEFAULT_AGENT: Agent = AGENTS.pg;
/** 接口中途回这两个错误码时，页面重新问 /mode，整页换成那句提示。 */
export const NOT_READY_CODES: ReadonlySet<string> = new Set(['KB_AGENT_NOT_READY', 'KB_AGENT_NOT_CONFIGURED']);

/** 同步的工具调用：success === false 当失败，文案照工具的 message（有 suggestion 就接在括号里）。 */
async function tool<T>(path: string, agent: Agent, init?: Parameters<typeof api>[1]): Promise<T> {
  const data = await api<T & { success?: boolean; message?: unknown; suggestion?: unknown; error_type?: unknown }>(path, init);
  if (data && typeof data === 'object' && data.success === false) {
    const message = typeof data.message === 'string' && data.message.trim() ? data.message : `${agent.lead}没有完成这次操作，稍后再试。`;
    const suggestion = typeof data.suggestion === 'string' && data.suggestion.trim() ? `（${data.suggestion}）` : '';
    throw new ApiError(200, typeof data.error_type === 'string' ? data.error_type : 'KB_TOOL_FAILED', `${message}${suggestion}`);
  }
  return data;
}
const enc = encodeURIComponent;

export const fetchMode = () => api<KbMode>('/poc/kb/mode');
export async function fetchSources(agent: Agent): Promise<KbSource[]> {
  const data = await tool<{ sources?: KbSource[] }>('/poc/kb/sources', agent);
  return Array.isArray(data?.sources) ? data.sources.filter(source => source && typeof source.source_id === 'string') : [];
}
export const fetchSource = (id: string, agent: Agent) => tool<{ source: KbSource; rule_ids?: string[] }>(`/poc/kb/sources/${enc(id)}`, agent);
export const manageSource = (id: string, op: KbOp, agent: Agent) => tool<{ source_id: string; affected?: number }>(`/poc/kb/sources/${enc(id)}/${op}`, agent, { method: 'POST' });
export async function fetchUploads(): Promise<KbUpload[]> {
  const data = await api<{ items?: KbUpload[] }>('/poc/kb/uploads');
  return Array.isArray(data?.items) ? data.items : [];
}
export const fetchUpload = (id: number) => api<KbUpload>(`/poc/kb/uploads/${id}`);

export interface UploadInput { file: File; sourceId: string; sourceVersion: string; title: string }
/** 版本说明没写就不带 sourceVersion（外壳 kb-steward-routes.mjs 的 meta() 把没有当空的）。 */
export function uploadPolicy({ file, sourceId, sourceVersion, title }: UploadInput) {
  const params = new URLSearchParams({ sourceId, ...(sourceVersion.trim() ? { sourceVersion: sourceVersion.trim() } : {}), title });
  return api<{ id: number; status: string }>(`/poc/kb/sources?${params}`, { method: 'POST', raw: file, headers: { 'Content-Type': DOCX, 'X-File-Name': enc(file.name) } });
}

export interface SearchInput { q: string; segment: string; amount: string }
export function searchRules({ q, segment, amount }: SearchInput, agent: Agent) {
  const params = new URLSearchParams({ q, ...(segment ? { segment } : {}), ...(amount ? { amount } : {}), k: String(SEARCH_K) });
  return tool<{ results?: KbHit[] }>(`/poc/kb/search?${params}`, agent);
}

export const kbKeys = {
  mode: ['kb', 'mode'] as const,
  sources: ['kb', 'sources'] as const,
  source: (id: string) => ['kb', 'source', id] as const,
  uploads: ['kb', 'uploads'] as const,
  upload: (id: number) => ['kb', 'upload', id] as const,
};

// ---- 预填（Ruling T6b）----

/** 最多 max 个码点（和外壳按 [...text].length 量字数的办法一样）。 */
export const clipChars = (text: string, max: number) => Array.from(text).slice(0, max).join('');
export const charCount = (text: string) => Array.from(text).length;

/** 制度标识按文件名预填：清单里有同名文件的制度就用它的标识；否则英文文件名转成标识；中文的留空让人填。 */
export function prefillSourceId(fileName: string, sources: KbSource[]): string {
  const known = sources.find(source => source.file_name && source.file_name === fileName);
  if (known) return known.source_id;
  const stem = fileName.replace(/\.docx$/iu, '');
  const slug = /^[\x20-\x7e]+$/u.test(stem) ? stem.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+/u, '').slice(0, 63).replace(/-+$/u, '') : '';
  return SOURCE_ID.test(slug) ? slug : '';
}
/**
 * 文档名：标识是清单里已有的制度就用它登记的标题；否则用完整的原文件名（带 .docx）——PG 知识库 Agent 把它记成 source_doc，
 * 少了 .docx，没改过的文件再传一次会是「更新」而不是「没有变化」。最多 200 字。
 */
export function prefillTitle(sourceId: string, fileName: string, sources: KbSource[]): string {
  const known = sources.find(source => source.source_id === sourceId);
  return clipChars(known?.title?.trim() || fileName, TITLE_MAX);
}

// ---- 文案 ----

export const nameOf = (source: Pick<KbSource, 'title' | 'source_id'>) => source.title?.trim() || source.source_id;
export const thousands = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '—');
export const sizeText = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
export const clip = (text: string, max: number) => { const chars = Array.from(text); return chars.length > max ? `${chars.slice(0, max).join('')}…` : text; };
