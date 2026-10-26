/**
 * 「制度知识库」页在测试台上起的 Python 子进程（kb/lib，测试台的 venv 里有 psycopg）：
 *   parse(docx, out)        parse_rules.py：读末行 REPORT，退出码非 0 时带上解析器的说明（stderr 最后一行）
 *   preview(rules, meta)    ingest_rules.py --embed sql --prune --dry-run：入库前看会新增 / 更新 / 删除多少
 *   ingest(rules, meta)     ingest_rules.py --embed sql --prune：向量由库里的 kb_embed() 生成，本服务不需要 AWS 凭证
 *   admin(args)             kb_admin.py：上传历史、标签、检索、检索日志
 * 都以 python -I（隔离模式）跑，连库密码只以 --password-file 传（文件在密钥目录里），不进参数和日志。
 */
import { execFile as nodeExecFile } from 'node:child_process';
import path from 'node:path';

const LIMITS = Object.freeze({ parse: 60_000, preview: 120_000, ingest: 15 * 60_000, admin: 30_000 });
const lastLine = text => String(text || '').trim().split('\n').at(-1) || '';

function defaultExecFile(file, args, { timeout }) {
  return new Promise(resolve => {
    nodeExecFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024, env: { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: process.env.HOME } }, (error, stdout, stderr) => {
      const code = !error ? 0 : Number.isInteger(error.code) ? error.code : 124;
      resolve({ code, stdout: String(stdout), stderr: error?.killed ? `${stderr}\n超过 ${Math.round(timeout / 1000)} 秒没有完成` : String(stderr) });
    });
  });
}

export function createKbRunner({ python, dir, pg, table = 'approval_rules', model = 'amazon.titan-embed-text-v2:0', dim = 1024, region = 'us-east-1', execFile = defaultExecFile }) {
  const lib = name => path.join(dir, 'lib', name);
  const connection = ['--host', pg.host, '--port', String(pg.port), '--db', pg.db, '--user', pg.user, '--password-file', pg.passwordFile];
  const failure = (code, message) => Object.assign(new Error(message || '没有完成'), { code });
  const json = text => { try { return JSON.parse(lastLine(text)); } catch { return null; } };

  async function parse(file, out) {
    const result = await execFile(python, ['-I', lib('parse_rules.py'), file, out], { timeout: LIMITS.parse });
    const line = String(result.stdout).trim().split('\n').reverse().find(entry => entry.startsWith('REPORT '));
    let report = null;
    try { report = line ? JSON.parse(line.slice('REPORT '.length)) : null; } catch { report = null; }
    return { code: result.code, report, message: result.code === 0 ? '' : lastLine(result.stderr) || '解析没有完成' };
  }
  const ingestArgs = (rules, meta, dryRun) => ['-I', lib('ingest_rules.py'), '--rules', rules, ...connection, '--table', table,
    '--ddl', path.join(dir, 'sql', 'approval_rules.sql'), '--source-tag', meta.sourceTag, '--source-doc', meta.sourceDoc, '--source-version', meta.sourceVersion ?? '',
    '--model', model, '--dim', String(dim), '--region', region, '--embed', 'sql', '--prune', ...(dryRun ? ['--dry-run'] : [])];
  async function ingestRun(args, timeout) {
    const result = await execFile(python, args, { timeout });
    const summary = json(result.stdout);
    if (result.code !== 0 || !summary) throw failure('KB_INGEST_FAILED', lastLine(result.stderr) || lastLine(result.stdout));
    return summary;
  }
  return {
    parse,
    preview: (rules, meta) => ingestRun(ingestArgs(rules, meta, true), LIMITS.preview),
    ingest: (rules, meta) => ingestRun(ingestArgs(rules, meta, false), LIMITS.ingest),
    async admin(args) {
      const result = await execFile(python, ['-I', lib('kb_admin.py'), ...connection, '--table', table, ...args], { timeout: LIMITS.admin });
      const answer = json(result.stdout);
      if (result.code !== 0 || !answer || answer.error) throw failure('KB_ADMIN_FAILED', answer?.error || lastLine(result.stderr));
      return answer;
    },
  };
}
