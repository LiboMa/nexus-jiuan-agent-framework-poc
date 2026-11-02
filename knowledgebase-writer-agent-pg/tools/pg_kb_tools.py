"""
PG 知识库工具 - 知识库文档管家（PG 版）：规则请求 kb.rules/v1 的三个工具（与 S3 Vectors 版的规则工具同名、同参数）

  - rules_writer:  ingest / preview（dry_run=True）。附件（.docx / .xlsx / .pdf / .md）→ 解析成规则记录 → 一个事务里
                   对比、由库里的 kb_embed_batch 算要写的向量、upsert、清理 → 返回结果与解析报告
  - rules_search:  search。调 kb_search(问题, top_k, NULL, 'agent')（与审核 Agent 同一个函数），再按编号取规则全文
  - rules_manager: describe / list / detail / deactivate / restore / delete / check

本文件只是 @tool 入口。解析（kb_parse、doc_blocks）、入库与管理（kb_store）是 kb/lib 的同一份代码（deploy.sh 的入库也用它），
由 scripts/build_tools.py 逐个文件放进同一个工具目录；Nexus 把一个版本的文件装成一个包，所以用相对 import。

数据（与审核 Agent 共用，接口约定第 3 节）：规则写进 approval_rules（_TABLE），source_tag = source_id，source_doc = title
（没给就用附件文件名）；每次入库在 kb_documents 记一行；下线 = 挪进 approval_rules_archive。
凭证：Nexus 密钥注入（nexus_utils.secret_key.get_tool_credentials()），key_name=pg_kb，类型 database_credentials，字段 host /
port / database / username / password。拿不到就报 credentials_missing，不回落到别的凭据。连接超时 5 秒，只执行写死的、带参数的 SQL。
时限：连上后、做任何事之前设 lock_timeout 30s（等入库锁 kb_ingest:<表>）、statement_timeout 240s（每一句，低于测试台入库的
5 分钟），然后提交。超过了这个事务都整份回滚，不会等到了照样提交，回 db_unavailable：等锁超过 30 秒是「知识库正忙」（另一项
入库或换模型正在进行），一句超过 240 秒是「这次操作超时」（入库或检索太慢）。
向量：工具不算向量、不调 Bedrock，全由库里的 kb_embed_batch / kb_embed 生成（模型是 kb_meta 登记的那个）。
回复：一行 JSON。失败一律 {"success": false, "error_type", "message", "suggestion"?}（rule_conflict 另带 conflicts）；
错误里不带密码、连接串、主机名、端口。时间是 ISO 8601（UTC）。
"""

import hashlib
import json
import os
import re
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

from . import doc_blocks, kb_parse, kb_store
from strands import tool
from nexus_utils.secret_key import get_tool_credentials

# >>> deploy-config：scripts/build_tools.py 按 deploy.env 改写这一段；其余代码各环境相同
_TABLE = "approval_rules"
_BUILD = ""
# <<< deploy-config

# ─────────────────────── 常量 ────────────────────────
_PROTOCOL = "kb.rules/v1"
_OPS = ["describe", "ingest", "preview", "list", "detail", "deactivate", "restore", "delete", "check", "search"]
_ACTIONS = ("describe", "list", "detail", "deactivate", "restore", "delete", "check")
_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024  # 50 MB
_MAX_TITLE_CHARS = 200
_MAX_VERSION_CHARS = 64
_MAX_QUESTION_CHARS = 2000               # 与 kb_search 的上限相同
_TOP_K_MAX = 20                          # 与 kb_search 的上限相同
_CONNECT_TIMEOUT = 5
# 会话级时限（连上后、做任何事之前设，提交）。入库、下线、恢复、删除都等 kb_ingest:<表> 这把锁，deploy.sh 的迁移 / 入库也拿它：
# 测试台入库 5 分钟、其余 2 分钟就放弃，这边不能还在等、等到了照样提交（页面以为失败、库里其实改了）
_SESSION_SQL = ("SET lock_timeout = '30s'", "SET statement_timeout = '240s'")
# 超时 → db_unavailable 的说明与建议：等不到入库锁（lock_not_available，lock_timeout）是别人占着；一句跑太久（query_canceled，
# statement_timeout）是这次自己太慢。两种都已整份回滚
_TIMEOUTS = {
    "55P03": ("知识库正忙（另一项入库或换模型正在进行），请稍后再试", "过一两分钟再试一次"),
    "57014": ("这次操作超时（入库或检索太慢），请稍后再试；文档很大时可以拆开入库",
              "过几分钟再试一次；文档很大就拆成几份、各用自己的制度标识入库；一直超时请管理员检查数据库主机的负载"),
}
_UPLOADED_BY = "agent"
_SEARCH_FILTER = {"segment": None, "amount": None, "note": "PG 方式按关键词 + 语义排序，不按板块 / 金额过滤"}
_RATE_MARK = "每分钟最多"                # kb_search（60 次）与 kb_embed / kb_embed_batch（新向量个数）的上限报错里都有这几个字
_ERROR_TYPES = frozenset((
    "credentials_missing", "invalid_parameter", "invalid_source_id", "file_not_found", "file_too_large", "unsupported_format",
    "empty_document", "no_text_layer", "encoding_unsupported", "pdf_parser_unavailable", "matrix_chapter_missing", "duplicate_rule_ids",
    "too_many_records", "rule_conflict", "source_inactive", "not_found", "rate_limited", "kb_not_ready", "table_owner",
    "db_unavailable", "embedding_failed", "internal_error"))
_SUGGEST = {
    "credentials_missing": "请管理员在 Nexus 把数据库密钥（database_credentials：host / port / database / username / password）"
                           "绑定到本工具模块（key_name=pg_kb）",
    "invalid_source_id": "制度标识由 2–63 位小写字母、数字或连字符组成，以字母或数字开头，如 fin-approval；同一份制度的新版本用同一个",
    "file_not_found": "附件在 .cache/<agent_id>/<session_id>/nexus_ai_internal_attachments_temp/ 下；"
                      "不确定时先用 runtime_workspace_list_files 列出该目录",
    "file_too_large": "单个文件至多 50 MB；请拆分后分批入库",
    "unsupported_format": "只收 .docx / .xlsx / .pdf / .md；旧版 .doc / .xls、加了密码或损坏的文件请用 Office 另存后再上传",
    "empty_document": "请确认上传的是制度原文，里面有正文条款或审批矩阵",
    "no_text_layer": "扫描件不做 OCR：请改传 Word / Excel，或带文字层的 PDF",
    "encoding_unsupported": "请把 Markdown 另存为 UTF-8 再上传",
    "pdf_parser_unavailable": "请改传 Word / Excel",
    "matrix_chapter_missing": "在每张审批矩阵表前加上章标题（如「一、立项审批」；Excel 可把工作表改名为章标题）再上传",
    "duplicate_rule_ids": "同一章的矩阵里序号不能重复；改好后再上传",
    "too_many_records": "一份文档至多 2,000 条记录：请拆成几份，各用自己的制度标识入库",
    "rule_conflict": "确认是不是同一份制度：是就用它原来的制度标识上传；不是就先下线或删除那一份",
    "source_inactive": "这份制度已下线：先 restore（恢复）或 delete（删除），再入库",
    "not_found": "用 list 查看知识库里已有的制度",
    "rate_limited": "已到每分钟上限，请一分钟后再试",
    "kb_not_ready": "请管理员先跑 kb/deploy.sh 的 db 阶段（新版 sql/kb_search.sql）升级知识库，再重试",
    "table_owner": "请管理员按提示改好表的属主后重试",
    "db_unavailable": "请稍后重试；一直连不上请管理员检查数据库是否在运行、网络是否放行，以及 Nexus 密钥 pg_kb 的字段",
    "embedding_failed": "知识库没有改动：请稍后重试；一直失败请管理员检查数据库主机调 Bedrock 的权限",
    "internal_error": "请稍后重试；问题持续请管理员查看平台日志",
}
_IP_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_PORT_RE = re.compile(r"\bport\s*=?\s*\"?\d+\"?", re.I)
_PLPY_PREFIX = re.compile(r"^plpy\.(?:Error|Fatal):\s*")   # PL/Python 的 plpy.error() 报出来的消息带这个前缀


# ─────────────────────── 回复 ────────────────────────
def _plain(value):
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime):
        return (value.astimezone(timezone.utc) if value.tzinfo else value).isoformat(timespec="seconds")
    if isinstance(value, date):
        return value.isoformat()
    raise TypeError(type(value).__name__)


def _dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, default=_plain)


def _fail(error_type: str, message: str, suggestion: str | None = None, **extra) -> dict:
    out = {"success": False, "error_type": error_type, "message": message}
    suggestion = suggestion if suggestion is not None else _SUGGEST.get(error_type)
    if suggestion:
        out["suggestion"] = suggestion
    out.update(extra)
    return out


def _scrub(text, creds, *, network=False) -> str:
    """去掉密钥里的主机、密码和端口（错误一律经这里）；network=True（数据库给的消息）另把 IP、「port 数字」都去掉。"""
    text = str(text or "")
    creds = creds if isinstance(creds, dict) else {}
    for key in ("password", "host"):
        value = str(creds.get(key) or "")
        if len(value) >= 3:
            text = text.replace(value, "…")
    port = str(creds.get("port") or "")
    if port:
        text = re.sub(rf"(?:\bport\s*=?\s*\"?|:){re.escape(port)}\b", "…", text, flags=re.I)
    if network:
        text = _PORT_RE.sub("port …", _IP_RE.sub("…", text))
    return text[:800]


def _unavailable(e, state: str) -> str:
    """连接失败 → 固定的说明（只拿 libpq 的原文分类，原文里有主机和端口，不往外带）。"""
    text = str(e).lower()
    if state.startswith("28") or any(w in text for w in ("password", "authentication", "认证", "密码")):
        return "数据库拒绝了登录：用户名或密码不对"
    if state == "3D000" or ("database" in text and "does not exist" in text):
        return "数据库不存在：请核对密钥里的 database"
    if any(w in text for w in ("resolve host", "translate host name", "nodename nor servname", "name or service not known")):
        return "连不上知识库数据库：主机名解析不了"
    if "timeout" in text or "timed out" in text:
        return f"连不上知识库数据库：{_CONNECT_TIMEOUT} 秒内没有响应（网络不通、安全组没放行，或数据库没在运行）"
    if "refused" in text:
        return "连不上知识库数据库：连接被拒绝（端口不对，或数据库没在运行）"
    if state:
        return f"知识库数据库暂时不可用（SQLSTATE {state}）"
    return "连不上知识库数据库（网络不通、超时，或数据库没在运行）"


def _db_error(e):
    """psycopg 的异常 → (error_type, message[, suggestion])；不是 psycopg 的返回 None。只用服务端的主消息，不用 str(e)。"""
    try:
        import psycopg
    except ImportError:
        return None
    if not isinstance(e, psycopg.Error):
        return None
    state = str(getattr(e, "sqlstate", None) or "")
    if state in _TIMEOUTS:   # 等锁超过 lock_timeout / 一句超过 statement_timeout：这个事务已整份回滚
        return ("db_unavailable", *_TIMEOUTS[state])
    diag = getattr(e, "diag", None)
    primary = _PLPY_PREFIX.sub("", str(getattr(diag, "message_primary", None) or "")) if diag is not None else ""
    if _RATE_MARK in primary:
        return "rate_limited", primary
    if state in ("42P01", "42883"):   # undefined_table / undefined_function
        return "kb_not_ready", f"库还没升级：{primary or '缺少表或函数'}"
    if primary.startswith("kb_embed"):
        return "embedding_failed", f"{primary}；整份没有写库"
    if primary.startswith("kb_search：问题"):
        return "invalid_parameter", primary
    if isinstance(e, (psycopg.OperationalError, psycopg.InterfaceError)):
        return "db_unavailable", _unavailable(e, state)
    return "internal_error", f"数据库报错（SQLSTATE {state or '?'}）：{primary or type(e).__name__}"


def _as_failure(e, creds) -> dict:
    if isinstance(e, kb_store.KbError):
        code = e.code if e.code in _ERROR_TYPES else "internal_error"
        extra = {"conflicts": list(e.extra.get("conflicts") or [])} if code == "rule_conflict" else {}
        return _fail(code, _scrub(e.message, creds), e.extra.get("suggestion"), **extra)
    if isinstance(e, doc_blocks.DocError):
        return _fail(e.code if e.code in _ERROR_TYPES else "unsupported_format", _scrub(e.message, creds))
    mapped = _db_error(e)
    if mapped:
        code, message, *suggestion = mapped
        return _fail(code, _scrub(message, creds, network=True), *suggestion)
    return _fail("internal_error", f"工具内部出错（{type(e).__name__}：{_scrub(e, creds, network=True)[:200]}）")


# ─────────────────────── 参数 ────────────────────────
def _source_id(value) -> str:
    s = str(value or "").strip()
    if not s:
        raise kb_store.KbError("invalid_parameter", "缺少 source_id（制度标识）", suggestion="可先用 action=list 查看已有的制度")
    if not kb_store.TAG_RE.fullmatch(s):
        raise kb_store.KbError("invalid_source_id", f"制度标识不合规：{s[:80]!r}")
    return s


def _table() -> str:
    if len(_TABLE) > 55 or not kb_store.TABLE_RE.fullmatch(_TABLE):
        raise kb_store.KbError("internal_error", f"工具的规则表名配置不合规：{_TABLE[:60]!r}（重新跑 build_tools.py）")
    return _TABLE


def _flag(value) -> bool:
    """dry_run：模型偶尔传成字符串，"false" / "0" 不能当成真。"""
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes", "y", "on")
    return bool(value)


def _top_k(value) -> int:
    if value is None or value == "":
        return 8
    try:
        k = int(value)
    except (TypeError, ValueError):
        raise kb_store.KbError("invalid_parameter", f"top_k 须是整数，收到：{str(value)[:20]!r}", suggestion="用默认值 8 即可") from None
    return max(1, min(k, _TOP_K_MAX))


# ─── 附件路径的检查：照搬 knowbase-s3vectors-agent/tools/s3vectors_kb_tools.py 的 _validate_path（原样）与 document_parser 里
#     的存在性、大小检查（工具目录之间不能互相 import，所以复制；那边改了这里一并改）。0 字节由 doc_blocks 报 empty_document ───
def _validate_path(file_path: str, agent_id: str = "", session_id: str = "") -> tuple[bool, str]:
    """
    校验文件路径合法性，防止路径穿越攻击。
    当 agent_id 与 session_id 均提供时，限定路径必须位于工作区内。
    """
    try:
        resolved = Path(file_path).resolve()
        resolved_str = str(resolved)

        # 明确禁止的系统敏感目录
        forbidden_prefixes = ["/etc", "/sys", "/proc", "/dev", "/root", "/var/run", "/boot"]
        for prefix in forbidden_prefixes:
            if resolved_str.startswith(prefix):
                return False, f"路径 {resolved_str} 涉及敏感系统目录，访问被拒绝"

        # 若提供 agent_id 与 session_id，限定工作区
        if agent_id and session_id:
            workspace = str(Path(f".cache/{agent_id}/{session_id}").resolve())
            if not resolved_str.startswith(workspace):
                return False, f"文件路径必须位于工作区 .cache/{agent_id}/{session_id}/ 内，禁止路径穿越"

        return True, resolved_str
    except Exception as e:
        return False, f"路径解析异常: {str(e)}"


def _check_file(file_path) -> str:
    """附件 → 真实路径（普通文件、≤ 50 MB）；不合格抛 KbError。"""
    fp = str(file_path or "").strip()
    if not fp:
        raise kb_store.KbError("invalid_parameter", "file_path 不能为空", suggestion="请给附件的路径")
    ok, path_or_error = _validate_path(fp)
    if not ok:
        raise kb_store.KbError("invalid_parameter", path_or_error, suggestion="请确保文件路径位于允许的工作区目录内，不含路径穿越字符")
    path = path_or_error
    if not os.path.isfile(path):
        raise kb_store.KbError("file_not_found", f"文件不存在：{os.path.basename(path)}")
    size = os.path.getsize(path)
    if size > _MAX_FILE_SIZE_BYTES:
        raise kb_store.KbError("file_too_large", f"文件大小 {size // (1024 * 1024)}MB 超过 50MB 上限")
    return path


def _file_hash(path: str) -> str:
    sha256 = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


# ─────────────────────── 连库 ────────────────────────
def _credentials() -> dict:
    """只认 Nexus 注入的数据库密钥；没有就是 credentials_missing（缺字段由 kb_store.connect 报同一个码）。"""
    try:
        creds = get_tool_credentials()
    except Exception:  # noqa: BLE001 — 平台没注入（没绑定密钥）时可能直接抛
        creds = None
    if not isinstance(creds, dict) or not creds:
        raise kb_store.KbError("credentials_missing", "没拿到数据库密钥：Nexus 没有给本工具注入 pg_kb（database_credentials）")
    return creds


def _connect(creds):
    """连库（5 秒超时），设好会话时限（_SESSION_SQL）并提交。连不上一律 db_unavailable，说明是固定的文字：psycopg 的原文和
    异常对象里有主机、端口和密码，所以在 except 外面抛新的错误，不把原来的异常挂在 __context__ 上带出去。"""
    failure = None
    try:
        name = "pg_kb_tools" + (f"@{_BUILD}" if _BUILD else "")
        conn = kb_store.connect(creds, application_name=name[:63], timeout=_CONNECT_TIMEOUT)
    except kb_store.KbError:
        raise
    except ImportError:
        failure = kb_store.KbError("internal_error", "运行环境里没有 psycopg（3），连不了数据库")
    except Exception as e:  # noqa: BLE001
        failure = kb_store.KbError("db_unavailable", _unavailable(e, str(getattr(e, "sqlstate", None) or "")))
    if failure is not None:
        raise failure
    conn.read_only = False   # kb_search 不能在只读事务里调（否则不写检索日志）；入库本来就要写
    try:
        with conn.cursor() as cur:
            for sql in _SESSION_SQL:
                cur.execute(sql)
        conn.commit()   # 会话级：之后的 rollback 撤不掉；连接回到空闲，入库锁仍是下一个事务的第一句
    except BaseException:
        _close(conn)
        raise
    return conn


def _close(conn) -> None:
    try:
        conn.close()
    except Exception:  # noqa: BLE001
        pass


# ═══════════════════════════════════════════════════════════════
# 工具 1：rules_writer
# ═══════════════════════════════════════════════════════════════
def _ingest_reply(status, plan, *, source_id, source_version, report, model, document_id=None) -> dict:
    out = {"success": True, "status": status, "source_id": source_id, "source_version": source_version,
           "rules_total": plan["rules_total"], "written": plan["inserted"] + plan["updated"] + plan["reembedded"],
           "removed": plan["removed"], "unchanged": plan["unchanged"], "conflicts": [], "report": report,
           "inserted": plan["inserted"], "updated": plan["updated"], "reembedded": plan["reembedded"],
           "embedding_model": model, "parser_version": kb_parse.PARSER_VERSION}
    if status == "previewed":
        out.update(will_insert=plan["will_insert"], will_update=plan["will_update"], will_remove=plan["will_remove"])
    elif out["written"] == 0 and out["removed"] == 0:
        out["status"] = "skipped"
    if document_id is not None:
        out["document_id"] = document_id
    return out


def _mark_failed(conn, doc_id, message) -> None:
    """入库失败：上传记录改成 failed（新的事务）。连接已断时作罢：这一行留在 ingesting，check 30 分钟后报 stuck_ingest。"""
    try:
        conn.rollback()
        with conn.cursor() as cur:
            kb_store.set_document_status(cur, doc_id, "failed", error=message)
        conn.commit()
    except Exception:  # noqa: BLE001
        _close(conn)


def _write(conn, creds, rows, report, *, path, file_name, source_id, source_version, source_doc, dry_run) -> dict:
    t = _table()
    with conn.cursor() as cur:
        model = kb_store.embed_model(cur)
    conn.rollback()   # 只读了 kb_meta：入库要在一个新事务里、以入库锁开头
    common = {"source_id": source_id, "source_version": source_version, "report": report, "model": model}
    if dry_run:
        try:
            plan = kb_store.ingest(conn, t, rows, source_tag=source_id, dry_run=True)
        except Exception as e:  # noqa: BLE001
            return _write_failure(e, creds, source_id, report)
        return _ingest_reply("previewed", plan, **common)

    # 1. 先记一行 ingesting、单独提交（留下痕迹）；2. 一个事务里入库（kb_store.ingest：锁 → 对比 → 向量 → 写 → 这一行改 ingested）
    with conn.cursor() as cur:
        doc_id = kb_store.record_document(cur, file_name=file_name, sha256=_file_hash(path), size_bytes=os.path.getsize(path),
                                          uploaded_by=_UPLOADED_BY, source_tag=source_id, doc_title=source_doc,
                                          source_version=source_version, report=report, status="ingesting")
    conn.commit()
    try:
        plan = kb_store.ingest(conn, t, rows, source_tag=source_id, document_id=doc_id)
    except Exception as e:  # noqa: BLE001
        failure = _write_failure(e, creds, source_id, report)
        _mark_failed(conn, doc_id, failure["message"])
        failure["document_id"] = doc_id
        return failure
    return _ingest_reply("ingested", plan, document_id=doc_id, **common)


def _write_failure(e, creds, source_id, report) -> dict:
    failure = _as_failure(e, creds)
    if failure["error_type"] == "rule_conflict":
        failure.update(source_id=source_id, report=report)
    return failure


@tool
def rules_writer(file_path: str, source_id: str, source_version: str = "", title: str = "", dry_run: bool = False) -> str:
    """
    把一份制度文档写入 PG 规则库（approval_rules，与审核 Agent 共用）：审批矩阵一行一条规则，正文按条一条；dry_run=True 只预览。

    步骤：检查附件 → 解析（.docx / .xlsx / .pdf / .md；审批矩阵编号如 C05-3.4 / G-02 / C05-NOTE，正文条款编号如 <source_id>-A12）
    → 在 kb_documents 记一行「入库中」→ 一个事务里：与库里的同一份制度对比 → 只为新增和正文改了的规则在库里生成向量
    （kb_embed_batch）→ 写入 → 删掉旧版本里有、新版本没有的编号 → 记成「已入库」。
      - 同一个 source_id 再传同一份内容：一条不写，status=skipped
      - 规则编号已属于另一份制度：整份拒绝（error_type=rule_conflict，conflicts 列出编号），什么都不写
      - 这份制度已下线：拒绝（source_inactive），先恢复或删除
      - dry_run=True（preview）：只对比，不写库、不生成向量、不记上传，status=previewed，另带将新增 / 更新 / 删除的编号
    数据库凭证经 Nexus 密钥注入（key_name=pg_kb，类型 database_credentials）；工具自己不调 Bedrock。

    Args:
        file_path: 附件路径；附件在 .cache/<agent_id>/<session_id>/nexus_ai_internal_attachments_temp/ 下
        source_id: 制度标识（2–63 位小写字母、数字或连字符，字母或数字开头），如 fin-approval；同一份制度的新版本用同一个
        source_version: 版本说明，如 V4.0；可空
        title: 文档名（写进每条规则的 source_doc）；不传就用附件的文件名
        dry_run: true 只预览（preview），不写库

    Returns:
        JSON 字符串：success / status（ingested / skipped / previewed）/ source_id / source_version / rules_total / written /
        removed / unchanged / conflicts / report（解析报告）/ inserted / updated（只改说明）/ reembedded / embedding_model /
        parser_version / document_id（上传记录编号，预览没有）；previewed 另带 will_insert / will_update / will_remove。
        失败时 success=false，附带 error_type / message / suggestion（rule_conflict 另带 conflicts）
    """
    creds = None
    try:
        source_id = _source_id(source_id)
        source_version, title = str(source_version or "").strip(), str(title or "").strip()
        if len(source_version) > _MAX_VERSION_CHARS or len(title) > _MAX_TITLE_CHARS:
            raise kb_store.KbError("invalid_parameter", f"source_version 至多 {_MAX_VERSION_CHARS} 字、title 至多 {_MAX_TITLE_CHARS} 字",
                                   suggestion="请缩短版本说明或文档名")
        creds = _credentials()
        path = _check_file(file_path)
        file_name = os.path.basename(path)
        source_doc = title or file_name
        records, report = kb_parse.parse_document(path, source_tag=source_id, doc_title=source_doc)
        rows = kb_store.prepare(records, source_tag=source_id, source_doc=source_doc, source_version=source_version)
        conn = _connect(creds)
        try:
            reply = _write(conn, creds, rows, report, path=path, file_name=file_name, source_id=source_id,
                           source_version=source_version, source_doc=source_doc, dry_run=_flag(dry_run))
        finally:
            _close(conn)
        return _dumps(reply)
    except Exception as e:  # noqa: BLE001
        return _dumps(_as_failure(e, creds))


# ═══════════════════════════════════════════════════════════════
# 工具 2：rules_search
# ═══════════════════════════════════════════════════════════════
def _hit(h: dict, row) -> dict:
    chapter_no, source_tag, content = row or (None, None, "")
    score = h.get("score")
    return {"rule_id": h["rule_id"], "rule_type": h.get("rule_type"), "chapter_no": chapter_no,
            "segments": [h["segment"]] if h.get("segment") else [], "amt_kind": None, "source_id": source_tag,
            "text": content or "", "distance": round(1 - float(score), 4) if score is not None else None,
            "business_item": h.get("business_item"), "amount_tier": h.get("amount_tier"),
            "approval_path_text": h.get("approval_path_text"), "final_approver": h.get("final_approver"),
            "keyword_hits": int(h.get("keyword_hits") or 0)}


@tool
def rules_search(question: str, segment: str = "", amount: float | None = None, top_k: int = 8) -> str:
    """
    按问题检索 PG 规则库：调库里的 kb_search（与审核 Agent 同一个函数，记检索日志），按关键词命中数、再按语义排序。

    segment、amount 收下但不用于过滤（PG 的板块过滤会漏掉「全板块」的行）：回复的 filter 里写明。
    每分钟至多 60 次检索（全库共用）；撞上上限回 rate_limited，不是「没查到」。
    数据库凭证经 Nexus 密钥注入（key_name=pg_kb，类型 database_credentials）。

    Args:
        question: 自然语言问题或关键词，如「合同用印 审批」；至多 2000 字
        segment: 板块名称（收下，不过滤）
        amount: 金额（元）（收下，不过滤）
        top_k: 返回条数，默认 8，范围 1–20

    Returns:
        JSON 字符串：success / filter / results（每条 rule_id / rule_type / chapter_no / segments / amt_kind（null）/ source_id /
        text（规则全文）/ distance（1 − 语义分）/ business_item / amount_tier / approval_path_text / final_approver / keyword_hits）。
        失败时 success=false，附带 error_type / message / suggestion
    """
    creds = None
    try:
        q = str(question or "").strip()
        if not q:
            raise kb_store.KbError("invalid_parameter", "question 不能为空", suggestion="请给要检索的问题")
        if len(q) > _MAX_QUESTION_CHARS:
            raise kb_store.KbError("invalid_parameter", f"question 至多 {_MAX_QUESTION_CHARS} 字", suggestion="请只给问题的要点")
        k = _top_k(top_k)
        creds = _credentials()
        conn = _connect(creds)
        try:
            with conn.cursor() as cur:
                hits = kb_store.search(cur, q, k, None, "agent")
                rows = {}
                ids = [h["rule_id"] for h in hits]
                if ids:
                    cur.execute(f"SELECT rule_id, chapter_no, source_tag, content FROM {_table()} WHERE rule_id = ANY(%s)", (ids,))
                    rows = {r[0]: r[1:] for r in cur.fetchall()}
            conn.commit()   # kb_search 写的检索日志随这次提交落库
        finally:
            _close(conn)
        return _dumps({"success": True, "filter": dict(_SEARCH_FILTER), "results": [_hit(h, rows.get(h["rule_id"])) for h in hits]})
    except Exception as e:  # noqa: BLE001
        return _dumps(_as_failure(e, creds))


# ═══════════════════════════════════════════════════════════════
# 工具 3：rules_manager
# ═══════════════════════════════════════════════════════════════
def _manage(conn, action: str, tag: str) -> dict:
    t = _table()
    if action == "list":
        with conn.cursor() as cur:
            sources = kb_store.list_sources(cur, t)
        conn.rollback()
        return {"success": True, "sources": sources}
    if action == "check":
        with conn.cursor() as cur:
            # 给了 source_id 却没有这份制度（规则表、归档表里都没有）：同 detail，回 not_found，不是「校验通过」
            missing = bool(tag) and kb_store.source_detail(cur, t, tag) is None
            result = None if missing else kb_store.check(cur, t, tag or None)
        if missing:
            conn.rollback()
            raise kb_store.KbError("not_found", f"知识库里没有制度「{tag}」，无从校验",
                                   suggestion="用 list 查看已有的制度；不带 source_id 的 check 校验全部（包括卡住的上传）")
        conn.commit()   # 只读校验；抽样重算的向量进了库里的缓存（每分钟上限按它数）
        return {"success": True, **result}
    with conn.cursor() as cur:
        detail = kb_store.source_detail(cur, t, tag)
        documents = 0
        if detail is None and action == "delete":   # 只剩上传记录（例如第一次入库就失败了）也能删
            cur.execute("SELECT to_regclass('public.kb_documents') IS NOT NULL")
            if cur.fetchone()[0]:
                cur.execute("SELECT count(*) FROM kb_documents WHERE source_tag = %s", (tag,))
                documents = cur.fetchone()[0]
    conn.rollback()
    if detail is None and not documents:
        raise kb_store.KbError("not_found", f"知识库里没有制度「{tag}」")
    if action == "detail":
        return {"success": True, "source": detail["source"], "rule_ids": detail["rule_ids"]}
    work = {"deactivate": kb_store.deactivate, "restore": kb_store.restore, "delete": kb_store.delete}[action]
    return {"success": True, "source_id": tag, "affected": work(conn, t, tag)}


@tool
def rules_manager(action: str, source_id: str = "") -> str:
    """
    PG 规则库管理：这个 Agent 支持哪些操作、制度清单、详情、下线、恢复、删除、一致性校验。

    支持的操作（action）：
      - describe:   支持的规则请求（kb.rules/v1）与解析器版本；不连库
      - list:       全部制度（来源标识、文档名、版本、文件名、文件哈希、规则条数、状态 active / inactive、时间）
      - detail:     一份制度的登记和它的全部规则编号（需 source_id）
      - deactivate: 下线一份制度（需 source_id）：规则挪进归档表，检索和审核 Agent 都看不到，可恢复
      - restore:    恢复下线的制度（需 source_id）
      - delete:     硬删除一份制度的全部规则和上传记录（需 source_id），不可恢复
      - check:      只读校验（没有向量、维度不对、没有标签、两张表重复编号、卡住的入库、登记与表里条数、向量模型）；
                    给 source_id 只查这一份（没有这份制度回 not_found），不给查全部
    数据库凭证经 Nexus 密钥注入（key_name=pg_kb，类型 database_credentials）。

    Args:
        action: describe / list / detail / deactivate / restore / delete / check
        source_id: 制度标识（detail / deactivate / restore / delete 必填；check 可空 = 全部），可从 list 获取

    Returns:
        JSON 字符串：
          describe: success / protocol / backend（pg）/ ops / parser_version
          list:     success / sources（每项 source_id / title / source_version / file_name / doc_hash / rules_total / status /
                    ingested_at / updated_at / by_type）
          detail:   success / source / rule_ids
          check:    success / ok / problems（每项 code / source_id / detail）
          deactivate / restore / delete: success / source_id / affected（挪动或删除的规则数）
        失败时 success=false，附带 error_type / message / suggestion
    """
    creds = None
    try:
        action = str(action or "").strip().lower()
        if action not in _ACTIONS:
            raise kb_store.KbError("invalid_parameter", f"action 无效：{action[:40]!r}，支持：{' / '.join(_ACTIONS)}")
        if action == "describe":
            return _dumps({"success": True, "protocol": _PROTOCOL, "backend": "pg", "ops": list(_OPS),
                           "parser_version": kb_parse.PARSER_VERSION, "build": _BUILD})
        tag = str(source_id or "").strip()
        if action in ("detail", "deactivate", "restore", "delete") or (action == "check" and tag):
            tag = _source_id(tag)
        creds = _credentials()
        conn = _connect(creds)
        try:
            reply = _manage(conn, action, tag)
        finally:
            _close(conn)
        return _dumps(reply)
    except Exception as e:  # noqa: BLE001
        return _dumps(_as_failure(e, creds))
