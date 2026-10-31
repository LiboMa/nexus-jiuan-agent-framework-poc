/**
 * 「我的规则」要的接口：测试台外壳 /poc/custom-rules*（poc/app07/custom-rules.mjs），只操作当前登录账号自己的。
 *   GET  /poc/custom-rules             { items: [{ id, title, format, chars, uploadedAt }], usedChars, limitChars, limitFiles }
 *   POST /poc/custom-rules             请求体是文件原文（X-File-Name 为 encodeURIComponent 后的文件名）→ 201 { …, text }（转出来的文字）
 *   GET  /poc/custom-rules/:id         一份规则，带全文
 *   POST /poc/custom-rules/:id/delete  → { id, deleted: true }
 * 限额（每人 10 份、单个文件 2 MB、合计 5,000 字）由外壳核对，超了照它的中文提示显示。
 */
import { api } from './client';
import { DOCX } from './knowledge';

export const RULE_MAX_BYTES = 2 * 1024 * 1024;
export const RULE_FILE = /\.(md|docx)$/iu;
export interface OwnRule { id: string; title: string; format: 'md' | 'docx' | string; chars: number; uploadedAt: string }
export interface OwnRuleText extends OwnRule { text: string }
export interface OwnRules { items: OwnRule[]; usedChars: number; limitChars: number; limitFiles: number }

const enc = encodeURIComponent;
export async function fetchRules(): Promise<OwnRules> {
  const data = await api<Partial<OwnRules>>('/poc/custom-rules');
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    usedChars: typeof data?.usedChars === 'number' ? data.usedChars : 0,
    limitChars: typeof data?.limitChars === 'number' ? data.limitChars : 5000,
    limitFiles: typeof data?.limitFiles === 'number' ? data.limitFiles : 10,
  };
}
export const fetchRule = (id: string) => api<OwnRuleText>(`/poc/custom-rules/${enc(id)}`);
export const uploadRule = (file: File) => api<OwnRuleText>('/poc/custom-rules', {
  method: 'POST', raw: file,
  headers: { 'Content-Type': /\.docx$/iu.test(file.name) ? DOCX : 'text/markdown; charset=utf-8', 'X-File-Name': enc(file.name) },
});
export const deleteRule = (id: string) => api<{ id: string; deleted: boolean }>(`/poc/custom-rules/${enc(id)}/delete`, { method: 'POST' });

export const rulesKeys = {
  list: ['custom-rules', 'list'] as const,
  one: (id: string) => ['custom-rules', 'one', id] as const,
};
