"""kb_search.sql 在真 PG（本机 PGlite + pgvector）上：打平规则、kb_embed / kb_embed_batch、kb_meta、权限、重复执行，
以及 migrate_embeddings.sql / restore_embeddings.sql。kb_embed_impl 换成 fake_kb_embed.sql（假向量，不调 Bedrock）。

    bash kb/tests/run_pglite.sh 55432        # 另一个终端
    KB_TEST_PG_PORT=55432 python3 -B -m unittest kb/tests/test_kb_search_pg.py -v

没设 KB_TEST_PG_PORT 时这些用例都是 skipped。
"""
import hashlib
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pg_harness as H  # noqa: E402

TABLE = "approval_rules"
SPLIT = r"[\s，。、；：,.;:？?！!（）()]+"   # 与 kb_search 里的切词相同
ISO_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
COHERE_FAMILY, TITAN_FAMILY = "cohere.embed-v4:0", "amazon.titan-embed-text-v2:0"


class PgCase(unittest.TestCase):
    schema = {}

    def setUp(self):
        self.conn = H.connect()
        self.addCleanup(self.conn.close)   # setUp 失败时 tearDown 不跑；PGlite 的连接数有限，必须关掉
        H.reset(self.conn, **self.schema)

    def q(self, sql, params=None):
        return self.conn.execute(sql, params).fetchall()

    def one(self, sql, params=None):
        return self.conn.execute(sql, params).fetchone()[0]

    def add(self, rule_id, rule_type, content, embedding=None, table=TABLE):
        """写一行；embedding 缺省 = kb_embed(content)（入库的用途），也可以直接给向量文本。"""
        if embedding is None:
            self.conn.execute(f"INSERT INTO {table} (rule_id, rule_type, content, embedding) VALUES (%s, %s, %s, kb_embed(%s))",
                              (rule_id, rule_type, content, content))
        else:
            self.conn.execute(f"INSERT INTO {table} (rule_id, rule_type, content, embedding) VALUES (%s, %s, %s, %s::vector)",
                              (rule_id, rule_type, content, embedding))

    def search(self, question, k=8):
        return self.q("SELECT rule_id, rule_type, keyword_hits, score FROM kb_search(%s, %s, NULL, 'test')", (question, k))

    def old_order(self, question, k=8):
        """旧排序的参考查询：ORDER BY 命中数 DESC, embedding <=> q（问题照旧用 search_query 的向量）。"""
        return [r[0] for r in self.q(f"""
            WITH q AS (SELECT kb_embed(%(q)s, 'search_query') AS v),
                 w AS (SELECT coalesce(array_agg(DISTINCT s.t), ARRAY[]::text[]) AS terms
                         FROM (SELECT t FROM regexp_split_to_table(%(q)s, %(split)s) AS t
                                WHERE char_length(t) BETWEEN 2 AND 20 LIMIT 8) s)
            SELECT r.rule_id FROM {TABLE} r, q, w
             WHERE r.embedding IS NOT NULL
             ORDER BY (SELECT count(*) FROM unnest(w.terms) AS t WHERE position(t in coalesce(r.content, '')) > 0) DESC,
                      r.embedding <=> q.v
             LIMIT %(k)s""", {"q": question, "split": SPLIT, "k": k})]

    def meta(self):
        return dict(self.q("SELECT key, value FROM kb_meta"))

    def app_role(self):
        """线上那样的应用用户：非超级用户，在 public 里有 USAGE、CREATE（harness 缺省把 {app_user} 填成 postgres）。"""
        self.conn.execute("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'kb_app') THEN CREATE ROLE kb_app NOLOGIN; END IF; END $$")
        self.conn.execute("GRANT USAGE, CREATE ON SCHEMA public TO kb_app")
        self.conn.commit()

    def as_app(self, sql):
        """以应用用户执行（建它自己的对象），再切回超级用户、提交。"""
        self.conn.execute("SET ROLE kb_app")
        try:
            self.conn.execute(sql)
        finally:
            self.conn.execute("RESET ROLE")
        self.conn.commit()

    # 应用用户写的「陷阱」：以超级用户身份执行时报 HIJACKED（以它自己的身份执行没事）
    TRAP = """
        CREATE FUNCTION public.kb_trap() RETURNS void LANGUAGE plpgsql AS $t$
        BEGIN
          IF (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
            RAISE EXCEPTION 'HIJACKED: 以 % 执行了应用用户的代码', current_user;
          END IF;
        END $t$;
    """

    def vectors(self, table=TABLE):
        return dict(self.q(f"SELECT rule_id, embedding::text FROM {table}"))


class KbSearchSqlFile(unittest.TestCase):
    """不连库：kb_search.sql / 迁移 / 回退的语句顺序。"""
    LOCK = "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('kb_ingest:{table}'))"

    @staticmethod
    def first_statement(name):
        text = (H.SQL_DIR / name).read_text(encoding="utf-8")
        body = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("--"))
        return body.strip().split(";")[0].strip()

    def test_ingest_lock_is_first_statement(self):
        # 后面的 DDL 拿 kb_embed_cache 等表的排他锁；先拿表锁再等入库锁，会和正在 kb_embed_batch 里的入库互相等死
        for name in ("kb_search.sql", "migrate_embeddings.sql", "restore_embeddings.sql"):
            self.assertEqual(self.first_statement(name), self.LOCK, name)
        # 与 kb_store 入库的锁同一个键：hashtext('kb_ingest:' || 表名)
        self.assertEqual(H.fill(self.LOCK), "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('kb_ingest:approval_rules'))")


class KbSearchRanking(PgCase):
    def test_tie_break_prefers_rules_over_clauses(self):
        question = "合同 用印"
        self.add("C03-1.2", "matrix", "第三章 合同管理 › 合同用印：合同 金额 30 万元以上 用印 由总经理审批",
                 embedding=self.one("SELECT kb_embed('与问题毫不相干的一段话')::text"))
        # 条款的 content 就是问句本身，向量就是问句的向量：语义距离 0
        self.add("demo-A12", "clause", question, embedding=self.one("SELECT kb_embed(%s, 'search_query')::text", (question,)))
        rows = self.search(question)
        self.assertEqual([r[0] for r in rows], ["C03-1.2", "demo-A12"])
        self.assertEqual([r[2] for r in rows], [2, 2])                  # 命中数相同
        self.assertEqual(float(rows[1][3]), 1.0)                        # 条款距离 0
        self.assertGreater(rows[1][3], rows[0][3])
        self.assertEqual(self.old_order(question)[0], "demo-A12")      # 旧排序会把条款排第一

    def test_more_hits_still_win(self):
        question = "合同 用印 审批"
        self.add("C03-1.2", "matrix", "合同 用印", embedding=self.one("SELECT kb_embed(%s, 'search_query')::text", (question,)))
        self.add("demo-A12", "clause", "合同 用印 审批 的正文条款")
        rows = self.search(question)
        self.assertEqual([(r[0], r[2]) for r in rows], [("demo-A12", 3), ("C03-1.2", 2)])

    def test_no_clauses_same_order_as_before(self):
        rows = [("C01-1.1", "matrix", "费用报销 金额 5 万元以下 部门负责人审批"),
                ("C01-1.2", "matrix", "费用报销 金额 5 万元以上 分管领导审批"),
                ("C02-2.1", "matrix", "差旅 出差 报销 标准"),
                ("C03-1.2", "matrix", "合同 用印 30 万元以上 总经理审批"),
                ("C03-1.3", "matrix", "合同 变更 审批"),
                ("C03-NOTE", "chapter_note", "本章说明：合同金额含税"),
                ("C05-3.4", "matrix", "房租 年度框架合同"),
                ("G-01", "general", "图例：审 = 审核，批 = 审批"),
                ("G-02", "general", "制度说明：金额档按含税金额"),
                ("C06-1.1", "matrix", "固定资产 采购 报销")]
        for rid, rtype, content in rows:
            self.add(rid, rtype, content)
        for question in ("报销 审批", "合同 金额 审批", "房租", "一个没有关键词能命中的问题"):
            for k in (3, 8):
                got = [r[0] for r in self.search(question, k)]
                self.assertEqual(got, self.old_order(question, k), question)
                self.assertEqual(len(got), k)


class KbEmbed(PgCase):
    def test_batch_equals_single(self):
        a, b = "合同用印的规则", "差旅报销的规则"
        batch = self.one("SELECT kb_embed_batch(%s::text[], 'search_document')::text[]", ([a, b],))
        self.assertEqual(len(batch), 2)
        self.assertTrue(self.one("SELECT (kb_embed_batch(ARRAY[%s, %s]))[1] = kb_embed(%s)", (a, b, a)))
        self.assertTrue(H.same_vector(batch[0], self.one("SELECT kb_embed(%s)::text", (a,))))
        self.assertTrue(H.same_vector(batch[1], self.one("SELECT kb_embed(%s, 'search_document')::text", (b,))))
        self.assertTrue(H.same_vector(batch[0], H.fake_vector(H.COHERE, "search_document", a)))
        q = self.one("SELECT (kb_embed_batch(ARRAY[%s], 'search_query'))[1]::text", (a,))
        self.assertTrue(H.same_vector(q, self.one("SELECT kb_embed(%s, 'search_query')::text", (a,))))
        self.assertFalse(H.same_vector(q, batch[0]))                   # 用途不同，向量不同
        self.assertEqual(self.one("SELECT kb_embed_batch(ARRAY[]::text[])::text[]"), [])
        calls = self.q("SELECT via, purpose, count(*) FROM kb_fake_embed_calls GROUP BY 1, 2 ORDER BY 1, 2")
        self.assertEqual(calls, [("batch", "search_document", 4), ("batch", "search_query", 1),
                                 ("single", "search_document", 3), ("single", "search_query", 1)])
        with self.assertRaisesRegex(Exception, "至多 2000 条"):
            self.one("SELECT kb_embed_batch(array_fill('x'::text, ARRAY[2001]))")

    def test_fail_marker_raises_like_bedrock(self):
        self.conn.commit()
        with self.assertRaisesRegex(Exception, "kb_embed：Bedrock 返回 500"):
            self.one("SELECT kb_embed_batch(ARRAY['好的一条', '坏的 __FAIL__ 一条'])")
        self.conn.rollback()
        self.assertEqual(self.one("SELECT count(*) FROM kb_fake_embed_calls"), 0)
        with self.assertRaisesRegex(Exception, "kb_embed：Bedrock 返回 500"):
            self.one("SELECT kb_embed('__FAIL__')")

    def test_caps_counted_per_via(self):
        # 批量这一分钟已用满 2000：批量报上限，单条照样能调
        self.conn.execute("INSERT INTO kb_fake_embed_calls (model, purpose, via, input) "
                          "SELECT 'm', 'search_document', 'batch', 'x' FROM generate_series(1, 2000)")
        self.conn.commit()
        with self.assertRaisesRegex(Exception, "每分钟最多生成 2000 个新向量"):
            self.one("SELECT kb_embed_batch(ARRAY['新的一条'])")
        self.conn.rollback()
        self.assertIsNotNone(self.one("SELECT kb_embed('新的问题', 'search_query')"))

    def test_read_only_refuses_new_batch_vectors(self):
        # 上限按记下的行数，只读事务里记不下：批量在只读事务里不许生成新向量；单条和检索照常（连接器可能是只读的）
        self.add("C03-1.2", "matrix", "合同 用印")
        self.conn.commit()
        self.conn.execute("SET TRANSACTION READ ONLY")
        with self.assertRaisesRegex(Exception, "只读事务里不能生成新向量"):
            self.one("SELECT kb_embed_batch(%s::text[])", ([f"新的第 {i} 条" for i in range(2000)],))
        self.conn.rollback()
        self.conn.execute("SET TRANSACTION READ ONLY")
        self.assertIsNotNone(self.one("SELECT kb_embed('新的问题', 'search_query')"))
        self.assertEqual([r[0] for r in self.search("合同 用印")], ["C03-1.2"])
        self.conn.rollback()


class KbSchema(PgCase):
    def test_kb_meta_only_on_fresh_db(self):
        meta = self.meta()
        self.assertEqual({k: meta[k] for k in ("embed_model", "embed_dim")}, {"embed_model": COHERE_FAMILY, "embed_dim": "1024"})
        self.assertRegex(meta["switched_at"], ISO_UTC)
        # 已登记的不改
        self.conn.execute("UPDATE kb_meta SET value = 'x' WHERE key = 'embed_model'")
        H.run_script(self.conn, H.kb_search_sql())
        self.assertEqual(self.meta()["embed_model"], "x")
        # 没登记、表里已有向量（老库）：不登记
        self.conn.execute("DELETE FROM kb_meta")
        self.add("C01-1.1", "matrix", "费用报销")
        self.conn.commit()
        H.run_script(self.conn, H.kb_search_sql())
        self.assertEqual(self.meta(), {})
        # 规则表空、归档表里有向量：也不登记
        self.conn.execute(f"CREATE TABLE {TABLE}_archive (LIKE {TABLE} INCLUDING DEFAULTS)")
        self.conn.execute(f"INSERT INTO {TABLE}_archive SELECT * FROM {TABLE}")
        self.conn.execute(f"DELETE FROM {TABLE}")
        self.conn.commit()
        H.run_script(self.conn, H.kb_search_sql())
        self.assertEqual(self.meta(), {})
        # 规则表还不存在的新库：登记（Titan 配置就登记 Titan 的模型族）
        H.run_script(self.conn, "DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION vector;")
        H.run_script(self.conn, H.kb_search_sql(model=H.TITAN))
        self.assertEqual(self.meta()["embed_model"], TITAN_FAMILY)

    def test_reapply_is_idempotent_and_upgrades_old_schema(self):
        # 老版本的样子：缓存表没有 via 列、键只是文本的 sha256；单参数的 kb_embed(text)
        H.run_script(self.conn, "DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION vector;\n"
                     + H.fill((H.SQL_DIR / "approval_rules.sql").read_text(encoding="utf-8")) + """
            CREATE TABLE kb_embed_cache (sha256 text PRIMARY KEY, embedding vector(1024) NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
            CREATE INDEX kb_embed_cache_created_idx ON kb_embed_cache (created_at);
            INSERT INTO kb_embed_cache (sha256, embedding) SELECT encode(sha256('老问题'::bytea), 'hex'), array_fill(0.5, ARRAY[1024])::vector;
            CREATE FUNCTION kb_embed(input text) RETURNS vector(1024) LANGUAGE sql AS $$ SELECT array_fill(0.5, ARRAY[1024])::vector $$;
        """)
        H.run_script(self.conn, H.kb_search_sql())
        H.run_script(self.conn, H.kb_search_sql())                     # 每次 db 阶段都会再执行一遍
        signatures = sorted(r[0] for r in self.q(
            "SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
            "WHERE n.nspname = 'public' AND p.proname LIKE 'kb\\_%'"))
        self.assertEqual(signatures, ["kb_assert_plain_table(regclass,text)", "kb_embed(text,text)", "kb_embed_batch(text[],text)",
                                      "kb_embed_impl(text[],text,text,integer)", "kb_log_search(text,text,integer,text,jsonb,integer)",
                                      "kb_search(text,integer,text,text)"])
        self.assertEqual(self.one("SELECT count(*) FROM kb_embed_cache"), 0)   # 旧键的缓存不会再命中，清掉
        self.assertEqual(self.one("SELECT column_default FROM information_schema.columns "
                                  "WHERE table_name = 'kb_embed_cache' AND column_name = 'via'"), "'single'::text")
        # 原有调用方的写法（ingest_rules.py --embed sql）照样能用：缺省用途 search_document
        one_arg = self.one("SELECT kb_embed(%s)::text", ("合同用印",))
        self.assertTrue(H.same_vector(one_arg, H.fake_vector(H.COHERE, "search_document", "合同用印")))
        self.add("C03-1.2", "matrix", "合同 用印")
        self.assertEqual([r[0] for r in self.search("合同 用印")], ["C03-1.2"])

    def test_app_user_privileges(self):
        # 应用用户另建一个角色（harness 缺省把 {app_user} 填成 postgres，看不出授权）：照线上那样拥有规则表
        self.conn.execute("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'kb_app') THEN CREATE ROLE kb_app NOLOGIN; END IF; END $$")
        self.conn.execute("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'kb_other') THEN CREATE ROLE kb_other NOLOGIN; END IF; END $$")
        self.conn.commit()
        H.run_script(self.conn, H.kb_search_sql(app_user="kb_app"))
        self.conn.execute(f"ALTER TABLE {TABLE} OWNER TO kb_app")
        self.add("C03-1.2", "matrix", "合同 用印")
        self.conn.execute("GRANT USAGE ON SCHEMA public TO kb_other")
        self.conn.commit()
        self.conn.autocommit = True

        def as_role(role, sql):
            with self.conn.transaction():
                self.conn.execute(f"SET LOCAL ROLE {role}")
                return self.conn.execute(sql).fetchall()

        self.assertEqual(len(as_role("kb_app", "SELECT kb_embed('报销')::text")), 1)
        self.assertEqual(len(as_role("kb_app", "SELECT kb_embed_batch(ARRAY['甲', '乙'])::text[]")[0][0]), 2)
        self.assertEqual(as_role("kb_app", "SELECT rule_id FROM kb_search('合同 用印', 3, NULL, 'test')"), [("C03-1.2",)])
        self.assertEqual(dict(as_role("kb_app", "SELECT key, value FROM kb_meta"))["embed_model"], COHERE_FAMILY)
        for role, sql in (("kb_app", "SELECT kb_embed_impl(ARRAY['甲'], 'search_document', 'single', 100000)"),
                          ("kb_app", f"SELECT kb_assert_plain_table('{TABLE}'::regclass, 'x')"),
                          ("kb_other", f"SELECT kb_assert_plain_table('{TABLE}'::regclass, 'x')"),
                          ("kb_app", "UPDATE kb_meta SET value = 'x'"),
                          ("kb_app", "INSERT INTO kb_meta VALUES ('k', 'v')"),
                          ("kb_app", "SELECT count(*) FROM kb_embed_cache"),
                          ("kb_app", "INSERT INTO kb_search_log (caller) VALUES ('forged')"),
                          ("kb_other", "SELECT kb_embed('报销')"),
                          ("kb_other", "SELECT kb_embed_batch(ARRAY['甲'])"),
                          ("kb_other", "SELECT kb_embed_impl(ARRAY['甲'], 'search_document', 'single', 100000)"),
                          ("kb_other", "SELECT count(*) FROM kb_meta")):
            with self.subTest(role=role, sql=sql), self.assertRaisesRegex(Exception, "permission denied"):
                as_role(role, sql)


    def test_view_swapped_for_rules_table_is_not_read(self):
        # 规则表归应用用户：它把表换成视图（列里调它自己的函数），kb_search.sql 不读它，更不以超级用户执行那个函数
        self.app_role()
        self.conn.execute(f"ALTER TABLE {TABLE} OWNER TO kb_app")
        self.conn.execute("DELETE FROM kb_meta")         # 没登记：kb_search.sql 要看规则表里有没有向量
        self.conn.commit()
        self.as_app(self.TRAP + f"""
            CREATE FUNCTION public.kb_probe_vector() RETURNS vector LANGUAGE plpgsql AS $t$
            BEGIN PERFORM public.kb_trap(); RETURN NULL; END $t$;
            DROP TABLE {TABLE};
            CREATE VIEW {TABLE} AS SELECT 'x'::text AS rule_id, 'matrix'::text AS rule_type, 'x'::text AS content,
                                          public.kb_probe_vector() AS embedding;
        """)
        with self.assertRaisesRegex(Exception, f"{TABLE} 不是普通表") as caught:
            H.run_script(self.conn, H.kb_search_sql())
        self.assertNotIn("HIJACKED", str(caught.exception))
        self.assertEqual(self.meta(), {})

    def test_preexisting_objects_not_adopted(self):
        # 应用用户抢先建的 kb_meta / kb_embed_impl、带触发器的 kb_meta：不接手，整段不执行
        cases = {
            "app-owned kb_meta": ("kb_meta", "DROP TABLE kb_meta", "CREATE TABLE public.kb_meta (key text PRIMARY KEY, value text NOT NULL)"),
            "trigger on kb_meta": ("kb_meta", """
                CREATE FUNCTION public.kb_meta_trg() RETURNS trigger LANGUAGE plpgsql AS $t$ BEGIN RETURN NEW; END $t$;
                CREATE TRIGGER kb_meta_trg BEFORE INSERT ON kb_meta FOR EACH ROW EXECUTE FUNCTION public.kb_meta_trg()""", None),
            "app-owned kb_embed_impl": ("kb_embed_impl", "DROP FUNCTION kb_embed_impl(text[], text, text, int)",
                                        "CREATE FUNCTION public.kb_embed_impl(inputs text[], purpose text, via text, cap int) "
                                        "RETURNS vector[] LANGUAGE sql AS 'SELECT NULL::vector[]'"),
            # 超级用户的脚本调它检查规则表：换成应用用户的（什么都放行），检查就形同虚设
            "app-owned kb_assert_plain_table": ("kb_assert_plain_table", "DROP FUNCTION kb_assert_plain_table(regclass, text)",
                                                "CREATE FUNCTION public.kb_assert_plain_table(rel regclass, caller text) "
                                                "RETURNS name LANGUAGE sql AS 'SELECT NULL::name'"),
        }
        for label, (name, as_superuser, as_app) in cases.items():
            with self.subTest(label):
                H.reset(self.conn)
                self.app_role()
                self.conn.execute(as_superuser)
                self.conn.commit()
                if as_app:
                    self.as_app(as_app)
                with self.assertRaisesRegex(Exception, f"{name}.*不接手"):
                    H.run_script(self.conn, H.kb_search_sql())

    def test_user_schema_named_after_superuser_ignored(self):
        # 线上库的属主是应用用户，它能建一个叫 postgres 的模式：超级用户的 "$user" 排在 public 前面，DDL 会落到它那里
        self.app_role()
        self.addCleanup(self._drop_postgres_schema)
        self.conn.execute("CREATE SCHEMA postgres AUTHORIZATION kb_app")
        self.conn.execute("DELETE FROM kb_meta")
        self.conn.commit()
        self.as_app("CREATE TABLE postgres.kb_meta (key text PRIMARY KEY, value text NOT NULL)")
        # PGlite 的缺省 search_path 是 public；照 PostgreSQL 的缺省（线上 psql -U postgres 就是这样）。LOCAL：只在这个事务里
        self.conn.execute('SET LOCAL search_path = "$user", public')
        self.assertEqual(self.one("SELECT current_schemas(false)"), ["postgres", "public"])
        H.run_script(self.conn, H.kb_search_sql())
        self.assertEqual(self.one("SELECT value FROM public.kb_meta WHERE key = 'embed_model'"), COHERE_FAMILY)
        self.assertEqual(self.one("SELECT pg_get_userbyid(relowner)::text FROM pg_class WHERE oid = 'postgres.kb_meta'::regclass"), "kb_app")
        self.assertEqual(self.one("SELECT count(*) FROM postgres.kb_meta"), 0)

    def _drop_postgres_schema(self):
        self.conn.rollback()
        self.conn.execute("DROP SCHEMA IF EXISTS postgres CASCADE")
        self.conn.commit()

    def test_builtin_overloads_not_run_as_superuser(self):
        # 应用用户在 public 里建比内置函数更「对口」的重载（多态函数、要隐式转换的操作符）：超级用户执行的代码一个都不能调到
        self.app_role()
        H.run_script(self.conn, H.kb_search_sql(app_user="kb_app"))   # 照线上：包装函数授予应用用户
        self.conn.execute(f"ALTER TABLE {TABLE} OWNER TO kb_app")
        self.conn.execute(f"CREATE TABLE {TABLE}_archive (LIKE {TABLE} INCLUDING DEFAULTS)")
        self.conn.execute(f"ALTER TABLE {TABLE}_archive OWNER TO kb_app")
        self.add("C03-1.2", "matrix", "合同 用印")
        self.add("demo-A12", "clause", "下线的一条", table=f"{TABLE}_archive")
        self.conn.execute("DELETE FROM kb_meta")
        self.conn.commit()
        self.as_app(self.TRAP + """
            CREATE FUNCTION public.cardinality(text[]) RETURNS int LANGUAGE plpgsql AS $t$ BEGIN PERFORM public.kb_trap(); RETURN pg_catalog.cardinality($1); END $t$;
            CREATE FUNCTION public.array_ndims(text[]) RETURNS int LANGUAGE plpgsql AS $t$ BEGIN PERFORM public.kb_trap(); RETURN pg_catalog.array_ndims($1); END $t$;
            CREATE FUNCTION public.unnest(text[]) RETURNS SETOF text LANGUAGE plpgsql AS $t$ BEGIN PERFORM public.kb_trap(); RETURN QUERY SELECT pg_catalog.unnest($1); END $t$;
            CREATE FUNCTION public.generate_subscripts(text[], int) RETURNS SETOF int LANGUAGE plpgsql AS $t$ BEGIN PERFORM public.kb_trap(); RETURN QUERY SELECT pg_catalog.generate_subscripts($1, $2); END $t$;
            CREATE FUNCTION public.format(text, text) RETURNS text LANGUAGE plpgsql AS $t$ BEGIN PERFORM public.kb_trap(); RETURN pg_catalog.format($1, $2); END $t$;
            CREATE FUNCTION public.format(text, name) RETURNS text LANGUAGE plpgsql AS $t$ BEGIN PERFORM public.kb_trap(); RETURN pg_catalog.format($1, $2); END $t$;
            CREATE FUNCTION public.kb_trap_sfunc(text[], text) RETURNS text[] LANGUAGE plpgsql AS $t$ BEGIN PERFORM public.kb_trap(); RETURN pg_catalog.array_append($1, $2); END $t$;
            CREATE AGGREGATE public.array_agg(text) (sfunc = public.kb_trap_sfunc, stype = text[]);
            CREATE FUNCTION public.kb_trap_eq(oid, regclass) RETURNS boolean LANGUAGE plpgsql AS $t$ BEGIN PERFORM public.kb_trap(); RETURN $1 OPERATOR(pg_catalog.=) $2::oid; END $t$;
            CREATE OPERATOR public.= (leftarg = oid, rightarg = regclass, function = public.kb_trap_eq);
        """)
        # 陷阱本身是通的：超级用户直接调就报
        with self.assertRaisesRegex(Exception, "HIJACKED"):
            self.one("SELECT cardinality(ARRAY['x'])")
        self.conn.rollback()
        # 应用用户调两个 SECURITY DEFINER 包装
        self.conn.execute("SET ROLE kb_app")
        self.assertEqual(len(self.one("SELECT kb_embed_batch(ARRAY['甲', '乙'])::text[]")), 2)
        self.assertIsNotNone(self.one("SELECT kb_embed('报销')"))
        self.conn.execute("RESET ROLE")
        self.conn.commit()
        # 超级用户：db 阶段重新执行、换模型、回退
        H.run_script(self.conn, H.kb_search_sql())
        H.run_script(self.conn, H.migrate_sql(model=H.TITAN))
        H.run_script(self.conn, H.restore_sql(model=H.COHERE))
        self.assertEqual(self.meta()["embed_model"], COHERE_FAMILY)


class Migration(PgCase):
    schema = {"model": H.TITAN}

    def setUp(self):
        super().setUp()
        self.seed()

    def seed(self):
        self.conn.execute("DELETE FROM kb_meta")       # 线上的 Titan 老库没有 kb_meta
        self.conn.execute(f"CREATE TABLE {TABLE}_archive (LIKE {TABLE} INCLUDING DEFAULTS)")
        self.conn.execute(f"ALTER TABLE {TABLE}_archive ADD COLUMN archived_at timestamptz")
        self.add("C01-1.1", "matrix", "费用报销 5 万元以下")
        self.add("C01-1.2", "matrix", "费用报销 5 万元以上")
        # 这一行的旧向量不是假函数算的（例如当年经 --embed bedrock 入库）：回退时必须原样拷回
        self.foreign = self.one("SELECT kb_embed('当年另一条路算的向量')::text")
        self.add("C03-1.2", "matrix", "合同 用印", embedding=self.foreign)
        self.add("demo-A12", "clause", "下线制度里的一条", table=f"{TABLE}_archive")
        self.conn.execute("INSERT INTO kb_embed_cache (sha256, embedding) SELECT 'stale', array_fill(0.5, ARRAY[1024])::vector")
        self.conn.commit()
        self.titan = {**self.vectors(), **self.vectors(f"{TABLE}_archive")}

    def all_rows(self):
        return self.q(f"SELECT '{TABLE}', rule_id, content, embedding::text FROM {TABLE} UNION ALL "
                      f"SELECT '{TABLE}_archive', rule_id, content, embedding::text FROM {TABLE}_archive ORDER BY 1, 2")

    def test_migrate_then_restore(self):
        H.run_script(self.conn, H.migrate_sql(model=H.COHERE))
        rows = self.all_rows()
        self.assertEqual(len(rows), 4)
        for table, rid, content, emb in rows:
            self.assertTrue(H.same_vector(emb, H.fake_vector(H.COHERE, "search_document", content)), (table, rid))
        backup = self.q(f"SELECT source_table, rule_id, content_md5, embedding::text FROM {TABLE}_titan_backup ORDER BY 1, 2")
        self.assertEqual([(t, r, m) for t, r, m, _ in backup],
                         [(t, r, hashlib.md5(c.encode("utf-8")).hexdigest()) for t, r, c, _ in rows])
        for _, rid, _, emb in backup:
            self.assertTrue(H.same_vector(emb, self.titan[rid]), rid)
        meta = self.meta()
        self.assertEqual((meta["embed_model"], meta["embed_dim"]), (COHERE_FAMILY, "1024"))
        self.assertRegex(meta["switched_at"], ISO_UTC)
        self.assertEqual(self.one("SELECT count(*) FROM kb_embed_cache"), 0)
        # 问题也换成了 Cohere 的 search_query 向量
        self.assertTrue(H.same_vector(self.one("SELECT kb_embed('报销', 'search_query')::text"),
                                      H.fake_vector(H.COHERE, "search_query", "报销")))

        # 迁移之后：新增一行、改一行 content
        self.add("C01-1.3", "matrix", "费用报销 50 万元以上")
        self.conn.execute(f"UPDATE {TABLE} SET content = '费用报销 5 万元以上（改）', embedding = kb_embed('费用报销 5 万元以上（改）') "
                          "WHERE rule_id = 'C01-1.2'")
        self.conn.execute("INSERT INTO kb_embed_cache (sha256, embedding) SELECT 'stale-cohere', array_fill(0.5, ARRAY[1024])::vector")
        self.conn.commit()
        before = self.one("SELECT coalesce(max(id), 0) FROM kb_fake_embed_calls")
        H.run_script(self.conn, H.restore_sql(model=H.TITAN))
        now = {**self.vectors(), **self.vectors(f"{TABLE}_archive")}
        for rid in ("C01-1.1", "C03-1.2", "demo-A12"):                    # 没改的：拷回旧向量
            self.assertTrue(H.same_vector(now[rid], self.titan[rid]), rid)
        self.assertTrue(H.same_vector(now["C03-1.2"], self.foreign))
        for rid, content in (("C01-1.2", "费用报销 5 万元以上（改）"), ("C01-1.3", "费用报销 50 万元以上")):   # 改过的、新增的：按 Titan 重算
            self.assertTrue(H.same_vector(now[rid], H.fake_vector(H.TITAN, "search_document", content)), rid)
        recomputed = self.q("SELECT model, purpose, via, input FROM kb_fake_embed_calls WHERE id > %s", (before,))
        self.assertCountEqual(recomputed, [(H.TITAN, "search_document", "migrate", "费用报销 50 万元以上"),
                                           (H.TITAN, "search_document", "migrate", "费用报销 5 万元以上（改）")])
        meta = self.meta()
        self.assertEqual((meta["embed_model"], meta["embed_dim"]), (TITAN_FAMILY, "1024"))
        self.assertRegex(meta["switched_at"], ISO_UTC)
        self.assertEqual(self.one("SELECT count(*) FROM kb_embed_cache"), 0)
        self.assertTrue(H.same_vector(self.one("SELECT kb_embed('报销', 'search_query')::text"),
                                      H.fake_vector(H.TITAN, "search_query", "报销")))

    def test_migrate_refuses_existing_backup(self):
        self.conn.execute(f"CREATE TABLE {TABLE}_titan_backup (x int)")
        self.conn.commit()
        rows = self.all_rows()
        with self.assertRaisesRegex(Exception, f"{TABLE}_titan_backup 已存在"):
            H.run_script(self.conn, H.migrate_sql(model=H.COHERE))
        # 一个事务：什么都没变，连前面的 kb_search.sql 也没生效（kb_embed 还是 Titan）
        self.assertEqual(self.all_rows(), rows)
        self.assertEqual(self.meta(), {})
        self.assertEqual(self.one("SELECT count(*) FROM kb_embed_cache"), 1)
        self.assertTrue(H.same_vector(self.one("SELECT kb_embed('报销')::text"), H.fake_vector(H.TITAN, "search_document", "报销")))

    def test_restore_needs_backup(self):
        with self.assertRaisesRegex(Exception, "没有备份表"):
            H.run_script(self.conn, H.restore_sql(model=H.TITAN))

    # ── 应用用户挂在表上、会执行代码的东西（F1）：SET LOCAL ROLE 成属主挡不住——会话用户是超级用户，那段代码能 RESET ROLE
    #    换回超级用户。迁移、回退、kb_search.sql 的 kb_meta 登记都要在执行它之前就整段拒绝 ──

    # 挂上去的代码都调 kb_armed()：脚本执行期间（脚本前加 SET LOCAL kb.armed = on）只要被执行一次就报 HIJACKED；
    # 挂上去时应用用户自己执行（校验约束、建索引、算生成列）不报
    ARMED = """
        CREATE FUNCTION public.kb_armed() RETURNS void LANGUAGE plpgsql AS $t$
        BEGIN
          IF pg_catalog.current_setting('kb.armed', true) = 'on' THEN
            RAISE EXCEPTION 'HIJACKED: 执行了应用用户挂在表上的代码（current_user = %）', current_user;
          END IF;
        END $t$;
        CREATE FUNCTION public.kb_ok(text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $t$ BEGIN PERFORM public.kb_armed(); RETURN true; END $t$;
        CREATE FUNCTION public.kb_imm(text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $t$ BEGIN PERFORM public.kb_armed(); RETURN upper($1); END $t$;
    """
    # 名字 → (拒绝时报出的那一项, 以应用用户执行的 SQL；{t} = 表名)
    ATTACHMENTS = {
        "trigger": ("触发器 kb_trg", """
            CREATE FUNCTION public.kb_trg() RETURNS trigger LANGUAGE plpgsql AS $t$ BEGIN PERFORM public.kb_armed(); RETURN NEW; END $t$;
            CREATE TRIGGER kb_trg BEFORE UPDATE ON {t} FOR EACH ROW EXECUTE FUNCTION public.kb_trg()"""),
        "rule": ("规则 kb_rule", "CREATE RULE kb_rule AS ON UPDATE TO {t} DO ALSO SELECT public.kb_armed()"),
        "row level security": ("行级安全（RLS）", """
            CREATE FUNCTION public.kb_pol() RETURNS boolean LANGUAGE plpgsql AS $t$ BEGIN PERFORM public.kb_armed(); RETURN true; END $t$;
            ALTER TABLE {t} ENABLE ROW LEVEL SECURITY;
            ALTER TABLE {t} FORCE ROW LEVEL SECURITY;
            CREATE POLICY kb_pol ON {t} USING (public.kb_pol())"""),
        "check constraint": ("CHECK 约束 kb_chk", "ALTER TABLE {t} ADD CONSTRAINT kb_chk CHECK (public.kb_ok(content))"),
        "foreign key": ("外键 kb_fk", """
            CREATE TABLE public.kb_ref (rule_id text PRIMARY KEY);
            INSERT INTO public.kb_ref SELECT rule_id FROM {t};
            ALTER TABLE {t} ADD CONSTRAINT kb_fk FOREIGN KEY (rule_id) REFERENCES public.kb_ref"""),
        "referenced by a foreign key": ("外键 kb_child_rule_id_fkey（public.kb_child 引用它）",
                                        "CREATE TABLE public.kb_child (rule_id text REFERENCES {t})"),
        "expression index": ("表达式索引 public.kb_expr", "CREATE INDEX kb_expr ON {t} (public.kb_imm(content))"),
        "partial index": ("部分索引 public.kb_part", "CREATE INDEX kb_part ON {t} (rule_id) WHERE public.kb_ok(content)"),
        "generated column": ("生成列 kb_gen", "ALTER TABLE {t} ADD COLUMN kb_gen text GENERATED ALWAYS AS (public.kb_imm(content)) STORED"),
        "domain column": ("列 kb_d 的类型 public.kb_dom（域 / 复合 / 范围类型）", """
            CREATE DOMAIN public.kb_dom AS text CHECK (public.kb_ok(VALUE));
            ALTER TABLE {t} ADD COLUMN kb_d public.kb_dom"""),
        "default calling an app function": ("列 kb_def 的默认值引用了 function public.kb_default()", """
            CREATE FUNCTION public.kb_default() RETURNS text LANGUAGE plpgsql AS $t$ BEGIN PERFORM public.kb_armed(); RETURN 'x'; END $t$;
            ALTER TABLE {t} ADD COLUMN kb_def text DEFAULT public.kb_default()"""),
        "partition": ("分区（分区约束里有分区键的表达式）", """
            CREATE TABLE public.kb_parent (LIKE {t}) PARTITION BY LIST ((public.kb_imm(rule_type)));
            ALTER TABLE public.kb_parent ATTACH PARTITION {t} FOR VALUES IN ('MATRIX', 'CLAUSE')"""),
    }

    def own(self, kb_meta=True):
        """照线上：两张表归应用用户（非超级用户），它建好 ARMED 里的函数。kb_meta=True：照 Titan 登记过（kb_search.sql 不再读
        规则表，拒绝的是迁移 / 回退自己的检查）。"""
        self.app_role()
        for table in (TABLE, f"{TABLE}_archive"):
            self.conn.execute(f"ALTER TABLE {table} OWNER TO kb_app")
        if kb_meta:
            self.conn.execute("INSERT INTO kb_meta (key, value) VALUES ('embed_model', %s), ('embed_dim', '1024'), "
                              "('switched_at', '2026-10-01T00:00:00Z')", (TITAN_FAMILY,))
        self.conn.commit()
        self.as_app(self.ARMED)

    def armed(self, sql):
        """照 deploy.sh：一个事务执行整段；这个事务里应用用户挂在表上的代码一执行就报 HIJACKED。"""
        H.run_script(self.conn, "SET LOCAL kb.armed = 'on';\n" + sql)

    def snapshot(self):
        has_backup = self.one("SELECT to_regclass(%s) IS NOT NULL", (f"public.{TABLE}_titan_backup",))
        return {"rows": self.all_rows(), "meta": self.meta(), "cache": self.one("SELECT count(*) FROM kb_embed_cache"),
                "kb_embed": self.one("SELECT kb_embed('报销')::text"),
                "backup": self.q(f"SELECT source_table, rule_id, content_md5, embedding::text FROM {TABLE}_titan_backup ORDER BY 1, 2")
                if has_backup else None}

    def refused(self, sql, message):
        """整段被拒绝、报的是 message（正则），挂上去的代码一次没执行（没有 HIJACKED），库里什么都没变。"""
        before = self.snapshot()
        self.conn.rollback()   # 快照里的 kb_embed 会写缓存：撤掉，脚本照 psql -1 在自己的事务里执行
        with self.assertRaisesRegex(Exception, message) as caught:
            self.armed(sql)
        self.assertNotIn("HIJACKED", str(caught.exception))
        self.assertEqual(self.snapshot(), before)

    def fresh(self):
        H.reset(self.conn, **self.schema)
        self.seed()

    def test_attached_code_is_live(self):
        # 对照：这些东西确实会在属主身份的 UPDATE 里执行（迁移、回退写回向量就是这句），所以光 SET LOCAL ROLE 不够
        for label in ("trigger", "row level security", "check constraint"):
            with self.subTest(label):
                self.fresh()
                self.own()
                self.as_app(self.ATTACHMENTS[label][1].format(t=TABLE))
                with self.assertRaisesRegex(Exception, "HIJACKED"):
                    self.armed(f"SET LOCAL ROLE kb_app; UPDATE ONLY public.{TABLE} SET embedding = embedding;")

    def test_migrate_refuses_attached_code(self):
        for label, (found, sql) in self.ATTACHMENTS.items():
            with self.subTest(label):
                self.fresh()
                self.own()
                self.as_app(sql.format(t=TABLE))
                self.refused(H.migrate_sql(model=H.COHERE), f"migrate_embeddings：{TABLE} 带着会执行代码的附加物（{re.escape(found)}）")
                self.assertIsNone(self.snapshot()["backup"], "备份表也没建")
        # 归档表上的同样拒绝；两张表在动手之前都查过
        self.fresh()
        self.own()
        self.as_app(self.ATTACHMENTS["trigger"][1].format(t=f"{TABLE}_archive"))
        self.refused(H.migrate_sql(model=H.COHERE), f"migrate_embeddings：{TABLE}_archive 带着会执行代码的附加物（触发器 kb_trg）")
        # 还没登记 kb_meta 的老库：拼在前面的 kb_search.sql 要读规则表看有没有向量，在它那里就拒绝
        self.fresh()
        self.own(kb_meta=False)
        self.as_app(self.ATTACHMENTS["trigger"][1].format(t=TABLE))
        self.refused(H.migrate_sql(model=H.COHERE), f"kb_search.sql：{TABLE} 带着会执行代码的附加物（触发器 kb_trg）")

    def test_restore_refuses_attached_code(self):
        for label, (found, sql) in self.ATTACHMENTS.items():
            with self.subTest(label):
                self.fresh()
                self.own()
                self.armed(H.migrate_sql(model=H.COHERE))          # 迁移时表还是干净的
                self.as_app(sql.format(t=TABLE))
                self.refused(H.restore_sql(model=H.TITAN), f"restore_embeddings：{TABLE} 带着会执行代码的附加物（{re.escape(found)}）")
                self.assertEqual(self.meta()["embed_model"], COHERE_FAMILY, "还是新模型")

    def test_restore_refuses_backup_not_made_by_migrate(self):
        # 验收后删掉备份表，应用用户就能建一张同名的（视图、它自己的表）塞进别的「旧向量」；超级用户的备份表带了触发器也不读
        swaps = {
            "app-owned view": ("CREATE VIEW public.{b} AS SELECT * FROM public.kb_fake_backup", f"{TABLE}_titan_backup 不是普通表"),
            "app-owned table": ("CREATE TABLE public.{b} AS SELECT * FROM public.kb_fake_backup", f"备份表 {TABLE}_titan_backup 的属主不是超级用户"),
        }
        for label, (sql, message) in swaps.items():
            with self.subTest(label):
                self.fresh()
                self.own()
                self.armed(H.migrate_sql(model=H.COHERE))
                self.conn.execute(f"ALTER TABLE {TABLE}_titan_backup RENAME TO kb_fake_backup")
                self.conn.execute("ALTER TABLE kb_fake_backup OWNER TO kb_app")
                self.conn.commit()
                self.as_app(sql.format(b=f"{TABLE}_titan_backup"))
                self.refused(H.restore_sql(model=H.TITAN), f"restore_embeddings：{message}")
        with self.subTest("trigger on the superuser's backup"):
            self.fresh()
            self.own()
            self.armed(H.migrate_sql(model=H.COHERE))
            self.as_app("CREATE FUNCTION public.kb_trg() RETURNS trigger LANGUAGE plpgsql AS $t$ BEGIN PERFORM public.kb_armed(); RETURN NEW; END $t$")
            self.conn.execute(f"CREATE TRIGGER kb_trg BEFORE UPDATE ON {TABLE}_titan_backup FOR EACH ROW EXECUTE FUNCTION public.kb_trg()")
            self.conn.commit()
            self.refused(H.restore_sql(model=H.TITAN), f"restore_embeddings：{TABLE}_titan_backup 带着会执行代码的附加物（触发器 kb_trg）")

    def test_kb_search_sql_reads_rules_table_only_when_clean(self):
        # db 阶段每次都执行 kb_search.sql：只有 kb_meta 还没登记时它才读规则表，那时同样先查、带附加物就拒绝；
        # 已登记的库（线上就是）不读规则表，附加物不妨碍 db 阶段
        self.own(kb_meta=False)
        self.as_app(self.ATTACHMENTS["trigger"][1].format(t=TABLE))
        self.refused(H.kb_search_sql(), f"kb_search.sql：{TABLE} 带着会执行代码的附加物（触发器 kb_trg）")
        self.assertEqual(self.meta(), {})
        self.conn.execute("INSERT INTO kb_meta (key, value) VALUES ('embed_model', %s), ('embed_dim', '1024')", (TITAN_FAMILY,))
        self.conn.commit()
        self.armed(H.kb_search_sql(model=H.TITAN))
        self.assertEqual(self.meta(), {"embed_model": TITAN_FAMILY, "embed_dim": "1024"})

    def test_app_owned_plain_tables_migrate_and_restore(self):
        # 没有附加物的、归应用用户的表照常迁移、回退（以属主身份读写）；应用用户建的函数在库里，但一个都没被执行
        self.own()
        self.armed(H.migrate_sql(model=H.COHERE))
        rows = self.all_rows()
        self.assertEqual(len(rows), 4)
        for table, rid, content, emb in rows:
            self.assertTrue(H.same_vector(emb, H.fake_vector(H.COHERE, "search_document", content)), (table, rid))
        self.assertEqual(self.one(f"SELECT count(*) FROM {TABLE}_titan_backup"), 4)
        self.assertEqual(self.meta()["embed_model"], COHERE_FAMILY)
        self.armed(H.restore_sql(model=H.TITAN))
        now = {**self.vectors(), **self.vectors(f"{TABLE}_archive")}
        for rid, old in self.titan.items():
            self.assertTrue(H.same_vector(now[rid], old), rid)
        self.assertEqual(self.meta()["embed_model"], TITAN_FAMILY)
        self.assertEqual([self.one("SELECT pg_get_userbyid(relowner)::text FROM pg_class WHERE oid = %s::regclass", (t,))
                          for t in (TABLE, f"{TABLE}_archive", f"{TABLE}_titan_backup")], ["kb_app", "kb_app", "postgres"])

    def test_refuses_tables_that_are_not_tables(self):
        # 归档表被换成视图：迁移、回退都不碰它（kb_search.sql 在已有向量时不看归档表，这两份脚本自己也要查）
        self.conn.execute(f"DROP TABLE {TABLE}_archive")
        self.conn.execute(f"CREATE VIEW {TABLE}_archive AS SELECT * FROM {TABLE} WHERE false")
        self.conn.commit()
        with self.assertRaisesRegex(Exception, f"migrate_embeddings：{TABLE}_archive 不是普通表"):
            H.run_script(self.conn, H.migrate_sql(model=H.COHERE))
        self.conn.execute(f"DROP VIEW {TABLE}_archive")
        self.conn.commit()
        H.run_script(self.conn, H.migrate_sql(model=H.COHERE))
        self.conn.execute(f"CREATE VIEW {TABLE}_archive AS SELECT * FROM {TABLE} WHERE false")
        self.conn.commit()
        with self.assertRaisesRegex(Exception, f"restore_embeddings：{TABLE}_archive 不是普通表"):
            H.run_script(self.conn, H.restore_sql(model=H.TITAN))


if __name__ == "__main__":
    unittest.main()
