-- 回退换模型：拷回 migrate_embeddings.sql 备份的旧向量。拼在旧配置（Titan）的 kb_search.sql 后面，同样以 postgres 超级用户
-- 经 psql -X -v ON_ERROR_STOP=1 -1 在一个事务里执行（deploy.sh db --restore-embeddings）：失败就整段回滚，库里还是新模型。
--   - content 没变的行（rule_id 和 md5(content) 与备份一致；不论它现在在规则表还是归档表）拷回旧向量；
--   - 迁移之后新增的、改过 content 的、备份里没有向量的行，用当前（旧模型）的 kb_embed_impl 重算；
--   - 清空缓存，kb_meta 改回旧模型族。备份表留着，确认后手工删。
-- 规则表、归档表同 migrate_embeddings.sql：先过 kb_assert_plain_table（带着会执行代码的附加物就整段拒绝），再以表的属主身份读写。
-- 备份表以超级用户身份读：它得是迁移时超级用户建的那张——普通表、属主是超级用户、同样没有附加物；删掉备份表之后应用用户
-- 能建一张同名的表或视图，不认。
-- 占位符：{table}=RULES_TABLE  {model_family}=旧模型族（去掉 us. / global. 前缀）  {dim}=EMBED_DIM

-- 入库的锁：kb_search.sql 的第一句已经拿到（可重入），这里再拿一次只是单独执行本文件时也不漏
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('kb_ingest:{table}'));
SET LOCAL search_path = public, pg_temp;

DO $$
DECLARE
  backup regclass := pg_catalog.to_regclass('public.{table}_titan_backup');
  su boolean;
  t text;
  rel regclass;
BEGIN
  IF backup IS NULL THEN
    RAISE EXCEPTION 'restore_embeddings：没有备份表 {table}_titan_backup，无从回退（迁移时才会建它）';
  END IF;
  PERFORM public.kb_assert_plain_table(backup, 'restore_embeddings'::text);
  SELECT r.rolsuper INTO su FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles r ON r.oid = c.relowner WHERE c.oid = backup::oid;
  IF su IS NOT TRUE THEN
    RAISE EXCEPTION 'restore_embeddings：备份表 {table}_titan_backup 的属主不是超级用户（迁移时由超级用户建，可能被换过），不读它。先查明来历';
  END IF;
  -- 两张表先都查过（并锁到提交）：后一张不合格时，前一张也还没去调 Bedrock
  FOREACH t IN ARRAY ARRAY['{table}', '{table}_archive'] LOOP
    rel := pg_catalog.to_regclass(pg_catalog.format('public.%I', t));
    IF rel IS NOT NULL THEN
      PERFORM public.kb_assert_plain_table(rel, 'restore_embeddings'::text);
    END IF;
  END LOOP;
END
$$;

DELETE FROM public.kb_embed_cache;

-- 中转（临时表，提交时删）：kb_mig_old = 这张表能用的旧向量，kb_mig_rows = 属主读出的行，kb_mig_vec = 重算的向量
CREATE TEMP TABLE kb_mig_old (rule_id text, content_md5 text, embedding vector, PRIMARY KEY (rule_id, content_md5)) ON COMMIT DROP;
CREATE TEMP TABLE kb_mig_rows (rule_id text, content text, content_md5 text) ON COMMIT DROP;
CREATE TEMP TABLE kb_mig_vec (content text PRIMARY KEY, embedding vector) ON COMMIT DROP;

DO $$
DECLARE
  t text;
  rel regclass;
  owner name;
  texts text[];
  vs vector[];
  copied int;
  recomputed int;
BEGIN
  FOREACH t IN ARRAY ARRAY['{table}', '{table}_archive'] LOOP
    rel := pg_catalog.to_regclass(pg_catalog.format('public.%I', t));
    CONTINUE WHEN rel IS NULL;
    owner := public.kb_assert_plain_table(rel, 'restore_embeddings'::text);   -- 再查一次（表已锁住），取属主
    TRUNCATE pg_temp.kb_mig_old, pg_temp.kb_mig_rows, pg_temp.kb_mig_vec;
    EXECUTE pg_catalog.format('GRANT SELECT ON pg_temp.kb_mig_old, pg_temp.kb_mig_vec TO %I', owner);
    EXECUTE pg_catalog.format('GRANT SELECT, INSERT ON pg_temp.kb_mig_rows TO %I', owner);

    -- 1. 超级用户：这张表能用的旧向量（同一编号、同一 content 在备份里有两行时，优先取同一张表的）
    INSERT INTO pg_temp.kb_mig_old (rule_id, content_md5, embedding)
      SELECT DISTINCT ON (b.rule_id, b.content_md5) b.rule_id, b.content_md5, b.embedding
        FROM public.{table}_titan_backup b
       WHERE b.embedding IS NOT NULL
       ORDER BY b.rule_id, b.content_md5, (b.source_table = t) DESC;

    -- 2. 以属主读出这张表
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner);
    EXECUTE pg_catalog.format('INSERT INTO pg_temp.kb_mig_rows (rule_id, content, content_md5) '
                              'SELECT rule_id, content, pg_catalog.md5(content) FROM ONLY public.%I', t);
    RESET ROLE;

    -- 3. 超级用户：备份里对不上的 content 用旧模型重算（去重，一次算完）
    SELECT pg_catalog.array_agg(DISTINCT r.content) INTO texts
      FROM pg_temp.kb_mig_rows r
     WHERE NOT EXISTS (SELECT 1 FROM pg_temp.kb_mig_old o WHERE o.rule_id = r.rule_id AND o.content_md5 = r.content_md5);
    IF texts IS NOT NULL THEN
      vs := public.kb_embed_impl(texts, 'search_document'::text, 'migrate'::text, 100000);
      INSERT INTO pg_temp.kb_mig_vec (content, embedding)
        SELECT texts[i], vs[i] FROM pg_catalog.generate_subscripts(texts, 1) AS g(i);
    END IF;

    -- 4. 以属主写回：先写重算的，再拷回对得上的
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner);
    EXECUTE pg_catalog.format($sql$
      UPDATE ONLY public.%I r SET embedding = v.embedding
        FROM pg_temp.kb_mig_vec v
       WHERE r.content = v.content
         AND NOT EXISTS (SELECT 1 FROM pg_temp.kb_mig_old o WHERE o.rule_id = r.rule_id AND o.content_md5 = pg_catalog.md5(r.content))
    $sql$, t);
    GET DIAGNOSTICS recomputed = ROW_COUNT;
    EXECUTE pg_catalog.format($sql$
      UPDATE ONLY public.%I r SET embedding = o.embedding
        FROM pg_temp.kb_mig_old o
       WHERE o.rule_id = r.rule_id AND o.content_md5 = pg_catalog.md5(r.content)
    $sql$, t);
    GET DIAGNOSTICS copied = ROW_COUNT;
    RESET ROLE;
    RAISE NOTICE 'restore_embeddings：% 拷回旧向量 % 行，重算 % 行（{model_family}）', t, copied, recomputed;
  END LOOP;
END
$$;

INSERT INTO public.kb_meta (key, value) VALUES
  ('embed_model', '{model_family}'),
  ('embed_dim', '{dim}'),
  ('switched_at', pg_catalog.to_char(pg_catalog.now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
