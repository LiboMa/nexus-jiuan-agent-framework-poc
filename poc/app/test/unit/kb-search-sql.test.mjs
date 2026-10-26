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
  assert.match(embed, /modelId="amazon\.titan-embed-text-v2:0"/);
  assert.match(embed, /region_name="us-east-1"/);
  assert.match(embed, /len\(input\) > 2000[\s\S]*plpy\.error/);
  assert.match(embed, /kb_embed_cache/);
  assert.match(sql, /REVOKE ALL ON FUNCTION kb_embed\(text\) FROM PUBLIC;/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION kb_embed\(text\) TO nexus;/);
});

test('kb_search：先把问题向量算进变量再排序（不在 ORDER BY 里调易变函数）；k 夹在 1–20；每分钟 60 次；返回约定的列；缓存与日志写不进去（只读事务）也照样返回', async () => {
  const sql = render(await readFile(kb('sql/kb_search.sql'), 'utf8'));
  const search = fn(sql, 'kb_search');
  assert.match(search, /kb_search\(question text, k int DEFAULT 8, segment_filter text DEFAULT NULL, caller text DEFAULT 'agent'\)/);
  assert.match(search, /RETURNS TABLE \(rule_id text, rule_type text, chapter text, business_item text, segment text, amount_tier text, approval_path_text text, final_approver text, scope_controls text, score numeric\)/);
  assert.match(search, /LANGUAGE plpgsql/);
  assert.match(search, /q := kb_embed\(question\)/);
  assert.match(search, /ORDER BY r\.embedding <=> q/);
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
  assert.match(sql, /ALTER TABLE kb_search_log OWNER TO nexus;/);
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
  assert.doesNotMatch(up, /docker (restart|rm|stop)/, '装语言不重启、不重建容器');
  const status = await readFile(kb('host/pgvector-status.sh'), 'utf8');
  assert.match(status, /RESULT plpython=/);
  assert.match(status, /RESULT kb_search=/);
  assert.match(status, /kb_search\('ping', 1, NULL, 'verify'\)/);
  const deploy = await readFile(kb('deploy.sh'), 'utf8');
  assert.match(deploy, /KB_SEARCH_SQL_B64=\$\(base64 < "\$PKG_DIR\/sql\/kb_search\.sql" \| tr -d '\\n'\)/);
  assert.match(deploy, /\[search\] kb_search 可用/);
  assert.match(deploy, /\[search\] E2E_QUESTION 前 3 名/);
});
