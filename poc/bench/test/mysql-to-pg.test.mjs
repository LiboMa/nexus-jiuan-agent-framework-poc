import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import pg from 'pg';

// 一次性的 MySQL → PostgreSQL 搬迁工具（mysql-to-pg.mjs），在两个真的测试库上：
// MySQL 那边用只打了 0001–0007 的九安副本（JIUAN_MYSQL_BUILD，换库之前的样子）跑 migrateMySql 建表，外壳的两张表照换库前的 DDL 建；
// PG 那边由工具自己 --create-schema（JIUAN_DIR 的 migratePg）和 --shell（JIUAN_SHELL_DIR 的外壳，两张表在 start() 时建）建表。
// 造一份覆盖各种列类型的数据（二进制含 \x00、嵌套 JSON 和大数、DATETIME(6) 的微秒、空值、中文、INT UNSIGNED 最大值）→ 搬 → 逐表核对。
const MYSQL_URL = process.env.MYSQL_TEST_URL;
const PG_URL = process.env.PG_TEST_URL;
const skip = MYSQL_URL && PG_URL && process.env.JIUAN_MYSQL_BUILD ? false : '要 MYSQL_TEST_URL、PG_TEST_URL 和 JIUAN_MYSQL_BUILD';
const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(here, '..', 'mysql-to-pg.mjs');
const JIUAN = process.env.JIUAN_DIR;
const SHELL = process.env.JIUAN_SHELL_DIR;

const OLD_REVIEWS = `CREATE TABLE poc_review_decisions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT, document_id VARCHAR(191) NOT NULL, document_version VARCHAR(191) NOT NULL, advice_round INT UNSIGNED NOT NULL,
  ai_result VARCHAR(8) NOT NULL, decision VARCHAR(16) NOT NULL, final_result VARCHAR(8) NOT NULL, reason VARCHAR(32) NULL, note VARCHAR(200) NULL,
  actor VARCHAR(191) NOT NULL, created_at DATETIME(3) NOT NULL, PRIMARY KEY (id), KEY poc_review_decisions_document (document_id, created_at, id),
  KEY poc_review_decisions_created (created_at, id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;
const OLD_KB = `CREATE TABLE poc_kb_cache (scope VARCHAR(96) NOT NULL, cache_key VARCHAR(191) NOT NULL, body MEDIUMTEXT NOT NULL, fetched_at DATETIME(3) NOT NULL,
  PRIMARY KEY (scope, cache_key)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;
const KEY_CHECK = Buffer.from([0x00, 0xff, 0x0a, 0x5c, 0x09, 0x27, 0x22]);
const PAYLOAD = Buffer.concat([Buffer.from([0x00]), randomBytes(300)]);
const SETTINGS_JSON = '{"z":1,"a":{"nested":[1,2,{"深":"值"}],"big":12345678901234567890,"f":0.1,"e":1e-7,"t":true,"n":null,"s":"tab\\tquote\\"","empty":{},"arr":[]}}';
const TEXT = "中文\t制表\n换行\\反斜杠 '引号\"";

function tool(args, { pgUrl = PG_URL } = {}) {
  return new Promise(resolve => {
    execFile(process.execPath, [TOOL, ...args], { env: { ...process.env, MIGRATE_MYSQL_URL: MYSQL_URL, MIGRATE_PG_URL: pgUrl }, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout: String(stdout), stderr: String(stderr), lines: String(stdout).split('\n').filter(Boolean) }));
  });
}
const tableLines = result => Object.fromEntries(result.lines.filter(line => line.startsWith('TABLE ')).map(line => [line.split(' ')[1], line]));
const status = line => line?.split(' ').at(-1);

let my, pq;
test.before(async () => {
  if (skip) return;
  assert.match(new URL(MYSQL_URL).pathname, /_test$/);
  assert.equal(new URL(MYSQL_URL).port, '3307');
  assert.match(new URL(PG_URL).pathname, /_test$/);
  assert.equal(new URL(PG_URL).port, '5434');
  my = await mysql.createConnection({ uri: MYSQL_URL, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
  pq = new pg.Client({ connectionString: PG_URL });
  await pq.connect();
  // 两边都从空库开始
  const [tables] = await my.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'");
  await my.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const { t } of tables) await my.query(`DROP TABLE \`${t}\``);
  await my.query('SET FOREIGN_KEY_CHECKS = 1');
  await pq.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public');
  const { createMySqlPool, migrateMySql } = await import(pathToFileURL(path.join(process.env.JIUAN_MYSQL_BUILD, 'src/mysql-database.mjs')).href);
  const pool = createMySqlPool({ url: MYSQL_URL, connectionLimit: 2 });
  try { await migrateMySql(pool); } finally { await pool.end(); }
  await my.query(OLD_REVIEWS);
  await my.query(OLD_KB);
  const ins = (table, columns, rows) => my.query(`INSERT INTO \`${table}\` (${columns.map(c => `\`${c}\``).join(', ')}) VALUES ?`, [rows]);
  await ins('analysis_connections', ['connection_id', 'environment', 'schema_version', 'key_check', 'tenant_id', 'created_at', 'updated_at'], [
    ['conn-a', 'prod', 4294967295, KEY_CHECK, '九安租户', '2026-11-06 01:02:03.123456', '2026-11-06 01:02:03.000001'],
    ['conn-b', 'prod', 0, Buffer.alloc(0), null, '2026-01-01 00:00:00', '2026-01-01 00:00:00']]);
  await ins('analysis_sync_states', ['connection_id', 'scope_key', 'payload', 'updated_at'], [
    ['conn-a', 'agent-enablement:v1:t', PAYLOAD, '2026-11-06 09:10:11.999999'], ['conn-a', 'Scope:混合大小写', Buffer.from('x'), '2026-11-06 09:10:12']]);
  await ins('metadata', ['key', 'value', 'updated_at'], [['k1', TEXT, '2026-11-06 01:02:03'], ['k2', '', '2026-11-06 01:02:04.5']]);
  await ins('platform_call_log', ['call_id', 'connector_id', 'operation', 'agent_id', 'run_id', 'attempt_no', 'started_at', 'duration_ms', 'outcome', 'http_status',
    'error_code', 'response_bytes', 'input_tokens', 'output_tokens', 'process_tag'], [
    [5, 'hly-prod', 'list', 'agent-a', null, 1, '2026-11-06 01:02:03.456789', 4294967295, 'ok', 200, null, 10, null, null, 'analysis-server'],
    [11415, 'nexus', 'advice', 'agent-b', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 255, '2026-11-06 01:02:04', 0, 'timeout', null, 'E', null, 1, 2, 'p']]);
  await ins('platform_settings', ['scope_kind', 'scope_id', 'revision', 'value_json', 'value_sha256', 'updated_by', 'updated_at'], [
    ['agent', 'a', 3, SETTINGS_JSON, createHash('sha256').update(SETTINGS_JSON).digest('hex'), 'admin', '2026-11-06 01:02:03.5'],
    ['platform', 'p', 1, '[]', 'b'.repeat(64), 'x', '2026-11-06 01:02:03']]);
  await ins('sap_payment_sync_batches', ['connection_id', 'id', 'tenant_id', 'company_code', 'start_date', 'end_date', 'status', 'complete', 'cursor_skip', 'started_at'], [
    ['conn-a', 'batch-1', 't', '3001', '2026-02-01', null, 'completed', 1, 4294967295, '2026-02-28 08:00:00.000001']]);
  await ins('sap_payment_requests', ['connection_id', 'tenant_id', 'company_code', 'request_number', 'line_item', 'request_date', 'order_quantity', 'paid_amount',
    'sync_batch_id', 'raw_payload', 'payload_sha256', 'collected_at'], [
    ['conn-a', 't', '3001', 'R1', '00001', '2026-02-03', '12345678901234567890123456.123456789012', null, 'batch-1', PAYLOAD, 'c'.repeat(64), '2026-02-28 08:00:00'],
    ['conn-a', 't', '3001', 'R1', '', '2026-02-04', '-0.000000000001', '0', 'batch-1', Buffer.alloc(0), 'd'.repeat(64), '2026-02-28 08:00:00.5']]);
  await ins('poc_review_decisions', ['id', 'document_id', 'document_version', 'advice_round', 'ai_result', 'decision', 'final_result', 'reason', 'note', 'actor', 'created_at'], [
    [7, 'd1', 'v1', 1, 'pass', 'adopt', 'pass', null, null, 'poc-reviewer', '2026-11-06 01:02:03.456'],
    [12, 'd2', 'v2', 4294967295, 'reject', 'override', 'pass', 'policy', '备注', 'poc-checker', '2026-11-06 01:02:04']]);
  await ins('poc_kb_cache', ['scope', 'cache_key', 'body', 'fetched_at'], [['pg:pub_x', 'describe', '{"中":"文"}', '2026-11-06 01:02:03.004'], ['pg:pub_x', 'Describe', 'upper', '2026-11-06 01:02:03']]);
});
test.after(async () => {
  await my?.end();
  await pq?.end();
});

test('搬：全部表一致（MIGRATE_OK）；schema_migrations 不搬；值原样（二进制、微秒、中文、大数、空值）；自增列接着原来的最大值往上长；搬完 ANALYZE 过', { skip }, async () => {
  const result = await tool(['--create-schema', JIUAN, '--shell', SHELL]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.lines.at(-1), 'MIGRATE_OK');
  const lines = tableLines(result);
  assert.equal(lines.schema_migrations, undefined, 'schema_migrations 不搬（PG 那边是 migratePg 自己写的）');
  for (const [table, rows] of [['analysis_connections', 2], ['analysis_sync_states', 2], ['metadata', 2], ['platform_call_log', 2], ['platform_settings', 2],
    ['sap_payment_sync_batches', 1], ['sap_payment_requests', 2], ['poc_review_decisions', 2], ['poc_kb_cache', 2], ['audit_documents', 0]]) {
    assert.match(lines[table] ?? '', new RegExp(`^TABLE ${table} rows=${rows} mysql=[0-9a-f]{64} pg=[0-9a-f]{64} OK$`), table);
  }
  assert.ok(Object.values(lines).every(line => status(line) === 'OK'), result.stdout);
  const one = async (sql, params) => (await pq.query(sql, params)).rows;
  assert.deepEqual(await one("SELECT encode(key_check, 'hex') AS k, schema_version::text AS v, tenant_id, to_char(created_at, 'YYYY-MM-DD HH24:MI:SS.US') AS c FROM analysis_connections ORDER BY connection_id"),
    [{ k: '00ff0a5c092722', v: '4294967295', tenant_id: '九安租户', c: '2026-11-06 01:02:03.123456' }, { k: '', v: '0', tenant_id: null, c: '2026-01-01 00:00:00.000000' }]);
  assert.ok((await one("SELECT payload FROM analysis_sync_states WHERE scope_key = 'agent-enablement:v1:t'"))[0].payload.equals(PAYLOAD), '启用记录的密文字节不差');
  assert.equal((await one("SELECT value FROM metadata WHERE key = 'k1'"))[0].value, TEXT);
  const [settings] = await one("SELECT value_json->'a'->>'big' AS big, value_json->'a'->'nested'->2->>'深' AS deep, (value_json->'a'->>'e')::numeric = 0.0000001 AS e, value_json->'a'->>'s' AS s FROM platform_settings WHERE scope_kind = 'agent'");
  assert.deepEqual(settings, { big: '12345678901234567890', deep: '值', e: true, s: 'tab\tquote"' });
  assert.deepEqual(await one("SELECT order_quantity::text AS q, paid_amount::text AS p, request_date::text AS d FROM sap_payment_requests ORDER BY line_item"),
    [{ q: '-0.000000000001', p: '0.000000000000', d: '2026-02-04' }, { q: '12345678901234567890123456.123456789012', p: null, d: '2026-02-03' }]);
  assert.deepEqual(await one('SELECT complete, end_date, cursor_skip::text AS s FROM sap_payment_sync_batches'), [{ complete: 1, end_date: null, s: '4294967295' }]);
  assert.deepEqual((await one("SELECT to_char(created_at, 'YYYY-MM-DD HH24:MI:SS.MS') AS c FROM poc_review_decisions ORDER BY id")).map(row => row.c), ['2026-11-06 01:02:03.456', '2026-11-06 01:02:04.000']);
  assert.deepEqual((await one('SELECT cache_key FROM poc_kb_cache ORDER BY cache_key')).map(row => row.cache_key), ['Describe', 'describe']);
  // 自增：接着原来的最大值
  const [call] = await one("INSERT INTO platform_call_log (connector_id, operation, agent_id, attempt_no, started_at, duration_ms, outcome, process_tag) VALUES ('x', 'y', 'z', 1, LOCALTIMESTAMP, 1, 'ok', 'p') RETURNING call_id::text AS id");
  assert.equal(call.id, '11416');
  await pq.query('DELETE FROM platform_call_log WHERE call_id = 11416');
  const [review] = await one("INSERT INTO poc_review_decisions (document_id, document_version, advice_round, ai_result, decision, final_result, actor, created_at) VALUES ('d3', 'v', 1, 'pass', 'adopt', 'pass', 'a', LOCALTIMESTAMP) RETURNING id::text AS id");
  assert.equal(review.id, '13');
  await pq.query('DELETE FROM poc_review_decisions WHERE id = 13');
  assert.deepEqual(await one('SELECT count(*)::int AS n FROM schema_migrations'), [{ n: 1 }], 'PG 的迁移记录还是 migratePg 写的那一行');
  assert.deepEqual(await one("SELECT relname, reltuples::int AS n FROM pg_class WHERE relname IN ('platform_call_log', 'metadata') ORDER BY relname"),
    [{ relname: 'metadata', n: 2 }, { relname: 'platform_call_log', n: 2 }], '搬完 ANALYZE 过（没分析过的表 reltuples 是 -1）');
});

test('只核对（--dry-run）：搬完一致就 MIGRATE_OK；改坏 PG 里一行，那张表 MISMATCH、退出 1；--only 只核对给的表；什么都不写', { skip }, async () => {
  const clean = await tool(['--dry-run']);
  assert.equal(clean.code, 0, clean.stdout + clean.stderr);
  assert.equal(clean.lines.at(-1), 'MIGRATE_OK');
  await pq.query("UPDATE metadata SET value = value || 'x' WHERE key = 'k1'");
  const broken = await tool(['--dry-run']);
  assert.equal(broken.code, 1);
  assert.match(tableLines(broken).metadata, /^TABLE metadata rows=2 mysql=[0-9a-f]{64} pg=[0-9a-f]{64} MISMATCH pg_rows=2$/);
  assert.equal(status(tableLines(broken).analysis_connections), 'OK');
  assert.match(broken.lines.at(-1), /^MIGRATE_FAILED mismatch metadata$/);
  const only = await tool(['--dry-run', '--only', 'analysis_connections,metadata']);
  assert.deepEqual(Object.keys(tableLines(only)).sort(), ['analysis_connections', 'metadata']);
  assert.equal(only.code, 1);
  assert.equal((await pq.query("SELECT value FROM metadata WHERE key = 'k1'")).rows[0].value, `${TEXT}x`, 'dry-run 不改 PG');
});

test('目标表不是空的：不带 --replace 就停（MIGRATE_FAILED target-not-empty，PG 原样）；带 --replace 先清空再搬，又一致了', { skip }, async () => {
  const refused = await tool([]);
  assert.equal(refused.code, 1);
  assert.match(refused.lines.at(-1), /^MIGRATE_FAILED target-not-empty /);
  assert.equal((await pq.query("SELECT value FROM metadata WHERE key = 'k1'")).rows[0].value, `${TEXT}x`);
  const replaced = await tool(['--replace']);
  assert.equal(replaced.code, 0, replaced.stdout + replaced.stderr);
  assert.equal(replaced.lines.at(-1), 'MIGRATE_OK');
  assert.equal((await pq.query("SELECT value FROM metadata WHERE key = 'k1'")).rows[0].value, TEXT);
});

test('PG 存不下的 NUL（文字里的 \\0、JSON 字符串里的 \\u0000）：写之前报出来是哪张表哪一列几行，一行都不写（整个搬迁在一个事务里）', { skip }, async () => {
  await my.query("INSERT INTO metadata (`key`, value, updated_at) VALUES ('nul', CONCAT('a', CHAR(0), 'b'), '2026-11-06 01:02:03')");
  await my.query("INSERT INTO platform_settings (scope_kind, scope_id, revision, value_json, value_sha256, updated_by, updated_at) VALUES ('connector', 'c', 1, '{\"s\":\"\\\\u0000x\"}', ?, 'x', '2026-11-06 01:02:03')", ['e'.repeat(64)]);
  const [[{ hasNul }]] = await my.query("SELECT INSTR(CAST(value_json AS CHAR), '\\\\u0000') > 0 AS hasNul FROM platform_settings WHERE scope_kind = 'connector'");
  assert.equal(Number(hasNul), 1, 'MySQL 里确实存了 \\u0000');
  for (const args of [['--replace'], ['--dry-run']]) {
    const result = await tool(args);
    assert.equal(result.code, 1, args.join(' '));
    assert.ok(result.lines.includes('NUL metadata.value rows=1'), result.stdout);
    assert.ok(result.lines.includes('NUL platform_settings.value_json rows=1'), result.stdout);
    assert.equal(result.lines.at(-1), 'MIGRATE_FAILED nul-characters');
  }
  assert.deepEqual((await pq.query('SELECT key FROM metadata ORDER BY key')).rows.map(row => row.key), ['k1', 'k2'], '一行都没写，原来的也没清掉');
  await my.query("DELETE FROM metadata WHERE `key` = 'nul'");
  await my.query("DELETE FROM platform_settings WHERE scope_kind = 'connector'");
});

test('只核对一个还不存在的库：不建库，有数据的表报 PENDING、空表 OK，最后一行 MIGRATE_PENDING，退出 0', { skip }, async () => {
  const url = new URL(PG_URL);
  url.pathname = '/jiuan_nosuch_test';
  const result = await tool(['--dry-run'], { pgUrl: url.href });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const lines = tableLines(result);
  assert.match(lines.metadata, /^TABLE metadata rows=2 mysql=[0-9a-f]{64} pg=- PENDING pg_rows=0$/);
  assert.equal(status(lines.audit_documents), 'OK');
  assert.match(result.lines.at(-1), /^MIGRATE_PENDING tables=\d+ rows=\d+$/);
  assert.equal((await pq.query("SELECT count(*)::int AS n FROM pg_database WHERE datname = 'jiuan_nosuch_test'")).rows[0].n, 0);
});

test('参数：--dry-run 不能和 --create-schema / --shell / --replace 一起用；没给两个地址就退出 2', { skip }, async () => {
  for (const args of [['--dry-run', '--create-schema', JIUAN], ['--dry-run', '--shell', SHELL], ['--dry-run', '--replace'], ['--nope']]) {
    const result = await tool(args);
    assert.equal(result.code, 2, args.join(' '));
  }
  const missing = await new Promise(resolve => execFile(process.execPath, [TOOL, '--dry-run'], { env: { ...process.env, MIGRATE_MYSQL_URL: '', MIGRATE_PG_URL: '' } }, error => resolve(error?.code)));
  assert.equal(missing, 2);
});
