"""本机 PG 测试底座：PGlite + pgvector（kb/tests/run_pglite.sh 起的），装 sql/approval_rules.sql + sql/kb_search.sql，
其中调 Bedrock 的 kb_embed_impl（两行标记之间）换成 fake_kb_embed.sql：按内容算的假向量，每算一个记一行 kb_fake_embed_calls。

    bash kb/tests/run_pglite.sh 55432                    # 另一个终端，前台运行，Ctrl-C 停
    KB_TEST_PG_PORT=55432 python3 -B -m unittest ...    # 没设 KB_TEST_PG_PORT 时 connect() 抛 unittest.SkipTest

    conn = pg_harness.connect()
    pg_harness.reset(conn)                               # 删光 public，再按 schema_sql() 重建（缺省 Cohere v4、1024 维）
    pg_harness.run_script(conn, pg_harness.migrate_sql())   # 照 psql -1：整段一个事务

PGlite 只有一个后端，所有连接共用它：
  - run_pglite.sh 允许多个连接，但同一时刻只有一个事务在跑，别的连接（连新连接本身）要等它结束。测试在等另一个连接
    （例如子进程跑命令行）之前，先 commit / rollback 自己的事务；两个连接抢锁的场景在这里测不了。
  - 会话状态不随连接关闭而清掉：psycopg 同一句执行 5 次后自动建的预备语句（_pg3_0…）会留给下一个连接，撞名报
    DuplicatePreparedStatement。connect() 关掉自动预备（prepare_threshold=None）并先 DEALLOCATE ALL；
    测试里别的代码自己连 PGlite 时也要传 prepare_threshold=None。
"""
import hashlib
import math
import os
import re
import unittest
from pathlib import Path

try:  # 导入时就拿住真的 psycopg：test_kb_admin.py 会在运行中把 sys.modules["psycopg"] 换成假的，而且不换回来
    import psycopg as _psycopg
except ImportError:  # 没装 psycopg 也能 import 本模块（没设 KB_TEST_PG_PORT 时 PG 用例本来就跳过）
    _psycopg = None

TESTS = Path(__file__).resolve().parent
SQL_DIR = TESTS.parent / "sql"
FAKE_IMPL = TESTS / "fake_kb_embed.sql"
COHERE = "us.cohere.embed-v4:0"
TITAN = "amazon.titan-embed-text-v2:0"
REGION = "us-east-1"
APP_USER = "postgres"
BEGIN_MARK, END_MARK = "-- >>> kb_embed_impl", "-- <<< kb_embed_impl"
PLPYTHON = "CREATE EXTENSION IF NOT EXISTS plpython3u;\n"


def model_family(model: str) -> str:
    """kb_meta.embed_model 记的模型族：去掉推理配置文件的区域前缀（us. / global. / eu. / apac.）。"""
    return re.sub(r"^(us|global|eu|apac)\.", "", model)


def fill(text: str, *, model: str = COHERE, dim: int = 1024, table: str = "approval_rules",
         region: str = REGION, app_user: str = APP_USER) -> str:
    """照 host/pgvector-up.sh 的 sed 填占位符，另加迁移 / 回退脚本用的 {model_family}。"""
    for key, value in (("{table}", table), ("{dim}", str(dim)), ("{model}", model), ("{model_family}", model_family(model)),
                       ("{region}", region), ("{app_user}", app_user)):
        text = text.replace(key, value)
    return text


def _read(name: str) -> str:
    return (SQL_DIR / name).read_text(encoding="utf-8")


def kb_search_sql(model: str = COHERE, dim: int = 1024, table: str = "approval_rules", app_user: str = APP_USER) -> str:
    """kb_search.sql：去掉 CREATE EXTENSION plpython3u，标记之间换成假的 kb_embed_impl，再填占位符。"""
    text = _read("kb_search.sql")
    if PLPYTHON not in text or text.count(BEGIN_MARK) != 1 or text.count(END_MARK) != 1:
        raise AssertionError("kb_search.sql 里要有一行 CREATE EXTENSION IF NOT EXISTS plpython3u; 和一对 kb_embed_impl 标记")
    text = text.replace(PLPYTHON, "")
    start, end = text.index(BEGIN_MARK), text.index(END_MARK) + len(END_MARK)
    text = text[:start] + FAKE_IMPL.read_text(encoding="utf-8") + text[end:]
    return fill(text, model=model, dim=dim, table=table, app_user=app_user)


def schema_sql(model: str = COHERE, dim: int = 1024, table: str = "approval_rules") -> str:
    """approval_rules.sql + kb_search.sql（假的 kb_embed_impl），{app_user} = postgres；新库上可以直接执行。"""
    return ("CREATE EXTENSION IF NOT EXISTS vector;\n" + fill(_read("approval_rules.sql"), model=model, dim=dim, table=table)
            + "\n" + kb_search_sql(model, dim, table))


def migrate_sql(model: str = COHERE, dim: int = 1024, table: str = "approval_rules") -> str:
    """换模型：新配置的 kb_search.sql + migrate_embeddings.sql（deploy.sh 用 psql -1 拼在一起执行）。"""
    return kb_search_sql(model, dim, table) + "\n" + fill(_read("migrate_embeddings.sql"), model=model, dim=dim, table=table)


def restore_sql(model: str = TITAN, dim: int = 1024, table: str = "approval_rules") -> str:
    """回退：旧配置（缺省 Titan）的 kb_search.sql + restore_embeddings.sql。"""
    return kb_search_sql(model, dim, table) + "\n" + fill(_read("restore_embeddings.sql"), model=model, dim=dim, table=table)


def connect():
    """连 run_pglite.sh 起的 PGlite（127.0.0.1:$KB_TEST_PG_PORT，postgres 超级用户）。没设端口就跳过。"""
    port = os.environ.get("KB_TEST_PG_PORT", "").strip()
    if not port:
        raise unittest.SkipTest("没设 KB_TEST_PG_PORT（先在另一个终端 bash kb/tests/run_pglite.sh 55432）")
    if _psycopg is None:
        raise ImportError("PG 用例要 psycopg 3：用 $KBPY（uv run --with psycopg --with psycopg-binary …）跑")
    conn = _psycopg.connect(host="127.0.0.1", port=int(port), user="postgres", password="kb-local-test",
                           dbname="postgres", connect_timeout=5, application_name="kb-tests", prepare_threshold=None)
    conn.execute("DEALLOCATE ALL")   # 清掉之前的连接留在这个后端上的预备语句
    conn.commit()
    return conn


def run_script(conn, sql: str) -> None:
    """照 psql -X -v ON_ERROR_STOP=1 -1：整段在一个事务里执行，出错整段回滚，异常照抛。"""
    if conn.autocommit:
        conn.execute(sql)  # 多条语句一次发出：服务器把它当一个隐式事务
        return
    try:
        conn.execute(sql)
        conn.commit()
    except BaseException:
        conn.rollback()
        raise


def reset(conn, **schema_kw) -> None:
    """删光 public（表、函数、kb_fake_embed_calls、vector 扩展），再按 schema_sql(**schema_kw) 重建。"""
    if not conn.autocommit:
        conn.rollback()
    run_script(conn, "DROP SCHEMA IF EXISTS public CASCADE;\nCREATE SCHEMA public;\n" + schema_sql(**schema_kw))


def fake_vector(model: str, purpose: str, text: str, dim: int = 1024) -> list:
    """fake_kb_embed.sql 的 Python 版：测试里拿来算期望的向量。"""
    vals = []
    for k in range((dim + 31) // 32):
        vals.extend(b - 127.5 for b in hashlib.sha256(f"{model}|{purpose}|{text}|{k}".encode("utf-8")).digest())
    vals = vals[:dim]
    norm = math.sqrt(sum(x * x for x in vals))
    return [x / norm for x in vals]


def parse_vector(text: str) -> list:
    """pgvector 的文本形式「[0.1,0.2,…]」→ list[float]。"""
    return [float(x) for x in text.strip().strip("[]").split(",")]


def same_vector(a, b, tol: float = 1e-6) -> bool:
    """库里是 float4：逐维差在 tol 以内就算同一个向量。a、b 可以是文本或 list。"""
    a = parse_vector(a) if isinstance(a, str) else a
    b = parse_vector(b) if isinstance(b, str) else b
    return len(a) == len(b) and all(abs(x - y) <= tol for x, y in zip(a, b))
