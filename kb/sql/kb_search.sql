-- 库内语义检索与上传历史（host/pgvector-up.sh 在 db 阶段以 postgres 超级用户执行，全部语句幂等）。
-- 占位符由 pgvector-up.sh 替换：{table}=RULES_TABLE  {dim}=EMBED_DIM  {model}=EMBED_MODEL_ID  {region}=AWS_REGION  {app_user}=PG_DB_USER
--
--   kb_embed_impl(...)   唯一调 Bedrock 的代码。PL/Python（容器经 IMDSv2 用实例角色签名）：模型 id 含 cohere 发 Cohere Embed v4
--                        的请求（texts、input_type，每次至多 96 条），含 titan 发 Titan v2 的（逐条，没有用途之分）；{dim} 维。
--                        按 sha256(模型|维度|用途|文本) 缓存，不重复调用。只有超级用户能执行：应用用户只经下面两个包装调到它。
--   kb_embed(text, purpose)          单条：问题、零星的重算。每分钟至多 300 个新向量。
--   kb_embed_batch(text[], purpose)  批量：入库都经它，顺序与输入相同，一次至多 2000 条，每分钟至多 2000 个新向量。
--                        两个上限分开数（缓存表的 via 列），只数缓存没命中、真去调 Bedrock 的：大文档入库挤不掉审核 Agent 的检索。
--                        purpose：规则正文 search_document（缺省），问题 search_query（kb_search 用）。
--   kb_meta              登记向量模型：embed_model（模型族，去掉 us. / global. 前缀）、embed_dim、switched_at。deploy.sh 的 db 阶段
--                        先读它防混用。这里只在新库上写；换模型由 migrate_embeddings.sql / restore_embeddings.sql 写。
--   kb_search(...)       审核 Agent 经 Nexus 数据连接器调用的语义检索：SELECT * FROM kb_search('问题', 8)。
--                        每次记一行 kb_search_log（谁查的、问了什么、命中了哪些）。
--   kb_documents         「规则库 › 制度知识库」页的上传历史（外壳 poc/app07 经 kb_admin.py 写）。
--
-- plpython3u 是不受信语言：只有超级用户能建这类函数；连接器用的应用用户只能执行，碰不到函数本身。
-- 本机测试（kb/tests/pg_harness.py）把 kb_embed_impl 前后两行标记（>>> / <<<）之间换成按内容算的假函数：标记别删、别改。
--
-- 权限：库的属主是应用用户时，PG 15+ 的 public 模式归 pg_database_owner（也就是应用用户），它能删掉超级用户建的表、
-- 换成带触发器的同名表，再等 kb_embed（以超级用户执行）写进去。所以 public 模式改归超级用户，应用用户只留 USAGE、CREATE
-- （照样建自己的表、删自己的表）；超级用户的表（缓存、检索日志、kb_meta）应用用户只能读或碰不到，写日志只经 kb_log_search。
-- 应用用户能在 public 里建函数、操作符：超级用户执行的代码（本文件和换模型脚本里的 DO 块、几个 SECURITY DEFINER 函数）调内置
-- 函数一律写 pg_catalog. 前缀、比较两边类型相同，引用自己的对象写 public. 前缀，免得被它建的更「对口」的同名重载截走。
-- 应用用户的表（规则表、归档表）：超级用户的脚本（本文件登记 kb_meta、换模型、回退）先经 kb_assert_plain_table 检查，表上挂着
-- 会执行代码的附加物（触发器、规则、行级安全、CHECK / 外键约束、表达式 / 部分索引、生成列、域等类型的列、引用内置以外对象的
-- 默认值，或它是分区）就拒绝、不碰它；没有才以表的属主身份读写（SET LOCAL ROLE）。光换成属主挡不住：会话用户还是超级用户，
-- 属主的代码一执行就能 RESET ROLE 换回超级用户，所以靠的是前面的拒绝。

-- 与入库（kb_store / ingest_rules）、换模型共用的锁，必须是第一句：后面的 DDL 要拿 kb_embed_cache 等表的排他锁，
-- 要是先拿了表锁再等这把锁，会和「拿着这把锁、正在 kb_embed_batch 里写缓存」的入库互相等死
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('kb_ingest:{table}'));
-- 只认 public：不认 "$user"（库的属主是应用用户，它能建一个和超级用户同名的模式，抢在 public 前面）
SET LOCAL search_path = public, pg_temp;

CREATE EXTENSION IF NOT EXISTS plpython3u;
ALTER SCHEMA public OWNER TO CURRENT_USER;
GRANT USAGE, CREATE ON SCHEMA public TO {app_user};

-- 只接手超级用户建的：应用用户能抢先建同名的表（带触发器、规则、默认值）或函数，等超级用户「接手」后在里面执行它的代码。
-- 已有的不是超级用户的、不是普通表、或带触发器 / 规则的，一律拒绝，不往下执行
DO $$
DECLARE
  bad text;
BEGIN
  SELECT pg_catalog.string_agg(x.what, '、') INTO bad FROM (
    SELECT c.relname::text AS what
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
     WHERE n.nspname = 'public' AND c.relname IN ('kb_embed_cache', 'kb_search_log', 'kb_meta')
       AND (NOT r.rolsuper OR c.relkind <> 'r'
            OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid = c.oid)
            OR EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite w WHERE w.ev_class = c.oid))
    UNION ALL
    SELECT p.oid::regprocedure::text
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
     WHERE n.nspname = 'public'
       AND p.proname IN ('kb_assert_plain_table', 'kb_embed_impl', 'kb_embed', 'kb_embed_batch', 'kb_log_search', 'kb_search')
       AND NOT r.rolsuper) x;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'kb_search.sql：% 已经存在，但不是超级用户建的（或不是普通表、带触发器 / 规则），不接手。先查明来历、删掉后再执行', bad;
  END IF;
END
$$;

-- 超级用户的脚本读写应用用户的表（规则表、归档表）之前过这一关；本文件登记 kb_meta、migrate_embeddings.sql、
-- restore_embeddings.sql（拼在本文件后面执行）都调它，规则只写在这里。
-- 在超级用户会话里 SET LOCAL ROLE 成表的属主并不隔离：表上挂的代码（触发器函数、规则、RLS 策略、约束和索引里的函数、生成列、
-- 域约束、默认值）以属主身份一执行，就能 RESET ROLE 换回超级用户。所以表上有下面任何一样就拒绝（RAISE，列出找到的），不碰它：
--   触发器（系统内部的除外）、规则、行级安全（开启或强制）、CHECK 约束、外键（它引用别的表、别的表引用它）、表达式索引、部分索引、
--   生成列、域 / 复合 / 范围类型（或这些类型的数组）的列、引用了内置（pg_catalog）以外的函数 / 操作符 / 类型的默认值，以及分区
--   （分区约束里有分区键的表达式）。普通的 btree / HNSW 索引、主键、NOT NULL、now() 这类内置默认值、序列都不算。
-- 检查之前先以 SHARE ROW EXCLUSIVE 锁住这张表（到事务结束）：检查完别的会话加不了触发器、约束、索引、规则、RLS，也改不了列和属主。
-- 通过就返回表的属主：调用方以它的身份读写，完了 RESET ROLE。只有超级用户能执行（检查的是 pg_catalog，与执行者无关，也不需要
-- SECURITY DEFINER）；search_path 只有 pg_catalog、pg_temp，应用用户在 public 里建的同名函数、操作符碰不到这里。
CREATE OR REPLACE FUNCTION kb_assert_plain_table(rel regclass, caller text) RETURNS name
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r oid := rel;
  sch name;
  nm name;
  kind "char";
  owner name;
  bad text;
BEGIN
  SELECT n.nspname, c.relname, c.relkind INTO sch, nm, kind
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = r;
  IF NOT FOUND THEN
    RAISE EXCEPTION '%：要检查的表（oid %）已经不在了，不往下执行', caller, r;
  END IF;
  IF kind <> 'r' THEN
    RAISE EXCEPTION '%：% 不是普通表（relkind=%），不碰它。先查明是谁换的', caller, nm, kind;
  END IF;
  EXECUTE pg_catalog.format('LOCK TABLE ONLY %I.%I IN SHARE ROW EXCLUSIVE MODE', sch, nm);
  IF pg_catalog.to_regclass(pg_catalog.format('%I.%I', sch, nm))::oid IS DISTINCT FROM r THEN
    RAISE EXCEPTION '%：% 在检查时被换掉了（同名的已不是原来那张表），不往下执行', caller, nm;
  END IF;
  SELECT pg_catalog.string_agg(f.what, '、' ORDER BY f.ord, f.what) INTO bad FROM (
    SELECT 1 AS ord, pg_catalog.format('触发器 %s', g.tgname) AS what
      FROM pg_catalog.pg_trigger g WHERE g.tgrelid = r AND NOT g.tgisinternal
    UNION ALL
    SELECT 2, pg_catalog.format('规则 %s', w.rulename) FROM pg_catalog.pg_rewrite w WHERE w.ev_class = r
    UNION ALL
    SELECT 3, '行级安全（RLS）' FROM pg_catalog.pg_class c WHERE c.oid = r AND (c.relrowsecurity OR c.relforcerowsecurity)
    UNION ALL
    SELECT 4, '分区（分区约束里有分区键的表达式）' FROM pg_catalog.pg_class c WHERE c.oid = r AND c.relispartition
    UNION ALL
    SELECT 5, CASE WHEN k.contype = 'c' THEN pg_catalog.format('CHECK 约束 %s', k.conname)
                   WHEN k.conrelid = r THEN pg_catalog.format('外键 %s', k.conname)
                   ELSE pg_catalog.format('外键 %s（%s 引用它）', k.conname, k.conrelid::pg_catalog.regclass) END
      FROM pg_catalog.pg_constraint k
     WHERE (k.contype = 'c' AND k.conrelid = r) OR (k.contype = 'f' AND (k.conrelid = r OR k.confrelid = r))
    UNION ALL
    SELECT 6, pg_catalog.format(CASE WHEN i.indexprs IS NOT NULL THEN '表达式索引 %s' ELSE '部分索引 %s' END, i.indexrelid::pg_catalog.regclass)
      FROM pg_catalog.pg_index i WHERE i.indrelid = r AND (i.indexprs IS NOT NULL OR i.indpred IS NOT NULL)
    UNION ALL
    SELECT 7, pg_catalog.format('生成列 %s', a.attname)
      FROM pg_catalog.pg_attribute a WHERE a.attrelid = r AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated <> ''
    UNION ALL
    SELECT 8, pg_catalog.format('列 %s 的类型 %s（域 / 复合 / 范围类型）', a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod))
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_catalog.pg_type e ON e.oid = t.typelem
     WHERE a.attrelid = r AND a.attnum > 0 AND NOT a.attisdropped
       AND (t.typtype IN ('d', 'c', 'r', 'm') OR e.typtype IN ('d', 'c', 'r', 'm'))
    UNION ALL
    -- 默认值里引用的函数、操作符、类型记在 pg_depend（内置的不记）；只许引用表自己的列和序列（pg_class）。
    -- 生成列的表达式也存在 pg_attrdef 里，上面已经报过
    SELECT 9, pg_catalog.format('列 %s 的默认值引用了 %s', a.attname, pg_catalog.pg_describe_object(p.refclassid, p.refobjid, p.refobjsubid))
      FROM pg_catalog.pg_attrdef d
      JOIN pg_catalog.pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      JOIN pg_catalog.pg_depend p ON p.classid = 'pg_catalog.pg_attrdef'::pg_catalog.regclass::pg_catalog.oid AND p.objid = d.oid
     WHERE d.adrelid = r AND a.attgenerated = ''
       AND p.refclassid <> 'pg_catalog.pg_class'::pg_catalog.regclass::pg_catalog.oid
  ) f;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '%：% 带着会执行代码的附加物（%），不碰它：超级用户的脚本即使以表的属主身份读写，这些代码也能换回超级用户身份。先查明来历、删掉后再执行',
      caller, nm, bad;
  END IF;
  -- 锁住之后再取属主（改属主要的锁与 SHARE ROW EXCLUSIVE 冲突，取到的就是读写时的属主）
  SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO owner FROM pg_catalog.pg_class c WHERE c.oid = r;
  RETURN owner;
END
$$;
REVOKE ALL ON FUNCTION kb_assert_plain_table(regclass, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION kb_assert_plain_table(regclass, text) FROM {app_user};

-- 向量缓存：键 = sha256(模型|维度|用途|文本)。只有 kb_embed_impl（SECURITY DEFINER，属主 postgres）读写。
-- via = 谁生成的（single / batch / migrate），每分钟上限按它分开数
CREATE TABLE IF NOT EXISTS kb_embed_cache (
  sha256     text PRIMARY KEY,
  embedding  vector({dim}) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- 老版本的缓存（键只是文本的 sha256，没有 via 列）换了键就不会再命中：加列之前清掉，只在升级这一次
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                  WHERE a.attrelid = pg_catalog.to_regclass('public.kb_embed_cache')::oid AND a.attname = 'via' AND NOT a.attisdropped) THEN
    DELETE FROM public.kb_embed_cache;
  END IF;
END
$$;
ALTER TABLE kb_embed_cache ADD COLUMN IF NOT EXISTS via text NOT NULL DEFAULT 'single';
ALTER TABLE kb_embed_cache OWNER TO CURRENT_USER;
REVOKE ALL ON TABLE kb_embed_cache FROM PUBLIC;
DROP INDEX IF EXISTS kb_embed_cache_created_idx;
CREATE INDEX IF NOT EXISTS kb_embed_cache_via_created_idx ON kb_embed_cache (via, created_at);

-- 向量模型登记：超级用户写，应用用户只读。只在新库上写：还没有登记，规则表（和归档表）里也还没有向量。
-- 已有向量却没登记的老库（Titan 时代建的）不在这里猜：deploy.sh 按 Titan 算，换模型时由 migrate_embeddings.sql 重算后登记。
-- 规则表、归档表归应用用户：先过 kb_assert_plain_table（不是普通表、带着会执行代码的附加物就停下），再以表的属主身份读
CREATE TABLE IF NOT EXISTS kb_meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);
ALTER TABLE kb_meta OWNER TO CURRENT_USER;
REVOKE ALL ON TABLE kb_meta FROM PUBLIC;
REVOKE ALL ON TABLE kb_meta FROM {app_user};
GRANT SELECT ON TABLE kb_meta TO {app_user};
DO $$
DECLARE
  t text;
  rel regclass;
  owner name;
  has_vectors boolean := false;
BEGIN
  IF EXISTS (SELECT 1 FROM public.kb_meta) THEN
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY['{table}', '{table}_archive'] LOOP
    rel := pg_catalog.to_regclass(pg_catalog.format('public.%I', t));
    CONTINUE WHEN rel IS NULL OR has_vectors;
    owner := public.kb_assert_plain_table(rel, 'kb_search.sql'::text);
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner);
    EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM ONLY public.%I WHERE embedding IS NOT NULL)', t) INTO has_vectors;
    RESET ROLE;
  END LOOP;
  IF NOT has_vectors THEN
    INSERT INTO public.kb_meta (key, value) VALUES
      ('embed_model', pg_catalog.regexp_replace('{model}', '^(us|global|eu|apac)\.', '')),
      ('embed_dim', '{dim}'),
      ('switched_at', pg_catalog.to_char(pg_catalog.now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  END IF;
END
$$;

-- 上传历史：一次上传一行
CREATE TABLE IF NOT EXISTS kb_documents (
  id bigserial PRIMARY KEY,
  file_name text NOT NULL,
  sha256 text NOT NULL,
  size_bytes bigint,
  uploaded_by text,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('parsed', 'ingesting', 'ingested', 'failed', 'superseded')),
  source_tag text,
  doc_title text,
  source_version text,
  report jsonb,
  result jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS kb_documents_uploaded_idx ON kb_documents (uploaded_at DESC);
ALTER TABLE kb_documents OWNER TO {app_user};

-- 检索日志：每次 kb_search 一行；只留 90 天。只追加：应用用户只能读，写只经 kb_log_search
CREATE TABLE IF NOT EXISTS kb_search_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  caller text,
  db_user text,
  question text,
  k int,
  segment text,
  hits jsonb,
  took_ms int
);
CREATE INDEX IF NOT EXISTS kb_search_log_at_idx ON kb_search_log (at DESC);
ALTER TABLE kb_search_log OWNER TO CURRENT_USER;
REVOKE ALL ON kb_search_log FROM {app_user};
GRANT SELECT ON kb_search_log TO {app_user};

-- 文本 → 向量（顺序与输入相同）。purpose 只能是 search_document / search_query；via、cap 由包装函数给（每分钟上限按 via 分开数）。
-- >>> kb_embed_impl
CREATE OR REPLACE FUNCTION kb_embed_impl(inputs text[], purpose text, via text, cap int) RETURNS vector({dim})[]
LANGUAGE plpython3u VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
MODEL, DIM = "{model}", {dim}
if purpose not in ("search_document", "search_query"):
    plpy.error("kb_embed：purpose 只能是 search_document 或 search_query")
if inputs is None:
    plpy.error("kb_embed：输入为空")
for i, text in enumerate(inputs):
    which = "" if len(inputs) == 1 else "第 %d 条" % (i + 1)
    if text is None or not text.strip():
        plpy.error("kb_embed：%s输入为空" % which)
    # 问题（2000 字以内，由 kb_search 管）和规则全文都经这里：上限按模型的输入长度给
    if len(text) > 8000:
        plpy.error("kb_embed：%s输入超过 8000 字" % which)
if not inputs:
    return []
if "cohere" in MODEL:
    kind = "cohere"
elif "titan" in MODEL:
    kind = "titan"
else:
    plpy.error("kb_embed：不支持的向量模型 %s（只支持 Cohere Embed v4 和 Titan v2）" % MODEL)
keys = [hashlib.sha256(("%s|%d|%s|%s" % (MODEL, DIM, purpose, t)).encode("utf-8")).hexdigest() for t in inputs]
# 以超级用户执行：表写 public.、内置函数写 pg_catalog.（应用用户能在 public 里建同名重载，见文件头）
if "get" not in SD:
    SD["get"] = plpy.prepare("SELECT sha256, embedding::text AS e FROM public.kb_embed_cache WHERE sha256 = ANY($1)", ["text[]"])
    SD["recent"] = plpy.prepare("SELECT pg_catalog.count(*) AS n FROM public.kb_embed_cache "
                                "WHERE via = $1 AND created_at > pg_catalog.clock_timestamp() - interval '1 minute'", ["text"])
    SD["put"] = plpy.prepare("INSERT INTO public.kb_embed_cache (sha256, embedding, via, created_at) "
                             "VALUES ($1, $2::public.vector, $3, pg_catalog.clock_timestamp()) ON CONFLICT (sha256) DO NOTHING", ["text", "text", "text"])
    SD["ro"] = plpy.prepare("SELECT pg_catalog.current_setting('transaction_read_only') AS ro")
found = {r["sha256"]: r["e"] for r in plpy.execute(SD["get"], [sorted(set(keys))])}
todo, seen = [], set()   # 缓存没命中的（同一批里重复的只算一次），按第一次出现的顺序
for k, t in zip(keys, inputs):
    if k not in found and k not in seen:
        seen.add(k)
        todo.append((k, t))
if not todo:
    return [found[k] for k in keys]
# 上限按缓存里记下的行数，只读事务里记不下：批量（和换模型）在只读事务里不许生成新向量，否则 BEGIN READ ONLY 一次就能
# 绕过上限刷 2000 个。单条照常（审核 Agent 的连接器可能是只读的；每次至多一个）
if via != "single" and plpy.execute(SD["ro"])[0]["ro"] == "on":
    plpy.error("kb_embed：只读事务里不能生成新向量（这次要 %d 个）；批量请在读写事务里调" % len(todo))
# 真去调 Bedrock 的（缓存没命中）每分钟有上限，按 via 分开数：连接器用户不能拿它刷调用，大文档入库也挤不掉单条的检索
recent = plpy.execute(SD["recent"], [via])[0]["n"]
if recent + len(todo) > cap:
    plpy.error("kb_embed：每分钟最多生成 %d 个新向量（这一分钟已生成 %d 个，这次还要 %d 个），请一分钟后再试" % (cap, recent, len(todo)))


def clean(text):
    # 错误会回到审核 Agent 和页面上：去掉 ARN 和账号
    text = re.sub(r"arn:aws[\w:/+=,.@-]*", "arn:…", text)
    return re.sub(r"\b\d{12}\b", "<账号>", text)


# 容器里 Debian 12 的 botocore（1.29）没有 bedrock-runtime 的服务定义：用它的 SigV4Auth 和实例角色凭证签名，经 HTTPS 直接调 InvokeModel
if "creds" not in SD:
    import botocore.session
    SD["creds"] = botocore.session.get_session().get_credentials()
if SD["creds"] is None:
    del SD["creds"]
    plpy.error("kb_embed：拿不到实例角色的凭证")
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
url = "https://bedrock-runtime.{region}.amazonaws.com/model/" + urllib.parse.quote("{model}", safe="") + "/invoke"


def invoke(payload):
    body = json.dumps(payload).encode("utf-8")
    for attempt in range(3):
        signed = AWSRequest(method="POST", url=url, data=body, headers={"Content-Type": "application/json", "Accept": "application/json"})
        SigV4Auth(SD["creds"].get_frozen_credentials(), "bedrock", "{region}").add_auth(signed)
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=dict(signed.headers.items()), method="POST"), timeout=20) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as error:
            # 限流和服务端错误重试两次；权限（403）、参数（400）等直接报
            if error.code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(0.5 * (attempt + 1))
                continue
            plpy.error("kb_embed：Bedrock 返回 %s %s" % (error.code, clean(error.read()[:300].decode("utf-8", "replace"))))
        except OSError as error:
            if attempt < 2:
                time.sleep(0.5 * (attempt + 1))
                continue
            plpy.error("kb_embed：连不上 Bedrock（%s）" % clean(str(getattr(error, "reason", error)))[:200])


vectors = []
if kind == "cohere":
    for start in range(0, len(todo), 96):
        chunk = [t for _, t in todo[start:start + 96]]
        out = invoke({"texts": chunk, "input_type": purpose, "embedding_types": ["float"], "output_dimension": {dim}, "truncate": "END"})
        got = (out.get("embeddings") or {}).get("float") if isinstance(out, dict) else None
        if not isinstance(got, list) or len(got) != len(chunk):
            plpy.error("kb_embed：Bedrock 返回的向量个数不对（要 %d 个，回了 %s 个）" % (len(chunk), len(got) if isinstance(got, list) else 0))
        vectors.extend(got)
else:
    for _, t in todo:
        out = invoke({"inputText": t, "dimensions": {dim}, "normalize": True})
        vectors.append(out.get("embedding") if isinstance(out, dict) else None)
texts = []
for v in vectors:
    if not isinstance(v, list) or len(v) != DIM:
        plpy.error("kb_embed：Bedrock 返回的向量不是 %d 维" % DIM)
    texts.append("[" + ",".join(repr(float(x)) for x in v) + "]")
for (k, _), e in zip(todo, texts):
    found[k] = e
# 只读事务里写不进缓存（只有单条会走到这里）：照样返回向量
try:
    with plpy.subtransaction():
        for (k, _), e in zip(todo, texts):
            plpy.execute(SD["put"], [k, e, via])
except plpy.spiexceptions.ReadOnlySqlTransaction:
    pass
return [found[k] for k in keys]
$$;
-- <<< kb_embed_impl

-- 单条（问题、零星重算）：每分钟 300 个新向量。原来的单参数版先删，否则 kb_embed('…') 有歧义；单参数的调用照样能用（缺省用途）
DROP FUNCTION IF EXISTS kb_embed(text);
CREATE OR REPLACE FUNCTION kb_embed(input text, purpose text DEFAULT 'search_document') RETURNS vector({dim})
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (public.kb_embed_impl(ARRAY[input], purpose, 'single'::text, 300))[1]
$$;

-- 批量（入库）：顺序与输入相同；一次至多 2000 条（一份文档至多 2000 条记录），每分钟 2000 个新向量，与单条分开数。
-- 调用方：SELECT kb_embed_batch(%s::text[], 'search_document')::text[]
CREATE OR REPLACE FUNCTION kb_embed_batch(inputs text[], purpose text DEFAULT 'search_document') RETURNS vector({dim})[]
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF inputs IS NULL THEN
    RAISE EXCEPTION 'kb_embed_batch：输入为空';
  END IF;
  IF pg_catalog.array_ndims(inputs) > 1 THEN
    RAISE EXCEPTION 'kb_embed_batch：输入要是一维数组';
  END IF;
  IF pg_catalog.cardinality(inputs) > 2000 THEN
    RAISE EXCEPTION 'kb_embed_batch：一次至多 2000 条（这次 % 条）', pg_catalog.cardinality(inputs);
  END IF;
  RETURN public.kb_embed_impl(inputs, purpose, 'batch'::text, 2000);
END
$$;

-- 写检索日志：kb_search 调；以超级用户写进只追加的 kb_search_log（应用用户自己写不进、删不掉），顺带清掉 90 天前的
DROP FUNCTION IF EXISTS kb_log_search(text, text, int, text, jsonb, int);
CREATE OR REPLACE FUNCTION kb_log_search(who text, asked text, n int, seg text, top jsonb, ms int) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO kb_search_log (caller, db_user, question, k, segment, hits, took_ms)
  VALUES (left(who, 40), session_user, left(asked, 2000), n, left(seg, 40), top, ms);
  DELETE FROM kb_search_log l WHERE l.at < now() - interval '90 days';
END
$$;

-- 排序：问题里用空格、标点隔开的词（2–20 字，至多 8 个；审核 Agent 传的是关键词）在规则原文 content 里出现得越多越靠前；
-- 命中数相同时，矩阵 / 制度说明 / 章节说明排在正文条款（rule_type = clause）前面，再按语义距离（关键词先把对口的行提上来，
-- 条款再多也挤不掉同样对口的矩阵行）。库里没有条款时与原来的「命中数、语义」完全一样；整句问话没有可匹配的词就是纯语义。
-- 问题的向量用 search_query，规则的用 search_document（Cohere v4 两种用途配对；Titan 不分）。
-- score 仍是语义相似度，keyword_hits 是命中的词数。返回的列变过：先删旧函数再建。
DROP FUNCTION IF EXISTS kb_search(text, int, text, text);
CREATE OR REPLACE FUNCTION kb_search(question text, k int DEFAULT 8, segment_filter text DEFAULT NULL, caller text DEFAULT 'agent')
RETURNS TABLE (rule_id text, rule_type text, chapter text, business_item text, segment text, amount_tier text, approval_path_text text, final_approver text, scope_controls text, score numeric, keyword_hits int)
LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  q vector({dim});
  n int := least(greatest(coalesce(k, 8), 1), 20);
  started timestamptz := clock_timestamp();
  recent int;
  rec record;
  terms text[];
  hits jsonb := '[]'::jsonb;
BEGIN
  IF question IS NULL OR btrim(question) = '' THEN
    RAISE EXCEPTION 'kb_search：问题为空';
  END IF;
  IF char_length(question) > 2000 THEN
    RAISE EXCEPTION 'kb_search：问题超过 2000 字';
  END IF;
  SELECT count(*) INTO recent FROM kb_search_log l WHERE l.at > now() - interval '1 minute';
  IF recent >= 60 THEN
    RAISE EXCEPTION 'kb_search：每分钟最多 60 次，请稍后再查';
  END IF;
  q := kb_embed(question, 'search_query');
  SELECT coalesce(array_agg(DISTINCT s.t), ARRAY[]::text[]) INTO terms
    FROM (SELECT t FROM regexp_split_to_table(question, '[\s，。、；：,.;:？?！!（）()]+') AS t WHERE char_length(t) BETWEEN 2 AND 20 LIMIT 8) s;
  FOR rec IN
    SELECT r.rule_id AS rid, r.rule_type AS rtype, r.chapter AS rchapter, r.business_item AS ritem, r.segment AS rsegment, r.amount_tier AS rtier,
           r.approval_path_text AS rpath, r.final_approver AS rfinal, r.scope_controls AS rscope, round((1 - (r.embedding <=> q))::numeric, 4) AS rscore,
           (SELECT count(*) FROM unnest(terms) AS t WHERE position(t in coalesce(r.content, '')) > 0)::int AS rhits
      FROM {table} r
     WHERE r.embedding IS NOT NULL
       AND (segment_filter IS NULL OR position(segment_filter in coalesce(r.segment, '')) > 0)
     ORDER BY rhits DESC, (r.rule_type = 'clause') ASC, r.embedding <=> q
     LIMIT n
  LOOP
    rule_id := rec.rid; rule_type := rec.rtype; chapter := rec.rchapter; business_item := rec.ritem; segment := rec.rsegment;
    amount_tier := rec.rtier; approval_path_text := rec.rpath; final_approver := rec.rfinal; scope_controls := rec.rscope; score := rec.rscore; keyword_hits := rec.rhits;
    hits := hits || jsonb_build_array(jsonb_build_object('rule_id', rec.rid, 'score', rec.rscore, 'keyword_hits', rec.rhits));
    RETURN NEXT;
  END LOOP;
  -- 记日志；只读事务（连接器若改成只读）里写不进去，照样返回结果
  BEGIN
    PERFORM kb_log_search(caller, question, n, segment_filter, hits, (extract(epoch FROM clock_timestamp() - started) * 1000)::int);
  EXCEPTION WHEN read_only_sql_transaction THEN
    NULL;
  END;
  RETURN;
END
$$;

-- kb_embed_impl 只有超级用户能执行（应用用户经 kb_embed / kb_embed_batch 这两个 SECURITY DEFINER 包装调到它）
REVOKE ALL ON FUNCTION kb_embed_impl(text[], text, text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION kb_embed_impl(text[], text, text, int) FROM {app_user};
REVOKE ALL ON FUNCTION kb_embed(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kb_embed(text, text) TO {app_user};
REVOKE ALL ON FUNCTION kb_embed_batch(text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kb_embed_batch(text[], text) TO {app_user};
REVOKE ALL ON FUNCTION kb_log_search(text, text, int, text, jsonb, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kb_log_search(text, text, int, text, jsonb, int) TO {app_user};
GRANT EXECUTE ON FUNCTION kb_search(text, int, text, text) TO {app_user};
