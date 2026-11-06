import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DEPLOY_ENV_KEYS, childEnv } from './helpers/child-env.mjs';

const execFileAsync = promisify(execFile);
// 子进程不继承部署的环境（DEPLOY_ENV 和环境配置的键，见 helpers/child-env.mjs）；自己给了 env 的调用照它给的
const run = (file, args, options = {}) => execFileAsync(file, args, { env: childEnv(), ...options });
const infra = name => fileURLToPath(new URL(`../${name}`, import.meta.url));
const block = (text, name) => {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `模板里没有 ${name}`);
  const next = text.slice(start + 1).search(/\n  [A-Za-z0-9]+:\n|\nOutputs:\n/);
  return text.slice(start + 1, next < 0 ? undefined : start + 1 + next);
};
// 九安 v0.7.10 代码里写死的外部主机（connectors.mjs、huilianyi-*.mjs、providers/*）
const BLACKHOLE = ['api.huilianyi.com', 'apistage.huilianyi.com', 'huoshantstapi.huilianyi.com', 'helioscloud-uat.huilianyi.com', 'oss-huilianyi.jiuan.com',
  'oapi.dingtalk.com', 'api.openai.com', 'finmcp.jiuan.local', 'sap-mcp.local', 'sub1api.jiuan.com', 'sub1api.theunifiedcare.com'];

test('配置脚本：服务以 jiuan 用户跑（读不到 secrets.env）、直接听 0.0.0.0:4180（安全组只放 CloudFront）、屏蔽实例元数据；库是 PostgreSQL 的 jiuan（pg-install.sh 起容器、pg-database.sh 建库和账号），不再管 MySQL；堵住写死的外部地址；先停掉以前的 v0.5.3 PoC 服务', async () => {
  const script = await readFile(infra('bench/bench-configure.sh'), 'utf8');
  const unit = await readFile(infra('bench/andon-jiuan.service'), 'utf8');
  assert.match(unit, /^User=jiuan$/m);
  assert.doesNotMatch(unit, /SupplementaryGroups|Group=andon/);
  assert.match(unit, /^IPAddressDeny=169\.254\.169\.254 fd00:ec2::254$/m);
  for (const line of ['NoNewPrivileges=true', 'ProtectSystem=strict', 'ProtectHome=true', 'PrivateTmp=true', 'ReadWritePaths=/var/lib/jiuan', 'CapabilityBoundingSet=']) {
    assert.ok(unit.split('\n').includes(line), `单元里缺 ${line}`);
  }
  assert.match(unit, /^ExecStart=\/usr\/bin\/node-24 \/opt\/andon-finance\/current\/app\/server\.mjs$/m);
  assert.match(script, /^POC_PORT=4180$/m);
  assert.match(script, /^POC_BIND=0\.0\.0\.0$/m);
  assert.doesNotMatch(unit, /andon-finance-poc/);
  assert.match(script, /useradd --system [^\n]*jiuan/);
  assert.doesNotMatch(script, /usermod[^\n]*andon|-G andon/);
  const database = script.slice(script.indexOf('# >>> jiuan-database'), script.indexOf('# <<< jiuan-database'));
  assert.equal(database, '# >>> jiuan-database\nbash "$HERE/pg-install.sh"\nbash "$HERE/pg-database.sh" jiuan\n');
  assert.doesNotMatch(script, /mysql-install|jiuan-mysql|mysql_root|GRANT ALL|docker exec/, '库和账号只经 pg-database.sh 建；MySQL 不再由它管');
  // 外壳连库的设置写进 env：测试台的 PG（127.0.0.1:5433 / jiuan / jiuan_app），口令在 db_app_password
  for (const line of ['POC_DB_HOST=127.0.0.1', 'POC_DB_PORT=5433', 'POC_DB_NAME=jiuan', 'POC_DB_USER=jiuan_app']) assert.ok(script.split('\n').includes(line), `env 里缺 ${line}`);
  for (const host of BLACKHOLE) assert.ok(script.includes(host), `/etc/hosts 没堵 ${host}`);
  // 以前的 v0.5.3 PoC（占着 4180、按 Host 转发）：最先停掉、删掉单元和补充配置、转发设置；不再写转发
  const legacy = script.slice(script.indexOf('# >>> legacy-poc'), script.indexOf('# <<< legacy-poc'));
  assert.ok(script.indexOf('# >>> legacy-poc') > 0 && script.indexOf('# <<< legacy-poc') < script.indexOf('useradd --system'), '先停旧服务');
  assert.match(legacy, /systemctl disable --now andon-finance-poc\.service/);
  assert.match(legacy, /rm -f \/etc\/systemd\/system\/andon-finance-poc\.service/);
  assert.match(legacy, /rm -rf \/etc\/systemd\/system\/andon-finance-poc\.service\.d/);
  assert.match(legacy, /rm -f \/etc\/andon-finance\/jiuan07-forward\.env/);
  assert.doesNotMatch(script, /POC_FORWARD_HOST|EnvironmentFile=-\/etc\/andon-finance\/jiuan-forward\.env/);
  assert.doesNotMatch(script, /echo[^\n]*\$(MYSQL_PASSWORD|DATA_KEY|value)\b/, '不打印密钥');
  // 审核建议发给哪个发布由「Agent 接入」的启用记录决定；S3 Vectors 方式的文档管家发布由 deploy.sh 作为参数传进来，脚本里只核对格式
  assert.doesNotMatch(script, /NEXUS_REVIEW_ADVICE_PUBLICATION|PUBLISH|pub_[0-9a-f]/, '不写死发布');
});

test('配置脚本：2026-11-02 之前的名字（andon-jiuan07、jiuan07……）原地改成现在的：先停旧服务，用户、组、目录改名；新名字已在就不动；MySQL 里的库和账号改名那段拿掉了（m7g 上早已改完，MySQL 不再由它管）', async () => {
  const script = await readFile(infra('bench/bench-configure.sh'), 'utf8');
  const start = script.indexOf('# >>> legacy-07');
  const legacy = script.slice(start, script.indexOf('# <<< legacy-07'));
  assert.ok(start > script.indexOf('# <<< legacy-poc') && script.indexOf('# <<< legacy-07') < script.indexOf('useradd --system'), '先改名，再按新名字建用户');
  for (const line of [/systemctl disable --now andon-jiuan07\.service/, /rm -f \/etc\/systemd\/system\/andon-jiuan07\.service/,
    /if id jiuan07 >\/dev\/null 2>&1 && ! id jiuan >\/dev\/null 2>&1; then\n  usermod -l jiuan jiuan07\n  groupmod -n jiuan jiuan07\n/,
    /\[\[ -d \/var\/lib\/jiuan07 && ! -e \/var\/lib\/jiuan \]\]; then mv \/var\/lib\/jiuan07 \/var\/lib\/jiuan/,
    /usermod -d \/var\/lib\/jiuan jiuan/, /\[\[ -d \/etc\/andon-finance\/jiuan07 && ! -e \/etc\/andon-finance\/jiuan \]\]; then mv \/etc\/andon-finance\/jiuan07 \/etc\/andon-finance\/jiuan/]) {
    assert.match(legacy, line);
  }
  assert.doesNotMatch(script, /RENAME TABLE|RENAME USER|schema_count|jiuan07_app|JIUAN_DB_RENAMED/);
});

test('配置脚本：数据密钥只认原值，和 secrets.env 不同就一个文件都不写；库口令写成 db_app_password（PG 的账号口令每次部署按 secrets.env 重设，所以不用钉住）；切换前的 mysql_app_password 不写也不删（回退到上一版构件时还要用）', async () => {
  const script = await readFile(infra('bench/bench-configure.sh'), 'utf8');
  assert.match(script, /^SECRET_FILES=\(JIUAN_PG_APP_PASSWORD:db_app_password JIUAN_DATA_KEY:analysis_data_key REVIEWER_PASSWORD:reviewer_password CHECKER_PASSWORD:checker_password\)$/m);
  assert.match(script, /^PINNED=\(analysis_data_key\)$/m);
  assert.match(script, /拒绝替换/);
  assert.match(script, /\[\[ "\$\(secret_value JIUAN_PG_APP_PASSWORD\)" =~ \^\[0-9a-f\]\{32\}\$ \]\] \|\| \{ echo "secrets\.env 里的 JIUAN_PG_APP_PASSWORD 应是 32 位十六进制"/);
  assert.doesNotMatch(script, /^[^#\n]*(mysql_app_password|JIUAN_MYSQL_APP_PASSWORD)/m, '代码里不再碰 MySQL 的口令（注释里可以说明为什么留着）');
  const reset = await readFile(infra('bench/bench-reset.sh'), 'utf8');
  assert.match(reset, /DROP DATABASE IF EXISTS jiuan WITH \(FORCE\)/);
  assert.doesNotMatch(reset, /jiuan_analysis/, '重置 v0.7.10 不碰 PoC 的库');
});

test('重置脚本：保留管理员在「Agent 接入」页上的启用记录（先导出、重建库跑完迁移后写回，再正式起服务），不读也不写任何调用密钥文件', async () => {
  const reset = await readFile(infra('bench/bench-reset.sh'), 'utf8');
  const steps = ["scope_key LIKE 'agent-enablement:%'", 'DROP DATABASE IF EXISTS jiuan', 'bash "$HERE/pg-database.sh" jiuan', 'systemctl start andon-jiuan.service', 'systemctl stop andon-jiuan.service',
    'COPY analysis_sync_states FROM STDIN', 'systemctl start andon-jiuan.service'];
  let at = -1;
  for (const step of steps) {
    const next = reset.indexOf(step, at + 1);
    assert.ok(next > at, `重置顺序不对或缺少：${step}`);
    at = next;
  }
  assert.doesNotMatch(reset, /secrets\.env|NEXUS_A2A_KEY|nxa_/);
});

test('重置脚本中途失败：服务照样起来，导出的启用记录留着（0600）并说出路径；导出用 COPY 的文本格式（bytea 成 \\x 十六进制，密文原样回得去）；表在却导不出来就停，不删库', async () => {
  const script = await readFile(infra('bench/bench-reset.sh'), 'utf8');
  assert.match(script, /trap finish EXIT/);
  const finish = script.slice(script.indexOf('finish() {'), script.indexOf('trap finish EXIT'));
  assert.match(finish, /systemctl start andon-jiuan\.service \|\| true/);
  assert.match(finish, /if \[\[ "\$rc" == 0 \]\]; then rm -rf "\$KEEP"/);
  assert.match(finish, /启用记录导出在 \$KEEP\/enablement\.copy，没删/);
  assert.ok(script.includes(`COPY (SELECT * FROM analysis_sync_states WHERE scope_key LIKE 'agent-enablement:%') TO STDOUT`));
  assert.match(script, /chmod 0600 "\$KEEP\/enablement\.copy"/);
  assert.doesNotMatch(script, /\|\| : > "\$KEEP/, '导出失败不能当成「没有启用记录」接着删库');
  assert.doesNotMatch(script, /mysql|MYSQL/);
});

// 照原样跑 bench-reset.sh：docker / systemctl / curl 换成只记账的桩（PATH 最前面），旁边的 pg-database.sh 换成桩；
// fail 给了就让对应的那一步失败。回 { code, stdout, stderr, calls, restored, keep }
async function runReset(t, { fail = '', dbExists = '1', hasTable = 't', rows = 'agent-enablement:v1:t\\\\x0a0b\t2026-11-06 01:02:03.456\n' } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'bench-reset-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'), bench = path.join(dir, 'bench'), log = path.join(dir, 'calls.log');
  await mkdir(bin); await mkdir(bench);
  await writeFile(path.join(bench, 'bench-reset.sh'), await readFile(infra('bench/bench-reset.sh'), 'utf8'));
  const stub = body => `#!/usr/bin/env bash\n${body}\n`;
  await writeFile(path.join(bench, 'pg-database.sh'), stub(`echo "pg-database.sh $*" >> "$LOG"; [[ "$FAIL" != create ]]`));
  await writeFile(path.join(bin, 'systemctl'), stub(`echo "systemctl $*" >> "$LOG"`), { mode: 0o755 });
  await writeFile(path.join(bin, 'curl'), stub('printf ok'), { mode: 0o755 });
  await writeFile(path.join(bin, 'docker'), stub([
    'echo "docker $*" >> "$LOG"',
    'case "$*" in',
    '  *pg_database*) printf \'%s\\n\' "$DB_EXISTS" ;;',
    '  *to_regclass*) printf \'%s\\n\' "$HAS_TABLE" ;;',
    '  *"TO STDOUT"*) [[ "$FAIL" != export ]] || exit 1; printf \'%s\' "$ROWS" ;;',
    '  *"FROM STDIN"*) cat > "$LOG.restored"; [[ "$FAIL" != restore ]] ;;',
    '  *DROP*) [[ "$FAIL" != drop ]] ;;',
    'esac'].join('\n')), { mode: 0o755 });
  const env = { ...childEnv(), PATH: `${bin}:${process.env.PATH}`, LOG: log, FAIL: fail, DB_EXISTS: dbExists, HAS_TABLE: hasTable, ROWS: rows };
  let result;
  try { result = { code: 0, ...(await run('bash', [path.join(bench, 'bench-reset.sh')], { env })) }; }
  catch (error) { result = { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  const keep = (result.stderr.match(/(\/var\/tmp\/jiuan-reset\.[A-Za-z0-9]+)\/enablement\.copy/) || [])[1];
  if (keep) t.after(() => rm(keep, { recursive: true, force: true }));
  return { ...result, keep, calls: (await readFile(log, 'utf8')).split('\n').filter(Boolean),
    restored: await readFile(`${log}.restored`, 'utf8').catch(() => null) };
}
const RESET_EXPORT = `docker exec -u postgres jiuan-pg psql -X -q -v ON_ERROR_STOP=1 -d jiuan -c COPY (SELECT * FROM analysis_sync_states WHERE scope_key LIKE 'agent-enablement:%') TO STDOUT`;

test('重置脚本照原样跑：停服务 → 表在就用 COPY 导出启用记录 → 删库 → pg-database.sh 按原参数建库 → 起服务跑迁移 → 停服务 → COPY 写回（字节不差）→ 起服务', async t => {
  const result = await runReset(t);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /JIUAN_ENABLEMENT_KEPT\nJIUAN_RESET_OK/);
  assert.deepEqual(result.calls, [
    'systemctl stop andon-jiuan.service',
    "docker exec -u postgres jiuan-pg psql -X -At -d postgres -c SELECT count(*) FROM pg_database WHERE datname = 'jiuan'",
    "docker exec -u postgres jiuan-pg psql -X -At -d jiuan -c SELECT to_regclass('public.analysis_sync_states') IS NOT NULL",
    RESET_EXPORT,
    'docker exec -u postgres jiuan-pg psql -X -q -v ON_ERROR_STOP=1 -d postgres -c DROP DATABASE IF EXISTS jiuan WITH (FORCE)',
    'pg-database.sh jiuan',
    'systemctl start andon-jiuan.service',
    'systemctl stop andon-jiuan.service',
    'docker exec -i -u postgres jiuan-pg psql -X -q -v ON_ERROR_STOP=1 -d jiuan -c COPY analysis_sync_states FROM STDIN',
    'systemctl start andon-jiuan.service',
    'systemctl start andon-jiuan.service']);
  assert.equal(result.restored, 'agent-enablement:v1:t\\\\x0a0b\t2026-11-06 01:02:03.456\n');
  assert.equal(result.keep, undefined);
});

test('重置脚本：库或表还不在（第一次部署）就没有要留的，照常重建、不写回；表在却导不出来就停（库不删），服务照样起来', async t => {
  for (const state of [{ dbExists: '0' }, { dbExists: '1', hasTable: 'f' }]) {
    const result = await runReset(t, state);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!result.calls.includes(RESET_EXPORT) && !result.calls.some(call => call.includes('FROM STDIN')), JSON.stringify(result.calls));
    assert.ok(result.calls.includes('pg-database.sh jiuan'));
    assert.match(result.stdout, /JIUAN_RESET_OK/);
    assert.doesNotMatch(result.stdout, /JIUAN_ENABLEMENT_KEPT/);
  }
  for (const fail of ['export']) {
    const failed = await runReset(t, { fail });
    assert.notEqual(failed.code, 0);
    assert.ok(!failed.calls.some(call => call.includes('DROP DATABASE')), '导不出来就不删库');
    assert.equal(failed.calls.at(-1), 'systemctl start andon-jiuan.service');
  }
});

test('重置脚本：写回失败（或建库失败）时服务照样起来，导出的启用记录留在 0600 的文件里并说出路径', async t => {
  for (const fail of ['restore', 'create']) {
    const result = await runReset(t, { fail });
    assert.notEqual(result.code, 0, fail);
    assert.equal(result.calls.at(-1), 'systemctl start andon-jiuan.service', fail);
    assert.ok(result.keep, `${fail}：${result.stderr}`);
    const { stat } = await import('node:fs/promises');
    const file = `${result.keep}/enablement.copy`;
    assert.equal((await stat(file)).mode & 0o777, 0o600, fail);
    assert.equal(await readFile(file, 'utf8'), 'agent-enablement:v1:t\\\\x0a0b\t2026-11-06 01:02:03.456\n', fail);
  }
});

// pg-database.sh 照原样跑，docker 换成桩：记下参数和送进 psql 的 SQL（标准输入）
async function runPgDatabase(t, args, { password = '0123456789abcdef0123456789abcdef' } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pg-database-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'), log = path.join(dir, 'calls.log'), secrets = path.join(dir, 'secrets.env');
  await mkdir(bin);
  await writeFile(secrets, `REVIEWER_PASSWORD=x\n${password === null ? '' : `JIUAN_PG_APP_PASSWORD=${password}\n`}`);
  await writeFile(path.join(bin, 'docker'), `#!/usr/bin/env bash\necho "docker $*" >> "$LOG"\ncat > "$LOG.sql"\n`, { mode: 0o755 });
  const env = { ...childEnv(), PATH: `${bin}:${process.env.PATH}`, LOG: log, BENCH_SECRETS_FILE: secrets };
  let result;
  try { result = { code: 0, ...(await run('bash', [infra('bench/pg-database.sh'), ...args], { env })) }; }
  catch (error) { result = { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  return { ...result, calls: await readFile(log, 'utf8').then(text => text.split('\n').filter(Boolean), () => []), sql: await readFile(`${log}.sql`, 'utf8').catch(() => '') };
}

test('pg-database.sh：在 jiuan-pg 里建账号 jiuan_app（没有才建，不是超级用户、不能建库建角色）、口令按 secrets.env 重设；库没有才建（属主 jiuan_app、UTF8 / C、template0），已有的核对编码和排序；只有属主连得上；库的时区是上海；口令只经标准输入、不打印', async t => {
  for (const [args, db] of [[[], 'jiuan'], [['jiuan'], 'jiuan'], [['jiuan_rehearsal'], 'jiuan_rehearsal']]) {
    const result = await runPgDatabase(t, args);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `JIUAN_PG_DATABASE_READY ${db}\n`);
    assert.deepEqual(result.calls, [`docker exec -i -u postgres jiuan-pg psql -X -q -v ON_ERROR_STOP=1 -v db=${db} -d postgres`]);
    const sql = result.sql;
    const order = ['SET log_min_error_statement = panic;',
      "SELECT 'CREATE ROLE jiuan_app' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jiuan_app') \\gexec",
      "ALTER ROLE jiuan_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '0123456789abcdef0123456789abcdef';",
      "SELECT format('CREATE DATABASE %I OWNER jiuan_app ENCODING %L LC_COLLATE %L LC_CTYPE %L TEMPLATE template0', :'db', 'UTF8', 'C', 'C')",
      "WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \\gexec",
      `datname = '${db}' AND (pg_encoding_to_char(encoding) <> 'UTF8' OR datcollate <> 'C' OR datctype <> 'C')`,
      'ALTER DATABASE :"db" OWNER TO jiuan_app;', `ALTER DATABASE :"db" SET timezone = 'Asia/Shanghai';`, 'REVOKE CONNECT ON DATABASE :"db" FROM PUBLIC;'];
    let at = -1;
    for (const line of order) {
      const next = sql.indexOf(line, at + 1);
      assert.ok(next > at, `${db}：SQL 里缺少或顺序不对：${line}\n${sql}`);
      at = next;
    }
    assert.ok(!result.stdout.includes('0123456789abcdef0123456789abcdef') && !result.stderr.includes('0123456789abcdef0123456789abcdef'), '不打印口令');
    assert.ok(!result.calls[0].includes('0123456789abcdef'), '口令不上命令行');
  }
});

test('pg-database.sh：库名只认 jiuan 或 jiuan_<小写字母数字>（退出 2），口令不是 32 位十六进制或没有（退出 1）；两种都不碰 docker', async t => {
  for (const name of ['postgres', 'Jiuan', 'jiuan;drop', 'jiuan_', 'jiuan-x', "jiuan'", 'nexus']) {
    const result = await runPgDatabase(t, [name]);
    assert.equal(result.code, 2, name);
    assert.deepEqual(result.calls, [], name);
  }
  for (const password of [null, '', 'short', '0123456789ABCDEF0123456789ABCDEF', "0123456789abcdef0123456789abcde'"]) {
    const result = await runPgDatabase(t, ['jiuan'], { password });
    assert.equal(result.code, 1, String(password));
    assert.match(result.stderr, /JIUAN_PG_APP_PASSWORD 应是 32 位十六进制/);
    assert.deepEqual(result.calls, [], String(password));
  }
});

test('deploy.sh：构建 v0.7.10 副本、把 app 和副本打进发布包；先配置测试台再重启 v0.7.10；密钥只补不换', async () => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  assert.match(deploy, /bench\/build-jiuan\.sh/);
  assert.match(deploy, /rsync -a --exclude test --exclude scripts --exclude node_modules --exclude \.DS_Store "\$POC_DIR\/app\/" "\$STAGE\/release\/app\/"/);
  assert.match(deploy, /rsync -a --exclude \.DS_Store "\$POC_DIR\/\.\.\/\.build\/jiuan\/" "\$STAGE\/release\/jiuan\/"/);
  assert.match(deploy, /^ensure_bench_secrets "\$SECRETS"$/m);
  assert.match(await readFile(infra('lib/bench-secrets.sh'), 'utf8'), /for name in BENCH_MYSQL_ROOT_PASSWORD JIUAN_MYSQL_APP_PASSWORD JIUAN_DATA_KEY BENCH_PG_SUPERUSER_PASSWORD JIUAN_PG_APP_PASSWORD; do/);
  // 整个 bench/ 进构件：bench-configure.sh 调的 pg-install.sh、pg-database.sh 都在
  assert.match(deploy, /^rsync -a --exclude \.DS_Store "\$HERE\/bench\/" "\$STAGE\/release\/bench\/"$/m);
  const install = deploy.slice(deploy.indexOf('# >>> install'), deploy.indexOf('# <<< install'));
  const order = ['bench-configure.sh" $SITE_DOMAIN', 'systemctl restart andon-jiuan.service'].map(text => install.indexOf(text));
  assert.ok(order.every(index => index > 0) && order[0] < order[1], `安装顺序不对：${order}`);
  assert.match(deploy, /\/poc\/healthz/);
  assert.doesNotMatch(install, /AdvisoryPublicationId|andon-finance-poc/, 'v0.7.10 不接收发布编号，也没有 PoC 服务');
});

// ---- 新前端（poc/web，React）：部署时按锁文件装依赖、跑测试、构建；dist/ 进构件的 web/dist，外壳的前门默认找 app/../web/dist ----
const WEB_BUILD = 'web_build() { (unset -v DEPLOY_ENV "${DEPLOY_ENV_KEYS[@]}"; cd "$1" && npm ci && npm test && npm run build); }';
const WEB_RSYNC = 'rsync -a --exclude .DS_Store "$POC_DIR/web/dist/" "$STAGE/release/web/dist/"';

test('deploy.sh：动 AWS 资源之前先构建新前端（npm ci → npm test → npm run build），再跑外壳的单元测试（前门对真实 dist 的那条测的就是要发的这份）；dist/ 打进构件的 web/dist；外壳默认就找这里', async () => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  const lines = deploy.split('\n');
  assert.ok(lines.find(line => line.startsWith('for tool in ')).split(' ').includes('npm'), '检查工具时要有 npm');
  assert.equal(lines.find(line => line.startsWith('web_build() ')), WEB_BUILD);
  const at = text => { const index = lines.indexOf(text); assert.ok(index > 0, `deploy.sh 里没有这一行：${text}`); return index; };
  const build = at('web_build "$POC_DIR/web"');
  const shellTests = at('node_tests "$POC_DIR/app" "test/unit/**/*.test.mjs"');
  assert.ok(at('"$POC_DIR/bench/build-jiuan.sh"') < build, '先构建九安 v0.7.10 副本');
  assert.ok(build < shellTests, '先构建新前端，再跑外壳的单元测试：前门对 poc/web/dist 的那条测试测的是这次构建、要发出去的那份');
  assert.ok(shellTests < lines.findIndex(line => line.includes('aws cloudformation deploy')), '外壳的单元测试不过就不建栈、不更新栈');
  assert.ok(build < lines.findIndex(line => line.includes('aws cloudformation deploy')), '新前端构建不过就不建栈、不更新栈');
  const mkdir = lines.find(line => line.startsWith('mkdir -p "$STAGE/release/'));
  assert.ok(mkdir.includes('"$STAGE/release/web/dist"'), '构件里先建好 web/dist');
  assert.ok(build < at(WEB_RSYNC) && at(WEB_RSYNC) < lines.findIndex(line => line.includes('tar --no-mac-metadata')), '构建在前，复制进构件、再打包');
  const front = await readFile(fileURLToPath(new URL('../../app/front.mjs', import.meta.url)), 'utf8');
  assert.match(front, /webDir = path\.join\(here, '\.\.\/web\/dist'\)/, '实例上外壳是 current/app/server.mjs，构件里是 current/web/dist');
});

test('deploy.sh 的 web_build：在 poc/web 里依次 npm ci、npm test、npm run build，DEPLOY_ENV 和环境配置的键都不传给 npm；哪一步失败部署就停', async t => {
  const fn = (await readFile(infra('deploy.sh'), 'utf8')).split('\n').find(line => line.startsWith('web_build() '));
  assert.ok(fn, 'deploy.sh 里应有一行 web_build() { … }');
  const fixture = fileURLToPath(new URL('./fixtures/deploy-env/s3v.env', import.meta.url));
  const dir = await mkdtemp(path.join(tmpdir(), 'deploy-web-build-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = npm => ['set -euo pipefail', `source ${JSON.stringify(infra('lib/deploy-env.sh'))}`, 'load_deploy_env 2>/dev/null', fn, npm,
    'printf "loaded=%s\\n" "${DEPLOY_ENV_LOADED[*]}"', `web_build ${JSON.stringify(dir)}`, 'echo AFTER_BUILD'].join('\n');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, DEPLOY_ENV: fixture, KB_ALLOWED_CIDR: '10.9.0.0/16', KEEP_ME: 'yes' };
  const { stdout } = await run('bash', ['-c', script('npm() { printf "npm=%s cwd=%s\\n" "$*" "$PWD"; [[ "$1" != ci ]] || env; }')], { env });
  const lines = stdout.split('\n');
  assert.ok(lines.find(line => line.startsWith('loaded=')).split(/[= ]/).includes('KB_MODE'), '先确认读进来了（并 export 了）');
  assert.deepEqual(lines.filter(line => line.startsWith('npm=')), [`npm=ci cwd=${dir}`, `npm=test cwd=${dir}`, `npm=run build cwd=${dir}`]);
  assert.ok(lines.includes('KEEP_ME=yes'), '别的环境变量照常传');
  assert.deepEqual(lines.map(line => line.slice(0, line.indexOf('='))).filter(name => name === 'DEPLOY_ENV' || DEPLOY_ENV_KEYS.includes(name)), []);
  assert.ok(lines.includes('AFTER_BUILD'));
  for (const step of ['ci', 'test', 'run']) {
    const failed = await run('bash', ['-c', script(`npm() { printf "npm=%s\\n" "$*"; [[ "$1" != ${step} ]]; }`)], { env }).then(() => null, error => error);
    assert.ok(failed && failed.code !== 0, `npm ${step} 失败时部署要停`);
    assert.doesNotMatch(failed.stdout, /AFTER_BUILD/, step);
    const ran = failed.stdout.split('\n').filter(line => line.startsWith('npm=')).map(line => line.slice(4).split(' ')[0]);
    assert.deepEqual(ran, ['ci', 'test', 'run'].slice(0, ['ci', 'test', 'run'].indexOf(step) + 1), step);
  }
});

// ---- 知识库两种方式（KB_MODE=pg|s3vectors，不写就是 pg）：「制度知识库」页都经 Nexus 上的知识库 Agent（A2A），测试台不直连 PG。
// deploy.sh 把方式和当前方式的知识库 Agent 发布（pg：KB_PG_PUBLICATION_ID；s3vectors：KB_S3V_PUBLICATION_ID）交给 bench-configure.sh ----
const KB_PUB = 'pub_0123456789abcdef';
const PG_PUB = 'pub_fedcba9876543210';
const SITE = ['jiuan.example.com', 'https://nexus.example.com'];
const deployPrelude = deploy => deploy.slice(0, deploy.indexOf('\nsay() ')).replace(/^#!.*\n/, '');

// 照 deploy.sh 拼实例上的安装脚本（先跑它开头的检查，栈参数换成假的），再看 bench-configure.sh 实际收到哪几个参数
async function configureArgs(env) {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  const block = deploy.slice(deploy.indexOf('# >>> install'), deploy.indexOf('# <<< install'));
  const script = [deployPrelude(deploy), 'param() { echo https://nexus.example.com; }', 'BUCKET=b REGION=us-east-1 SITE_DOMAIN=jiuan.example.com', block,
    'printf "%s" "$INSTALL"'].join('\n');
  const { stdout } = await run('bash', ['-c', script], { cwd: infra('.'), env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
  const prefix = 'bash "$work/release/bench/bench-configure.sh" ';
  const call = stdout.split('\n').find(line => line.startsWith(prefix)).slice(prefix.length);
  return (await run('bash', ['-c', `printf '[%s]' ${call}`])).stdout;
}

test('deploy.sh：KB_MODE（缺省 pg）和当前方式的知识库 Agent 发布是 bench-configure.sh 的第 3、4 个参数（pg 用 KB_PG_PUBLICATION_ID，s3vectors 用 KB_S3V_PUBLICATION_ID）', async () => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  assert.match(deploy.slice(deploy.indexOf('# >>> install'), deploy.indexOf('# <<< install')),
    /\/bench\/bench-configure\.sh" \$SITE_DOMAIN \$\(param NexusOrigin\) '\$\{KB_MODE:-pg\}' '\$KB_PUBLICATION'\n/);
  assert.equal(await configureArgs({}), '[jiuan.example.com][https://nexus.example.com][pg][]');
  assert.equal(await configureArgs({ KB_PG_PUBLICATION_ID: PG_PUB }), `[jiuan.example.com][https://nexus.example.com][pg][${PG_PUB}]`);
  assert.equal(await configureArgs({ KB_MODE: 'pg', KB_PG_PUBLICATION_ID: PG_PUB, KB_S3V_PUBLICATION_ID: KB_PUB }), `[jiuan.example.com][https://nexus.example.com][pg][${PG_PUB}]`);
  assert.equal(await configureArgs({ KB_MODE: 'pg', KB_S3V_PUBLICATION_ID: KB_PUB }), '[jiuan.example.com][https://nexus.example.com][pg][]', 'pg 方式不拿文档管家的发布');
  assert.equal(await configureArgs({ KB_MODE: 's3vectors', KB_S3V_PUBLICATION_ID: KB_PUB }), `[jiuan.example.com][https://nexus.example.com][s3vectors][${KB_PUB}]`);
  assert.equal(await configureArgs({ KB_MODE: 's3vectors', KB_S3V_PUBLICATION_ID: KB_PUB, KB_PG_PUBLICATION_ID: PG_PUB }), `[jiuan.example.com][https://nexus.example.com][s3vectors][${KB_PUB}]`);
});

test('deploy.sh：KB_MODE 只能是 pg 或 s3vectors，s3vectors 时要有 KB_S3V_PUBLICATION_ID，两个发布编号给了就要合格式（pg 的不强制）——在动任何 AWS 资源之前就停（exit 2）', async () => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  const prelude = deployPrelude(deploy);
  const runPrelude = env => run('bash', ['-c', `${prelude}\necho PRELUDE_OK`], { cwd: infra('.'), env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
  for (const env of [{}, { KB_MODE: 'pg' }, { KB_PG_PUBLICATION_ID: PG_PUB }, { KB_MODE: 'pg', KB_PG_PUBLICATION_ID: PG_PUB },
    { KB_MODE: 's3vectors', KB_S3V_PUBLICATION_ID: KB_PUB }]) assert.equal((await runPrelude(env)).stdout, 'PRELUDE_OK\n', JSON.stringify(env));
  for (const env of [{ KB_MODE: 'mongo' }, { KB_MODE: 's3vectors' }, { KB_MODE: 's3vectors', KB_S3V_PUBLICATION_ID: 'pub_0123' },
    { KB_MODE: 's3vectors', KB_S3V_PUBLICATION_ID: `${KB_PUB}' && reboot '` }, { KB_S3V_PUBLICATION_ID: "pub_x'" }]) {
    await assert.rejects(runPrelude(env), error => error.code === 2 && !error.stdout.includes('PRELUDE_OK') && /KB_MODE|KB_S3V_PUBLICATION_ID/.test(error.stderr), JSON.stringify(env));
  }
  for (const env of [{ KB_PG_PUBLICATION_ID: 'pub_0123' }, { KB_MODE: 'pg', KB_PG_PUBLICATION_ID: PG_PUB.toUpperCase() }, { KB_PG_PUBLICATION_ID: `${PG_PUB}' && reboot '` },
    { KB_MODE: 's3vectors', KB_S3V_PUBLICATION_ID: KB_PUB, KB_PG_PUBLICATION_ID: "pub_x'" }]) {
    await assert.rejects(runPrelude(env), error => error.code === 2 && !error.stdout.includes('PRELUDE_OK') && /KB_PG_PUBLICATION_ID/.test(error.stderr), JSON.stringify(env));
  }
});

// 跑 bench-configure.sh 的参数检查 + jiuan-kb 段 + 写 env 那段：install / write_secret / sed / curl / python3 换成只记账的桩，
// DIR 指到临时目录（里面放一份旧的 kb_pg_password）；上传目录 /var/lib/jiuan/kb-uploads 换成临时目录，里面放上 PG 直连时留下的
// <id>.rules.json（和别的文件，看它们碰不碰）；调用记录里再换回原路径
const KB_UPLOADS = '/var/lib/jiuan/kb-uploads';
const UPLOAD_LEFTOVERS = ['1.rules.json', '12.rules.json', '.tmp-0a1b2c3d4e5f.rules.json'];
const UPLOAD_KEEP = ['0123abcd.docx', '1.rules.json.bak', 'history.json', 'keep.rules.json'];
async function configureKb(t, args, { oldPassword = true } = {}) {
  const script = await readFile(infra('bench/bench-configure.sh'), 'utf8');
  const dir = await mkdtemp(path.join(tmpdir(), 'bench-kb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.log');
  if (oldPassword) await writeFile(path.join(dir, 'kb_pg_password'), 'not-a-real-password');
  const uploads = path.join(dir, 'kb-uploads');
  await mkdir(path.join(uploads, 'keep.rules.json'), { recursive: true });   // 同名的目录不删
  for (const name of [...UPLOAD_LEFTOVERS, ...UPLOAD_KEEP.filter(name => name !== 'keep.rules.json')]) await writeFile(path.join(uploads, name), 'x');
  const between = (start, end) => {
    const from = script.indexOf(start), to = script.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `bench-configure.sh 里没有 ${start}`);
    return script.slice(from, to + end.length);
  };
  const prelude = script.slice(0, script.indexOf('\nHERE=')).replace(/^#!.*\n/, '');
  const stubs = [`LOG=${JSON.stringify(log)}; DIR=${JSON.stringify(dir)}; : > "$LOG"`,
    `install() { printf 'install %s\\n' "$*" >> "$LOG"; }`, `write_secret() { printf 'write_secret %s\\n' "$1" >> "$LOG"; }`,
    `sed() { printf 'sed %s\\n' "$*" >> "$LOG"; command sed "$@"; }`, `curl() { printf 'curl\\n' >> "$LOG"; echo 10.0.0.5; }`,
    `python3() { printf 'python3 %s\\n' "$*" >> "$LOG"; }`].join('\n');
  const leftover = () => readFile(path.join(dir, 'kb_pg_password'), 'utf8').then(() => true, () => false);
  try {
    const kb = between('# >>> jiuan-kb', '# <<< jiuan-kb').replaceAll(KB_UPLOADS, uploads);
    await run('bash', ['-c', [prelude, stubs, kb, between('cat > "$DIR/env.new" <<ENV', '\nENV\n')].join('\n'), 'bench-configure.sh', ...args]);
  } catch (error) { return { code: error.code, stderr: error.stderr, wrote: await readFile(path.join(dir, 'env.new'), 'utf8').then(() => true, () => false), leftover: await leftover() }; }
  return { code: 0, env: await readFile(path.join(dir, 'env.new'), 'utf8'), leftover: await leftover(), uploads: (await readdir(uploads)).sort(),
    calls: (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => line.replaceAll(uploads, KB_UPLOADS)) };
}
const UPLOADS = 'install -d -o jiuan -g jiuan -m 0700 /var/lib/jiuan/kb-uploads';
const NO_PG = /POC_KB_PG_HOST|POC_KB_USER|POC_KB_DB|POC_KB_DIR|POC_KB_PYTHON|POC_KB_S3V_PUBLICATION_ID|not-a-real-password/;

test('bench-configure.sh 两种方式一个样：写 POC_KB_MODE 和知识库 Agent 的发布 POC_KB_PUBLICATION_ID，只建上传目录；不读 PG 主机的 .env、不写任何密钥文件、不建 venv、不碰 IMDS，旧的 kb_pg_password 删掉', async t => {
  for (const [mode, id] of [['s3vectors', KB_PUB], ['pg', PG_PUB]]) {
    const result = await configureKb(t, [...SITE, mode, id]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.env, new RegExp(`^POC_KB_MODE=${mode}\\nPOC_KB_PUBLICATION_ID=${id}$`, 'm'), mode);
    assert.doesNotMatch(result.env, NO_PG, mode);
    assert.deepEqual(result.calls, [UPLOADS], mode);
    assert.equal(result.leftover, false, `${mode}：实例上留下的连库密码文件要删掉`);
    assert.deepEqual(result.uploads, [...UPLOAD_KEEP].sort(), `${mode}：PG 直连时留下的 <id>.rules.json（从制度派生的规则）删掉，别的文件和同名目录不动`);
  }
});

test('bench-configure.sh：没给发布编号（或不给第 3 个参数，旧的调用方式就是 pg）也照常配置，env 里不写 POC_KB_PUBLICATION_ID（页面说「知识库 Agent 还没配置」）；没有旧密码文件也不出错', async t => {
  for (const args of [SITE, [...SITE, 'pg'], [...SITE, 'pg', ''], [...SITE, 's3vectors', '']]) {
    const result = await configureKb(t, args, { oldPassword: args.length === 2 });
    assert.equal(result.code, 0, `${JSON.stringify(args)}：${result.stderr}`);
    assert.match(result.env, new RegExp(`^POC_KB_MODE=${args[2] || 'pg'}$`, 'm'));
    assert.doesNotMatch(result.env, /POC_KB_PUBLICATION_ID/);
    assert.doesNotMatch(result.env, NO_PG);
    assert.deepEqual(result.calls, [UPLOADS]);
    assert.equal(result.leftover, false);
    assert.deepEqual(result.uploads, [...UPLOAD_KEEP].sort());
  }
});

test('bench-configure.sh：kb 方式只能是 pg 或 s3vectors，发布编号给了就要是 pub_ 加 16 位十六进制（两种方式都是）；不合格就退出（2），env 一个字不写', async t => {
  const bad = ['pub_0123', KB_PUB.toUpperCase(), `${KB_PUB}x`, `${KB_PUB}\nPOC_KB_PG_HOST=evil`, ' ', `${KB_PUB}' && reboot '`];
  for (const args of [[...SITE, 'mongo'], ...bad.flatMap(id => [[...SITE, 's3vectors', id], [...SITE, 'pg', id]])]) {
    const result = await configureKb(t, args);
    assert.equal(result.code, 2, JSON.stringify(args));
    assert.match(result.stderr, /pg 或 s3vectors|发布编号/, JSON.stringify(args));
    assert.equal(result.wrote, false);
  }
});

test('bench-configure.sh：测试台不直连 PG——整份脚本不读 PG 主机的 .env、不写 kb_pg_password、不建 kb-venv、不取私网 IP；两种方式都建 /var/lib/jiuan/custom-rules（jiuan 0700，不在任何分支里）', async () => {
  const script = await readFile(infra('bench/bench-configure.sh'), 'utf8');
  for (const gone of ['/opt/nexus-pgvector', 'NEXUS_DB_PASSWORD', 'write_secret kb_pg_password', 'kb-venv', 'psycopg', '169.254.169.254', 'local-ipv4',
    'POC_KB_PG_HOST', 'POC_KB_USER', 'POC_KB_DB', 'POC_KB_DIR', 'POC_KB_PYTHON', 'POC_KB_S3V_PUBLICATION_ID']) assert.ok(!script.includes(gone), `还有 ${gone}`);
  const kb = script.slice(script.indexOf('# >>> jiuan-kb'), script.indexOf('# <<< jiuan-kb'));
  assert.match(kb, /^rm -f "\$DIR\/kb_pg_password"$/m);
  assert.match(kb, /^find "\/var\/lib\/jiuan\/kb-uploads" -maxdepth 1 -type f -name '\*\.rules\.json' -delete$/m, '只删上传目录第一层的 *.rules.json 文件');
  assert.match(kb, /^install -d -o jiuan -g jiuan -m 0700 \/var\/lib\/jiuan\/kb-uploads$/m, '上传目录不在任何分支里');
  assert.doesNotMatch(kb, /^(if|elif) /m, 'kb 段不再按方式分支');
  const dirs = script.indexOf('\ninstall -d -o jiuan -g jiuan -m 0700 /var/lib/jiuan /var/lib/jiuan/nexus /var/lib/jiuan/custom-rules\n');
  assert.ok(dirs > 0 && dirs < script.indexOf('# >>> jiuan-kb'), '数据目录在一开始就建好，和 kb 方式无关');
  assert.match(script, /^# 用法：bench-configure\.sh <站点主机名> <Nexus 地址> \[<kb 方式> \[<知识库 Agent 发布编号>\]\]/m);
});
