-- 整库换向量模型（例如 Titan v2 → Cohere v4）：先备份旧向量，再用新模型把规则表和归档表全部重算，最后登记 kb_meta。
-- 拼在新配置的 kb_search.sql 后面，以 postgres 超级用户经 psql -X -v ON_ERROR_STOP=1 -1 在一个事务里执行
-- （deploy.sh db --migrate-embeddings）：任何一步失败（备份表已存在、表上有附加物、Bedrock 报错、上限）整段回滚，库里还是原来的模型、
-- 原来的 kb_embed / kb_search；成功提交的那一刻，函数、向量、登记一起换过来。
-- 占位符：{table}=RULES_TABLE  {model_family}=新模型族（去掉 us. / global. 前缀）  {dim}=EMBED_DIM
--
-- 回退：restore_embeddings.sql。验收通过、确认不再回退后，手工删掉备份表 {table}_titan_backup（不删就不能再迁移）。
--
-- 规则表、归档表归应用用户：超级用户不在自己的身份下读写它们。动手之前两张表都过 kb_assert_plain_table（kb_search.sql 里建的）：
-- 表上挂着会执行代码的附加物（触发器、规则、行级安全、CHECK / 外键约束、表达式 / 部分索引、生成列等）就整段拒绝，一个向量都不算、
-- 一行都不改——换成属主身份挡不住它们（会话用户仍是超级用户，它们能 RESET ROLE 换回来）。没有附加物的表，先以表的属主身份
-- （SET LOCAL ROLE）把行读进临时表，超级用户只在临时表、备份表上算向量，再以属主身份写回。

-- 入库的锁：kb_search.sql 的第一句已经拿到（同一事务，可重入，这里再拿一次只是单独执行本文件时也不漏）。
-- 拿锁时还在入库的事务先提交，它写的行在下面一并重算；之后来的入库等迁移提交，再用新模型算向量
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('kb_ingest:{table}'));
SET LOCAL search_path = public, pg_temp;

DO $$
DECLARE
  t text;
  rel regclass;
BEGIN
  IF pg_catalog.to_regclass('public.{table}_titan_backup') IS NOT NULL THEN
    RAISE EXCEPTION 'migrate_embeddings：备份表 {table}_titan_backup 已存在（上一次换模型的备份）。确认不再回退后先删掉它（DROP TABLE {table}_titan_backup），再迁移';
  END IF;
  -- 两张表先都查过（并锁到提交）：后一张不合格时，前一张也还没去调 Bedrock
  FOREACH t IN ARRAY ARRAY['{table}', '{table}_archive'] LOOP
    rel := pg_catalog.to_regclass(pg_catalog.format('public.%I', t));
    IF rel IS NOT NULL THEN
      PERFORM public.kb_assert_plain_table(rel, 'migrate_embeddings'::text);
    END IF;
  END LOOP;
END
$$;

-- 备份：两张表的每一行（没有向量的也记，回退时它们照样重算）。只有超级用户能读
CREATE TABLE public.{table}_titan_backup (
  source_table text NOT NULL,          -- 所在表：{table} 或 {table}_archive
  rule_id      text NOT NULL,
  content_md5  text NOT NULL,          -- md5(content)：回退时 content 没变的行才拷回旧向量
  embedding    vector,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE public.{table}_titan_backup FROM PUBLIC;

-- 旧模型的缓存清掉（键里有模型 id，本来也不会再命中）；重算记在 via = migrate 名下，不占单条、批量的每分钟上限
DELETE FROM public.kb_embed_cache;

-- 中转（临时表，提交时删）：属主把读出的行写进 kb_mig_rows，超级用户算好的向量放在 kb_mig_vec
CREATE TEMP TABLE kb_mig_rows (rule_id text, content text, content_md5 text, embedding vector) ON COMMIT DROP;
CREATE TEMP TABLE kb_mig_vec (content text PRIMARY KEY, embedding vector) ON COMMIT DROP;

DO $$
DECLARE
  t text;
  rel regclass;
  owner name;
  texts text[];
  vs vector[];
  n int;
BEGIN
  FOREACH t IN ARRAY ARRAY['{table}', '{table}_archive'] LOOP
    rel := pg_catalog.to_regclass(pg_catalog.format('public.%I', t));
    CONTINUE WHEN rel IS NULL;
    owner := public.kb_assert_plain_table(rel, 'migrate_embeddings'::text);   -- 再查一次（表已锁住），取属主
    TRUNCATE pg_temp.kb_mig_rows, pg_temp.kb_mig_vec;
    EXECUTE pg_catalog.format('GRANT SELECT, INSERT ON pg_temp.kb_mig_rows TO %I', owner);
    EXECUTE pg_catalog.format('GRANT SELECT ON pg_temp.kb_mig_vec TO %I', owner);

    -- 1. 以属主读出这张表
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner);
    EXECUTE pg_catalog.format('INSERT INTO pg_temp.kb_mig_rows (rule_id, content, content_md5, embedding) '
                              'SELECT rule_id, content, pg_catalog.md5(content), embedding FROM ONLY public.%I', t);
    RESET ROLE;

    -- 2. 超级用户：备份；按 content 去重后一次算完（Cohere 每 96 条一个请求）
    INSERT INTO public.{table}_titan_backup (source_table, rule_id, content_md5, embedding)
      SELECT t, r.rule_id, r.content_md5, r.embedding FROM pg_temp.kb_mig_rows r;
    SELECT pg_catalog.array_agg(DISTINCT r.content) INTO texts FROM pg_temp.kb_mig_rows r;
    IF texts IS NOT NULL THEN
      vs := public.kb_embed_impl(texts, 'search_document'::text, 'migrate'::text, 100000);
      INSERT INTO pg_temp.kb_mig_vec (content, embedding)
        SELECT texts[i], vs[i] FROM pg_catalog.generate_subscripts(texts, 1) AS g(i);
    END IF;

    -- 3. 以属主写回：同一 content 的行（包括重复编号）向量相同
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner);
    EXECUTE pg_catalog.format('UPDATE ONLY public.%I r SET embedding = v.embedding FROM pg_temp.kb_mig_vec v WHERE r.content = v.content', t);
    GET DIAGNOSTICS n = ROW_COUNT;
    RESET ROLE;
    RAISE NOTICE 'migrate_embeddings：% 重算 % 行（{model_family}，{dim} 维）', t, n;
  END LOOP;
END
$$;

INSERT INTO public.kb_meta (key, value) VALUES
  ('embed_model', '{model_family}'),
  ('embed_dim', '{dim}'),
  ('switched_at', pg_catalog.to_char(pg_catalog.now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
