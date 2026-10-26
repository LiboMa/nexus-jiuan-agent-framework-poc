-- 库内语义检索与上传历史（host/pgvector-up.sh 在 db 阶段以 postgres 超级用户执行，全部语句幂等）。
-- 占位符由 pgvector-up.sh 替换：{table}=RULES_TABLE  {dim}=EMBED_DIM  {model}=EMBED_MODEL_ID  {region}=AWS_REGION  {app_user}=PG_DB_USER
--
--   kb_embed(text)   问题或规则正文 → 向量。PL/Python 调 Bedrock（容器经 IMDSv2 用实例角色）；参数和入库时一样
--                    （Titan v2、{dim} 维、normalize），所以问题和规则的向量可比。按内容缓存，不重复调用。
--   kb_search(...)   审核 Agent 经 Nexus 数据连接器调用的语义检索：SELECT * FROM kb_search('问题', 8)。
--                    每次记一行 kb_search_log（谁查的、问了什么、命中了哪些）。
--   kb_documents     「规则库 › 制度知识库」页的上传历史（外壳 poc/app07 经 kb_admin.py 写）。
--
-- plpython3u 是不受信语言：只有超级用户能建这类函数；连接器用的应用用户只能执行，碰不到函数本身。
--
-- 权限：库的属主是应用用户时，PG 15+ 的 public 模式归 pg_database_owner（也就是应用用户），它能删掉超级用户建的表、
-- 换成带触发器的同名表，再等 kb_embed（以超级用户执行）写进去。所以 public 模式改归超级用户，应用用户只留 USAGE、CREATE
-- （照样建自己的表、删自己的表）；超级用户的表（缓存、检索日志）应用用户只能读或碰不到，写日志只经 kb_log_search。

CREATE EXTENSION IF NOT EXISTS plpython3u;
ALTER SCHEMA public OWNER TO CURRENT_USER;
GRANT USAGE, CREATE ON SCHEMA public TO {app_user};

-- 向量缓存：按内容 sha256。只有 kb_embed（SECURITY DEFINER，属主 postgres）读写
CREATE TABLE IF NOT EXISTS kb_embed_cache (
  sha256     text PRIMARY KEY,
  embedding  vector({dim}) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE kb_embed_cache OWNER TO CURRENT_USER;
REVOKE ALL ON TABLE kb_embed_cache FROM PUBLIC;
CREATE INDEX IF NOT EXISTS kb_embed_cache_created_idx ON kb_embed_cache (created_at);

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

CREATE OR REPLACE FUNCTION kb_embed(input text) RETURNS vector({dim})
LANGUAGE plpython3u VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
if input is None or not input.strip():
    plpy.error("kb_embed：输入为空")
# 问题（2000 字以内，由 kb_search 管）和入库时的规则全文都经这里：上限按模型的输入长度给
if len(input) > 8000:
    plpy.error("kb_embed：输入超过 8000 字")
key = hashlib.sha256(input.encode("utf-8")).hexdigest()
if "get" not in SD:
    SD["get"] = plpy.prepare("SELECT embedding::text AS e FROM kb_embed_cache WHERE sha256 = $1", ["text"])
    SD["put"] = plpy.prepare("INSERT INTO kb_embed_cache (sha256, embedding, created_at) VALUES ($1, $2::vector, clock_timestamp()) ON CONFLICT (sha256) DO NOTHING", ["text", "text"])
    SD["recent"] = plpy.prepare("SELECT count(*) AS n FROM kb_embed_cache WHERE created_at > clock_timestamp() - interval '1 minute'")
hit = plpy.execute(SD["get"], [key])
if hit:
    return hit[0]["e"]
# 真去调 Bedrock 的（缓存未命中）每分钟最多 300 次，连接器用户不能拿它刷调用（入库约 100 条一分钟）
if plpy.execute(SD["recent"])[0]["n"] >= 300:
    plpy.error("kb_embed：每分钟最多生成 300 个新向量，请稍后再试")


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
body = json.dumps({"inputText": input, "dimensions": {dim}, "normalize": True}).encode("utf-8")
vector = None
for attempt in range(3):
    signed = AWSRequest(method="POST", url=url, data=body, headers={"Content-Type": "application/json", "Accept": "application/json"})
    SigV4Auth(SD["creds"].get_frozen_credentials(), "bedrock", "{region}").add_auth(signed)
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=dict(signed.headers.items()), method="POST"), timeout=20) as resp:
            vector = json.loads(resp.read())["embedding"]
        break
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
text = "[" + ",".join(repr(float(x)) for x in vector) + "]"
# 只读事务里写不进缓存：照样返回向量
try:
    with plpy.subtransaction():
        plpy.execute(SD["put"], [key, text])
except plpy.spiexceptions.ReadOnlySqlTransaction:
    pass
return text
$$;

-- 写检索日志：kb_search 调；以超级用户写进只追加的 kb_search_log（应用用户自己写不进、删不掉），顺带清掉 90 天前的
CREATE OR REPLACE FUNCTION kb_log_search(who text, asked text, n int, seg text, found jsonb, ms int) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO kb_search_log (caller, db_user, question, k, segment, hits, took_ms)
  VALUES (left(who, 40), session_user, left(asked, 2000), n, left(seg, 40), found, ms);
  DELETE FROM kb_search_log l WHERE l.at < now() - interval '90 days';
END
$$;

-- 排序：问题里用空格、标点隔开的词（2–20 字，至多 8 个；审核 Agent 传的是关键词）在规则原文 content 里出现得越多越靠前，
-- 同样多的再按语义（Titan v2 对长段中文的相似度区分度不大，关键词先把对口的行提上来）；整句问话没有可匹配的词就是纯语义。
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
  q := kb_embed(question);
  SELECT coalesce(array_agg(DISTINCT s.t), ARRAY[]::text[]) INTO terms
    FROM (SELECT t FROM regexp_split_to_table(question, '[\s，。、；：,.;:？?！!（）()]+') AS t WHERE char_length(t) BETWEEN 2 AND 20 LIMIT 8) s;
  FOR rec IN
    SELECT r.rule_id AS rid, r.rule_type AS rtype, r.chapter AS rchapter, r.business_item AS ritem, r.segment AS rsegment, r.amount_tier AS rtier,
           r.approval_path_text AS rpath, r.final_approver AS rfinal, r.scope_controls AS rscope, round((1 - (r.embedding <=> q))::numeric, 4) AS rscore,
           (SELECT count(*) FROM unnest(terms) AS t WHERE position(t in coalesce(r.content, '')) > 0)::int AS rhits
      FROM {table} r
     WHERE r.embedding IS NOT NULL
       AND (segment_filter IS NULL OR position(segment_filter in coalesce(r.segment, '')) > 0)
     ORDER BY rhits DESC, r.embedding <=> q
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

REVOKE ALL ON FUNCTION kb_embed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kb_embed(text) TO {app_user};
REVOKE ALL ON FUNCTION kb_log_search(text, text, int, text, jsonb, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kb_log_search(text, text, int, text, jsonb, int) TO {app_user};
GRANT EXECUTE ON FUNCTION kb_search(text, int, text, text) TO {app_user};
