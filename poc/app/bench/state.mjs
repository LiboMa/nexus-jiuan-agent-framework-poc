/**
 * 只依赖九安存储接口的几样（内存存储和九安 MySQL 存储都能用，不导入 mysql2）：
 * 按九安同步的写法写入单据原文、种子单据、模拟来单原文与来单编号的持久化。
 */
import { setTimeout as delay } from 'node:timers/promises';

const RAW_PREFIX = 'poc-raw:';
const SEQUENCE_KEY = 'poc-intake-sequence';
const PAGE = 100;

/** 按九安同步的写法写入单据原文：每家公司一个批次 → 每 100 条一页 upsertPage → 批次完成。 */
export async function writeRaws(store, { tenantId, raws, collectedAt = new Date().toISOString() }) {
  const byCompany = new Map();
  for (const raw of raws) {
    if (!byCompany.has(raw.docCompanyOID)) byCompany.set(raw.docCompanyOID, []);
    byCompany.get(raw.docCompanyOID).push(structuredClone(raw));
  }
  for (const [companyId, reports] of byCompany) {
    const scope = { tenantId, companyId };
    const batch = await store.createBatch({ scope, query: { source: 'poc-bench' } });
    let pages = 0;
    for (let start = 0; start < reports.length; start += PAGE) {
      await store.upsertPage({ scope, reports: reports.slice(start, start + PAGE), batchId: batch.id, collectedAt });
      pages += 1;
    }
    await store.updateBatch(batch.id, { status: 'completed', finishedAt: new Date().toISOString(), pages, reportCount: reports.length });
  }
}

/** 种子单据：每次启动都写一遍，原文不变时九安不会多出版本。 */
export async function seedBench(store, { tenantId, raws }) {
  await writeRaws(store, { tenantId, raws });
}

/** 模拟来单的原文：九安读单据详情时按单据号来取，所以要存在库里，重启后还在。 */
export async function rememberRaw(store, raw) {
  await store.writeState(`${RAW_PREFIX}${raw.businessCode}`, raw);
}

export async function lookupRaw(store, number) {
  return (await store.readState(`${RAW_PREFIX}${number}`)) ?? null;
}

/** 下一张模拟来单的编号（从 1 开始），存在存储里；并发时靠 compareAndWriteState 排队，冲突就重读再试。 */
export async function nextIntakeSequence(store) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await store.readState(SEQUENCE_KEY);
    const revision = current?.revision ?? 0;
    const value = (current?.value ?? 0) + 1;
    try {
      await store.compareAndWriteState(SEQUENCE_KEY, { expectedRevision: revision, value: { revision: revision + 1, value } });
      return value;
    } catch (error) {
      if (error?.code !== 'ANALYSIS_STATE_CONFLICT') throw error;
      await delay(5 + Math.floor(Math.random() * 20));
    }
  }
  throw Object.assign(new Error('POC_INTAKE_BUSY'), { code: 'POC_INTAKE_BUSY', status: 409 });
}
