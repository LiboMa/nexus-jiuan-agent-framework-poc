"""kb_search.sql 里的 kb_embed_impl（PL/Python，唯一调 Bedrock 的代码）：不连库、不连网。

照 host/pgvector-up.sh 的 sed 填好占位符，取出 `-- >>> kb_embed_impl` 与 `-- <<< kb_embed_impl` 之间 $$…$$ 的函数体，
照 PL/Python 的做法包成一个无参函数（参数、SD、plpy 都是全局变量），配上假的 plpy（缓存表、每分钟计数）、
botocore（session / auth / awsrequest）和 urllib.request.urlopen（记下每个请求）。

    python3 -B -m unittest kb/tests/test_kb_embed_impl.py -v
"""
import contextlib
import hashlib
import io
import json
import re
import sys
import types
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

SQL = Path(__file__).resolve().parent.parent / "sql" / "kb_search.sql"
COHERE, TITAN = "us.cohere.embed-v4:0", "amazon.titan-embed-text-v2:0"
ARN = "arn:aws:sts::123456789012:assumed-role/KbPgHostRole/i-0123456789abcdef0"


def fill(text, model, dim, region="us-east-1", table="approval_rules", app_user="nexus"):
    """与 pgvector-up.sh 相同：sed s/{table}/…/g、{dim}、{model}、{region}、{app_user}。"""
    for key, value in (("{table}", table), ("{dim}", str(dim)), ("{model}", model), ("{region}", region), ("{app_user}", app_user)):
        text = text.replace(key, value)
    return text


def impl_source(model, dim):
    text = fill(SQL.read_text(encoding="utf-8"), model, dim)
    m = re.search(r"^-- >>> kb_embed_impl\n(.*?)^-- <<< kb_embed_impl$", text, re.S | re.M)
    assert m, "kb_search.sql 里没有 -- >>> kb_embed_impl … -- <<< kb_embed_impl 标记"
    block = m.group(1)
    assert "CREATE OR REPLACE FUNCTION kb_embed_impl(inputs text[], purpose text, via text, cap int)" in block, block[:300]
    assert "LANGUAGE plpython3u" in block and "SECURITY DEFINER" in block
    body = block.split("$$")[1]
    # PL/Python 把函数体包进 def，每行缩进一级（见 plpython 的 PLy_procedure_munge_source）
    return "def __plpython_procedure_kb_embed_impl():\n" + "".join(
        ("    " + line if line.strip() else "") + "\n" for line in body.splitlines())


def bedrock_vector(text, dim):
    h = hashlib.sha256(text.encode("utf-8")).digest()
    return [(h[i % 32] - 127.5) / 128 for i in range(dim)]


class PlpyError(Exception):
    pass


class ReadOnlySqlTransaction(Exception):
    pass


class FakePlpy:
    """假的 plpy：kb_embed_cache 是一个 dict（sha256 → (向量文本, via)），每分钟计数由 recent 给（via → 已生成个数）。"""
    spiexceptions = types.SimpleNamespace(ReadOnlySqlTransaction=ReadOnlySqlTransaction)

    def __init__(self, cache, recent, read_only=False):
        self.cache, self.recent, self.read_only, self.queries, self.prepared = cache, recent, read_only, [], []

    def error(self, message):
        raise PlpyError(message)

    def prepare(self, sql, types_=None):
        sql = " ".join(sql.split())
        self.prepared.append(sql)
        return sql

    def execute(self, sql, args=None):
        self.queries.append((sql, args))
        if sql == "SELECT pg_catalog.current_setting('transaction_read_only') AS ro":
            return [{"ro": "on" if self.read_only else "off"}]
        if sql == "SELECT sha256, embedding::text AS e FROM public.kb_embed_cache WHERE sha256 = ANY($1)":
            return [{"sha256": k, "e": self.cache[k][0]} for k in args[0] if k in self.cache]
        if sql.startswith("SELECT pg_catalog.count(*) AS n FROM public.kb_embed_cache"):
            # 只数同一 via、一分钟内新建的行：SQL 必须真按这两个条件过滤（假的 recent 只按 via 给数）
            assert sql.endswith("WHERE via = $1 AND created_at > pg_catalog.clock_timestamp() - interval '1 minute'"), sql
            return [{"n": self.recent.get(args[0], 0)}]
        if sql == ("INSERT INTO public.kb_embed_cache (sha256, embedding, via, created_at) "
                   "VALUES ($1, $2::public.vector, $3, pg_catalog.clock_timestamp()) ON CONFLICT (sha256) DO NOTHING"):
            if self.read_only:
                raise ReadOnlySqlTransaction("cannot execute INSERT in a read-only transaction")
            key, vector, via = args
            self.cache.setdefault(key, (vector, via))
            return []
        raise AssertionError("没想到的 SQL：" + sql)

    def subtransaction(self):
        return contextlib.nullcontext()


class FakeBedrock:
    """假的 urlopen：记下 url、请求体、请求头；按请求体的格式回 Cohere 或 Titan 的响应。"""

    def __init__(self, fail=None, cohere_drop=0):
        self.requests, self.fail, self.cohere_drop = [], fail, cohere_drop

    def urlopen(self, request, timeout=None):
        body = json.loads(request.data)
        self.requests.append({"url": request.full_url, "body": body, "headers": dict(request.header_items()), "method": request.get_method()})
        if self.fail is not None:
            raise self.fail()
        if "texts" in body:
            vectors = [bedrock_vector(t, body["output_dimension"]) for t in body["texts"]]
            payload = {"id": "fake", "embeddings": {"float": vectors[:len(vectors) - self.cohere_drop]}, "texts": body["texts"], "response_type": "embeddings_by_type"}
        else:
            payload = {"embedding": bedrock_vector(body["inputText"], body["dimensions"]), "inputTextTokenCount": 3}
        return io.BytesIO(json.dumps(payload).encode("utf-8"))


def fake_botocore():
    root, session, auth, awsrequest = (types.ModuleType(n) for n in ("botocore", "botocore.session", "botocore.auth", "botocore.awsrequest"))

    class Credentials:
        def get_frozen_credentials(self):
            return ("AKIDEXAMPLE", "fake-secret", None)

    session.get_session = lambda: types.SimpleNamespace(get_credentials=lambda: Credentials())

    class AWSRequest:
        def __init__(self, method, url, data, headers):
            self.method, self.url, self.data, self.headers = method, url, data, dict(headers)

    class SigV4Auth:
        def __init__(self, credentials, service, region):
            self.service, self.region = service, region

        def add_auth(self, request):
            request.headers["Authorization"] = f"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261030/{self.region}/{self.service}/aws4_request"
            request.headers["X-Amz-Date"] = "20261030T000000Z"

    auth.SigV4Auth, awsrequest.AWSRequest = SigV4Auth, AWSRequest
    root.session, root.auth, root.awsrequest = session, auth, awsrequest
    return {"botocore": root, "botocore.session": session, "botocore.auth": auth, "botocore.awsrequest": awsrequest}


class Session:
    """一个 PG 会话里的 kb_embed_impl：SD 跨调用保留，缓存、计数、Bedrock 都是假的。"""

    def __init__(self, model=COHERE, dim=1024, cache=None, recent=None, bedrock=None, read_only=False):
        self.model, self.dim = model, dim
        self.plpy = FakePlpy({} if cache is None else cache, {} if recent is None else recent, read_only)
        self.bedrock = bedrock or FakeBedrock()
        self.SD = {}
        self.code = compile(impl_source(model, dim), f"kb_embed_impl[{model}]", "exec")

    def __call__(self, inputs, purpose="search_document", via="single", cap=300):
        g = {"__builtins__": __builtins__, "plpy": self.plpy, "SD": self.SD, "GD": {},
             "inputs": inputs, "purpose": purpose, "via": via, "cap": cap}
        exec(self.code, g)
        with mock.patch.dict(sys.modules, fake_botocore()), mock.patch("urllib.request.urlopen", self.bedrock.urlopen), \
                mock.patch("time.sleep", lambda seconds: None):
            return g["__plpython_procedure_kb_embed_impl"]()

    def key(self, purpose, text, model=None, dim=None):
        return hashlib.sha256(f"{model or self.model}|{dim or self.dim}|{purpose}|{text}".encode("utf-8")).hexdigest()


def vectors(result):
    return [json.loads(v) for v in result]


class KbEmbedImpl(unittest.TestCase):
    def test_cohere_body_exact(self):
        s = Session()
        out = s(["合同 用印", "差旅报销"], "search_document")
        self.assertEqual(len(s.bedrock.requests), 1)
        req = s.bedrock.requests[0]
        self.assertEqual(req["body"], {"texts": ["合同 用印", "差旅报销"], "input_type": "search_document",
                                       "embedding_types": ["float"], "output_dimension": 1024, "truncate": "END"})
        self.assertEqual(list(req["body"]), ["texts", "input_type", "embedding_types", "output_dimension", "truncate"])
        self.assertEqual(req["url"], "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.cohere.embed-v4%3A0/invoke")
        self.assertEqual(req["method"], "POST")
        self.assertIn("/us-east-1/bedrock/", req["headers"]["Authorization"])
        self.assertEqual(req["headers"]["Content-type"], "application/json")
        self.assertEqual(vectors(out), [bedrock_vector("合同 用印", 1024), bedrock_vector("差旅报销", 1024)])
        s(["问句"], "search_query")
        self.assertEqual(s.bedrock.requests[1]["body"]["input_type"], "search_query")

    def test_batches_of_96_in_order(self):
        s = Session()
        inputs = [f"第 {i} 条规则正文" for i in range(200)]
        out = s(inputs, "search_document", "batch", 2000)
        self.assertEqual([len(r["body"]["texts"]) for r in s.bedrock.requests], [96, 96, 8])
        self.assertEqual([t for r in s.bedrock.requests for t in r["body"]["texts"]], inputs)
        self.assertEqual(vectors(out), [bedrock_vector(t, 1024) for t in inputs])

    def test_duplicates_embedded_once(self):
        s = Session()
        out = s(["甲", "乙", "甲"], "search_document", "batch", 2000)
        self.assertEqual([r["body"]["texts"] for r in s.bedrock.requests], [["甲", "乙"]])
        self.assertEqual(vectors(out), [bedrock_vector(t, 1024) for t in ("甲", "乙", "甲")])

    def test_cache_hits_skip_bedrock(self):
        s = Session()
        cached = "[" + ",".join(["0.5"] * 1024) + "]"
        s.plpy.cache[s.key("search_document", "甲")] = (cached, "single")
        s.plpy.cache[s.key("search_document", "丙")] = (cached, "batch")
        out = s(["甲", "乙", "丙"], "search_document", "batch", 2000)
        self.assertEqual([r["body"]["texts"] for r in s.bedrock.requests], [["乙"]])
        self.assertEqual(out[0], cached)
        self.assertEqual(out[2], cached)
        self.assertEqual(json.loads(out[1]), bedrock_vector("乙", 1024))
        # 乙 已写进缓存（via = batch）；再来一次一个请求都不发
        self.assertEqual(s.plpy.cache[s.key("search_document", "乙")], (out[1], "batch"))
        self.assertEqual(s(["甲", "乙", "丙"], "search_document", "batch", 2000), out)
        self.assertEqual(len(s.bedrock.requests), 1)

    def test_cache_key_includes_model_dim_purpose(self):
        keys = set()
        for model, dim, purpose in ((COHERE, 1024, "search_document"), (COHERE, 1024, "search_query"),
                                    (COHERE, 512, "search_document"), (TITAN, 1024, "search_document")):
            s = Session(model=model, dim=dim)
            s(["报销"], purpose)
            expected = hashlib.sha256(f"{model}|{dim}|{purpose}|报销".encode("utf-8")).hexdigest()
            self.assertEqual(list(s.plpy.cache), [expected])
            keys.add(expected)
        self.assertEqual(len(keys), 4)

    def test_bad_purpose_rejected(self):
        for purpose in ("classification", "", None):
            s = Session()
            with self.assertRaises(PlpyError) as caught:
                s(["报销"], purpose)
            self.assertIn("search_document", str(caught.exception))
            self.assertEqual(s.bedrock.requests, [])

    def test_inputs_validated(self):
        for inputs, words in (([""], "输入为空"), (["  "], "输入为空"), (["甲", None], "第 2 条输入为空"),
                              (["字" * 8001], "超过 8000 字"), (None, "输入为空")):
            s = Session()
            with self.assertRaises(PlpyError) as caught:
                s(inputs)
            self.assertIn(words, str(caught.exception))
            self.assertEqual(s.bedrock.requests, [])
        self.assertEqual(Session()([]), [])

    def test_caps_counted_per_via(self):
        s = Session(recent={"batch": 2000, "single": 0})
        with self.assertRaises(PlpyError) as caught:
            s(["新的一条"], "search_document", "batch", 2000)
        self.assertIn("每分钟最多生成 2000 个新向量", str(caught.exception))
        self.assertEqual(s.bedrock.requests, [])
        self.assertEqual(len(s(["新的问题"], "search_query", "single", 300)), 1)
        counted = [args[0] for sql, args in s.plpy.queries if sql.startswith("SELECT pg_catalog.count(*)")]
        self.assertEqual(counted, ["batch", "single"])
        # 只数缓存没命中、真去调的：这一批 10 个新的正好到 2000，11 个就超
        s = Session(recent={"batch": 1990})
        s([f"b{i}" for i in range(10)], "search_document", "batch", 2000)
        with self.assertRaises(PlpyError):
            s([f"c{i}" for i in range(11)], "search_document", "batch", 2000)
        # 计数已满，但全部命中缓存：照样返回，不报上限
        s = Session(recent={"single": 300})
        s.plpy.cache[s.key("search_query", "老问题")] = ("[" + ",".join(["0.1"] * 1024) + "]", "single")
        self.assertEqual(len(s(["老问题"], "search_query", "single", 300)), 1)

    def test_titan_body_unchanged(self):
        s = Session(model=TITAN)
        out = s(["甲", "乙"], "search_query")
        self.assertEqual([r["body"] for r in s.bedrock.requests],
                         [{"inputText": "甲", "dimensions": 1024, "normalize": True},
                          {"inputText": "乙", "dimensions": 1024, "normalize": True}])
        self.assertTrue(all(r["url"] == "https://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.titan-embed-text-v2%3A0/invoke"
                            for r in s.bedrock.requests))
        self.assertEqual(vectors(out), [bedrock_vector("甲", 1024), bedrock_vector("乙", 1024)])

    def test_errors_redacted(self):
        body = json.dumps({"message": f"User: {ARN} is not authorized to perform: bedrock:InvokeModel on resource: "
                                      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.cohere.embed-v4:0 (account 123456789012)"})

        def forbidden():
            return urllib.error.HTTPError("https://bedrock-runtime", 403, "Forbidden", {}, io.BytesIO(body.encode("utf-8")))

        s = Session(bedrock=FakeBedrock(fail=forbidden))
        with self.assertRaises(PlpyError) as caught:
            s(["报销"])
        message = str(caught.exception)
        self.assertIn("kb_embed：Bedrock 返回 403", message)
        self.assertNotIn("123456789012", message)
        self.assertNotIn("arn:aws", message)
        self.assertEqual(len(s.bedrock.requests), 1)  # 403 不重试

        def unreachable():
            return urllib.error.URLError(f"proxy said no for {ARN}")

        s = Session(bedrock=FakeBedrock(fail=unreachable))
        with self.assertRaises(PlpyError) as caught:
            s(["报销"])
        self.assertIn("连不上 Bedrock", str(caught.exception))
        self.assertNotIn("123456789012", str(caught.exception))
        self.assertEqual(len(s.bedrock.requests), 3)  # 连不上重试两次

    def test_response_shape_checked(self):
        s = Session(bedrock=FakeBedrock(cohere_drop=1))
        with self.assertRaises(PlpyError) as caught:
            s(["甲", "乙"], "search_document", "batch", 2000)
        self.assertIn("个数", str(caught.exception))

    def test_read_only_single_still_works(self):
        # 审核 Agent 的连接器可能是只读的：单条照常返回，只是缓存写不进去
        s = Session(read_only=True)
        self.assertEqual(vectors(s(["报销"], "search_query", "single", 300)), [bedrock_vector("报销", 1024)])
        self.assertEqual(s.plpy.cache, {})

    def test_read_only_refuses_new_batch_vectors(self):
        # 上限按缓存行数，只读事务里记不下：批量 / 换模型在只读事务里不许生成新向量（否则 BEGIN READ ONLY 就绕过了上限）
        for via, cap in (("batch", 2000), ("migrate", 100000)):
            s = Session(read_only=True)
            with self.assertRaises(PlpyError) as caught:
                s([f"新的第 {i} 条" for i in range(2000)], "search_document", via, cap)
            self.assertIn("只读事务里不能生成新向量", str(caught.exception))
            self.assertEqual(s.bedrock.requests, [])
        # 全部命中缓存：不用生成新向量，只读事务里照样返回
        s = Session(read_only=True)
        cached = "[" + ",".join(["0.5"] * 1024) + "]"
        s.plpy.cache[s.key("search_document", "甲")] = (cached, "batch")
        self.assertEqual(s(["甲"], "search_document", "batch", 2000), [cached])

    def test_spi_statements_qualified(self):
        # 以超级用户执行的 SQL：内置函数都写 pg_catalog.，自己的表、类型写 public.（应用用户能在 public 里建同名重载截走调用）
        s = Session()
        s(["甲"], "search_document", "batch", 2000)
        self.assertEqual(len(s.plpy.prepared), 4)
        for sql in s.plpy.prepared:
            calls = {m.group(1) for m in re.finditer(r"(?<![.\w])([A-Za-z_]\w*)\(", sql)}
            self.assertLessEqual(calls, {"ANY"}, sql)
            self.assertNotIn(" kb_embed_cache", sql.replace("public.kb_embed_cache", ""), sql)


if __name__ == "__main__":
    unittest.main()
