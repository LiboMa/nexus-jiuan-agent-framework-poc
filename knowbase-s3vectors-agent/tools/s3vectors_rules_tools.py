"""
S3 Vectors 规则工具集 - 知识库文档管家（S3 Vectors 版，knowbase_s3vectors_agent）的「规则」部分

审批矩阵类的制度一行一条规则、一条规则一个向量；审核 Agent 按问题检索，板块和金额的过滤条件由本工具的代码拼，
模型只填「问题、板块、金额、取几条」：
  - rules_writer:  解析附件里的审批矩阵 .docx → 每条规则一个向量写入规则索引 → 删掉这份制度旧版本里有、新版本没有的编号 → 更新登记
  - rules_search:  按问题检索规则；过滤 = 在线（active）且板块命中或全板块、且金额落在档位里或不是金额条件
  - rules_manager: 制度清单、详情、下线、恢复、删除、一致性校验

本模块单独导入成一个工具目录。与 s3vectors_kb_tools.py 共用的代码（凭证、客户端、嵌入、多取再截断、错误映射）复制在这里，
不 import 它（每个模块在 Nexus 里各自导入）。解析照搬 kb/lib/parse_rules.py 的 parse()（只用标准库）；
金额档照搬研究的 tiers.py 的 tier_interval()；元数据与过滤照 E10（e10_s3vectors.py 的 metadata_for() / s3v_filter()）。

存储布局（同一个向量桶，索引由 infra/aws_setup.sh 创建）：
  rules         一条规则一个向量。键 = 规则编号（C05-3.4 / G-02 / C05-NOTE）；向量 = Cohere Embed v4，1536 维，余弦距离
                可过滤：source_id / source_version / rule_type / chapter_no / segments / amt_kind / lo / lo_incl / hi / hi_incl /
                        active / ingested_at / rule_sha
                不可过滤：text（规则全文 = parse_rules 的 content，里面已有章名、业务事项、板块、金额档、审批路径、控制要点）
  rule_sources  一份制度一条登记。键 = source_id；1 维常量向量 [1.0]
                可过滤：source_version / rules_total / status（active / inactive）/ ingested_at / updated_at
                不可过滤：title / file_name / doc_hash
  audit         与 s3vectors_kb_tools.py 共用：每次入库、下线、恢复、删除记一条（operation = rules_*）

凭证：
  - S3 Vectors：Nexus 密钥注入（nexus_utils.secret_key.get_tool_credentials()），key_name=s3vectors_kb，类型 aws_credentials；
    绝不回落默认凭证链（在服务主机上那是平台自己的实例角色）。
  - Bedrock：运行环境的 IAM 角色（boto3 默认凭证链），不需要密钥。
"""

import hashlib
import json
import math
import os
import re
import time
import uuid
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from strands import tool

# >>> deploy-config：scripts/render.py 按 deploy.env 改写这一段；其余代码各环境相同
_REGION = "us-east-1"
_VECTOR_BUCKET = ""
_RULES_INDEX = ""
_SOURCES_INDEX = "rule_sources"
_AUDIT_INDEX = "audit"
# <<< deploy-config

# ─────────────────────── 常量 ────────────────────────
_MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024   # 与「制度知识库」页的上传上限一致
_MAX_FILE_NAME_CHARS = 255
_MAX_TITLE_CHARS = 200
_MAX_VERSION_CHARS = 64
_SOURCE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_FILTERABLE_MAX_BYTES = 2048              # S3 Vectors：每条向量的可过滤元数据 ≤ 2 KB
_METADATA_MAX_BYTES = 40 * 1024           # 元数据合计 ≤ 40 KB
_BIG = 1e13                               # 金额区间无界的一端用很大的数代替（与 E10 相同）
# 同一个模型的两个推理配置文件，向量完全相同：global 是 Nexus 平台缺省，不可用时退到 us
_EMBED_MODEL_IDS = ("global.cohere.embed-v4:0", "us.cohere.embed-v4:0")
_EMBED_DIMENSION = 1536
_EMBED_BATCH = 96                # Cohere Embed 单次请求最多 96 条
_EMBED_TIMEOUT_SECONDS = 120
_EMBED_MAX_RETRIES = 3
_TEXT_MAX_CHARS = 8192
_PUT_BATCH = 100                 # PutVectors 上限 500 条；与 s3vectors_kb_tools.py 一样按 100 条一批控制请求体大小
_GET_BATCH = 100                 # GetVectors 上限 100 个键
_DELETE_BATCH = 500              # DeleteVectors 上限 500 个键
_LIST_PAGE = 1000                # ListVectors 每页上限
_TOP_K_MAX = 100
_ACTIONS = ("list", "detail", "deactivate", "restore", "delete", "check")
_DENIED_CODES = {"AccessDenied", "AccessDeniedException", "UnrecognizedClientException", "InvalidClientTokenId",
                 "InvalidSignatureException", "SignatureDoesNotMatch", "ExpiredToken", "ExpiredTokenException"}
_NOT_FOUND_CODES = {"NotFoundException", "ResourceNotFoundException", "NoSuchVectorBucket", "NoSuchIndex"}
_BUSY_CODES = {"ThrottlingException", "TooManyRequestsException", "ServiceUnavailableException",
               "ServiceQuotaExceededException", "InternalServerException"}
_KEY_HINT = "在 Nexus「密钥管理」新建「AWS 凭证」类型的密钥（只授权本知识库的向量桶），并绑定到本工具（key_name=s3vectors_kb）"


# S3 Vectors 是近似检索：实测小索引上 topK=1 有时返回 0 条。所以每次多取一些（至少 2 倍、至少多 5 条，不超过 100）再按距离截断。
def _fetch_k(top_k: int) -> int:
    return min(_TOP_K_MAX, max(top_k * 2, top_k + 5))


class _CredentialsMissing(Exception):
    pass


class _NotConfigured(Exception):
    pass


# ═══════════════════════════════════════════════════════════════
#  解析：照搬 kb/lib/parse_rules.py 的 parse()（只用标准库；docx 是不可信输入）
# ═══════════════════════════════════════════════════════════════
_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_CHAPTER_RE = re.compile(r"^([一二三四五六七八九十]+)、(.+)$")
_CN_NUM = {c: i for i, c in enumerate("一二三四五六七八九十", start=1)}
_MARK_RE = re.compile(r"[①②③④⑤⑥⑦⑧⑨⑩]")
_MARK_NUM = {c: i for i, c in enumerate("①②③④⑤⑥⑦⑧⑨⑩", start=1)}
_FIXED_COLS = ("序号", "业务事项", "板块", "金额档 / 触发情形")
_SCOPE_COL = "适用范围与控制要点"


def _text_of(el):
    parts = []
    for p in el.iter(_W + "p"):
        parts.append("".join(t.text or "" for t in p.iter(_W + "t")))
    return "\n".join(s for s in (x.strip() for x in parts) if s)


def _cn_chapter_no(s):
    if s in _CN_NUM:
        return _CN_NUM[s]
    if s.startswith("十") and len(s) == 2:
        return 10 + _CN_NUM[s[1]]
    return None


def _norm(s):
    return re.sub(r"[\s　]+", " ", s or "").strip()


def _table_grid(tbl):
    """表格 → 行列表；每行是按网格列展开的 (文本, vMerge) 列表。"""
    rows = []
    for tr in tbl.findall(_W + "tr"):
        row = []
        for tc in tr.findall(_W + "tc"):
            pr = tc.find(_W + "tcPr")
            span, vm = 1, None
            if pr is not None:
                gs = pr.find(_W + "gridSpan")
                if gs is not None:
                    span = int(gs.get(_W + "val", "1"))
                v = pr.find(_W + "vMerge")
                if v is not None:
                    vm = v.get(_W + "val", "continue")
            txt = _text_of(tc)
            for k in range(span):
                row.append((txt if k == 0 else "", vm))
        rows.append(row)
    return rows


def _blank(rule_id, rule_type, chapter_no, chapter, content, **kw):
    rec = {"rule_id": rule_id, "rule_type": rule_type, "chapter_no": chapter_no, "chapter": chapter,
           "chapter_note": "", "seq_no": "", "business_item": "", "segment": "", "amount_tier": "",
           "approval_path": [], "approval_path_text": "", "final_approver": "", "post_actions": "",
           "not_applicable": "", "scope_controls": "", "extra": {}, "content": content}
    rec.update(kw)
    return rec


def _parse(src):
    with zipfile.ZipFile(src) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    body = root.find(_W + "body")

    general, records = [], []
    chapter, chapter_no, notes = None, None, []
    chapter_notes, chapter_titles = {}, {}
    in_preface = True
    for el in body:
        if el.tag == _W + "p":
            t = _norm(_text_of(el))
            if not t:
                continue
            m = _CHAPTER_RE.match(t)
            if m and _cn_chapter_no(m.group(1)):
                chapter, chapter_no, notes = t, _cn_chapter_no(m.group(1)), []
                chapter_notes[chapter_no], chapter_titles[chapter_no] = notes, chapter
                in_preface = False
                continue
            (general if in_preface else notes).append(t)
        elif el.tag == _W + "tbl":
            grid = _table_grid(el)
            if not grid or chapter is None:
                continue
            header = [_norm(c[0]) for c in grid[0]]
            if not header or header[0] != "序号":
                continue
            prev = [""] * len(header)
            rows = []
            for row in grid[1:]:
                vals = []
                for j in range(len(header)):
                    txt, vm = row[j] if j < len(row) else ("", None)
                    vals.append(prev[j] if vm == "continue" else txt)
                prev = vals
                rows.append(dict(zip(header, vals)))
            others = [h for h in header if h and h not in _FIXED_COLS and h != _SCOPE_COL]
            roles = [h for h in others
                     if any(_MARK_RE.search(r.get(h, "")) or "√" in r.get(h, "") or "▲" in r.get(h, "")
                            or _norm(r.get(h, "")) == "不适用" for r in rows)]
            notes_cols = [h for h in others if h not in roles]
            for cell in rows:
                seq = _norm(cell.get("序号", ""))
                if not seq:
                    continue
                path, post, excluded = [], [], []
                for r in roles:
                    v = _norm(cell.get(r, ""))
                    if not v:
                        continue
                    if v == "不适用":
                        excluded.append(r)
                        continue
                    nums = [_MARK_NUM[c] for c in _MARK_RE.findall(v)]
                    if nums:
                        path.append({"step": min(nums), "role": r, "mark": v, "final": "√" in v})
                    elif "▲" in v:
                        post.append(r)
                    else:
                        path.append({"step": None, "role": r, "mark": v, "final": "√" in v})
                path.sort(key=lambda x: (x["step"] is None, x["step"] or 0))
                final = [p["role"] for p in path if p["final"]]
                path_text = " → ".join(f'{p["role"]}{p["mark"]}' for p in path)
                if post:
                    path_text += "；审批后办理/报备：" + "、".join(post) + "（▲）"
                item = _norm(cell.get("业务事项", ""))
                seg = _norm(cell.get("板块", ""))
                tier = _norm(cell.get("金额档 / 触发情形", ""))
                scope = (cell.get(_SCOPE_COL, "") or "").strip()
                extra = {h: _norm(cell.get(h, "")) for h in notes_cols if _norm(cell.get(h, ""))}
                if not path and tier == "不适用":
                    path_desc, final_desc = "该板块不适用此事项", "不适用"
                else:
                    path_desc, final_desc = path_text or "无", "、".join(final) or "未标注"
                content = (f"【{chapter}】{seq} {item}｜板块：{seg}｜金额档/触发情形：{tier}"
                           f"｜审批路径：{path_desc}"
                           f"｜最终审批：{final_desc}"
                           + (f"｜不适用：{'、'.join(excluded)}" if excluded else "")
                           + "".join(f"｜{h}：{v}" for h, v in extra.items())
                           + (f"｜适用范围与控制要点：{_norm(scope)}" if scope else ""))
                records.append(_blank(
                    f"C{chapter_no:02d}-{seq}", "matrix", chapter_no, chapter, content,
                    seq_no=seq, business_item=item, segment=seg, amount_tier=tier,
                    approval_path=path, approval_path_text=path_text, final_approver="、".join(final),
                    post_actions="、".join(post), not_applicable="、".join(excluded),
                    scope_controls=scope, extra=extra))

    # 制度说明（一）~（五）与图例 → general（跳过封面与修改记录；「图例说明」这个标题本身不成条）
    start = next((i for i, t in enumerate(general) if t == "制度说明"), None)
    gen = [t for t in (general[start + 1:] if start is not None else []) if t != "图例说明"]
    gen_records = [_blank(f"G-{i:02d}", "general", 0, "制度说明 / 图例说明", f"【制度说明 / 图例说明】{t}",
                          seq_no=str(i), business_item=t.split("。")[0][:40])
                   for i, t in enumerate(gen, start=1)]

    note_records = []
    for no in sorted(chapter_notes):
        text = "\n".join(chapter_notes[no])
        for r in records:
            if r["chapter_no"] == no:
                r["chapter_note"] = text
        if text:
            note_records.append(_blank(f"C{no:02d}-NOTE", "chapter_note", no, chapter_titles[no],
                                       f"【{chapter_titles[no]}】章节说明：{_norm(text)}",
                                       chapter_note=text, business_item=chapter_titles[no]))
    return gen_records, note_records, records


def parse_matrix(path) -> tuple[list, dict]:
    """解析审批矩阵 .docx，返回 (规则记录, report)。记录顺序与 parse_rules.py 的输出相同（制度说明、章节说明、矩阵行）；
    report 与它末行的 REPORT 相同：各类条数、各章行数、重复编号、缺审批路径的行。"""
    gen_records, note_records, records = _parse(path)
    out = gen_records + note_records + records
    counts = Counter(r["rule_id"] for r in out)
    chapters = [{"no": no, "title": ch, "rows": sum(1 for r in records if r["chapter_no"] == no)}
                for no, ch in sorted({(r["chapter_no"], r["chapter"]) for r in records})]
    report = {"general": len(gen_records), "chapter_notes": len(note_records), "matrix": len(records), "total": len(out),
              "chapters": chapters, "duplicates": sorted(i for i, n in counts.items() if n > 1),
              "without_path": [r["rule_id"] for r in records if not r["approval_path"] and r["amount_tier"] != "不适用"]}
    return out, report


# ═══════════════════════════════════════════════════════════════
#  金额档、元数据、过滤（照研究 tiers.py 与 E10）
# ═══════════════════════════════════════════════════════════════
_NUM = r"([0-9]+(?:\.[0-9]+)?)\s*万"
_OP = r"(≥|>|＞|≤|<|＜)"
_CMP = re.compile(_OP + r"\s*" + _NUM)


def tier_interval(text) -> tuple:
    """「金额档 / 触发情形」文字 → (lo, lo_incl, hi, hi_incl, kind)，单位元（照搬研究的 tiers.py）。
    kind：range（有明确上下界，任一端可为 None）/ any（不论金额、不限金额、全额）/
          mixed（一格里混了多个子事项、各有金额条件）/ None（不是金额条件）。"""
    s = (text or "").strip()
    if not s:
        return (None, False, None, False, None)
    if "升级事项" in s or "；" in s and "个人借款" in s:
        return (None, False, None, False, "mixed")
    if any(k in s for k in ("不论金额", "不限金额", "全额")):
        return (None, False, None, False, "any")
    cmps = _CMP.findall(s)
    if not cmps:
        return (None, False, None, False, None)
    lo = hi = None
    lo_incl = hi_incl = False
    for op, num in cmps:
        v = float(num) * 10000
        if op in ("≥", ">", "＞"):
            lo, lo_incl = v, op == "≥"
        else:
            hi, hi_incl = v, op == "≤"
    return (lo, lo_incl, hi, hi_incl, "range")


def _segments(s) -> set:
    """「板块」文字 → 板块集合；空或「全板块」= {"*"}（与 E10 的 segs() 相同）。"""
    s = (s or "").replace(" ", "")
    if not s or s == "全板块":
        return {"*"}
    return {x for x in s.replace("／", "/").split("/") if x}


_SHA_FIELDS = ("text", "source_version", "rule_type", "chapter_no", "segments", "amt_kind", "lo", "lo_incl", "hi", "hi_incl")


def rule_metadata(rule: dict, source: dict) -> dict:
    """一条规则的元数据：E10 的 metadata_for() 再加 source_id / source_version / active / ingested_at / rule_sha。
    source：{source_id, source_version, ingested_at, active（缺省 true）}。
    text（规则全文）是不可过滤键；业务事项、审批路径这些长字段不另存，免得可过滤元数据超过 2 KB。
    rule_sha = 正文与元数据（不含 active、ingested_at）的 sha256 前 16 位：再入库时相同就不重写。"""
    lo, lo_incl, hi, hi_incl, kind = tier_interval(rule.get("amount_tier"))
    md = {
        "source_id": str(source["source_id"]),
        "source_version": str(source.get("source_version") or ""),
        "rule_type": rule["rule_type"],
        "chapter_no": int(rule["chapter_no"]),
        "segments": sorted(_segments(rule.get("segment"))),
        "amt_kind": "range" if kind == "range" else "other",
        "lo": float(lo) if lo is not None else -_BIG, "lo_incl": bool(lo_incl) if lo is not None else True,
        "hi": float(hi) if hi is not None else _BIG, "hi_incl": bool(hi_incl) if hi is not None else True,
        "active": bool(source.get("active", True)),
        "ingested_at": int(source.get("ingested_at") or 0),
        "text": rule["content"],
    }
    basis = json.dumps({k: md[k] for k in _SHA_FIELDS}, ensure_ascii=False, sort_keys=True)
    md["rule_sha"] = hashlib.sha256(basis.encode("utf-8")).hexdigest()[:16]
    return md


def build_filter(segment: str, amount) -> dict:
    """检索用的过滤条件：active=true，且（给了板块时）板块命中或全板块，且（给了金额时）金额落在区间里或不是金额条件。
    与 E10 的 s3v_filter(f, use_seg=True, use_amt=True, use_ch=False) 同义；不按章节过滤。"""
    conds = [{"active": {"$eq": True}}]
    seg = str(segment or "").strip()
    if seg:
        conds.append({"$or": [{"segments": {"$eq": seg}}, {"segments": {"$eq": "*"}}]})
    if amount is not None:
        a = float(amount)
        lo_ok = {"$or": [{"$and": [{"lo_incl": {"$eq": True}}, {"lo": {"$lte": a}}]},
                         {"$and": [{"lo_incl": {"$eq": False}}, {"lo": {"$lt": a}}]}]}
        hi_ok = {"$or": [{"$and": [{"hi_incl": {"$eq": True}}, {"hi": {"$gte": a}}]},
                         {"$and": [{"hi_incl": {"$eq": False}}, {"hi": {"$gt": a}}]}]}
        conds.append({"$or": [{"amt_kind": {"$ne": "range"}}, {"$and": [lo_ok, hi_ok]}]})
    return conds[0] if len(conds) == 1 else {"$and": conds}


def _metadata_fits(md: dict) -> bool:
    filterable = {k: v for k, v in md.items() if k != "text"}
    return (len(json.dumps(filterable, ensure_ascii=False).encode("utf-8")) <= _FILTERABLE_MAX_BYTES
            and len(json.dumps(md, ensure_ascii=False).encode("utf-8")) <= _METADATA_MAX_BYTES)


# ═══════════════════════════════════════════════════════════════
#  通用辅助（照 s3vectors_kb_tools.py 复制）
# ═══════════════════════════════════════════════════════════════
def _dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False)


def _fail(error_type: str, message: str, suggestion: str = "", **extra: Any) -> str:
    out = {"success": False, "error_type": error_type, "message": message}
    if suggestion:
        out["suggestion"] = suggestion
    out.update(extra)
    return _dumps(out)


def _error_code(e: Exception) -> str:
    resp = getattr(e, "response", None)
    if isinstance(resp, dict):
        return str((resp.get("Error") or {}).get("Code") or "")
    return ""


def _aws_fail(e: Exception, action: str) -> str:
    """把 boto3 异常翻译成工具的错误返回；只带错误码和截断的说明，不带凭证。"""
    code = _error_code(e)
    detail = str(e)[:300]
    if code in _DENIED_CODES:
        return _fail("access_denied", f"{action}被拒绝（{code}）：S3 Vectors 密钥无效、已停用，或没有本知识库向量桶的权限",
                     f"确认绑定的密钥属于专用 IAM 用户、其策略覆盖向量桶 {_VECTOR_BUCKET}；{_KEY_HINT}")
    if code in _NOT_FOUND_CODES:
        return _fail("kb_not_found", f"{action}失败（{code}）：找不到向量桶 {_VECTOR_BUCKET} 或其中的索引",
                     f"请管理员确认 infra/aws_setup.sh 已在正确的区域建好向量桶与 {_RULES_INDEX} / {_SOURCES_INDEX} / "
                     f"{_AUDIT_INDEX} 索引")
    if code in _BUSY_CODES:
        return _fail("kb_busy", f"{action}暂时失败（{code}），S3 Vectors 正忙或限流", "请稍后重试")
    if code == "ValidationException":
        return _fail("invalid_request", f"{action}的请求被 S3 Vectors 拒绝：{detail}", "请检查参数（键、过滤条件、元数据大小）")
    return _fail("unexpected_error", f"{action}失败（{type(e).__name__}{'/' + code if code else ''}）：{detail}",
                 "请稍后重试；问题持续请联系管理员查看平台日志")


def _now() -> int:
    return int(time.time())


def _iso(ts: Any) -> str | None:
    try:
        return datetime.fromtimestamp(int(ts), timezone.utc).isoformat(timespec="seconds")
    except Exception:
        return None


def _validate_path(file_path: str, agent_id: str = "", session_id: str = "") -> tuple[bool, str]:
    """校验文件路径合法性，防止路径穿越攻击。当 agent_id 与 session_id 均提供时，限定路径必须位于工作区内。"""
    try:
        resolved = Path(file_path).resolve()
        resolved_str = str(resolved)
        forbidden_prefixes = ["/etc", "/sys", "/proc", "/dev", "/root", "/var/run", "/boot"]
        for prefix in forbidden_prefixes:
            if resolved_str.startswith(prefix):
                return False, f"路径 {resolved_str} 涉及敏感系统目录，访问被拒绝"
        if agent_id and session_id:
            workspace = str(Path(f".cache/{agent_id}/{session_id}").resolve())
            if not resolved_str.startswith(workspace):
                return False, f"文件路径必须位于工作区 .cache/{agent_id}/{session_id}/ 内，禁止路径穿越"
        return True, resolved_str
    except Exception as e:
        return False, f"路径解析异常: {str(e)}"


def _compute_file_hash(file_path: str) -> str:
    sha256 = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


# ─────────────────────── 凭证与客户端 ────────────────────────
def _kb_credentials() -> dict:
    """S3 Vectors 只认 Nexus 注入的密钥：绝不回落到默认凭证链（在服务主机上那是平台自己的实例角色）。"""
    from nexus_utils.secret_key import get_tool_credentials
    creds = get_tool_credentials() or {}
    if not creds.get("access_key_id") or not creds.get("secret_access_key"):
        raise _CredentialsMissing()
    return creds


def _s3v_client(creds: dict):
    import boto3
    from botocore.config import Config
    session = boto3.Session(
        aws_access_key_id=creds["access_key_id"],
        aws_secret_access_key=creds["secret_access_key"],
        aws_session_token=creds.get("session_token") or None,
        region_name=_REGION,
    )
    return session.client("s3vectors", config=Config(connect_timeout=10, read_timeout=60,
                                                     retries={"max_attempts": 3, "mode": "adaptive"}))


def _client():
    """渲染段为空（没按环境渲染就导入了）时不发任何请求。"""
    if not _VECTOR_BUCKET or not _RULES_INDEX:
        raise _NotConfigured()
    return _s3v_client(_kb_credentials())


def _runtime_bedrock_client():
    """boto3 默认凭证链：隔离环境 VM 内是平台按会话签发的 sandbox-vm-role 短期令牌；主机上是实例角色。"""
    import boto3
    from botocore.config import Config
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or _REGION
    return boto3.client("bedrock-runtime", region_name=region,
                        config=Config(read_timeout=_EMBED_TIMEOUT_SECONDS,
                                      retries={"max_attempts": _EMBED_MAX_RETRIES, "mode": "adaptive"}))


def _credentials_fail() -> str:
    return _fail("credentials_missing", "S3 Vectors 访问密钥未配置或不完整（需要 access_key_id / secret_access_key）", _KEY_HINT)


def _not_configured_fail() -> str:
    return _fail("not_configured", "规则工具还没按环境渲染：向量桶名或规则索引名为空",
                 "请管理员用 scripts/render.py 按 deploy.env 生成本环境的工具文件，再导入 Nexus")


# ─────────────────────── 向量化 ────────────────────────
def _embed_texts(texts: list, purpose: str) -> tuple[list, str]:
    """调 Bedrock Cohere Embed v4 生成 1536 维向量，返回 (向量列表, 实际模型 id)。
    全部成功才返回，任何一批失败就抛异常：宁可整份不写，也不写半份向量。
    第一个推理配置文件没有权限或不可用时换下一个（同一个模型，向量相同）。"""
    client = _runtime_bedrock_client()
    input_type = "search_query" if purpose == "query" else "search_document"
    last_error: Exception | None = None
    for n, model_id in enumerate(_EMBED_MODEL_IDS):
        try:
            vectors: list = []
            for s in range(0, len(texts), _EMBED_BATCH):
                part = [str(t)[:_TEXT_MAX_CHARS] for t in texts[s:s + _EMBED_BATCH]]
                body = {"texts": part, "input_type": input_type, "embedding_types": ["float"],
                        "output_dimension": _EMBED_DIMENSION, "truncate": "END"}
                resp = client.invoke_model(modelId=model_id, body=json.dumps(body),
                                           contentType="application/json", accept="application/json")
                out = json.loads(resp["body"].read())["embeddings"]
                out = out["float"] if isinstance(out, dict) else out
                if len(out) != len(part) or any(len(v) != _EMBED_DIMENSION for v in out):
                    raise ValueError(f"嵌入结果条数或维度不对（期望 {len(part)} 条、{_EMBED_DIMENSION} 维）")
                vectors.extend(out)
            return vectors, model_id
        except Exception as e:  # noqa: BLE001
            last_error = e
            if _error_code(e) in ("AccessDeniedException", "ValidationException", "ResourceNotFoundException") \
                    and n < len(_EMBED_MODEL_IDS) - 1:
                continue
            raise
    raise last_error  # pragma: no cover


def _embed_fail(e: Exception) -> str:
    code = _error_code(e)
    if code in _DENIED_CODES or "NoCredentials" in type(e).__name__:
        return _fail("embedding_access_denied", f"运行环境的 IAM 角色无法调用 Cohere Embed v4（{code or type(e).__name__}）",
                     "确认运行环境角色有 bedrock:InvokeModel 权限、该模型已在本区域开通")
    return _fail("embedding_failed", f"向量化失败（{type(e).__name__}{'/' + code if code else ''}）：{str(e)[:200]}",
                 "请稍后重试；规则库内容没有改动")


# ─────────────────────── S3 Vectors 读写辅助 ────────────────────────
def _put(client, index: str, vectors: list) -> None:
    for s in range(0, len(vectors), _PUT_BATCH):
        client.put_vectors(vectorBucketName=_VECTOR_BUCKET, indexName=index, vectors=vectors[s:s + _PUT_BATCH])


def _delete(client, index: str, keys: list) -> None:
    for s in range(0, len(keys), _DELETE_BATCH):
        client.delete_vectors(vectorBucketName=_VECTOR_BUCKET, indexName=index, keys=keys[s:s + _DELETE_BATCH])


def _get(client, index: str, keys: list, with_data: bool = False) -> list:
    out: list = []
    keys = list(dict.fromkeys(keys))
    for s in range(0, len(keys), _GET_BATCH):
        r = client.get_vectors(vectorBucketName=_VECTOR_BUCKET, indexName=index, keys=keys[s:s + _GET_BATCH],
                               returnData=with_data, returnMetadata=True)
        out.extend(r.get("vectors") or [])
    return out


def _list(client, index: str) -> list:
    """分页列出索引里的全部向量（带元数据、不带向量数据）。规则索引是几百条的量级，整份扫描代价很小。"""
    items: list = []
    token = None
    while True:
        kw = {"vectorBucketName": _VECTOR_BUCKET, "indexName": index, "maxResults": _LIST_PAGE,
              "returnMetadata": True, "returnData": False}
        if token:
            kw["nextToken"] = token
        r = client.list_vectors(**kw)
        items.extend(r.get("vectors") or [])
        token = r.get("nextToken")
        if not token:
            return items


def _get_source(client, source_id: str) -> dict | None:
    found = _get(client, _SOURCES_INDEX, [source_id])
    return found[0] if found else None


def _put_source(client, source_id: str, md: dict) -> None:
    _put(client, _SOURCES_INDEX, [{"key": source_id, "data": {"float32": [1.0]}, "metadata": md}])


def _own_rules(client, source_id: str) -> list:
    """这份制度在规则索引里的全部编号。"""
    return sorted(v["key"] for v in _list(client, _RULES_INDEX) if (v.get("metadata") or {}).get("source_id") == source_id)


def _audit(client, operation: str, source_id: str, detail: dict) -> str:
    """写一条操作记录，返回 audit_log_id；写失败返回空串，不影响主操作（与 s3vectors_kb_tools.py 相同）。"""
    now = time.time()
    log_id = f"{int(now * 1000):013d}-{uuid.uuid4().hex[:8]}"
    try:
        client.put_vectors(vectorBucketName=_VECTOR_BUCKET, indexName=_AUDIT_INDEX, vectors=[{
            "key": log_id, "data": {"float32": [1.0]},
            "metadata": {"operation": operation, "source_id": source_id or "", "at": int(now),
                         "detail": json.dumps(detail, ensure_ascii=False)[:8000]},
        }])
    except Exception:  # noqa: BLE001
        return ""
    return log_id


def _source_view(source_id: str, md: dict) -> dict:
    return {"source_id": source_id, "title": md.get("title") or "", "source_version": md.get("source_version") or "",
            "file_name": md.get("file_name") or "", "doc_hash": md.get("doc_hash") or "",
            "rules_total": int(md.get("rules_total") or 0), "status": md.get("status") or "active",
            "ingested_at": _iso(md.get("ingested_at")), "updated_at": _iso(md.get("updated_at"))}


def _check_file(file_path: str):
    """附件校验，返回 (绝对路径, 错误 JSON 或 None)。"""
    fp = str(file_path or "").strip()
    if not fp:
        return None, _fail("invalid_parameter", "file_path 不能为空", "请给附件里审批矩阵 .docx 的路径")
    if Path(fp).suffix.lower() != ".docx":
        return None, _fail("unsupported_format", f"只支持审批矩阵格式的 Word（.docx），收到：{os.path.basename(fp)}",
                           "请上传 .docx（旧版 .doc 请先另存为 .docx）")
    ok, path_or_error = _validate_path(fp)
    if not ok:
        return None, _fail("invalid_path", path_or_error, "请确保文件路径位于允许的工作区目录内，不含路径穿越字符")
    path = path_or_error
    if not os.path.isfile(path):
        return None, _fail("file_not_found", f"文件不存在：{os.path.basename(path)}",
                           "附件在 .cache/<agent_id>/<session_id>/nexus_ai_internal_attachments_temp/ 下；"
                           "不确定时先用 runtime_workspace_list_files 列出该目录")
    size = os.path.getsize(path)
    if size == 0:
        return None, _fail("empty_file", f"文件为空：{os.path.basename(path)}", "请检查文件内容是否完整")
    if size > _MAX_FILE_SIZE_BYTES:
        return None, _fail("file_too_large", f"文件大小 {size // (1024 * 1024)}MB 超过 20MB 上限", "请确认上传的是制度原件")
    return path, None


def _check_source_id(source_id: str) -> str:
    if not _SOURCE_ID_RE.match(source_id):
        return _fail("invalid_parameter", f"source_id 不合法：{source_id[:80]!r}",
                     "source_id 由字母、数字、点、下划线、连字符组成（1~64 位，字母或数字开头），如 fin-approval")
    return ""


# ═══════════════════════════════════════════════════════════════
# 工具 1：rules_writer
# ═══════════════════════════════════════════════════════════════
@tool
def rules_writer(file_path: str, source_id: str, source_version: str = "", title: str = "") -> str:
    """
    把一份审批矩阵格式的制度（.docx）写入规则库：一行一条规则、一条一个向量（Cohere Embed v4，1536 维）。

    步骤：解析附件（制度说明、章节说明、矩阵每一行各成一条，编号如 C05-3.4 / G-02 / C05-NOTE）→ 算元数据
    （板块、金额区间等，供 rules_search 过滤）→ 只对新增和改动的规则向量化并写入 → 删掉这份制度旧版本里有、
    新版本没有的编号 → 更新制度登记。
      - 同一个 source_id 再上传同一文件（且版本、标题没变）：不重写，status=skipped，直接返回现状
      - 规则编号已属于另一个 source_id 时整份拒绝（error_type=rule_conflict），conflicts 列出冲突编号，什么都不写
      - 已下线的制度上传新版本：照样入库，仍是下线状态
    S3 Vectors 凭证经 Nexus 密钥注入（key_name=s3vectors_kb，类型 aws_credentials）；Bedrock 用运行环境的 IAM 角色。

    Args:
        file_path: 审批矩阵 .docx 的路径；附件在 .cache/<agent_id>/<session_id>/nexus_ai_internal_attachments_temp/ 下
        source_id: 这份制度的标识（字母、数字、点、下划线、连字符，1~64 位），如 fin-approval；同一份制度的新版本用同一个
        source_version: 制度版本，如 V4.0；不传则沿用上次的版本
        title: 制度名称；不传则沿用上次的名称，首次入库时用文件名

    Returns:
        JSON 字符串：success / status（ingested / skipped）/ source_id / source_version / rules_total /
        written（写入的规则数）/ removed（删掉的旧编号数）/ unchanged（没变、没重写的规则数）/ conflicts（冲突编号）/
        report（解析报告：general / chapter_notes / matrix / total / chapters / duplicates / without_path）。
        失败时 success=false，附带 error_type / message / suggestion（冲突时另有 conflicts 与 report）
    """
    try:
        source_id = str(source_id or "").strip()
        err = _check_source_id(source_id)
        if err:
            return err
        source_version, title = str(source_version or "").strip(), str(title or "").strip()
        if len(source_version) > _MAX_VERSION_CHARS or len(title) > _MAX_TITLE_CHARS:
            return _fail("invalid_parameter", f"source_version 最多 {_MAX_VERSION_CHARS} 字、title 最多 {_MAX_TITLE_CHARS} 字",
                         "请缩短版本号或制度名称")
        path, err = _check_file(file_path)
        if err:
            return err
        file_name = os.path.basename(path)[:_MAX_FILE_NAME_CHARS]
        try:
            records, report = parse_matrix(path)
        except Exception as e:  # noqa: BLE001
            return _fail("parse_failed", f"文件「{file_name}」无法解析（{type(e).__name__}）：可能已损坏，或不是 Word 文档",
                         "请用 Word 重新另存为 .docx 后再上传")
        if not report["matrix"] or report["duplicates"]:
            why = f"有重复的规则编号 {', '.join(report['duplicates'][:10])}" if report["duplicates"] else "没有找到审批矩阵表格"
            return _fail("not_a_matrix", f"文件「{file_name}」{why}：文档结构与解析器不匹配，没有写入",
                         "审批矩阵每章一张表，表头第一列是「序号」，并有「业务事项」「板块」「金额档 / 触发情形」列",
                         report=report)
        doc_hash = _compute_file_hash(path)

        client = _client()
        old = _get_source(client, source_id)
        old_md = (old or {}).get("metadata") or {}
        source_version = source_version or str(old_md.get("source_version") or "")
        title = title or str(old_md.get("title") or "") or Path(file_name).stem[:_MAX_TITLE_CHARS]
        if old and old_md.get("doc_hash") == doc_hash and old_md.get("source_version", "") == source_version \
                and old_md.get("title") == title:
            n = int(old_md.get("rules_total") or 0)
            return _dumps({"success": True, "status": "skipped", "source_id": source_id, "source_version": source_version,
                           "rules_total": n, "written": 0, "removed": 0, "unchanged": n, "conflicts": [], "report": report})

        now = _now()
        active = old_md.get("status") != "inactive"
        src = {"source_id": source_id, "source_version": source_version, "ingested_at": now, "active": active}
        mds = {r["rule_id"]: rule_metadata(r, src) for r in records}
        too_big = [rid for rid, md in mds.items() if not _metadata_fits(md)]
        if too_big:
            return _fail("metadata_too_large", f"{len(too_big)} 条规则的元数据超过 S3 Vectors 的上限（可过滤部分 2 KB），没有写入",
                         "多半是「板块」一格写得太长；请检查这些行", rule_ids=too_big, report=report)

        existing = {v["key"]: v.get("metadata") or {} for v in _list(client, _RULES_INDEX)}
        conflicts = sorted(rid for rid in mds if rid in existing and existing[rid].get("source_id") != source_id)
        if conflicts:
            owners = sorted({str(existing[rid].get("source_id")) for rid in conflicts})
            return _fail("rule_conflict", f"{len(conflicts)} 条规则编号已属于别的制度（{', '.join(owners)}），整份没有写入",
                         "确认是不是同一份制度：是就用原来的 source_id 上传；不是就先下线或删除那一份",
                         source_id=source_id, conflicts=conflicts, report=report)
        own = {k: md for k, md in existing.items() if md.get("source_id") == source_id}
        to_write = [rid for rid, md in mds.items()
                    if rid not in own or own[rid].get("rule_sha") != md["rule_sha"] or own[rid].get("active") is not active]
        removed = sorted(k for k in own if k not in mds)

        model_id = ""
        if to_write:
            try:
                vectors, model_id = _embed_texts([mds[rid]["text"] for rid in to_write], "document")
            except Exception as e:  # noqa: BLE001
                return _embed_fail(e)
        registry = {"title": title, "source_version": source_version, "file_name": file_name, "doc_hash": doc_hash,
                    "rules_total": len(records), "status": "active" if active else "inactive",
                    "ingested_at": int(old_md.get("ingested_at") or now), "updated_at": now}
        try:
            # 先写规则、再删旧编号、最后改登记：中途失败时登记还是上一版，再上传同一文件会补齐（没变的规则按 rule_sha 跳过）
            if to_write:
                _put(client, _RULES_INDEX, [{"key": rid, "data": {"float32": v}, "metadata": mds[rid]}
                                            for rid, v in zip(to_write, vectors)])
            if removed:
                _delete(client, _RULES_INDEX, removed)
            _put_source(client, source_id, registry)
        except Exception as e:  # noqa: BLE001
            _audit(client, "rules_ingest_failed", source_id, {"file_name": file_name, "error": _error_code(e) or type(e).__name__})
            out = json.loads(_aws_fail(e, "写入规则"))
            out.update({"error_type": "write_failed", "source_id": source_id,
                        "suggestion": "登记仍是上一版；再上传一次同一文件会补齐，也可先执行 check 查看情况"})
            return _dumps(out)
        counts = {"rules_total": len(records), "written": len(to_write), "removed": len(removed),
                  "unchanged": len(records) - len(to_write)}
        _audit(client, "rules_ingest", source_id, {"source_version": source_version, "file_name": file_name,
                                                    "embedding_model": model_id, **counts})
        return _dumps({"success": True, "status": "ingested", "source_id": source_id, "source_version": source_version,
                       **counts, "conflicts": [], "report": report})
    except _NotConfigured:
        return _not_configured_fail()
    except _CredentialsMissing:
        return _credentials_fail()
    except ImportError as e:
        return _fail("dependency_missing", f"依赖库缺失：{e}", "请确认运行环境装有 boto3")
    except Exception as e:  # noqa: BLE001
        return _aws_fail(e, "写入规则库")


# ═══════════════════════════════════════════════════════════════
# 工具 2：rules_search
# ═══════════════════════════════════════════════════════════════
def _parse_amount(value) -> tuple[float | None, str]:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None, ""
    if isinstance(value, bool):
        return None, "amount 须是以元为单位的数字"
    try:
        a = float(value)
    except (TypeError, ValueError):
        return None, f"amount 读不出金额：{str(value)[:40]!r}（须是以元为单位的数字）"
    if not math.isfinite(a):
        return None, "amount 须是有限的数字"
    return a, ""


def _rule_hit(v: dict) -> dict:
    md = v.get("metadata") or {}
    return {"rule_id": v.get("key"), "rule_type": md.get("rule_type"), "chapter_no": int(md.get("chapter_no") or 0),
            "segments": md.get("segments") or [], "amt_kind": md.get("amt_kind"), "source_id": md.get("source_id"),
            "text": md.get("text") or "", "distance": round(float(v.get("distance", 1.0)), 6)}


@tool
def rules_search(question: str, segment: str = "", amount: float | None = None, top_k: int = 8) -> str:
    """
    按问题检索规则库（审批矩阵一行一条），板块与金额的过滤条件由工具代码拼，不要自己写过滤条件。

    过滤：只查在线（active）的规则；给了 segment 时只留该板块或全板块的规则；给了 amount 时只留金额落在档位里的规则，
    不是金额条件的规则（不论金额、研发项目、混合条件等）始终保留。没给的那一项不过滤。不按章节过滤。
    问句由工具自己转成向量（Cohere Embed v4，search_query），按余弦距离从近到远返回。
    S3 Vectors 凭证经 Nexus 密钥注入（key_name=s3vectors_kb，类型 aws_credentials）。

    Args:
        question: 自然语言问题，如「九安板块对公付款 30 万元，谁最终审批」
        segment: 板块名称，如「九安」；不确定时不传
        amount: 金额（元），如 300000；读不出金额时不传
        top_k: 返回条数，默认 8，最大 100

    Returns:
        JSON 字符串：success / filter（实际用的过滤条件）/ results（每条 rule_id / rule_type / chapter_no / segments /
        amt_kind / source_id / text（规则全文）/ distance，按距离从小到大）。失败时 success=false，附带 error_type / message / suggestion
    """
    try:
        q = str(question or "").strip()
        if not q:
            return _fail("invalid_parameter", "question 不能为空", "请给要检索的问题")
        try:
            k = max(1, min(int(top_k), _TOP_K_MAX))
        except (TypeError, ValueError):
            return _fail("invalid_parameter", f"top_k 须是整数，收到：{top_k!r}", "使用默认值 8 即可")
        amt, err = _parse_amount(amount)
        if err:
            return _fail("invalid_parameter", err, "读不出金额时不要传 amount")
        flt = build_filter(segment, amt)
        client = _client()
        try:
            qvec = _embed_texts([q], "query")[0][0]
        except Exception as e:  # noqa: BLE001
            return _embed_fail(e)
        r = client.query_vectors(vectorBucketName=_VECTOR_BUCKET, indexName=_RULES_INDEX, topK=_fetch_k(k),
                                 queryVector={"float32": qvec}, filter=flt, returnMetadata=True, returnDistance=True)
        hits = sorted(r.get("vectors") or [], key=lambda x: float(x.get("distance", 1.0)))[:k]
        return _dumps({"success": True, "filter": flt, "results": [_rule_hit(v) for v in hits]})
    except _NotConfigured:
        return _not_configured_fail()
    except _CredentialsMissing:
        return _credentials_fail()
    except Exception as e:  # noqa: BLE001
        return _aws_fail(e, "检索规则库")


# ═══════════════════════════════════════════════════════════════
# 工具 3：rules_manager
# ═══════════════════════════════════════════════════════════════
def _set_active(client, keys: list, active: bool) -> int:
    """下线 / 恢复：改写这些规则的 active（S3 Vectors 只能整条覆盖，所以连向量一起取回再写，距离不变）。"""
    changed = 0
    for s in range(0, len(keys), _GET_BATCH):
        batch = []
        for v in _get(client, _RULES_INDEX, keys[s:s + _GET_BATCH], with_data=True):
            md = dict(v.get("metadata") or {})
            if md.get("active") is active:
                continue
            md["active"] = active
            batch.append({"key": v["key"], "data": v["data"], "metadata": md})
        if batch:
            _put(client, _RULES_INDEX, batch)
            changed += len(batch)
    return changed


def _op_check(client, only: str) -> str:
    """只读：登记的条数、上下线状态与规则索引里的键是否一致；有没有不属于任何登记的规则。"""
    sources = {v["key"]: v.get("metadata") or {} for v in _list(client, _SOURCES_INDEX)}
    per: dict = {}
    for v in _list(client, _RULES_INDEX):
        md = v.get("metadata") or {}
        n = per.setdefault(str(md.get("source_id") or ""), {"total": 0, "active": 0})
        n["total"] += 1
        n["active"] += md.get("active") is True
    problems = []
    for sid in sorted(sources):
        if only and sid != only:
            continue
        md, n = sources[sid], per.get(sid, {"total": 0, "active": 0})
        registered = int(md.get("rules_total") or 0)
        if registered != n["total"]:
            problems.append({"kind": "count_mismatch", "source_id": sid, "registered": registered, "indexed": n["total"],
                             "message": f"「{sid}」登记 {registered} 条，索引里有 {n['total']} 条；再上传一次这份制度可修复"})
        status = md.get("status") or "active"
        wrong = n["total"] - n["active"] if status == "active" else n["active"]
        if wrong:
            problems.append({"kind": "status_mismatch", "source_id": sid, "status": status, "rules": wrong,
                             "message": f"「{sid}」登记为 {status}，但有 {wrong} 条规则的 active 标记不符；"
                                        f"再执行一次 {'restore' if status == 'active' else 'deactivate'} 可修复"})
    for sid in sorted(set(per) - set(sources)):
        if only and sid != only:
            continue
        problems.append({"kind": "unregistered_rules", "source_id": sid, "rules": per[sid]["total"],
                         "message": f"有 {per[sid]['total']} 条规则属于没有登记的「{sid}」；"
                                    f"上一次入库可能没完成，再上传一次或执行 delete 清理"})
    return _dumps({"success": True, "ok": not problems, "problems": problems})


@tool
def rules_manager(action: str, source_id: str = "") -> str:
    """
    规则库管理：制度清单、详情、下线、恢复、删除、一致性校验。

    支持的操作（action）：
      - list:       全部制度的登记（来源标识、名称、版本、文件名、文件哈希、规则条数、状态、时间）
      - detail:     一份制度的登记和它的全部规则编号（需 source_id）
      - deactivate: 下线一份制度（需 source_id）：它的规则 active=false，检索不到，可恢复
      - restore:    恢复下线的制度（需 source_id）
      - delete:     硬删除一份制度的全部规则和登记（需 source_id），不可恢复
      - check:      只读校验：登记条数与索引里的键数、上下线标记是否一致，有没有没登记的规则；给 source_id 时只查这一份
    deactivate / restore / delete 各写一条操作记录。
    S3 Vectors 凭证经 Nexus 密钥注入（key_name=s3vectors_kb，类型 aws_credentials）。

    Args:
        action: list / detail / deactivate / restore / delete / check
        source_id: 制度标识（detail / deactivate / restore / delete 必填），可从 list 获取

    Returns:
        JSON 字符串：
          list:   success / sources（每项 source_id / title / source_version / file_name / doc_hash / rules_total /
                  status（active / inactive）/ ingested_at / updated_at）
          detail: success / source / rule_ids
          check:  success / ok / problems（每项 kind / source_id / message 等）
          deactivate / restore / delete: success / source_id / affected（改动或删除的规则数）
        失败时 success=false，附带 error_type / message / suggestion
    """
    try:
        action = str(action or "").strip().lower()
        if action not in _ACTIONS:
            return _fail("invalid_parameter", f"action 无效：{action!r}，支持：{' / '.join(_ACTIONS)}", "请选择正确的操作")
        source_id = str(source_id or "").strip()
        if action not in ("list", "check") or source_id:
            if not source_id:
                return _fail("invalid_parameter", f"{action} 操作必须提供 source_id", "可先用 action=list 查看制度清单")
            err = _check_source_id(source_id)
            if err:
                return err
        client = _client()
        if action == "list":
            items = [_source_view(v["key"], v.get("metadata") or {}) for v in _list(client, _SOURCES_INDEX)]
            items.sort(key=lambda s: (s["ingested_at"] or "", s["source_id"]), reverse=True)
            return _dumps({"success": True, "sources": items})
        if action == "check":
            return _op_check(client, source_id)

        reg = _get_source(client, source_id)
        own = _own_rules(client, source_id)
        if not reg and not (action == "delete" and own):
            return _fail("source_not_found", f"规则库里没有制度「{source_id}」", "请用 action=list 查看已有的制度")
        if action == "detail":
            return _dumps({"success": True, "source": _source_view(source_id, reg.get("metadata") or {}), "rule_ids": own})
        if action == "delete":
            if own:
                _delete(client, _RULES_INDEX, own)
            if reg:
                _delete(client, _SOURCES_INDEX, [source_id])
            _audit(client, "rules_delete", source_id, {"deleted_rules": len(own)})
            return _dumps({"success": True, "source_id": source_id, "affected": len(own)})

        active = action == "restore"
        changed = _set_active(client, own, active)
        md = dict(reg.get("metadata") or {})
        md.update({"status": "active" if active else "inactive", "updated_at": _now()})
        _put_source(client, source_id, md)
        _audit(client, f"rules_{action}", source_id, {"rules": len(own), "changed": changed})
        return _dumps({"success": True, "source_id": source_id, "affected": changed})
    except _NotConfigured:
        return _not_configured_fail()
    except _CredentialsMissing:
        return _credentials_fail()
    except Exception as e:  # noqa: BLE001
        return _aws_fail(e, "规则库管理操作")
