/** 校验 progress.json：node tools/progress/check.mjs。有错误退出 1（编号重复、未知状态、未知依赖、依赖成环……），文件不存在只算提醒。 */
import { loadProject } from './project.mjs';

const { errors, warnings } = await loadProject();
for (const warning of warnings) console.log(`提醒：${warning}`);
for (const error of errors) console.error(`错误：${error}`);
console.log(errors.length ? `progress.json 有 ${errors.length} 个错误` : `progress.json 没问题${warnings.length ? `（${warnings.length} 个提醒）` : ''}`);
process.exitCode = errors.length ? 1 : 0;
