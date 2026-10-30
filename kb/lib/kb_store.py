"""PG 知识库的写入与管理：入库规则（哈希、对比、冲突、清理）、上传历史、下线 / 恢复 / 删除、清单、校验。只此一份实现，
ingest_rules.py（deploy.sh ingest）、kb_admin.py 和 Nexus 工具都调这里，同一份制度不管从哪条路入库，结果都一样。

    conn = kb_store.connect(creds, application_name="kb-tool")          # creds：host / port / database / username / password
    rows = kb_store.prepare(records, source_tag="travel", source_doc="差旅管理办法", source_version="V2")
    result = kb_store.ingest(conn, "approval_rules", rows, source_tag="travel", document_id=doc_id)

入库（ingest）是一个事务，第一句是 advisory lock（键 = hashtext('kb_ingest:' || 表名)，与 sql/kb_search.sql、
换模型脚本、deploy.sh 的入库共用），之后依次：已下线（归档表里有这个标签）→ source_inactive；对比；冲突 → rule_conflict；
dry_run 到此回滚；要写的向量由库里的 kb_embed_batch 一次算出（Bedrock 失败整份回滚；库里还没有 kb_embed_batch
→ kb_not_ready）；upsert、只改说明的更新、清理；
给了 document_id 就把那一行上传记录改成 ingested（同标签之前的记成 superseded）。

  - record_sha256 = 除向量外全部列的 SHA-256（record_hash）：与库里一致且有向量 → 不写；content 没变、别的列变了 → 只更新
    这些列（updated，向量不动）；新规则、content 变了或没有向量 → 重算向量（inserted / reembedded）。
  - 冲突：编号属于别的标签，或者没有标签、source_doc 也不同（另一份文档手工写的）。没有标签、source_doc 相同或为空的认领过来。
  - prune：删掉同一标签下、新版本里已没有的编号；没有标签的行一律不删，只在 untagged_not_in_doc 里计数。

管理的写操作（deactivate / restore / delete）同样在一个事务里、先拿同一把锁。函数只执行写死的、带参数的 SQL：值一律走参数；
表名先过 [a-z_][a-z0-9_]*，kb_search 的调用方只能是 CALLERS 里的几个。出错抛 KbError(code, message, **extra)。
psycopg 只在 connect() 里 import：不连库也能 import 本模块。
"""
import hashlib
import json
import re
from datetime import timezone

COLUMNS = ("rule_id", "rule_type", "chapter_no", "chapter", "seq_no", "business_item", "segment", "amount_tier",
           "approval_path", "approval_path_text", "final_approver", "post_actions", "not_applicable", "extra",
           "scope_controls", "chapter_note", "content", "embedding", "source_doc", "source_version",
           "source_tag", "record_sha256")
JSONB = {"approval_path", "extra"}
TAG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}$")
TABLE_RE = re.compile(r"[a-z_][a-z0-9_]*")
MAX_RECORDS = 2000                       # 一份文档至多 2000 条（kb_embed_batch 一次、一分钟的上限）
STATUSES = ("parsed", "ingesting", "ingested", "failed", "superseded")
CALLERS = ("page", "agent", "ingest", "verify")
LOCK_SQL = "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('kb_ingest:' || %s))"
DRIFT_MIN_COSINE = 0.999
STUCK_MINUTES = 30
DOCUMENT_COLUMNS = ("id, file_name, sha256, size_bytes, uploaded_by, uploaded_at, status, source_tag, doc_title, source_version, "
                    "report, result, error, started_at, finished_at")
_MOVED = ", ".join(COLUMNS + ("ingested_at",))   # 下线 / 恢复时在两张表之间挪的列（列名写全，不靠两张表的列序）


class KbError(Exception):
    """code：给调用方（工具回复的 error_type、命令行的提示）；message：中文说明；extra：rule_conflict 的 conflicts 等。"""

    def __init__(self, code, message, **extra):
        super().__init__(message)
        self.code, self.message, self.extra = code, message, extra


def record_hash(row):
    """除向量与 record_sha256 自身外全部列的稳定哈希。"""
    body = {c: row.get(c) for c in COLUMNS if c not in ("embedding", "record_sha256")}
    return hashlib.sha256(json.dumps(body, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")).hexdigest()


def prepare(records, *, source_tag, source_doc, source_version):
    """解析出的记录 → 入库用的行：全部 COLUMNS，JSONB 列是 JSON 文本，补上三个来源字段与 record_sha256。不改 records。"""
    out = []
    for r in records:
        row = {c: r.get(c) for c in COLUMNS}
        row["approval_path"] = json.dumps(r.get("approval_path") or [], ensure_ascii=False)
        row["extra"] = json.dumps(r.get("extra") or {}, ensure_ascii=False)
        row.update(source_doc=source_doc, source_version=source_version, source_tag=source_tag)
        row["record_sha256"] = record_hash(row)
        out.append(row)
    return out


def connect(creds, *, application_name, timeout=5):
    """按数据库密钥的字段（host / port / database / username / password）连库。关掉自动预备语句：经连接池（或本机的 PGlite）
    时预备语句会串到别的会话上；入库的语句不多，不靠它提速。"""
    creds = creds or {}
    missing = [k for k in ("host", "database", "username") if not creds.get(k)] + ([] if creds.get("password") is not None else ["password"])
    if missing:
        raise KbError("credentials_missing", f"数据库密钥缺少字段：{'、'.join(missing)}")
    try:
        port = int(creds.get("port") or 5432)
    except (TypeError, ValueError):
        raise KbError("credentials_missing", "数据库密钥的 port 不是数字") from None
    import psycopg
    return psycopg.connect(host=creds["host"], port=port, dbname=creds["database"], user=creds["username"], password=creds["password"],
                           connect_timeout=timeout, application_name=application_name, prepare_threshold=None)


def _table(table):
    if not isinstance(table, str) or len(table) > 55 or not TABLE_RE.fullmatch(table):
        raise KbError("invalid_parameter", f"非法表名 {table}")
    return table


def _tag(tag):
    if not isinstance(tag, str) or not TAG_RE.fullmatch(tag):
        raise KbError("invalid_parameter", f"制度标识 {tag!r} 不合规：要是 2–63 位小写字母、数字或连字符，以字母或数字开头")
    return tag


def _json(value):
    return None if value is None else json.dumps(value, ensure_ascii=False, default=str)


def _rows(cur):
    names = [d[0] for d in cur.description or []]
    return [dict(zip(names, row)) for row in cur.fetchall()]


def _exists(cur, name):
    cur.execute("SELECT to_regclass(%s) IS NOT NULL", (name,))
    row = cur.fetchone()
    return bool(row and row[0])


def _iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec="seconds") if value is not None else None


def _ids(ids, n=12):
    ids = list(ids)
    return "、".join(ids[:n]) + ("…" if len(ids) > n else "")


def _rollback(conn):
    try:
        conn.rollback()
    except Exception:  # noqa: BLE001 — 连接已断：服务器在会话结束时自己回滚；保留原来的错误往上抛
        pass


def _transaction(conn):
    """写操作自己开事务，锁是第一句：连接不能是 autocommit（每句一个事务，锁立刻就放了），也不能还开着调用方的事务。"""
    if getattr(conn, "autocommit", False):
        raise KbError("invalid_parameter", "写入要在一个事务里：连接不能是 autocommit")
    status = getattr(getattr(getattr(conn, "info", None), "transaction_status", None), "name", "IDLE")
    if status != "IDLE":
        raise KbError("invalid_parameter", "连接上还开着一个事务：先提交或回滚，入库锁要是新事务的第一句")


def lock(cur, table):
    """入库锁（事务结束才放）：kb_store 的写操作、deploy.sh 的建表、kb_search.sql 与换模型脚本都先拿它。"""
    cur.execute(LOCK_SQL, (_table(table),))


def ensure_owner(cur, table):
    """表已存在但属主不是当前用户时抛 table_owner（补列、建索引、建归档表要属主权限）。表不存在不算错。"""
    t = _table(table)
    cur.execute("SELECT tableowner, current_user FROM pg_tables WHERE schemaname = 'public' AND tablename = %s", (t,))
    row = cur.fetchone()
    if row and row[0] != row[1]:
        owner, me = row
        raise KbError("table_owner", f"表 {t} 的 owner 是 {owner}，不是当前用户 {me}：补列 / 建索引会失败。"
                                     f"请以 postgres 执行 ALTER TABLE {t} OWNER TO {me}; 后重试")


def embed_model(cur):
    """kb_meta 登记的向量模型：{"model": 模型族, "dim": int}；没有 kb_meta（或没登记全）是 None。"""
    if not _exists(cur, "public.kb_meta"):
        return None
    cur.execute("SELECT key, value FROM public.kb_meta WHERE key IN ('embed_model', 'embed_dim')")
    meta = dict(cur.fetchall())
    if not meta.get("embed_model") or not str(meta.get("embed_dim") or "").isdigit():
        return None
    return {"model": meta["embed_model"], "dim": int(meta["embed_dim"])}


# ─────────────── 入库 ───────────────

def _existing(cur, t):
    """库里现有的行：rule_id → (record_sha256, 有没有向量, source_tag, content, source_doc)。接管的旧表可能还没有后加的列。"""
    cur.execute("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = %s", (t,))
    cols = {r[0] for r in cur.fetchall()}
    sha_expr = "record_sha256" if "record_sha256" in cols else "NULL"
    tag_expr = "source_tag" if "source_tag" in cols else "NULL"
    doc_expr = "source_doc" if "source_doc" in cols else "NULL"
    cur.execute(f"SELECT rule_id, {sha_expr}, embedding IS NOT NULL, {tag_expr}, content, {doc_expr} FROM {t}")
    return {r[0]: r[1:] for r in cur.fetchall()}


def _diff(existing, rows, source_tag, prune):
    """→ (plan, todo, conflicts)。todo 里每项 (行, insert | retag | embed)；retag = 只更新元数据列（向量不动）。"""
    todo, conflicts, unchanged = [], [], 0
    for row in rows:
        current = existing.get(row["rule_id"])
        if current is None:
            todo.append((row, "insert"))
            continue
        c_sha, has_emb, c_tag, c_content, c_doc = current
        # rule_id 是主键：同编号的行属于另一份文档（别的标签；没有标签时看来源文档）就不能覆盖
        if (c_tag is not None and c_tag != source_tag) or (c_tag is None and c_doc not in (None, row["source_doc"])):
            conflicts.append(row["rule_id"])
            continue
        if has_emb and c_sha == row["record_sha256"]:
            unchanged += 1
        else:
            todo.append((row, "retag" if (has_emb and c_content == row["content"]) else "embed"))
    in_doc = {r["rule_id"] for r in rows}
    remove = sorted(rid for rid, v in existing.items() if rid not in in_doc and v[2] == source_tag) if prune else []
    kinds = {k: sorted(r["rule_id"] for r, kind in todo if kind == k) for k in ("insert", "retag", "embed")}
    plan = {"rules_total": len(rows), "inserted": len(kinds["insert"]), "updated": len(kinds["retag"]), "reembedded": len(kinds["embed"]),
            "unchanged": unchanged, "removed": len(remove),
            "will_insert": kinds["insert"], "will_update": sorted(kinds["retag"] + kinds["embed"]), "will_remove": remove,
            "untagged_not_in_doc": sum(1 for rid, v in existing.items() if rid not in in_doc and v[2] is None)}
    return plan, todo, sorted(conflicts)


def _has_batch(cur):
    cur.execute("SELECT to_regprocedure(%s) IS NOT NULL", ("public.kb_embed_batch(text[],text)",))
    row = cur.fetchone()
    return bool(row and row[0])


def _vectors(cur, texts, embed, batch):
    """要写的正文 → 向量文本（顺序相同）。库里有 kb_embed_batch（batch）就由它一次算出；没有时（只在 embed="sql-legacy"
    走到这里：库里的 kb_search.sql 早于它）逐条调 kb_embed(text)，同一个库、同一个模型。embed 给的是函数时（只有
    ingest_rules --embed bedrock 的 Titan）由它算。"""
    if not texts:
        return []
    if callable(embed):
        vectors = embed(list(texts))
    else:
        if batch:
            cur.execute("SELECT public.kb_embed_batch(%s::text[], 'search_document')::text[]", (list(texts),))
            row = cur.fetchone()
            vectors = row[0] if row else None
        else:
            vectors = []
            for text in texts:
                cur.execute("SELECT kb_embed(%s)::text", (text,))
                row = cur.fetchone()
                vectors.append(row[0] if row else None)
    vectors = list(vectors or [])
    if len(vectors) != len(texts) or not all(vectors):
        raise KbError("embedding_failed", f"向量没算全：要 {len(texts)} 个，拿到 {sum(1 for v in vectors if v)} 个；整份没有写库")
    return vectors


def ingest(conn, table, rows, *, source_tag, document_id=None, prune=True, dry_run=False, embed="sql"):
    """rows（prepare 的输出）在一个事务里写进 table，返回
    {rules_total, inserted, updated, reembedded, unchanged, removed, will_insert, will_update, will_remove, untagged_not_in_doc}：
    updated = 只改说明、向量不动；reembedded = content 变了（或原来没向量）重算向量；will_* 是编号（dry_run 时是将要做的）。
    连接要是非 autocommit，调用方之前的事务已提交：锁是这个事务的第一句。出错整份回滚，异常照抛；
    rule_conflict 带 conflicts（编号）和 plan（与返回值同形，不含冲突的行）。
    embed：
      "sql"（缺省，工具用）  库里的 kb_embed_batch；表或 kb_embed_batch 不存在 → kb_not_ready（库还没升级），dry_run 也一样。
      "sql-legacy"         只给 ingest_rules.py（deploy.sh）：有 kb_embed_batch 就用它，没有就逐条 kb_embed(text)；表不存在照旧
                           按空表对比（deploy.sh 的建表在另一个事务里先做了）。
      函数 fn(texts) -> [向量文本]  只给 ingest_rules --embed bedrock 的 Titan。
    rows 为空时报 empty_document，一句 SQL 都不执行：空的新版本加上 prune 会删光这份制度。"""
    t = _table(table)
    _tag(source_tag)
    if not (embed in ("sql", "sql-legacy") or callable(embed)):
        raise KbError("invalid_parameter", "embed 只能是 \"sql\"、\"sql-legacy\" 或一个函数")
    if not rows:
        raise KbError("empty_document", "这份文档解析不出一条规则，没有入库（照样入库会把这份制度原有的规则全部清掉）")
    if len(rows) > MAX_RECORDS:
        raise KbError("too_many_records", f"一份文档至多 {MAX_RECORDS} 条记录，这次 {len(rows)} 条；请拆成几份入库")
    if any(r.get("source_tag") != source_tag for r in rows):
        raise KbError("invalid_parameter", "rows 要由 prepare() 用同一个 source_tag 生成")
    _transaction(conn)
    try:
        with conn.cursor() as cur:
            lock(cur, t)
            has_table = _exists(cur, f"public.{t}")
            batch = _has_batch(cur) if not callable(embed) else False
            if embed == "sql" and not has_table:
                raise KbError("kb_not_ready", f"知识库还没建好：表 {t} 不存在。先由管理员跑 deploy.sh 的 db 与 ingest 阶段")
            if embed == "sql" and not batch:
                raise KbError("kb_not_ready", "库还没升级：没有 kb_embed_batch（新版 sql/kb_search.sql 里的批量向量函数）。"
                                              "先由管理员跑 deploy.sh 的 db 阶段，再入库")
            existing = {}
            if has_table:
                ensure_owner(cur, t)
                existing = _existing(cur, t)
            if _exists(cur, f"public.{t}_archive"):
                cur.execute(f"SELECT count(*) FROM {t}_archive WHERE source_tag = %s", (source_tag,))
                row = cur.fetchone()
                if row and row[0]:
                    raise KbError("source_inactive", f"制度 {source_tag} 已下线（{row[0]} 条规则在 {t}_archive 里）：先恢复或删除，再入库；"
                                                     "没有写库", archived=row[0])
            plan, todo, conflicts = _diff(existing, rows, source_tag, prune)
            if conflicts:
                owners = sorted({str(existing[rid][2] or existing[rid][4]) for rid in conflicts})
                raise KbError("rule_conflict", f"{len(conflicts)} 条规则编号已属于库里另一份文档（{'、'.join(owners)}）：{_ids(conflicts)}。"
                                               "同一份制度的新版本请用它原来的标签；另一份制度不能和它共用规则编号，没有写库",
                              conflicts=conflicts, plan=plan)
            if dry_run:
                conn.rollback()
                return plan

            vectors = iter(_vectors(cur, [r["content"] for r, kind in todo if kind != "retag"], embed, batch))
            placeholders = ", ".join(f"%({c})s::jsonb" if c in JSONB else ("%(embedding)s::vector" if c == "embedding" else f"%({c})s")
                                     for c in COLUMNS)
            updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in COLUMNS if c != "rule_id")
            upsert = (f"INSERT INTO {t} ({', '.join(COLUMNS)}, ingested_at) VALUES ({placeholders}, now()) "
                      f"ON CONFLICT (rule_id) DO UPDATE SET {updates}, ingested_at = now()")
            retag = (f"UPDATE {t} SET " + ", ".join(f"{c} = %({c})s::jsonb" if c in JSONB else f"{c} = %({c})s"
                                                    for c in COLUMNS if c not in ("rule_id", "embedding"))
                     + ", ingested_at = now() WHERE rule_id = %(rule_id)s")
            for row, kind in todo:
                if kind == "retag":
                    cur.execute(retag, row)
                else:
                    cur.execute(upsert, dict(row, embedding=next(vectors)))
            if plan["will_remove"]:
                cur.execute(f"DELETE FROM {t} WHERE source_tag = %s AND rule_id = ANY(%s)", (source_tag, plan["will_remove"]))
                plan["removed"] = cur.rowcount
            if document_id is not None:
                set_document_status(cur, document_id, "ingested", result=plan, source_tag=source_tag)
        conn.commit()
        return plan
    except BaseException:
        _rollback(conn)
        raise


# ─────────────── 上传历史（kb_documents） ───────────────

def record_document(cur, *, file_name, sha256, size_bytes, uploaded_by, source_tag, doc_title, source_version, report, status="parsed"):
    """记一次上传 → id。status=ingesting 时同时记 started_at（工具先记这一行、单独提交，留下痕迹）。"""
    if status not in STATUSES:
        raise KbError("invalid_parameter", f"不认识的状态 {status!r}")
    cur.execute("INSERT INTO kb_documents (file_name, sha256, size_bytes, uploaded_by, status, source_tag, doc_title, source_version, report, "
                "started_at) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, CASE WHEN %s THEN now() END) RETURNING id",
                (file_name, sha256, size_bytes, uploaded_by, status, source_tag, doc_title, source_version, _json(report),
                 status == "ingesting"))
    return cur.fetchone()[0]


def set_document_status(cur, doc_id, status, *, result=None, error=None, source_tag=None, doc_title=None, source_version=None):
    """改状态。ingested 时（给了 source_tag）同标签之前入库的记成 superseded；failed 等记 error（至多 2000 字）。"""
    if status not in STATUSES:
        raise KbError("invalid_parameter", f"不认识的状态 {status!r}")
    if status == "ingesting":
        cur.execute("UPDATE kb_documents SET status = 'ingesting', started_at = now(), error = NULL, "
                    "source_tag = coalesce(%s, source_tag), doc_title = coalesce(%s, doc_title), source_version = coalesce(%s, source_version) WHERE id = %s",
                    (source_tag, doc_title, source_version, doc_id))
    elif status == "ingested":
        if source_tag:
            cur.execute("UPDATE kb_documents SET status = 'superseded' WHERE source_tag = %s AND status = 'ingested' AND id <> %s", (source_tag, doc_id))
        cur.execute("UPDATE kb_documents SET status = 'ingested', result = %s::jsonb, error = NULL, finished_at = now(), "
                    "source_tag = coalesce(%s, source_tag), doc_title = coalesce(%s, doc_title), source_version = coalesce(%s, source_version) WHERE id = %s",
                    (_json(result), source_tag, doc_title, source_version, doc_id))
    else:
        cur.execute("UPDATE kb_documents SET status = %s, error = %s, result = coalesce(%s::jsonb, result), finished_at = now() WHERE id = %s",
                    (status, (error or "")[:2000] or None, _json(result), doc_id))


def recover(cur, minutes=STUCK_MINUTES):
    """入库中超过 minutes 分钟的记成失败 → 条数。minutes=0：全部（服务重启时，kb_admin recover）。"""
    minutes = int(minutes)
    reason = "服务重启，入库中断" if minutes == 0 else f"入库超过 {minutes} 分钟没有结束，按中断记为失败"
    cur.execute("UPDATE kb_documents SET status = 'failed', error = %s, finished_at = now() WHERE status = 'ingesting' "
                "AND coalesce(started_at, uploaded_at) <= now() - make_interval(mins => %s) RETURNING id", (reason, minutes))
    return len(cur.fetchall())


def history(cur, limit):
    cur.execute(f"SELECT {DOCUMENT_COLUMNS} FROM kb_documents ORDER BY id DESC LIMIT %s", (limit,))
    return _rows(cur)


def show(cur, doc_id):
    cur.execute(f"SELECT {DOCUMENT_COLUMNS} FROM kb_documents WHERE id = %s", (doc_id,))
    found = _rows(cur)
    return found[0] if found else None


def tags(cur, table):
    """规则表里现有的 source_tag 与来源文档、版本说明、行数。"""
    t = _table(table)
    # 接管的旧表还没有 source_tag 列（第一次经本工具入库时由 approval_rules.sql 补上）：没有标签可选
    cur.execute("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = %s AND column_name = 'source_tag'", (t,))
    if cur.fetchone() is None:
        return []
    cur.execute(f"SELECT source_tag, source_doc, source_version, count(*) AS rows FROM {t} WHERE source_tag IS NOT NULL GROUP BY 1, 2, 3 ORDER BY 1, 2, 3")
    return _rows(cur)


def search(cur, question, k, segment, caller):
    """调 kb_search（与审核 Agent 同一个函数，记检索日志）。caller 只能是 CALLERS 里的。"""
    if caller not in CALLERS:
        raise KbError("invalid_parameter", f"不认识的调用方 {caller!r}")
    cur.execute(f"SELECT * FROM kb_search(%s, %s, %s, '{caller}')", (question, k, segment))
    return _rows(cur)


def search_log(cur, limit):
    cur.execute("SELECT id, at, caller, db_user, question, k, segment, hits, took_ms FROM kb_search_log ORDER BY id DESC LIMIT %s", (limit,))
    return _rows(cur)


# ─────────────── 管理：清单、详情、下线、恢复、删除、校验 ───────────────

def ensure_archive(cur, table):
    """归档表 {table}_archive：同样的列（LIKE … INCLUDING DEFAULTS），另加 archived_at。下线 = 挪进去，kb_search 和
    审核 Agent 的 ILIKE 补查都看不到。"""
    t = _table(table)
    cur.execute(f"CREATE TABLE IF NOT EXISTS {t}_archive (LIKE {t} INCLUDING DEFAULTS)")
    cur.execute(f"ALTER TABLE {t}_archive ADD COLUMN IF NOT EXISTS archived_at timestamptz")


def _sources(cur, t, tag=None):
    where, params = ("source_tag = %s", (tag,)) if tag is not None else ("source_tag IS NOT NULL", ())
    parts = [f"SELECT source_tag, 'active' AS status, rule_type, source_doc, source_version, ingested_at, NULL::timestamptz AS archived_at "
             f"FROM {t} WHERE {where}"]
    if _exists(cur, f"public.{t}_archive"):
        parts.append(f"SELECT source_tag, 'inactive', rule_type, source_doc, source_version, ingested_at, archived_at FROM {t}_archive WHERE {where}")
        params = params * 2
    cur.execute("SELECT source_tag, status, rule_type, count(*), max(source_doc), max(source_version), min(ingested_at), "
                f"greatest(max(ingested_at), max(archived_at)) FROM ({' UNION ALL '.join(parts)}) r GROUP BY 1, 2, 3 ORDER BY 1, 2, 3", params)
    groups = cur.fetchall()
    docs = {}
    if groups and _exists(cur, "public.kb_documents"):
        cur.execute("SELECT DISTINCT ON (source_tag) source_tag, file_name, sha256 FROM kb_documents "
                    f"WHERE status = 'ingested' AND {where} ORDER BY source_tag, id DESC", params[:1])
        docs = {r[0]: r[1:] for r in cur.fetchall()}
    items = {}
    for source_tag, status, rule_type, n, title, version, first, last in groups:
        item = items.setdefault((source_tag, status), {"source_id": source_tag, "title": None, "source_version": None,
                                                        "file_name": None, "doc_hash": None, "rules_total": 0, "status": status,
                                                        "ingested_at": None, "updated_at": None, "by_type": {}, "_first": [], "_last": []})
        item["rules_total"] += n
        item["by_type"][rule_type] = n
        item["title"] = max((x for x in (item["title"], title) if x is not None), default=None)
        item["source_version"] = max((x for x in (item["source_version"], version) if x is not None), default=None)
        item["_first"].append(first)
        item["_last"].append(last)
    out = []
    for (source_tag, _), item in items.items():
        file_name, doc_hash = docs.get(source_tag, (None, None))
        # 字段类型与 S3 Vectors 版相同（接口约定第 2 节）：没有的文字字段回 ""，不回 null
        item.update(title=item["title"] or "", source_version=item["source_version"] or "", file_name=file_name or "", doc_hash=doc_hash or "")
        item["ingested_at"] = _iso(min((x for x in item.pop("_first") if x is not None), default=None))
        item["updated_at"] = _iso(max((x for x in item.pop("_last") if x is not None), default=None))
        out.append(item)
    out.sort(key=lambda s: s["source_id"])
    out.sort(key=lambda s: s["ingested_at"] or "", reverse=True)   # 最近入库的在前（与 S3 Vectors 版相同）
    return out


def list_sources(cur, table):
    """按 source_tag 汇总两张表：在线 active，归档 inactive。每项 source_id、title（source_doc）、source_version、file_name /
    doc_hash（最近一次入库的上传记录；deploy.sh 入的没有）、rules_total、status、ingested_at / updated_at（ISO 8601 UTC）、by_type。
    类型与 S3 Vectors 版相同：title / source_version / file_name / doc_hash 没有时是 ""。"""
    return _sources(cur, _table(table))


def source_detail(cur, table, tag):
    """{"source": 同 list_sources 的一项, "rule_ids": [...]}；没有这份制度是 None。"""
    t = _table(table)
    found = _sources(cur, t, _tag(tag))
    if not found:
        return None
    sql = f"SELECT rule_id FROM {t} WHERE source_tag = %s"
    params = (tag,)
    if _exists(cur, f"public.{t}_archive"):
        sql += f" UNION SELECT rule_id FROM {t}_archive WHERE source_tag = %s"
        params = (tag, tag)
    cur.execute(sql + " ORDER BY 1", params)
    return {"source": found[0], "rule_ids": [r[0] for r in cur.fetchall()]}


def _manage(conn, table, tag, work):
    """下线 / 恢复 / 删除：一个事务，先拿入库锁；出错回滚。"""
    t = _table(table)
    _tag(tag)
    _transaction(conn)
    try:
        with conn.cursor() as cur:
            lock(cur, t)
            n = work(cur, t)
        conn.commit()
        return n
    except BaseException:
        _rollback(conn)
        raise


def deactivate(conn, table, tag):
    """这份制度的规则挪进归档表 → 条数。归档表里已有同编号的行时抛 rule_conflict，一条不挪。"""
    def work(cur, t):
        ensure_archive(cur, t)
        cur.execute(f"SELECT a.rule_id, a.source_tag FROM {t}_archive a JOIN {t} r USING (rule_id) WHERE r.source_tag = %s ORDER BY 1", (tag,))
        taken = cur.fetchall()
        if taken:
            ids, owners = [r[0] for r in taken], sorted({str(r[1]) for r in taken})
            raise KbError("rule_conflict", f"{len(ids)} 条规则编号在 {t}_archive 里已有（{'、'.join(owners)}）：{_ids(ids)}。"
                                           "先删除归档里的那份，再下线；没有改动", conflicts=ids)
        cur.execute(f"INSERT INTO {t}_archive ({_MOVED}, archived_at) SELECT {_MOVED}, now() FROM {t} WHERE source_tag = %s", (tag,))
        cur.execute(f"DELETE FROM {t} WHERE source_tag = %s", (tag,))
        return cur.rowcount
    return _manage(conn, table, tag, work)


def restore(conn, table, tag):
    """从归档表挪回来（向量原样）→ 条数。编号在规则表里已被占用时抛 rule_conflict，一条不挪。"""
    def work(cur, t):
        if not _exists(cur, f"public.{t}_archive"):
            return 0
        cur.execute(f"SELECT a.rule_id, coalesce(r.source_tag, r.source_doc) FROM {t}_archive a JOIN {t} r USING (rule_id) "
                    "WHERE a.source_tag = %s ORDER BY 1", (tag,))
        taken = cur.fetchall()
        if taken:
            ids, owners = [r[0] for r in taken], sorted({str(r[1]) for r in taken})
            raise KbError("rule_conflict", f"{len(ids)} 条规则编号已属于库里另一份文档（{'、'.join(owners)}）：{_ids(ids)}。"
                                           "先删除或下线那份制度，再恢复；一条没挪", conflicts=ids)
        cur.execute(f"INSERT INTO {t} ({_MOVED}) SELECT {_MOVED} FROM {t}_archive WHERE source_tag = %s", (tag,))
        cur.execute(f"DELETE FROM {t}_archive WHERE source_tag = %s", (tag,))
        return cur.rowcount
    return _manage(conn, table, tag, work)


def delete(conn, table, tag):
    """硬删除这份制度在两张表里的全部行和它在 kb_documents 里的登记 → 删掉的规则条数。"""
    def work(cur, t):
        cur.execute(f"DELETE FROM {t} WHERE source_tag = %s", (tag,))
        n = cur.rowcount
        if _exists(cur, f"public.{t}_archive"):
            cur.execute(f"DELETE FROM {t}_archive WHERE source_tag = %s", (tag,))
            n += cur.rowcount
        if _exists(cur, "public.kb_documents"):
            cur.execute("DELETE FROM kb_documents WHERE source_tag = %s", (tag,))
        return n
    return _manage(conn, table, tag, work)


def check(cur, table, tag=None):
    """只读校验 → {"ok", "problems": [{"code", "source_id", "detail"}]}；tag 给了只查这份制度（kb_meta 是全库的，照样报）。
    code：missing_embedding / wrong_dimension / untagged / duplicate_rule_id / stuck_ingest / count_mismatch / kb_meta_missing /
    embedding_drift（抽 3 行用 kb_embed(content, 'search_document') 重算，余弦 < 0.999 就报：残留的旧模型向量或被改过）。"""
    t = _table(table)
    if tag is not None:
        _tag(tag)
    problems = []

    def add(code, source_id, detail):
        problems.append({"code": code, "source_id": source_id, "detail": detail})
    and_tag, p = ("", ()) if tag is None else (" AND source_tag = %s", (tag,))
    meta = embed_model(cur)
    dim = meta["dim"] if meta else 1024
    has_archive = _exists(cur, f"public.{t}_archive")
    has_documents = _exists(cur, "public.kb_documents")

    cur.execute(f"SELECT source_tag, array_agg(rule_id ORDER BY rule_id) FROM {t} WHERE embedding IS NULL{and_tag} GROUP BY 1 ORDER BY 1", p)
    for source_tag, ids in cur.fetchall():
        add("missing_embedding", source_tag, f"{len(ids)} 行没有向量（语义检索查不到）：{_ids(ids)}；重新入库这份制度可补上")
    cur.execute(f"SELECT source_tag, array_agg(rule_id ORDER BY rule_id) FROM {t} "
                f"WHERE embedding IS NOT NULL AND vector_dims(embedding) <> %s{and_tag} GROUP BY 1 ORDER BY 1", (dim, *p))
    for source_tag, ids in cur.fetchall():
        add("wrong_dimension", source_tag, f"{len(ids)} 行的向量不是 {dim} 维：{_ids(ids)}")
    if tag is None:
        cur.execute(f"SELECT array_agg(rule_id ORDER BY rule_id) FROM {t} WHERE source_tag IS NULL")
        row = cur.fetchone()
        if row and row[0]:
            add("untagged", None, f"{len(row[0])} 行没有 source_tag（手工写入或更早的入库，不属于任何一份制度、不会被清理）：{_ids(row[0])}")
    if has_archive:
        both = "" if tag is None else " AND (r.source_tag = %s OR a.source_tag = %s)"
        cur.execute(f"SELECT r.source_tag, r.rule_id, a.source_tag FROM {t} r JOIN {t}_archive a USING (rule_id) WHERE TRUE{both} ORDER BY 1, 2",
                    p * 2)
        dup = {}
        for source_tag, rule_id, archived_tag in cur.fetchall():
            dup.setdefault(source_tag, []).append(f"{rule_id}（归档的属于 {archived_tag}）")
        for source_tag, ids in dup.items():
            add("duplicate_rule_id", source_tag, f"{len(ids)} 个编号同时在 {t} 和 {t}_archive 里：{_ids(ids)}；恢复归档的那份会冲突")
    if has_documents:
        cur.execute("SELECT id, source_tag, (extract(epoch FROM now() - coalesce(started_at, uploaded_at)) / 60)::int FROM kb_documents "
                    f"WHERE status = 'ingesting' AND coalesce(started_at, uploaded_at) < now() - make_interval(mins => %s){and_tag} ORDER BY id",
                    (STUCK_MINUTES, *p))
        for doc_id, source_tag, minutes in cur.fetchall():
            add("stuck_ingest", source_tag, f"上传记录 #{doc_id} 卡在「入库中」{minutes} 分钟：入库进程多半已中断，记为失败后重新上传")
        archived = f" + (SELECT count(*) FROM {t}_archive a WHERE a.source_tag = d.source_tag)" if has_archive else ""
        cur.execute("SELECT d.source_tag, CASE WHEN jsonb_typeof(d.result -> 'rules_total') = 'number' THEN (d.result ->> 'rules_total')::numeric::int END, "
                    f"(SELECT count(*) FROM {t} r WHERE r.source_tag = d.source_tag){archived} "
                    "FROM (SELECT DISTINCT ON (source_tag) source_tag, result FROM kb_documents "
                    f"WHERE status = 'ingested' AND source_tag IS NOT NULL{and_tag} ORDER BY source_tag, id DESC) d ORDER BY 1", p)
        for source_tag, registered, n in cur.fetchall():
            if registered is not None and registered != n:
                add("count_mismatch", source_tag, f"最近一次入库登记 {registered} 条，表里 {n} 条")
    if meta is None:
        add("kb_meta_missing", None, "kb_meta 里没有登记向量模型（embed_model / embed_dim）：deploy.sh 会按 Titan 处理；换模型请走 migrate")
    cur.execute("SELECT to_regprocedure(%s) IS NOT NULL", ("public.kb_embed(text,text)",))
    row = cur.fetchone()
    if row and row[0]:
        cur.execute("SELECT s.rule_id, s.source_tag, (1 - (s.embedding <=> kb_embed(s.content, 'search_document')))::float8 "
                    f"FROM (SELECT rule_id, source_tag, content, embedding FROM {t} WHERE embedding IS NOT NULL AND vector_dims(embedding) = %s{and_tag} "
                    "ORDER BY random() LIMIT 3) s", (dim, *p))
        for rule_id, source_tag, cosine in cur.fetchall():
            if cosine is not None and cosine < DRIFT_MIN_COSINE:
                model = meta["model"] if meta else "库里的模型"
                add("embedding_drift", source_tag, f"{rule_id} 的向量与用 {model} 重算的不一致（余弦 {cosine:.4f} < {DRIFT_MIN_COSINE}）："
                                                   "可能是残留的旧模型向量或被改过；重新入库这份制度可修复")
    return {"ok": not problems, "problems": problems}
