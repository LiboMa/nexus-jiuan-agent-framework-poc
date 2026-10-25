/**
 * 种子单据的时间锚点：第一次启动时取「昨天中午（北京时间）」存进服务自己的数据目录，以后重启都沿用。
 * 九安首轮增量同步只读昨天 0 点以后的单据，所以锚点要近；但一旦同步进库，种子的时间就不能再变：
 * 变了的话，读原件时取回的详情和库里那份对不上（ANALYSIS_DETAIL_CHANGED），原件读不出来。重置测试台（bench07-reset.sh）时删掉文件重算。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DAY_MS = 24 * 3600_000, SHANGHAI_MS = 8 * 3600_000;
export const yesterdayNoon = at => Math.floor((at + SHANGHAI_MS) / DAY_MS) * DAY_MS - SHANGHAI_MS - DAY_MS + 12 * 3600_000;

export async function loadSeedAnchor(file, { now = () => new Date() } = {}) {
  try {
    const anchor = Date.parse(JSON.parse(await readFile(file, 'utf8')).anchor);
    if (Number.isFinite(anchor)) return anchor;
  } catch (error) { if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const anchor = yesterdayNoon(new Date(now()).getTime());
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.new`, JSON.stringify({ anchor: new Date(anchor).toISOString() }), { mode: 0o600 });
  await rename(`${file}.new`, file);
  return anchor;
}
