/**
 * 每个应用账号一个目录 <root>/<账号>/（0700）：
 *   nexus/           这个账号的 operator CLI 凭证目录（NEXUS_HOME），由 CLI 自己管理
 *   enabled.json     启用的 Agent（调用密钥已加密）
 *   connection.json  连接 Nexus 的时间与 Nexus 账号（不含任何密钥）
 *   audit.jsonl      留痕：连接、断开、启用、换密钥、重新验证、停用、标记失效（只追加）
 * 写入先写临时文件再改名；同一账号的写操作排队执行。
 */
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ACCOUNT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const error = code => Object.assign(new Error(code), { code });

export function createUserStore({ root, now = () => new Date().toISOString() }) {
  const chains = new Map();
  let sequence = 0;
  const dirFor = accountId => {
    if (typeof accountId !== 'string' || !ACCOUNT.test(accountId)) throw error('POC_ACCOUNT_INVALID');
    return path.join(root, accountId);
  };
  const file = (accountId, name) => path.join(dirFor(accountId), name);
  async function ensure(accountId) {
    const dir = dirFor(accountId);
    await mkdir(path.join(dir, 'nexus'), { recursive: true, mode: 0o700 });
    return dir;
  }
  function serial(accountId, task) {
    const run = async () => { dirFor(accountId); return task(); };
    const next = (chains.get(accountId) ?? Promise.resolve()).then(run, run);
    chains.set(accountId, next.catch(() => {}));
    return next;
  }
  async function readJson(target, fallback) {
    try { return JSON.parse(await readFile(target, 'utf8')); } catch (cause) {
      if (cause?.code === 'ENOENT') return fallback;
      throw error('POC_STORE_CORRUPT');
    }
  }
  async function writeJson(target, value) {
    sequence += 1;
    const tmp = `${target}.${process.pid}.${sequence}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, target);
  }
  async function items(accountId) {
    const data = await readJson(file(accountId, 'enabled.json'), { version: 1, items: [] });
    if (!data || !Array.isArray(data.items)) throw error('POC_STORE_CORRUPT');
    return data.items;
  }
  const save = (accountId, list) => writeJson(file(accountId, 'enabled.json'), { version: 1, items: list });
  return {
    // 有目录的账号（按名字排序）；审批流找系统里启用的调用密钥时用。
    async accounts() {
      try {
        return (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && ACCOUNT.test(entry.name)).map(entry => entry.name).sort();
      } catch (cause) {
        if (cause?.code === 'ENOENT') return [];
        throw cause;
      }
    },
    async nexusHomeFor(accountId) { return path.join(await ensure(accountId), 'nexus'); },
    async list(accountId) { dirFor(accountId); return items(accountId); },
    async get(accountId, publishId) { dirFor(accountId); return (await items(accountId)).find(entry => entry.publishId === publishId) ?? null; },
    put: (accountId, item) => serial(accountId, async () => {
      await ensure(accountId);
      await save(accountId, [...(await items(accountId)).filter(entry => entry.publishId !== item.publishId), item]);
      return item;
    }),
    // 先在队列里看一眼当前那一项，accept(当前项或 null) 为真才写；用来防止「验证期间被停用，验证完又写回去」。
    putIf: (accountId, item, accept) => serial(accountId, async () => {
      const list = await items(accountId);
      if (!accept(list.find(entry => entry.publishId === item.publishId) ?? null)) return null;
      await ensure(accountId);
      await save(accountId, [...list.filter(entry => entry.publishId !== item.publishId), item]);
      return item;
    }),
    update: (accountId, publishId, patch) => serial(accountId, async () => {
      const list = await items(accountId);
      const index = list.findIndex(entry => entry.publishId === publishId);
      if (index < 0) return null;
      list[index] = { ...list[index], ...patch };
      await save(accountId, list);
      return list[index];
    }),
    remove: (accountId, publishId) => serial(accountId, async () => {
      const list = await items(accountId);
      const kept = list.filter(entry => entry.publishId !== publishId);
      if (kept.length === list.length) return false;
      await save(accountId, kept);
      return true;
    }),
    async readConnection(accountId) { dirFor(accountId); return readJson(file(accountId, 'connection.json'), null); },
    saveConnection: (accountId, value) => serial(accountId, async () => { await ensure(accountId); await writeJson(file(accountId, 'connection.json'), value); }),
    clearConnection: accountId => serial(accountId, () => rm(file(accountId, 'connection.json'), { force: true })),
    audit: (accountId, entry) => serial(accountId, async () => {
      await ensure(accountId);
      await appendFile(file(accountId, 'audit.jsonl'), `${JSON.stringify({ at: now(), ...entry })}\n`, { mode: 0o600 });
    }),
    async readAudit(accountId) {
      try { return (await readFile(file(accountId, 'audit.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (cause) {
        if (cause?.code === 'ENOENT') return [];
        throw error('POC_STORE_CORRUPT');
      }
    },
  };
}
