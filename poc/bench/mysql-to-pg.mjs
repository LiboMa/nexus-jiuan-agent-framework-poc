#!/usr/bin/env node
// 一次性的 MySQL → PostgreSQL 搬迁（九安 v0.7.10 测试台换库用；随 migrate-mysql-to-pg.sh 传到实例上跑，Node 24）。
// 两边的地址只从环境变量读（MIGRATE_MYSQL_URL、MIGRATE_PG_URL；里面有口令，不上命令行），不打印口令和数据内容。
//   搬（缺省）：MySQL 在一个一致的只读快照里逐表流式读出；PG 那边整个搬迁在一个事务里写（按外键先父后子），失败就整体回滚、一行不留；
//     自增（identity）列复制原值，提交前把序列设到最大值之后；提交后逐表 ANALYZE，再逐表从 PG 读回来核对。
//     schema_migrations 不搬（PG 的那一行由 migratePg 自己写）。目标表不是空的就停，除非 --replace（同一个事务里先 TRUNCATE … CASCADE）。
//   只核对（--dry-run）：只读两边、逐表比；PG 那边还没有这个库或这张表就当空表，报 PENDING（会搬多少行）。
//   核对：每一行按列规范化（空值 \N；时间是两边各自的原文字补齐到 6 位小数，不做时区换算；JSON 按键排序、数字按十进制值；
//     二进制成 hex；其余成文字；\ 制表 换行 回车转义），算 sha256；一张表的校验值是这些行的 sha256 排好序后再算一次 sha256
//     （和两边的排序规则无关）。搬的时候 MySQL 那边的校验值就从搬的那些行算。
//   PG 存不下的 NUL（文字里的 \0、JSON 字符串里的 \u0000）：写之前报出来（NUL <表>.<列> rows=<n>），整体失败。
// 标准输出：每表一行 TABLE <名> rows=<n> mysql=<sha256> pg=<sha256|-> OK|MISMATCH|PENDING（后两种另带 pg_rows=<n>），
//   最后一行 MIGRATE_OK、MIGRATE_PENDING tables=<n> rows=<n>（只核对、还没搬）或 MIGRATE_FAILED <原因>。进度写标准错误。
// 退出码：0 全部一致（或只核对时没有不一致的）；1 不一致或失败；2 参数不对。
// 用法：MIGRATE_MYSQL_URL=… MIGRATE_PG_URL=… node mysql-to-pg.mjs [--create-schema <九安副本> [--shell <外壳目录>]] [--dry-run] [--replace] [--batch 1000] [--only <表,…>]
//   --create-schema：先用那份九安副本的 src/pg-database.mjs 跑 migratePg 建表；--shell：再用外壳的 reviews.mjs、kb-cache.mjs 建外壳的两张表。
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import pg from 'pg';

const NOT_COPIED = new Set(['schema_migrations']);
const NUM = Symbol('number');
class UsageError extends Error {}
const usage = message => new UsageError(message);
const say = text => process.stdout.write(`${text}\n`);
const progress = text => process.stderr.write(`${text}\n`);
const sha = text => createHash('sha256').update(text).digest('hex');
const name = value => { if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error(`unexpected identifier ${JSON.stringify(value)}`); return value; };
const pgId = value => `"${name(value)}"`;
const myId = value => `\`${name(value)}\``;

export function parseArgs(argv) {
  const options = { dryRun: false, replace: false, batch: 1000, only: null, createSchema: null, shell: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => { const next = argv[++i]; if (!next || next.startsWith('--')) throw usage(`${arg} 要跟一个值`); return next; };
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--replace') options.replace = true;
    else if (arg === '--create-schema') options.createSchema = path.resolve(value());
    else if (arg === '--shell') options.shell = path.resolve(value());
    else if (arg === '--batch') options.batch = Number(value());
    else if (arg === '--only') options.only = value().split(',').map(item => item.trim()).filter(Boolean);
    else throw usage(`不认识的参数：${arg}`);
  }
  if (!Number.isInteger(options.batch) || options.batch < 1 || options.batch > 10000) throw usage('--batch 要是 1 到 10000 的整数');
  if (options.dryRun && (options.createSchema || options.shell || options.replace)) throw usage('--dry-run 只读两边，不能和 --create-schema、--shell、--replace 一起用');
  if (options.shell && !options.createSchema) throw usage('--shell 要和 --create-schema 一起用');
  if (options.only && (!options.only.length || options.only.some(table => !/^[a-z][a-z0-9_]*$/.test(table)))) throw usage('--only 的表名只能是小写字母、数字、下划线');
  return options;
}

/** A JSON number's source text as its exact decimal value: sign, digits without leading or trailing zeros, exponent ("1.50" → "15e-1", "-0" → "0"). */
export function canonicalNumber(text) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) throw new Error(`not a JSON number: ${text}`);
  const fraction = match[3] || '';
  const digits = (match[2] + fraction).replace(/^0+/, '');
  if (!digits) return '0';
  const trimmed = digits.replace(/0+$/, '');
  const exponent = BigInt(match[4] || 0) - BigInt(fraction.length) + BigInt(digits.length - trimmed.length);
  return `${match[1]}${trimmed}e${exponent}`;
}

function stringify(value) {
  if (value === null) return 'null';
  if (typeof value === 'object' && NUM in value) return value[NUM];
  if (Array.isArray(value)) return `[${value.map(stringify).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** JSON text → keys sorted at every level, numbers by exact decimal value (from the source text, so big integers keep every digit); flags strings and keys holding U+0000. */
export function canonicalJson(text, flags = {}) {
  const value = JSON.parse(text, function reviver(key, item, context) {
    if (key.includes('\0') || (typeof item === 'string' && item.includes('\0'))) flags.nul = true;
    return typeof item === 'number' ? { [NUM]: canonicalNumber(context?.source ?? String(item)) } : item;
  });
  return stringify(value);
}

const escapeText = text => text.replace(/[\\\t\n\r]/g, char => ({ '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' })[char]);
const NULL = '\\N';
const padMicros = text => (/\.\d+$/.test(text) ? text.replace(/\.(\d+)$/, (all, digits) => `.${digits.padEnd(6, '0')}`) : `${text}.000000`);

/** How a column is compared (and how PG reads it back as text). */
function kindFromPg(typname) {
  if (typname === 'timestamp') return 'timestamp';
  if (typname === 'date') return 'date';
  if (typname === 'jsonb' || typname === 'json') return 'json';
  if (typname === 'bytea') return 'bytea';
  return 'text';
}
function kindFromMySql(dataType) {
  if (dataType === 'datetime' || dataType === 'timestamp') return 'timestamp';
  if (dataType === 'date') return 'date';
  if (dataType === 'json') return 'json';
  if (/blob$|binary$/.test(dataType)) return 'bytea';
  return 'text';
}
function pgExpression(column) {
  const id = pgId(column.name);
  if (column.kind === 'timestamp') return `to_char(${id}, 'YYYY-MM-DD HH24:MI:SS.US')`;
  if (column.kind === 'date') return `to_char(${id}, 'YYYY-MM-DD')`;
  if (column.kind === 'bytea') return `encode(${id}, 'hex')`;
  return `${id}::text`;
}

/** One MySQL value (dateStrings, big numbers as strings, JSON as text) → its canonical text; sets flags.nul when PG cannot store it. */
function canonicalMySql(value, kind, flags) {
  if (value === null || value === undefined) return NULL;
  if (kind === 'timestamp') return escapeText(padMicros(String(value)));
  if (kind === 'json') return escapeText(canonicalJson(String(value), flags));
  if (kind === 'bytea') return (Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')).toString('hex');
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  if (text.includes('\0')) flags.nul = true;
  return escapeText(text);
}
function canonicalPg(value, kind) {
  if (value === null) return NULL;
  return kind === 'json' ? escapeText(canonicalJson(value)) : escapeText(value);
}
const tableDigest = hashes => sha(hashes.sort().join('\n'));

async function mysqlCatalog(my) {
  const [tables] = await my.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name");
  const [columns] = await my.query('SELECT table_name AS t, column_name AS c, data_type AS type FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position');
  const byTable = new Map(tables.map(row => [row.t, []]));
  for (const row of columns) byTable.get(row.t)?.push({ name: row.c, type: String(row.type).toLowerCase() });
  return byTable;
}

async function pgCatalog(pq) {
  const { rows } = await pq.query(`SELECT c.relname AS t, a.attname AS c, ty.typname AS typname, a.attidentity AS identity, a.attgenerated AS generated
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid JOIN pg_type ty ON ty.oid = a.atttypid
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum`);
  const tables = new Map();
  for (const row of rows) {
    if (!tables.has(row.t)) tables.set(row.t, []);
    tables.get(row.t).push({ name: row.c, kind: kindFromPg(row.typname), identity: row.identity === 'a' || row.identity === 'd', generated: row.generated !== '' });
  }
  const { rows: fks } = await pq.query("SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace");
  return { tables, fks };
}

/** Parents before children (PG's foreign keys), ties alphabetical; whatever is left in a cycle goes last, alphabetical. */
function parentsFirst(tables, fks) {
  const wanted = new Set(tables);
  const parents = new Map(tables.map(table => [table, new Set()]));
  for (const { child, parent } of fks) if (wanted.has(child) && wanted.has(parent) && child !== parent) parents.get(child).add(parent);
  const ordered = [], done = new Set();
  while (ordered.length < tables.length) {
    const ready = tables.filter(table => !done.has(table) && [...parents.get(table)].every(parent => done.has(parent))).sort();
    const next = ready.length ? ready : tables.filter(table => !done.has(table)).sort();
    for (const table of (ready.length ? ready : next)) { ordered.push(table); done.add(table); }
  }
  return ordered;
}

/** Streams one MySQL table (inside the snapshot transaction): calls onRow(values, hasNul) per row; returns { rows, hash, nul: Map(column → rows) }. */
async function readMySqlTable(my, table, columns, onRow) {
  const select = columns.map(column => (column.kind === 'json' ? `CAST(${myId(column.name)} AS CHAR) AS ${myId(column.name)}` : myId(column.name))).join(', ');
  const stream = my.connection.query(`SELECT ${select} FROM ${myId(table)}`).stream({ highWaterMark: 500 });
  const hashes = [], nul = new Map();
  for await (const row of stream) {
    const values = columns.map(column => row[column.name]);
    let hasNul = false;
    const parts = columns.map((column, index) => {
      const flags = {};
      const text = canonicalMySql(values[index], column.kind, flags);
      if (flags.nul) { hasNul = true; nul.set(column.name, (nul.get(column.name) || 0) + 1); }
      return text;
    });
    hashes.push(sha(parts.join('\t')));
    if (onRow) await onRow(values, hasNul);
  }
  return { rows: hashes.length, hash: tableDigest(hashes), nul };
}

/** Reads one PG table back through a cursor (all columns as text): { rows, hash }. */
async function readPgTable(pq, table, columns) {
  const hashes = [];
  await pq.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await pq.query(`DECLARE migrate_read NO SCROLL CURSOR FOR SELECT ${columns.map(pgExpression).join(', ')} FROM ${pgId(table)}`);
    for (;;) {
      const { rows } = await pq.query({ text: 'FETCH 2000 FROM migrate_read', rowMode: 'array' });
      if (!rows.length) break;
      for (const row of rows) hashes.push(sha(row.map((value, index) => canonicalPg(value, columns[index].kind)).join('\t')));
    }
    await pq.query('COMMIT');
  } catch (error) {
    await pq.query('ROLLBACK').catch(() => {});
    throw error;
  }
  return { rows: hashes.length, hash: tableDigest(hashes) };
}

function insertValue(value, kind) {
  if (value === null || value === undefined) return null;
  if (kind === 'bytea') return Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return value;
}

async function createSchema(url, { createSchema: jiuanDir, shell }) {
  const { createPgPool, migratePg } = await import(pathToFileURL(path.join(jiuanDir, 'src/pg-database.mjs')).href);
  const pool = createPgPool({ url, connectionLimit: 2 });
  try {
    await migratePg(pool);
    if (shell) {
      const { createReviews } = await import(pathToFileURL(path.join(shell, 'reviews.mjs')).href);
      const { createKbCache } = await import(pathToFileURL(path.join(shell, 'kb-cache.mjs')).href);
      await createReviews({ pool, readCurrentAdvice: async () => null }).start();
      await createKbCache({ pool, scope: 'migrate' }).start();
    }
  } finally {
    await pool.end();
  }
  progress('SCHEMA_READY');
}

async function connectPg(url, { allowMissing }) {
  const client = new pg.Client({ connectionString: url, application_name: 'mysql-to-pg' });
  try {
    await client.connect();
  } catch (error) {
    if (allowMissing && error.code === '3D000') return null;
    throw error;
  }
  client.on('error', error => progress(`PG_CONNECTION_ERROR ${error.code || ''}`));
  return client;
}

function plan(myTables, pgInfo, only) {
  const source = [...myTables.keys()].filter(table => !NOT_COPIED.has(table));
  const unknown = (only || []).filter(table => !source.includes(table));
  if (unknown.length) return { failure: `unknown-tables ${unknown.join(',')}` };
  const selected = only || source;
  const tables = new Map();
  const columnProblems = [];
  for (const table of selected) {
    const mysqlColumns = myTables.get(table);
    const pgColumns = pgInfo?.tables.get(table);
    if (!pgColumns) { tables.set(table, { columns: mysqlColumns.map(column => ({ name: column.name, kind: kindFromMySql(column.type), identity: false })), inPg: false }); continue; }
    const mysqlNames = new Set(mysqlColumns.map(column => column.name));
    const copied = pgColumns.filter(column => !column.generated);
    const onlyMySql = [...mysqlNames].filter(column => !copied.some(item => item.name === column));
    const onlyPg = copied.filter(column => !mysqlNames.has(column.name)).map(column => column.name);
    if (onlyMySql.length || onlyPg.length) columnProblems.push(`COLUMNS ${table} only-mysql=${onlyMySql.join(',') || '-'} only-pg=${onlyPg.join(',') || '-'}`);
    tables.set(table, { columns: copied, inPg: true });
  }
  const extra = only || !pgInfo ? [] : [...pgInfo.tables.keys()].filter(table => !myTables.has(table) && !NOT_COPIED.has(table)).sort();
  return { tables, order: parentsFirst(selected, pgInfo?.fks || []), columnProblems, extra };
}

async function copy(my, pq, tables, order, options) {
  const missing = order.filter(table => !tables.get(table).inPg);
  if (missing.length) return { failure: `missing-in-pg ${missing.join(',')}` };
  const nonEmpty = [];
  for (const table of order) if ((await pq.query(`SELECT EXISTS (SELECT 1 FROM ${pgId(table)}) AS e`)).rows[0].e) nonEmpty.push(table);
  if (nonEmpty.length && !options.replace) return { failure: `target-not-empty ${nonEmpty.join(',')}` };
  const results = new Map(), nulLines = [];
  let sawNul = false;   // PG can't store a NUL: from the first one on, keep reading (to report every column) but write nothing more
  await pq.query('BEGIN');
  try {
    if (options.replace) await pq.query(`TRUNCATE ${order.map(pgId).join(', ')} CASCADE`);
    for (const table of order) {
      const { columns } = tables.get(table);
      const started = Date.now();
      const perBatch = Math.max(1, Math.min(options.batch, Math.floor(60000 / columns.length)));
      const overriding = columns.some(column => column.identity) ? ' OVERRIDING SYSTEM VALUE' : '';
      let batch = [];
      const flush = async () => {
        if (!batch.length) return;
        const params = [], groups = [];
        for (const values of batch) {
          groups.push(`(${values.map((value, index) => { params.push(insertValue(value, columns[index].kind)); return `$${params.length}`; }).join(', ')})`);
        }
        await pq.query(`INSERT INTO ${pgId(table)} (${columns.map(column => pgId(column.name)).join(', ')})${overriding} VALUES ${groups.join(', ')}`, params);
        batch = [];
      };
      const read = await readMySqlTable(my, table, columns, async (values, hasNul) => {
        sawNul ||= hasNul;
        if (sawNul) return;
        batch.push(values);
        if (batch.length >= perBatch) await flush();
      });
      for (const [column, count] of read.nul) nulLines.push(`NUL ${table}.${column} rows=${count}`);
      if (!sawNul) await flush();
      results.set(table, read);
      progress(`COPIED ${table} rows=${read.rows} ${Date.now() - started}ms`);
    }
    if (nulLines.length) {
      await pq.query('ROLLBACK');
      return { failure: 'nul-characters', nulLines };
    }
    for (const table of order) {
      for (const column of tables.get(table).columns.filter(item => item.identity)) {
        await pq.query(`SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT max(${pgId(column.name)}) FROM ${pgId(table)}), 0) + 1, false)`, [table, column.name]);
      }
    }
    await pq.query('COMMIT');
  } catch (error) {
    await pq.query('ROLLBACK').catch(() => {});
    throw error;
  }
  for (const table of order) await pq.query(`ANALYZE ${pgId(table)}`);
  progress('ANALYZED');
  return { results };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const mysqlUrl = process.env.MIGRATE_MYSQL_URL, pgUrl = process.env.MIGRATE_PG_URL;
  if (!mysqlUrl || !pgUrl) throw usage('要在环境变量 MIGRATE_MYSQL_URL、MIGRATE_PG_URL 里给两边的地址');
  if (options.createSchema) await createSchema(pgUrl, options);
  const my = await mysql.createConnection({ uri: mysqlUrl, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, charset: 'utf8mb4' });
  let pq = null;
  try {
    pq = await connectPg(pgUrl, { allowMissing: options.dryRun });
    const pgInfo = pq ? await pgCatalog(pq) : null;
    const planned = plan(await mysqlCatalog(my), pgInfo, options.only);
    if (planned.failure) return fail(planned.failure);
    for (const line of planned.columnProblems) say(line);
    if (planned.columnProblems.length) return fail('columns');
    for (const table of planned.extra) say(`EXTRA ${table} (only in PostgreSQL, left as it is)`);
    await my.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await my.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    let mysqlResults;
    if (options.dryRun) {
      mysqlResults = new Map();
      const nulLines = [];
      for (const table of planned.order) {
        const read = await readMySqlTable(my, table, planned.tables.get(table).columns);
        for (const [column, count] of read.nul) nulLines.push(`NUL ${table}.${column} rows=${count}`);
        mysqlResults.set(table, read);
      }
      await my.query('COMMIT');
      if (nulLines.length) { for (const line of nulLines) say(line); return fail('nul-characters'); }
    } else {
      const copied = await copy(my, pq, planned.tables, planned.order, options);
      await my.query('COMMIT');
      if (copied.failure) { for (const line of copied.nulLines || []) say(line); return fail(copied.failure); }
      mysqlResults = copied.results;
    }
    const mismatched = [];
    let pending = 0, pendingRows = 0;
    for (const table of planned.order) {
      const mine = mysqlResults.get(table);
      const theirs = pq && planned.tables.get(table).inPg ? await readPgTable(pq, table, planned.tables.get(table).columns) : null;
      let state;
      if (theirs && theirs.hash === mine.hash && theirs.rows === mine.rows) state = 'OK';
      else if ((!theirs || theirs.rows === 0) && options.dryRun) state = mine.rows === 0 ? 'OK' : 'PENDING';
      else state = 'MISMATCH';
      if (state === 'PENDING') { pending += 1; pendingRows += mine.rows; }
      if (state === 'MISMATCH') mismatched.push(table);
      say(`TABLE ${table} rows=${mine.rows} mysql=${mine.hash} pg=${theirs ? theirs.hash : '-'} ${state}${state === 'OK' ? '' : ` pg_rows=${theirs ? theirs.rows : 0}`}`);
    }
    if (mismatched.length) return fail(`mismatch ${mismatched.join(',')}`);
    say(pending ? `MIGRATE_PENDING tables=${pending} rows=${pendingRows}` : 'MIGRATE_OK');
    return 0;
  } finally {
    await my.end().catch(() => {});
    await pq?.end().catch(() => {});
  }
}

function fail(reason) {
  say(`MIGRATE_FAILED ${reason}`);
  return 1;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  main().then(code => { process.exitCode = code; }, error => {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n用法：MIGRATE_MYSQL_URL=… MIGRATE_PG_URL=… node mysql-to-pg.mjs [--create-schema <九安副本> [--shell <外壳目录>]] [--dry-run] [--replace] [--batch 1000] [--only <表,…>]\n`);
      process.exitCode = 2;
      return;
    }
    say(`MIGRATE_FAILED error ${String(error?.code || '')} ${String(error?.message || error).split('\n')[0].slice(0, 300)}`.replace(/\s+$/, ''));
    process.exitCode = 1;
  });
}
