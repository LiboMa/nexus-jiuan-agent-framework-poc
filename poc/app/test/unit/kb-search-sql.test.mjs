import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// 库内语义检索（kb/sql/kb_search.sql）：PG 里的 kb_embed() 调 Bedrock Titan v2，kb_search() 给审核 Agent 经连接器用，
// 每次检索记进 kb_search_log。函数本身在测试台上由 kb.sh db / verify 实测（本机没有 PG）；这里核对 SQL 和装包脚本的约束。
const kb = name => fileURLToPath(new URL(`../../../../kb/${name}`, import.meta.url));
const render = text => text.replaceAll('{table}', 'approval_rules').replaceAll('{dim}', '1024').replaceAll('{model}', 'amazon.titan-embed-text-v2:0')
  .replaceAll('{region}', 'us-east-1').replaceAll('{app_user}', 'nexus');
const fn = (sql, name) => { const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`); assert.ok(start >= 0, `缺函数 ${name}`); return sql.slice(start, sql.indexOf('$$;', sql.indexOf('$$', start) + 2) + 3); };

test('kb_embed：plpython3u、SECURITY DEFINER、固定 search_path；Titan v2 1024 维、normalize，和库里已有的向量同一套参数；超过 2000 字拒绝；按内容缓存', async () => {
  const sql = render(await readFile(kb('sql/kb_search.sql'), 'utf8'));
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS plpython3u;/);
  assert.doesNotMatch(sql, /\{(table|dim|model|region|app_user)\}/, '占位符都要被替换');
  const embed = fn(sql, 'kb_embed');
  assert.match(embed, /RETURNS vector\(1024\)/);
  assert.match(embed, /LANGUAGE plpython3u/);
  assert.match(embed, /SECURITY DEFINER/);
  assert.match(embed, /SET search_path = public, pg_temp/);
  assert.match(embed, /"dimensions": 1024/);
  assert.match(embed, /"normalize": True/);
  assert.match(embed, /len\(input\) > 8000[\s\S]*plpy\.error/, '入库时规则全文也经它：上限按模型给，问题的 2000 字在 kb_search 里管');
  assert.match(embed, /kb_embed_cache/);
  assert.match(sql, /REVOKE ALL ON FUNCTION kb_embed\(text\) FROM PUBLIC;/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION kb_embed\(text\) TO nexus;/);
});

test('kb_embed 怎么调 Bedrock：容器里 Debian 12 的 botocore（1.29）没有 bedrock-runtime 的服务定义，不用 boto3.client；用它的 SigV4Auth（服务名 bedrock）和实例角色凭证签名，经 HTTPS 直接调 InvokeModel，模型编号在路径里转义', async () => {
  const embed = fn(render(await readFile(kb('sql/kb_search.sql'), 'utf8')), 'kb_embed');
  assert.doesNotMatch(embed, /boto3\.client\(/);
  assert.match(embed, /from botocore\.auth import SigV4Auth/);
  assert.match(embed, /SigV4Auth\(SD\["creds"\]\.get_frozen_credentials\(\), "bedrock", "us-east-1"\)/);
  assert.match(embed, /"https:\/\/bedrock-runtime\.us-east-1\.amazonaws\.com\/model\/" \+ urllib\.parse\.quote\("amazon\.titan-embed-text-v2:0", safe=""\) \+ "\/invoke"/);
  assert.match(embed, /get_frozen_credentials\(\)/);
  assert.match(embed, /urlopen\([^\n]*timeout=\d+/);
  assert.match(embed, /except urllib\.error\.HTTPError[\s\S]*plpy\.error/, 'Bedrock 拒绝时把状态码和原因报出来');
});

test('kb_search：先把问题向量算进变量再排序（不在 ORDER BY 里调易变函数）；k 夹在 1–20；每分钟 60 次；返回约定的列；缓存与日志写不进去（只读事务）也照样返回', async () => {
  const sql = render(await readFile(kb('sql/kb_search.sql'), 'utf8'));
  const search = fn(sql, 'kb_search');
  assert.match(search, /kb_search\(question text, k int DEFAULT 8, segment_filter text DEFAULT NULL, caller text DEFAULT 'agent'\)/);
  assert.match(search, /RETURNS TABLE \(rule_id text, rule_type text, chapter text, business_item text, segment text, amount_tier text, approval_path_text text, final_approver text, scope_controls text, score numeric, keyword_hits int\)/);
  assert.match(search, /LANGUAGE plpgsql/);
  assert.match(search, /q := kb_embed\(question\)/);
  assert.match(search, /ORDER BY rhits DESC, r\.embedding <=> q/);
  assert.doesNotMatch(search, /ORDER BY[^;]*kb_embed\(/);
  assert.match(search, /least\(greatest\(coalesce\(k, 8\), 1\), 20\)/);
  assert.match(search, /round\(\(1 - \(r\.embedding <=> q\)\)::numeric, 4\)/);
  assert.match(search, /interval '1 minute'[\s\S]*>= 60/);
  assert.match(search, /EXCEPTION WHEN read_only_sql_transaction/);
  assert.match(search, /position\(segment_filter in coalesce\(r\.segment, ''\)\) > 0/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION kb_search\(text, int, text, text\) TO nexus;/);
  const embed = fn(sql, 'kb_embed');
  assert.match(embed, /except plpy\.spiexceptions\.ReadOnlySqlTransaction/, '缓存写不进去也照样返回向量');
});

test('kb_search 的排序：问题里用空格、标点隔开的词（2–20 字，至多 8 个）在规则原文里出现得越多越靠前，同样多的再按语义；整句没有可匹配的词就是纯语义；分数仍是语义相似度', async () => {
  const sql = render(await readFile(kb('sql/kb_search.sql'), 'utf8'));
  const search = fn(sql, 'kb_search');
  assert.ok(sql.indexOf('DROP FUNCTION IF EXISTS kb_search(text, int, text, text);') >= 0 && sql.indexOf('DROP FUNCTION IF EXISTS kb_search(text, int, text, text);') < sql.indexOf('CREATE OR REPLACE FUNCTION kb_search('),
    '返回的列变了：先删旧函数再建');
  assert.match(search, /regexp_split_to_table\(question, '\[\\s，。、；：,\.;:？\?！!（）\(\)\]\+'\)/);
  assert.match(search, /char_length\(t\) BETWEEN 2 AND 20/);
  assert.match(search, /LIMIT 8/);
  assert.match(search, /position\(t in coalesce\(r\.content, ''\)\) > 0/);
  assert.match(search, /keyword_hits := rec\.rhits/);
  assert.match(search, /'keyword_hits', rec\.rhits/, '检索日志里也记下关键词命中数');
  assert.match(search, /round\(\(1 - \(r\.embedding <=> q\)\)::numeric, 4\) AS rscore/);
});

test('上传历史 kb_documents、检索日志 kb_search_log：列和状态与设计一致，属主是应用用户；日志只留 90 天', async () => {
  const sql = render(await readFile(kb('sql/kb_search.sql'), 'utf8'));
  for (const column of ['id bigserial PRIMARY KEY', 'file_name text NOT NULL', 'sha256 text NOT NULL', 'size_bytes bigint', 'uploaded_by text', 'uploaded_at timestamptz',
    'status text NOT NULL', 'source_tag text', 'doc_title text', 'source_version text', 'report jsonb', 'result jsonb', 'error text', 'started_at timestamptz', 'finished_at timestamptz']) {
    assert.ok(sql.includes(column), `kb_documents 缺 ${column}`);
  }
  assert.match(sql, /CHECK \(status IN \('parsed', 'ingesting', 'ingested', 'failed', 'superseded'\)\)/);
  for (const column of ['at timestamptz NOT NULL DEFAULT now()', 'caller text', 'db_user text', 'question text', 'k int', 'segment text', 'hits jsonb', 'took_ms int']) {
    assert.ok(sql.includes(column), `kb_search_log 缺 ${column}`);
  }
  assert.match(sql, /ALTER TABLE kb_documents OWNER TO nexus;/);
  // 检索日志只追加：属主是建它的超级用户，应用用户（连接器）只能读；写日志经 SECURITY DEFINER 的 kb_log_search
  assert.match(sql, /ALTER TABLE kb_search_log OWNER TO CURRENT_USER;/);
  assert.match(sql, /REVOKE ALL ON kb_search_log FROM nexus;\s*GRANT SELECT ON kb_search_log TO nexus;/);
  assert.match(sql, /ALTER TABLE kb_embed_cache OWNER TO CURRENT_USER;/);
  assert.match(sql, /interval '90 days'/);
});

test('pgvector-up.sh：给了 KB_SEARCH_SQL_B64 才装 PL/Python 和建函数；先查有没有，没有才在容器里 apt-get 装（不重启）；status 报告 plpython 和 kb_search', async () => {
  const up = await readFile(kb('host/pgvector-up.sh'), 'utf8');
  assert.match(up, /if \[ -n "\$\{KB_SEARCH_SQL_B64:-\}" \]/);
  assert.match(up, /pg_available_extensions WHERE name = 'plpython3u'/);
  assert.match(up, /docker exec -u 0 "\$PG_CONTAINER_NAME" sh -c 'apt-get update -qq && apt-get install -y -qq --no-install-recommends postgresql-plpython3-17 python3-boto3'/);
  assert.match(up, /result plpython installed/);
  assert.match(up, /result plpython present/);
  assert.match(up, /result kb_search ready/);
  // 整份 kb_search.sql 一个事务：中途出错就全部回滚，不会留下「新函数调旧函数」的半截状态（测试台上出过）
  assert.match(up, /psql -X -q -1 -U postgres -d "\$PG_DB_NAME" -v ON_ERROR_STOP=1/);
  assert.doesNotMatch(up, /docker (restart|rm|stop)/, '装语言不重启、不重建容器');
  const status = await readFile(kb('host/pgvector-status.sh'), 'utf8');
  assert.match(status, /RESULT plpython=/);
  assert.match(status, /RESULT kb_search=/);
  assert.match(status, /kb_search\('ping', 1, NULL, 'verify'\)/);
  assert.match(status, /RESULT kb_search_error=/, '用不了时带上 PG 报的那一行（权限、凭证、模型），不只说 error');
  const deploy = await readFile(kb('deploy.sh'), 'utf8');
  assert.match(deploy, /KB_SEARCH_SQL_B64=\$\(base64 < "\$PKG_DIR\/sql\/kb_search\.sql" \| tr -d '\\n'\)/);
  assert.match(deploy, /\[search\] kb_search 可用/);
  assert.match(deploy, /result_of kb_search_error/);
  assert.match(deploy, /\[search\] E2E_QUESTION 前 3 名/);
});

test('权限：public 模式归超级用户（应用用户只留 USAGE、CREATE），连接器用户删不掉、改不了超级用户的表；写日志只经 kb_log_search；kb_embed 限流、重试、错误里不带账号和 ARN', async () => {
  const sql = render(await readFile(kb('sql/kb_search.sql'), 'utf8'));
  // 库的属主是应用用户时，PG 15+ 的 public 模式归 pg_database_owner＝应用用户：它能删掉超级用户建的表、换成带触发器的同名表
  assert.match(sql, /ALTER SCHEMA public OWNER TO CURRENT_USER;\s*GRANT USAGE, CREATE ON SCHEMA public TO nexus;/);
  const log = fn(sql, 'kb_log_search');
  for (const line of [/LANGUAGE plpgsql/, /SECURITY DEFINER/, /SET search_path = public, pg_temp/, /INSERT INTO kb_search_log/, /session_user/, /interval '90 days'/]) assert.match(log, line);
  // plpgsql 自带布尔变量 FOUND，会盖过同名参数（测试台上 kb_search 因此报「hits 是 jsonb、表达式是 boolean」）
  assert.doesNotMatch(log.slice(0, log.indexOf('RETURNS')), /\bfound\b/i);
  const dropLog = sql.indexOf('DROP FUNCTION IF EXISTS kb_log_search(text, text, int, text, jsonb, int);');
  assert.ok(dropLog >= 0 && dropLog < sql.indexOf('CREATE OR REPLACE FUNCTION kb_log_search('), '参数改过名：CREATE OR REPLACE 改不了，先删再建');
  assert.match(sql, /REVOKE ALL ON FUNCTION kb_log_search\(text, text, int, text, jsonb, int\) FROM PUBLIC;\s*GRANT EXECUTE ON FUNCTION kb_log_search\(text, text, int, text, jsonb, int\) TO nexus;/);
  const search = fn(sql, 'kb_search');
  assert.match(search, /PERFORM kb_log_search\(/);
  assert.doesNotMatch(search, /INSERT INTO kb_search_log|DELETE FROM kb_search_log/);
  assert.match(search, /char_length\(question\) > 2000/);
  const embed = fn(sql, 'kb_embed');
  assert.match(embed, /clock_timestamp\(\) - interval '1 minute'[\s\S]*>= 300/, '每分钟最多 300 次缓存未命中（真去调 Bedrock 的）');
  assert.match(embed, /INSERT INTO kb_embed_cache \(sha256, embedding, created_at\) VALUES \(\$1, \$2::vector, clock_timestamp\(\)\)/);
  assert.match(embed, /for attempt in range\(3\)/);
  assert.match(embed, /error\.code (in|==) [^\n]*429/);
  assert.match(embed, /re\.sub\(r"arn:aws/, '错误里的 ARN 去掉');
  assert.match(embed, /re\.sub\(r"\\b\\d\{12\}\\b"/, '错误里的账号去掉');
  assert.match(sql, /CREATE INDEX IF NOT EXISTS kb_embed_cache_created_idx ON kb_embed_cache \(created_at\);/);
});

test('pgvector-status.sh：以应用用户（不是超级用户）查；kb_search 的探测放在只读事务里：verify / dry-run 不写日志和缓存，也顺带核对只读事务能检索', async () => {
  const status = await readFile(kb('host/pgvector-status.sh'), 'utf8');
  assert.doesNotMatch(status, /-U postgres/, '超级用户会话里跑应用用户能改的表和函数，等于把超级用户交出去');
  assert.match(status, /psql -X -At -U "\$PG_DB_USER"/);
  assert.match(status, /BEGIN READ ONLY;[^\n]*kb_search\('ping', 1, NULL, 'verify'\)[^\n]*ROLLBACK;/);
  assert.match(status, /BEGIN READ ONLY;[^\n]*kb_search\(:'question', 3, NULL, 'verify'\)[^\n]*ROLLBACK;/);
  assert.match(status, /: "\$\{PG_CONTAINER_NAME:\?\}" "\$\{PG_DB_NAME:\?\}" "\$\{PG_DB_USER:\?\}" "\$\{RULES_TABLE:\?\}"/);
});
