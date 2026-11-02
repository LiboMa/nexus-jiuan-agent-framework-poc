-- 本机测试用的 kb_embed_impl（plpgsql，不调 Bedrock）：kb/tests/pg_harness.py 把 kb_search.sql 里
-- `-- >>> kb_embed_impl` 与 `-- <<< kb_embed_impl` 之间换成这一段，占位符照填（{model}、{dim}）。
--
--   向量 = 对「模型|用途|文本|k」（k = 0…31，{dim} 维每 32 维一段）做 sha256，每字节减去 127.5，再归一化：
--          同样的输入永远得到同样的向量，换模型、换用途就变（pg_harness.fake_vector 是它的 Python 版）。
--   每算一个向量在 kb_fake_embed_calls 里记一行（没有缓存：要几个就算几个、记几行）；只读事务里不记。
--   每分钟上限照真函数：同一 via 一分钟内记下的行数 + 这次要算的个数 > cap 就报同样的错；只读事务里 via 不是 single 就拒绝。
--   文本含 __FAIL__ 时照真函数的样子报「kb_embed：Bedrock 返回 500」，一个都不算。
--   和真函数一样以超级用户执行：内置函数写 pg_catalog. 前缀（应用用户能在 public 里建同名重载）。
CREATE TABLE IF NOT EXISTS kb_fake_embed_calls (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  model   text NOT NULL,
  purpose text NOT NULL,
  via     text NOT NULL,
  input   text NOT NULL
);

CREATE OR REPLACE FUNCTION kb_embed_impl(inputs text[], purpose text, via text, cap int) RETURNS vector({dim})[]
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  result vector[] := ARRAY[]::vector[];
  item text;
  n int := 0;
  total int;
  recent int;
  vals float8[];
BEGIN
  IF purpose IS NULL OR purpose NOT IN ('search_document', 'search_query') THEN
    RAISE EXCEPTION 'kb_embed：purpose 只能是 search_document 或 search_query';
  END IF;
  IF inputs IS NULL THEN
    RAISE EXCEPTION 'kb_embed：输入为空';
  END IF;
  total := pg_catalog.cardinality(inputs);
  FOREACH item IN ARRAY inputs LOOP
    n := n + 1;
    IF item IS NULL OR pg_catalog.btrim(item) = '' THEN
      RAISE EXCEPTION 'kb_embed：%输入为空', CASE WHEN total = 1 THEN '' ELSE pg_catalog.format('第 %s 条', n) END;
    END IF;
    IF pg_catalog.char_length(item) > 8000 THEN
      RAISE EXCEPTION 'kb_embed：%输入超过 8000 字', CASE WHEN total = 1 THEN '' ELSE pg_catalog.format('第 %s 条', n) END;
    END IF;
    IF pg_catalog.strpos(item, '__FAIL__') > 0 THEN
      RAISE EXCEPTION 'kb_embed：Bedrock 返回 500 {"message":"本机假函数：文本含 __FAIL__"}';
    END IF;
  END LOOP;
  IF total > 0 AND via <> 'single' AND pg_catalog.current_setting('transaction_read_only') = 'on' THEN
    RAISE EXCEPTION 'kb_embed：只读事务里不能生成新向量（这次要 % 个）；批量请在读写事务里调', total;
  END IF;
  SELECT pg_catalog.count(*) INTO recent FROM public.kb_fake_embed_calls c
   WHERE c.via = kb_embed_impl.via AND c.at > pg_catalog.clock_timestamp() - interval '1 minute';
  IF total > 0 AND recent + total > cap THEN
    RAISE EXCEPTION 'kb_embed：每分钟最多生成 % 个新向量（这一分钟已生成 % 个，这次还要 % 个），请一分钟后再试', cap, recent, total;
  END IF;
  FOREACH item IN ARRAY inputs LOOP
    SELECT pg_catalog.array_agg(pg_catalog.get_byte(h.b, j.j)::float8 - 127.5::float8 ORDER BY h.k, j.j) INTO vals
      FROM (SELECT k, pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.format('%s|%s|%s|%s', '{model}', purpose, item, k), 'UTF8')) AS b
              FROM pg_catalog.generate_series(0, ({dim} + 31) / 32 - 1) AS k) h
     CROSS JOIN pg_catalog.generate_series(0, 31) AS j(j);
    vals := vals[1:{dim}];
    result := pg_catalog.array_append(result, (SELECT pg_catalog.array_agg(u.x / s.norm ORDER BY u.o)
                                                 FROM pg_catalog.unnest(vals) WITH ORDINALITY AS u(x, o),
                                                      (SELECT pg_catalog.sqrt(pg_catalog.sum(y * y)) AS norm FROM pg_catalog.unnest(vals) AS y) s)::vector);
    BEGIN
      INSERT INTO public.kb_fake_embed_calls (model, purpose, via, input) VALUES ('{model}', purpose, kb_embed_impl.via, item);
    EXCEPTION WHEN read_only_sql_transaction THEN
      NULL;
    END;
  END LOOP;
  RETURN result;
END
$$;
