"""
S3 Vectors 知识库工具集 - 知识库文档管家（S3 Vectors 版，knowbase_s3vectors_agent）

与 PostgreSQL 版（knowbase_writer_agent）的工具一一对应：
  - document_parser:       解析 Word/Excel/PDF 文档（与 PostgreSQL 版相同）
  - text_chunker:          文本分块（与 PostgreSQL 版相同）
  - s3vectors_writer:      对应 pgvector_connector。向量化并写入 S3 Vectors；给附件路径就能一步入库
  - s3vectors_search:      对应 vector_search。语义检索 / 按文档列出文本块；过滤条件由代码拼
  - s3vectors_manager:     对应 vector_manager。删除（硬 / 软）、恢复、一致性校验
  - s3vectors_statistics:  对应 kb_statistics。Dashboard 统计、文档清单、文档详情、内容抽样

和 PostgreSQL 版最大的不同：向量不经过模型。写入和检索工具自己调 Bedrock 生成向量，
模型只传文字（或附件路径），不用在工具之间搬运上千个浮点数。

存储布局（一个向量桶、三个索引，由 infra/aws_setup.sh 创建）：
  chunks  一个文本块一条。键 {doc_id}#{chunk_index:05d}；向量 = Cohere Embed v4，1536 维，余弦距离
          可过滤：doc_id / chunk_index / active / file_format / ingested_at / char_count / tags
          不可过滤：text（正文）/ file_name
  docs    一份文档一条（文档登记表）。键 doc_id；向量 = 该文档全部文本块向量的平均（归一化）
          可过滤：doc_id / status / file_format / chunk_count / ingested_at / updated_at / tags
          不可过滤：file_name / doc_hash / embedding_model / page_or_row_count / quality_flag
  audit   每次写入、删除、恢复一条操作记录。键 {毫秒时间戳}-{随机串}；1 维常量向量
          可过滤：operation / doc_id / at；不可过滤：detail

凭证：
  - S3 Vectors：Nexus 密钥注入（nexus_utils.secret_key.get_tool_credentials()），key_name=s3vectors_kb，
    类型 aws_credentials，字段 access_key_id / secret_access_key / session_token（可选）。
    这把密钥只对本知识库的向量桶有读写权限（infra/writer-policy.json.tmpl）。
    隔离环境（VM）的运行角色对用户自己的向量桶没有读写权限，所以读写都用这把密钥。
  - Bedrock：运行环境的 IAM 角色（boto3 默认凭证链），不需要密钥。
"""

import hashlib
import json
import math
import os
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from strands import tool

# >>> deploy-config：scripts/render.py 按 deploy.env 改写这一段；其余代码各环境相同
_REGION = "us-east-1"
_VECTOR_BUCKET = "knowbase-s3v-demo"
_CHUNK_INDEX = "chunks"
_DOC_INDEX = "docs"
_AUDIT_INDEX = "audit"
# <<< deploy-config

# ─────────────────────── 常量 ────────────────────────
_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024  # 50 MB
_SUPPORTED_FORMATS = {"docx", "xlsx", "pdf", "doc", "xls"}
_FORMAT_MAP = {
    "doc": "docx", "docx": "docx",
    "xls": "xlsx", "xlsx": "xlsx",
    "pdf": "pdf",
    ".doc": "docx", ".docx": "docx",
    ".xls": "xlsx", ".xlsx": "xlsx",
    ".pdf": "pdf",
}


# ─────────────────────── 路径安全 ────────────────────────
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


# ─────────────────────── 文本清洗 ────────────────────────
def _clean_text(text: str) -> str:
    """去除控制字符，合并多余空白，保留合理换行。"""
    if not text:
        return ""
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ─────────────────────── 格式解析器 ────────────────────────
def _parse_docx(file_path: str, file_name: str) -> tuple[str, list[dict[str, Any]]]:
    """解析 DOCX：提取段落（含标题层级）和表格行。"""
    import docx  # python-docx

    doc = docx.Document(file_path)
    parts: list[str] = []
    page_or_row_count = 0

    # 段落
    for para in doc.paragraphs:
        text = _clean_text(para.text)
        if not text:
            continue
        style_name = para.style.name if para.style else "Normal"
        # 标题加分隔符增强结构感
        if style_name.startswith("Heading"):
            parts.append(f"\n## {text}\n")
        else:
            parts.append(text)
        page_or_row_count += 1

    # 表格
    for table in doc.tables:
        for row in table.rows:
            cells = [_clean_text(c.text) for c in row.cells if _clean_text(c.text)]
            if cells:
                parts.append(" | ".join(cells))
                page_or_row_count += 1

    structured_text = "\n".join(parts)
    metadata = {
        "file_name": file_name,
        "file_format": "docx",
        "page_or_row_count": page_or_row_count,
    }
    return structured_text, metadata


def _parse_xlsx(file_path: str, file_name: str) -> tuple[str, list[dict[str, Any]]]:
    """解析 XLSX：按工作表行列提取，保留表结构语义。"""
    import openpyxl

    wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
    parts: list[str] = []
    row_count = 0

    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        parts.append(f"\n=== 工作表: {sheet_name} ===")
        for row_idx, row in enumerate(ws.iter_rows(values_only=True), start=1):
            cells = []
            for cell in row:
                if cell is not None:
                    s = _clean_text(str(cell))
                    if s:
                        cells.append(s)
            if cells:
                parts.append(f"[行{row_idx}] " + " | ".join(cells))
                row_count += 1
    wb.close()

    structured_text = "\n".join(parts)
    metadata = {
        "file_name": file_name,
        "file_format": "xlsx",
        "page_or_row_count": row_count,
    }
    return structured_text, metadata


def _parse_pdf_with_pdfplumber(file_path: str) -> tuple[str, int]:
    """使用 pdfplumber 提取 PDF 文本层。"""
    import pdfplumber

    pages_text: list[str] = []
    with pdfplumber.open(file_path) as pdf:
        for page in pdf.pages:
            text = page.extract_text(x_tolerance=3, y_tolerance=3) or ""
            if not text:
                words = page.extract_words()
                if words:
                    text = " ".join(w["text"] for w in words)
            text = _clean_text(text)
            if text:
                pages_text.append(text)
    return "\n\n".join(pages_text), len(pages_text)


def _parse_pdf_with_ocr(file_path: str) -> tuple[str, int, bool]:
    """对无文本层的扫描 PDF 进行 OCR 识别。返回 (text, page_count, ocr_success)。"""
    try:
        import pytesseract
        from pdf2image import convert_from_path

        pages = convert_from_path(file_path, dpi=200)
        texts: list[str] = []
        for page_img in pages:
            page_text = pytesseract.image_to_string(page_img, lang="chi_sim+eng")
            page_text = _clean_text(page_text)
            if page_text:
                texts.append(page_text)
        return "\n\n".join(texts), len(pages), True
    except Exception:
        return "", 0, False


def _parse_pdf(file_path: str, file_name: str, enable_ocr: bool = True) -> tuple[str, list[dict[str, Any]], str]:
    """
    解析 PDF：先尝试提取文本层，若内容为空则触发 OCR。
    返回 (structured_text, metadata, quality_flag)。
    """
    text, page_count = _parse_pdf_with_pdfplumber(file_path)
    quality_flag = "ok"

    if not text.strip() and enable_ocr:
        # 无文本层，尝试 OCR
        ocr_text, ocr_pages, ocr_ok = _parse_pdf_with_ocr(file_path)
        if ocr_ok and ocr_text.strip():
            text = ocr_text
            page_count = ocr_pages
            quality_flag = "ok"
        else:
            # OCR 也失败，降级返回空文本并标记
            quality_flag = "low_quality_ocr"
    elif not text.strip():
        quality_flag = "low_quality_ocr"

    metadata = {
        "file_name": file_name,
        "file_format": "pdf",
        "page_or_row_count": page_count,
    }
    return text, metadata, quality_flag


# ─────────────────────── SHA256 哈希 ────────────────────────
def _compute_file_hash(file_path: str) -> str:
    """计算文件 SHA256 哈希，用于幂等去重。"""
    sha256 = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


# ═══════════════════════════════════════════════════════════════
# 工具 1：document_parser
# ═══════════════════════════════════════════════════════════════
@tool
def document_parser(
    file_path: str,
    file_format: str,
    enable_ocr: bool = True,
) -> str:
    """
    解析 Word（.docx）、Excel（.xlsx）、PDF（.pdf）文档，抽取结构化文本与元数据，支持扫描 PDF OCR 识别。

    按格式分别处理：
      - docx：提取段落/标题层级/表格，保留结构语义
      - xlsx：按工作表行列提取，保留表结构
      - pdf：提取文本层；无文本层扫描件触发 OCR（pytesseract + pdf2image）
    同时计算文档内容 SHA256 哈希，用于注入管道的幂等去重判断。

    Args:
        file_path: 待解析文档的本地路径，须位于工作区 .cache/<agent_id>/<session_id>/ 内，禁止路径穿越
        file_format: 文档格式枚举：docx / xlsx / pdf（不区分大小写）
        enable_ocr: 是否对无文本层的扫描 PDF 启用 OCR，默认 true

    Returns:
        JSON 字符串，包含：
          success (bool) - 是否成功
          structured_text (str) - 提取的结构化文本
          metadata (dict) - file_name / file_format / page_or_row_count
          doc_hash (str) - 文件内容 SHA256
          quality_flag (str) - 解析质量：ok / low_quality_ocr
        失败时返回 success=false，附带 error_type / message / suggestion
    """
    try:
        # ── 1. 参数校验 ──
        if not file_path or not file_path.strip():
            return json.dumps({
                "success": False,
                "error_type": "invalid_parameter",
                "message": "file_path 不能为空",
                "suggestion": "请提供有效的文件路径"
            }, ensure_ascii=False)

        fmt = (file_format or "").strip().lower()
        if fmt not in _FORMAT_MAP:
            return json.dumps({
                "success": False,
                "error_type": "unsupported_format",
                "message": f"不支持的文件格式 '{file_format}'，仅支持 docx / xlsx / pdf",
                "suggestion": "请上传 Word（.docx）、Excel（.xlsx）或 PDF（.pdf）格式文件"
            }, ensure_ascii=False)
        resolved_fmt = _FORMAT_MAP[fmt]

        # ── 2. 路径合法性校验 ──
        is_valid, path_or_error = _validate_path(file_path)
        if not is_valid:
            return json.dumps({
                "success": False,
                "error_type": "invalid_path",
                "message": path_or_error,
                "suggestion": "请确保文件路径位于允许的工作区目录内，不含路径穿越字符"
            }, ensure_ascii=False)
        resolved_path = path_or_error

        # ── 3. 文件存在性与大小校验 ──
        if not os.path.isfile(resolved_path):
            return json.dumps({
                "success": False,
                "error_type": "file_not_found",
                "message": f"文件不存在：{os.path.basename(resolved_path)}",
                "suggestion": "请确认文件已上传到工作区"
            }, ensure_ascii=False)

        file_size = os.path.getsize(resolved_path)
        if file_size == 0:
            return json.dumps({
                "success": False,
                "error_type": "empty_file",
                "message": f"文件为空：{os.path.basename(resolved_path)}",
                "suggestion": "请检查文件内容是否完整"
            }, ensure_ascii=False)

        if file_size > _MAX_FILE_SIZE_BYTES:
            size_mb = file_size // (1024 * 1024)
            return json.dumps({
                "success": False,
                "error_type": "file_too_large",
                "message": f"文件大小 {size_mb}MB 超过 50MB 上限",
                "suggestion": "请拆分文件后分批上传"
            }, ensure_ascii=False)

        file_name = os.path.basename(resolved_path)

        # ── 4. 计算文件哈希 ──
        doc_hash = _compute_file_hash(resolved_path)

        # ── 5. 按格式解析 ──
        quality_flag = "ok"

        if resolved_fmt == "docx":
            structured_text, metadata = _parse_docx(resolved_path, file_name)
        elif resolved_fmt == "xlsx":
            structured_text, metadata = _parse_xlsx(resolved_path, file_name)
        else:  # pdf
            structured_text, metadata, quality_flag = _parse_pdf(resolved_path, file_name, enable_ocr)

        # ── 6. 空内容检查 ──
        if not structured_text or not structured_text.strip():
            if quality_flag == "low_quality_ocr":
                return json.dumps({
                    "success": False,
                    "error_type": "parse_failed",
                    "message": f"文档「{file_name}」为扫描件，OCR 识别质量较低，未能提取到有效文本",
                    "suggestion": "建议人工复核或提供清晰度更高的文件",
                    "quality_flag": quality_flag
                }, ensure_ascii=False)
            return json.dumps({
                "success": False,
                "error_type": "empty_content",
                "message": f"文档「{file_name}」未提取到任何文本内容",
                "suggestion": "请确认文档内包含可读文本，扫描件请启用 OCR 选项"
            }, ensure_ascii=False)

        return json.dumps({
            "success": True,
            "structured_text": structured_text,
            "metadata": metadata,
            "doc_hash": doc_hash,
            "quality_flag": quality_flag
        }, ensure_ascii=False)

    except ImportError as e:
        return json.dumps({
            "success": False,
            "error_type": "dependency_missing",
            "message": f"依赖库缺失，请检查环境配置：{str(e)}",
            "suggestion": "请确认已安装 python-docx / openpyxl / pdfplumber / pytesseract / pdf2image"
        }, ensure_ascii=False)
    except Exception as e:
        err_type = type(e).__name__
        err_str = str(e).lower()
        if any(k in err_str for k in ["corrupt", "invalid", "badzipfile", "bad zip"]):
            return json.dumps({
                "success": False,
                "error_type": "parse_failed",
                "message": f"文件「{os.path.basename(file_path)}」可能已损坏或格式不兼容",
                "suggestion": "请重新导出或转换文件后再试"
            }, ensure_ascii=False)
        return json.dumps({
            "success": False,
            "error_type": "parse_failed",
            "message": f"文件解析失败（{err_type}）：{str(e)[:300]}",
            "suggestion": "请确认文件格式正确且文件未损坏"
        }, ensure_ascii=False)


# ═══════════════════════════════════════════════════════════════
# 工具 2：text_chunker
# ═══════════════════════════════════════════════════════════════
def _split_into_sentences(text: str) -> list[str]:
    """
    按句子/段落粒度初步分割文本，优先利用自然段落边界。
    """
    # 按双换行分段
    paragraphs = [p.strip() for p in re.split(r"\n{2,}", text) if p.strip()]
    if not paragraphs:
        # 回退：按单换行分
        paragraphs = [p.strip() for p in text.split("\n") if p.strip()]
    if not paragraphs:
        paragraphs = [text.strip()]
    return paragraphs


def _build_chunks(
    paragraphs: list[str],
    chunk_size: int,
    chunk_overlap: int,
) -> list[dict[str, Any]]:
    """
    将段落列表合并为固定大小（字符数）的文本块，块间保持重叠。
    返回 chunk 列表，每项含 chunk_index / content / char_count。
    """
    chunks: list[dict[str, Any]] = []
    current_chars: list[str] = []
    current_len = 0
    chunk_idx = 0

    for para in paragraphs:
        para_len = len(para)
        # 单段落超过 chunk_size 时强制按字符切割
        if para_len > chunk_size:
            # 先保存当前缓冲
            if current_chars:
                content = "\n\n".join(current_chars)
                chunks.append({
                    "chunk_index": chunk_idx,
                    "content": content,
                    "metadata": {"char_count": len(content)},
                })
                chunk_idx += 1
                current_chars = []
                current_len = 0
            # 强制分割长段落
            start = 0
            while start < para_len:
                end = min(start + chunk_size, para_len)
                slice_text = para[start:end]
                chunks.append({
                    "chunk_index": chunk_idx,
                    "content": slice_text,
                    "metadata": {"char_count": len(slice_text)},
                })
                chunk_idx += 1
                start += chunk_size - chunk_overlap
            continue

        # 若加入当前段落后超过 chunk_size，先输出当前块
        if current_len + para_len + (2 if current_chars else 0) > chunk_size and current_chars:
            content = "\n\n".join(current_chars)
            chunks.append({
                "chunk_index": chunk_idx,
                "content": content,
                "metadata": {"char_count": len(content)},
            })
            chunk_idx += 1
            # 保留最后若干字符作为重叠
            overlap_text = content[-chunk_overlap:] if chunk_overlap > 0 else ""
            current_chars = [overlap_text] if overlap_text else []
            current_len = len(overlap_text)

        current_chars.append(para)
        current_len += para_len + 2  # +2 for "\n\n"

    # 输出剩余内容
    if current_chars:
        content = "\n\n".join(current_chars)
        chunks.append({
            "chunk_index": chunk_idx,
            "content": content,
            "metadata": {"char_count": len(content)},
        })

    return chunks


@tool
def text_chunker(
    text: str,
    chunk_size: int = 512,
    chunk_overlap: int = 64,
) -> str:
    """
    将解析后的长文本按语义/固定字符长度加重叠切分为文本块，供后续向量化使用。

    优先以自然段落/双换行为边界聚合文本块，在段落内部超长时强制切割。
    每个文本块携带 chunk_index（块序号）与 metadata（含 char_count），为向量化做准备。
    相邻块保持 chunk_overlap 字符的重叠，确保跨块上下文完整性。

    Args:
        text: 待分块的原始结构化文本（来自 document_parser 的 structured_text）
        chunk_size: 单块最大字符数，默认 512，有效范围 64~8192
        chunk_overlap: 相邻块重叠字符数，默认 64，必须小于 chunk_size

    Returns:
        JSON 字符串，包含：
          success (bool) - 是否成功
          chunks (list) - 文本块列表，每项含 chunk_index / content / metadata
          total_chunks (int) - 总块数
        失败时返回 success=false，附带 error_type / message
    """
    try:
        # ── 1. 参数校验 ──
        if not text or not text.strip():
            return json.dumps({
                "success": False,
                "error_type": "empty_content",
                "message": "输入文本为空，无法分块",
                "suggestion": "请确认 document_parser 已成功提取文本内容"
            }, ensure_ascii=False)

        # chunk_size 范围
        if not isinstance(chunk_size, int) or chunk_size < 64 or chunk_size > 8192:
            return json.dumps({
                "success": False,
                "error_type": "invalid_parameter",
                "message": f"chunk_size 必须为 64~8192 之间的整数，当前值：{chunk_size}",
                "suggestion": "建议使用默认值 512"
            }, ensure_ascii=False)

        # chunk_overlap 范围
        if not isinstance(chunk_overlap, int) or chunk_overlap < 0:
            return json.dumps({
                "success": False,
                "error_type": "invalid_parameter",
                "message": f"chunk_overlap 必须为非负整数，当前值：{chunk_overlap}",
                "suggestion": "建议使用默认值 64"
            }, ensure_ascii=False)

        if chunk_overlap >= chunk_size:
            return json.dumps({
                "success": False,
                "error_type": "invalid_parameter",
                "message": f"chunk_overlap（{chunk_overlap}）必须小于 chunk_size（{chunk_size}）",
                "suggestion": f"请将 chunk_overlap 设置为小于 {chunk_size} 的值"
            }, ensure_ascii=False)

        # ── 2. 分段 ──
        paragraphs = _split_into_sentences(text.strip())

        # ── 3. 构建文本块 ──
        chunks = _build_chunks(paragraphs, chunk_size, chunk_overlap)

        if not chunks:
            return json.dumps({
                "success": False,
                "error_type": "empty_content",
                "message": "分块结果为空，文档可能不含有效文本内容",
                "suggestion": "请确认文档内有可读文本"
            }, ensure_ascii=False)

        return json.dumps({
            "success": True,
            "chunks": chunks,
            "total_chunks": len(chunks)
        }, ensure_ascii=False)

    except Exception as e:
        return json.dumps({
            "success": False,
            "error_type": "chunking_error",
            "message": f"文本分块失败（{type(e).__name__}）：{str(e)[:300]}",
            "suggestion": "请检查输入文本格式是否正常"
        }, ensure_ascii=False)


# ═══════════════════════════════════════════════════════════════
#  S3 Vectors 部分
# ═══════════════════════════════════════════════════════════════

# ─────────────────────── 常量 ────────────────────────
# 同一个模型的两个推理配置文件，向量完全相同：global 是 Nexus 平台缺省（连接器查询也用它），不可用时退到 us
_EMBED_MODEL_IDS = ("global.cohere.embed-v4:0", "us.cohere.embed-v4:0")
_EMBED_DIMENSION = 1536          # Cohere v4 原生维度 = Nexus s3_vector 连接器查询时的维度；索引建好后不能改
_EMBED_BATCH = 96                # Cohere Embed 单次请求最多 96 条
_EMBED_TIMEOUT_SECONDS = 120
_EMBED_MAX_RETRIES = 3
_TEXT_MAX_CHARS = 8192           # 与 text_chunker 的 chunk_size 上限一致
_PUT_BATCH = 100                 # PutVectors 上限 500 条；正文最长 8 KB，按 100 条一批控制请求体大小
_GET_BATCH = 100                 # GetVectors 上限 100 个键
_DELETE_BATCH = 500              # DeleteVectors 上限 500 个键
_LIST_PAGE = 1000                # ListVectors 每页上限
_TOP_K_MAX = 100
# S3 Vectors 是近似检索：实测 3 个向量的小索引上 topK=1 有时返回 0 条、topK=3 只回 2 条。
# 所以每次多取一些（至少 2 倍、至少多 5 条，不超过 100）再按距离截断到 top_k。
def _fetch_k(top_k: int) -> int:
    return min(_TOP_K_MAX, max(top_k * 2, top_k + 5))
_SCAN_LIMIT = 200_000            # 一致性校验最多扫描的文本块数
_CONTENT_MAX_CHARS = 4000        # 检索结果里每条正文最多返回的字数
_MAX_TAGS = 10
_MAX_TAG_CHARS = 32
_MAX_TAG_BYTES = 600         # 标签合计（UTF-8）：可过滤元数据每条只有 2 KB，标签不能挤占其余字段
_MAX_FILE_NAME_CHARS = 255
_DEFAULT_PAGE_SIZE = 20
_MAX_PAGE_SIZE = 100
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_DOC_ID_RE = re.compile(r"^doc_[0-9a-f]{24}$")
_DENIED_CODES = {"AccessDenied", "AccessDeniedException", "UnrecognizedClientException", "InvalidClientTokenId",
                 "InvalidSignatureException", "SignatureDoesNotMatch", "ExpiredToken", "ExpiredTokenException"}
_NOT_FOUND_CODES = {"NotFoundException", "ResourceNotFoundException", "NoSuchVectorBucket", "NoSuchIndex"}
_BUSY_CODES = {"ThrottlingException", "TooManyRequestsException", "ServiceUnavailableException",
               "ServiceQuotaExceededException", "InternalServerException"}
_KEY_HINT = "在 Nexus「密钥管理」新建「AWS 凭证」类型的密钥（只授权本知识库的向量桶），并绑定到本工具（key_name=s3vectors_kb）"


class _CredentialsMissing(Exception):
    pass


# ─────────────────────── 通用辅助 ────────────────────────
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
                     "请管理员确认 infra/aws_setup.sh 已在正确的区域建好向量桶与 chunks / docs / audit 三个索引")
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


def _doc_id(doc_hash: str) -> str:
    """doc_id 由文件内容的 SHA256 推出：同一份内容永远是同一个 doc_id，入库天然幂等。"""
    return "doc_" + doc_hash[:24]


def _chunk_key(doc_id: str, chunk_index: int) -> str:
    return f"{doc_id}#{int(chunk_index):05d}"


def _as_list(value: Any) -> list:
    if value is None or value == "":
        return []
    if isinstance(value, (list, tuple, set)):
        return [str(v) for v in value if str(v).strip()]
    return [str(value)]


def _clean_tags(tags: Any) -> tuple[list, str]:
    items = _as_list(tags)
    if len(items) > _MAX_TAGS:
        return [], f"tags 最多 {_MAX_TAGS} 个"
    cleaned = []
    for t in items:
        t = t.strip()
        if len(t) > _MAX_TAG_CHARS:
            return [], f"标签「{t[:20]}…」超过 {_MAX_TAG_CHARS} 字"
        if t and t not in cleaned:
            cleaned.append(t)
    if len(json.dumps(cleaned, ensure_ascii=False).encode("utf-8")) > _MAX_TAG_BYTES:
        return [], f"标签合计超过 {_MAX_TAG_BYTES} 字节，请减少个数或缩短"
    return cleaned, ""


def _clip(text: Any, limit: int = _CONTENT_MAX_CHARS) -> str:
    text = str(text or "")
    return text if len(text) <= limit else text[:limit] + "…（已截断）"


def _and(conds: list) -> dict | None:
    conds = [c for c in conds if c]
    if not conds:
        return None
    return conds[0] if len(conds) == 1 else {"$and": conds}


def _any_tag(tags: list) -> dict | None:
    """列表型元数据用 $eq 匹配「包含该元素」；多个标签任一命中。"""
    if not tags:
        return None
    conds = [{"tags": {"$eq": t}} for t in tags]
    return conds[0] if len(conds) == 1 else {"$or": conds}


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


# ─────────────────────── 向量化 ────────────────────────
def _embed_texts(texts: list, purpose: str) -> tuple[list, str]:
    """调 Bedrock Cohere Embed v4 生成 1536 维向量，返回 (向量列表, 实际模型 id)。

    全部成功才返回，任何一批失败就抛异常：宁可整份不写，也不写半份向量。
    第一个推理配置文件没有权限或不可用时换下一个（同一个模型，向量相同）。
    """
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
                 "请稍后重试；知识库内容没有改动")


def _normalize(vec: list) -> list:
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


def _mean_vector(vectors: list) -> list:
    acc = [0.0] * _EMBED_DIMENSION
    for v in vectors:
        for i, x in enumerate(_normalize(v)):
            acc[i] += x
    return _normalize(acc)


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


def _list(client, index: str, limit: int | None = None, with_metadata: bool = True) -> tuple[list, bool]:
    """分页列出索引里的全部向量（不带向量数据），返回 (条目, 是否因 limit 截断)。
    with_metadata=False 只取键：文本块的元数据含正文，全量扫描时只取键，传输量小几个数量级。"""
    items: list = []
    token = None
    while True:
        kw = {"vectorBucketName": _VECTOR_BUCKET, "indexName": index, "maxResults": _LIST_PAGE,
              "returnMetadata": with_metadata, "returnData": False}
        if token:
            kw["nextToken"] = token
        r = client.list_vectors(**kw)
        items.extend(r.get("vectors") or [])
        token = r.get("nextToken")
        if not token:
            return items, False
        if limit and len(items) >= limit:
            return items, True


def _get_doc(client, doc_id: str, with_data: bool = False) -> dict | None:
    found = _get(client, _DOC_INDEX, [doc_id], with_data=with_data)
    return found[0] if found else None


def _audit(client, operation: str, doc_id: str, detail: dict) -> str:
    """写一条操作记录，返回 audit_log_id；写失败返回空串，不影响主操作（与 PostgreSQL 版的审计日志一致）。"""
    now = time.time()
    log_id = f"{int(now * 1000):013d}-{uuid.uuid4().hex[:8]}"
    try:
        client.put_vectors(vectorBucketName=_VECTOR_BUCKET, indexName=_AUDIT_INDEX, vectors=[{
            "key": log_id, "data": {"float32": [1.0]},
            "metadata": {"operation": operation, "doc_id": doc_id or "", "at": int(now),
                         "detail": json.dumps(detail, ensure_ascii=False)[:8000]},
        }])
    except Exception:  # noqa: BLE001
        return ""
    return log_id


def _doc_record(doc: dict, chunk_count: int, status: str, model_id: str, ingested_at: int, updated_at: int,
                tags: list) -> dict:
    md = {"doc_id": _doc_id(doc["doc_hash"]), "status": status, "file_format": doc["file_format"],
          "chunk_count": int(chunk_count),
          "ingested_at": int(ingested_at), "updated_at": int(updated_at),
          "file_name": doc["file_name"], "doc_hash": doc["doc_hash"], "embedding_model": model_id,
          "page_or_row_count": int(doc.get("page_or_row_count") or 0),
          "quality_flag": doc.get("quality_flag") or "ok"}
    if tags:
        md["tags"] = tags
    return md


def _chunk_record(doc_id: str, doc: dict, chunk: dict, ingested_at: int, tags: list) -> dict:
    content = chunk["content"]
    md = {"doc_id": doc_id, "chunk_index": int(chunk["chunk_index"]), "active": True,
          "file_format": doc["file_format"], "ingested_at": int(ingested_at), "char_count": len(content),
          "text": content, "file_name": doc["file_name"]}
    if tags:
        md["tags"] = tags
    return md


def _doc_view(doc_id: str, md: dict) -> dict:
    """登记表元数据 → 与 PostgreSQL 版 kb_document_index 同名的字段。"""
    return {
        "doc_id": doc_id,
        "doc_hash": md.get("doc_hash"),
        "file_name": md.get("file_name"),
        "file_format": md.get("file_format"),
        "page_or_row_count": int(md.get("page_or_row_count") or 0),
        "chunk_count": int(md.get("chunk_count") or 0),
        "embedding_model_version": md.get("embedding_model"),
        "status": md.get("status"),
        "tags": md.get("tags") or [],
        "ingested_at": _iso(md.get("ingested_at")),
        "updated_at": _iso(md.get("updated_at")),
    }


def _prepare_from_file(file_path: str, file_format: str, chunk_size: int, chunk_overlap: int):
    """一步入库：解析 + 计算哈希 + 分块，返回 (doc, chunks, 错误 JSON 或 None)。"""
    fmt = (file_format or Path(file_path).suffix.lstrip(".")).strip().lower()
    if fmt not in _FORMAT_MAP:
        return None, None, _fail("unsupported_format", f"不支持的文件格式 '{fmt or file_path}'，仅支持 docx / xlsx / pdf",
                                 "请上传 Word（.docx）、Excel（.xlsx）或 PDF（.pdf）格式文件")
    fmt = _FORMAT_MAP[fmt]
    if not isinstance(chunk_size, int) or not 64 <= chunk_size <= 8192:
        return None, None, _fail("invalid_parameter", f"chunk_size 必须为 64~8192 之间的整数，当前值：{chunk_size}", "建议使用默认值 512")
    if not isinstance(chunk_overlap, int) or not 0 <= chunk_overlap < chunk_size:
        return None, None, _fail("invalid_parameter", f"chunk_overlap 必须是小于 chunk_size 的非负整数，当前值：{chunk_overlap}", "建议使用默认值 64")
    ok, path_or_error = _validate_path(file_path)
    if not ok:
        return None, None, _fail("invalid_path", path_or_error, "请确保文件路径位于允许的工作区目录内，不含路径穿越字符")
    path = path_or_error
    if not os.path.isfile(path):
        return None, None, _fail("file_not_found", f"文件不存在：{os.path.basename(path)}",
                                 "附件在 .cache/<agent_id>/<session_id>/nexus_ai_internal_attachments_temp/ 下；"
                                 "不确定时先用 runtime_workspace_list_files 列出该目录")
    size = os.path.getsize(path)
    if size == 0:
        return None, None, _fail("empty_file", f"文件为空：{os.path.basename(path)}", "请检查文件内容是否完整")
    if size > _MAX_FILE_SIZE_BYTES:
        return None, None, _fail("file_too_large", f"文件大小 {size // (1024 * 1024)}MB 超过 50MB 上限", "请拆分文件后分批上传")
    file_name = os.path.basename(path)
    doc_hash = _compute_file_hash(path)
    quality_flag = "ok"
    if fmt == "docx":
        text, meta = _parse_docx(path, file_name)
    elif fmt == "xlsx":
        text, meta = _parse_xlsx(path, file_name)
    else:
        text, meta, quality_flag = _parse_pdf(path, file_name, True)
    if not text or not text.strip():
        return None, None, _fail("parse_failed" if quality_flag == "low_quality_ocr" else "empty_content",
                                 f"文档「{file_name}」未提取到有效文本", "扫描件请提供更清晰的文件或带文本层的 PDF")
    chunks = _build_chunks(_split_into_sentences(text.strip()), chunk_size, chunk_overlap)
    doc = {"doc_hash": doc_hash, "file_name": file_name[:_MAX_FILE_NAME_CHARS], "file_format": fmt,
           "page_or_row_count": int(meta.get("page_or_row_count") or 0), "quality_flag": quality_flag}
    return doc, chunks, None


def _prepare_from_chunks(doc_metadata: dict, chunks: list):
    """分步入库：校验 document_parser / text_chunker 的结果，返回 (doc, chunks, 错误 JSON 或 None)。"""
    doc_hash = str(doc_metadata.get("doc_hash") or "").strip().lower()
    file_name = str(doc_metadata.get("file_name") or "").strip()
    fmt = _FORMAT_MAP.get(str(doc_metadata.get("file_format") or "").strip().lower())
    if not _HASH_RE.match(doc_hash):
        return None, None, _fail("invalid_parameter", "doc_metadata.doc_hash 必须是 document_parser 返回的 64 位十六进制 SHA256",
                                 "不要自己构造 doc_hash；document_parser 失败时请停止入库")
    if not file_name or not fmt:
        return None, None, _fail("invalid_parameter", "doc_metadata 缺少 file_name，或 file_format 不是 docx / xlsx / pdf",
                                 "请使用 document_parser 返回的 metadata")
    cleaned, seen = [], set()
    for c in chunks or []:
        if not isinstance(c, dict):
            continue
        content = str(c.get("content") or "")
        try:
            idx = int(c.get("chunk_index"))
        except (TypeError, ValueError):
            return None, None, _fail("invalid_parameter", "chunks 每项须含整数 chunk_index", "请原样传入 text_chunker 返回的 chunks")
        if idx < 0 or idx in seen:
            return None, None, _fail("invalid_parameter", f"chunk_index {idx} 重复或为负数", "请原样传入 text_chunker 返回的 chunks")
        if content.strip():
            seen.add(idx)
            cleaned.append({"chunk_index": idx, "content": content[:_TEXT_MAX_CHARS]})
    if not cleaned:
        return None, None, _fail("invalid_parameter", "chunks 为空或没有正文", "请先用 text_chunker 分块")
    doc = {"doc_hash": doc_hash, "file_name": file_name[:_MAX_FILE_NAME_CHARS], "file_format": fmt,
           "page_or_row_count": int(doc_metadata.get("page_or_row_count") or 0),
           "quality_flag": str(doc_metadata.get("quality_flag") or "ok")}
    return doc, cleaned, None


# ═══════════════════════════════════════════════════════════════
# 工具 3：s3vectors_writer（对应 PostgreSQL 版的 pgvector_connector）
# ═══════════════════════════════════════════════════════════════
@tool
def s3vectors_writer(
    file_path: str = "",
    file_format: str = "",
    write_strategy: str = "skip",
    chunk_size: int = 512,
    chunk_overlap: int = 64,
    tags: list = None,
    doc_metadata: dict = None,
    chunks: list = None,
) -> str:
    """
    把一份文档写入 S3 Vectors 知识库：分块 → 调 Bedrock（Cohere Embed v4，1536 维）生成向量 → 写入文本块索引与文档登记表。

    两种用法（二选一）：
      1. 一步入库（推荐）：给 file_path，工具自己解析、分块、向量化、写入；doc_hash 由工具按文件内容计算
      2. 分步入库：先用 document_parser、text_chunker，再把 doc_metadata 与 chunks 交给本工具（不用传向量）
    写入策略（按文件内容 SHA256 去重：同一内容 = 同一个 doc_id）：
      - skip（默认）：已存在就跳过，直接返回已有 doc_id，不重新向量化
      - insert：新建；已存在则报 duplicate_document
      - overwrite：已存在则覆盖：同键覆盖文本块，多出来的旧块删除，首次入库时间保留
    上一次入库没有完成（登记状态为 ingesting / failed）时，三种策略都会重新写入。
    S3 Vectors 凭证经 Nexus 密钥注入（key_name=s3vectors_kb，类型 aws_credentials）；Bedrock 用运行环境的 IAM 角色，不需要密钥。

    Args:
        file_path: 一步入库时的文档路径；附件在 .cache/<agent_id>/<session_id>/nexus_ai_internal_attachments_temp/ 下
        file_format: docx / xlsx / pdf；留空按扩展名判断
        write_strategy: 写入策略枚举：skip / insert / overwrite，默认 skip
        chunk_size: 一步入库时单块最大字符数，默认 512，有效范围 64~8192
        chunk_overlap: 一步入库时相邻块重叠字符数，默认 64，必须小于 chunk_size
        tags: 可选标签列表（最多 10 个、每个不超过 32 字），检索时可按标签过滤；覆盖已有文档时不传则沿用原标签，传 [] 清空
        doc_metadata: 分步入库时的文档元数据：doc_hash（必填，document_parser 返回的 64 位十六进制）/ file_name / file_format / page_or_row_count
        chunks: 分步入库时 text_chunker 返回的 chunks 列表（每项含 chunk_index / content）

    Returns:
        JSON 字符串，包含：
          success (bool)
          doc_id (str) - 文档 ID（doc_ + SHA256 前 24 位）
          file_name (str)
          written_chunks (int) - 写入的文本块数
          status (str) - ingested / skipped
          dedup_status (str) - inserted / overwritten / repaired / skipped
          embedding_model (str) / dimension (int)
          quality_flag (str) / audit_log_id (str)
        失败时含 success=false，附带 error_type / message / suggestion
    """
    try:
        if write_strategy not in ("skip", "insert", "overwrite"):
            return _fail("invalid_parameter", f"write_strategy 无效：{write_strategy}，支持：skip / insert / overwrite",
                         "首次入库用 skip 或 insert；更新已入库的同一文档用 overwrite")
        tag_list, tag_err = _clean_tags(tags)
        if tag_err:
            return _fail("invalid_parameter", tag_err, "请精简标签")
        if file_path and str(file_path).strip():
            doc, chunk_list, err = _prepare_from_file(str(file_path).strip(), file_format, chunk_size, chunk_overlap)
        elif doc_metadata and chunks:
            doc, chunk_list, err = _prepare_from_chunks(doc_metadata, chunks)
        else:
            return _fail("invalid_parameter", "请提供 file_path（一步入库），或同时提供 doc_metadata 与 chunks（分步入库）",
                         "上传的附件直接给 file_path 即可")
        if err:
            return err

        client = _s3v_client(_kb_credentials())
        doc_id = _doc_id(doc["doc_hash"])
        existing = _get_doc(client, doc_id)
        old_md = (existing or {}).get("metadata") or {}
        dedup_status, old_count = "inserted", 0
        if existing:
            complete = old_md.get("status") in ("ingested", "deleted")
            if complete and write_strategy == "skip":
                out = {"success": True, "doc_id": doc_id, "file_name": old_md.get("file_name"), "written_chunks": 0,
                       "status": "skipped", "dedup_status": "skipped",
                       "message": f"同一内容的文档已在知识库中（doc_id={doc_id}），已跳过写入"}
                if old_md.get("status") == "deleted":
                    out["message"] += "；它目前处于软删除状态，可用 s3vectors_manager(operation='restore') 恢复，或用 overwrite 重新入库"
                return _dumps(out)
            if complete and write_strategy == "insert":
                return _fail("duplicate_document", f"同一内容的文档已存在（doc_id={doc_id}），策略为 insert 不允许重复写入",
                             "请使用 overwrite 覆盖更新，或使用 skip 跳过")
            dedup_status = "overwritten" if complete else "repaired"
            old_count = int(old_md.get("chunk_count") or 0)
            if tags is None and old_md.get("tags"):
                tag_list = list(old_md["tags"])     # 没传 tags = 沿用原标签；传 [] 才是清空

        try:
            vectors, model_id = _embed_texts([c["content"] for c in chunk_list], "document")
        except Exception as e:  # noqa: BLE001
            return _embed_fail(e)

        now = _now()
        ingested_at = int(old_md.get("ingested_at") or now)
        mean = _mean_vector(vectors)
        # 1. 登记表先记「入库中」：中途失败时一致性校验和下次入库都能看出这份文档没写完
        _put(client, _DOC_INDEX, [{"key": doc_id, "data": {"float32": mean},
                                   "metadata": _doc_record(doc, len(chunk_list), "ingesting", model_id, ingested_at, now, tag_list)}])
        items = [{"key": _chunk_key(doc_id, c["chunk_index"]), "data": {"float32": v},
                  "metadata": _chunk_record(doc_id, doc, c, now, tag_list)} for c, v in zip(chunk_list, vectors)]
        try:
            # 2. 文本块（同键覆盖）；3. 覆盖时删掉新版本里已经没有的旧块
            _put(client, _CHUNK_INDEX, items)
            new_keys = {it["key"] for it in items}
            stale = [k for k in (_chunk_key(doc_id, i) for i in range(old_count)) if k not in new_keys]
            if stale:
                _delete(client, _CHUNK_INDEX, stale)
        except Exception as e:  # noqa: BLE001
            try:
                _put(client, _DOC_INDEX, [{"key": doc_id, "data": {"float32": mean},
                                           "metadata": _doc_record(doc, len(chunk_list), "failed", model_id, ingested_at, _now(), tag_list)}])
            except Exception:  # noqa: BLE001
                pass
            _audit(client, "ingest_failed", doc_id, {"file_name": doc["file_name"], "error": _error_code(e) or type(e).__name__})
            out = json.loads(_aws_fail(e, "写入文本块"))
            out.update({"error_type": "write_failed", "doc_id": doc_id,
                        "suggestion": "文档已登记为 failed，再次入库（任一策略）会自动重写；也可先执行一致性校验查看情况"})
            return _dumps(out)
        # 4. 登记表改为「已入库」
        _put(client, _DOC_INDEX, [{"key": doc_id, "data": {"float32": mean},
                                   "metadata": _doc_record(doc, len(chunk_list), "ingested", model_id, ingested_at, _now(), tag_list)}])
        log_id = _audit(client, "ingest", doc_id, {"strategy": write_strategy, "dedup_status": dedup_status,
                                                   "written_chunks": len(items), "file_name": doc["file_name"]})
        return _dumps({
            "success": True,
            "doc_id": doc_id,
            "file_name": doc["file_name"],
            "file_format": doc["file_format"],
            "written_chunks": len(items),
            "status": "ingested",
            "dedup_status": dedup_status,
            "embedding_model": model_id,
            "dimension": _EMBED_DIMENSION,
            "quality_flag": doc.get("quality_flag", "ok"),
            "tags": tag_list,
            "audit_log_id": log_id,
            "storage": {"vector_bucket": _VECTOR_BUCKET, "index": _CHUNK_INDEX},
        })
    except _CredentialsMissing:
        return _credentials_fail()
    except ImportError as e:
        return _fail("dependency_missing", f"依赖库缺失：{e}", "请确认运行环境装有 boto3 / python-docx / openpyxl / pdfplumber")
    except Exception as e:  # noqa: BLE001
        return _aws_fail(e, "写入知识库")


# ═══════════════════════════════════════════════════════════════
# 工具 4：s3vectors_search（对应 PostgreSQL 版的 vector_search）
# ═══════════════════════════════════════════════════════════════
def _doc_ids_by_name(client, name_part: str, include_deleted: bool) -> list:
    items, _ = _list(client, _DOC_INDEX)
    part = name_part.strip().lower()
    out = []
    for v in items:
        md = v.get("metadata") or {}
        if part in str(md.get("file_name") or "").lower() and (include_deleted or md.get("status") != "deleted"):
            out.append(v["key"])
    return out


def _chunk_hit(v: dict, similarity: float | None) -> dict:
    md = v.get("metadata") or {}
    hit = {"key": v.get("key"), "doc_id": md.get("doc_id"), "file_name": md.get("file_name"),
           "chunk_index": int(md.get("chunk_index") or 0), "content": _clip(md.get("text")),
           "similarity_score": similarity}
    if md.get("active") is False:
        hit["deleted"] = True
    if md.get("tags"):
        hit["tags"] = md["tags"]
    return hit


@tool
def s3vectors_search(
    query: str = "",
    filters: dict = None,
    top_k: int = 10,
    similarity_threshold: float = 0.0,
    include_deleted: bool = False,
    scope: str = "chunks",
) -> str:
    """
    在 S3 Vectors 知识库中检索：语义检索、按文档查看文本块，或找出最相关的文档。

    检索方式：
      1. 语义检索：给 query（用户的自然语言问题），工具自己把问题转成向量（Cohere Embed v4，search_query），
         按余弦相似度取前 top_k 个文本块；不要自己生成或传入向量
      2. 按文档查看：不给 query、给 filters.doc_id 或 filters.file_name，按块序号列出该文档的文本块
      3. scope="documents"：在文档登记表里做语义检索（每份文档一条），找出整体最相关的几份文档
    过滤条件由工具拼成 S3 Vectors 的 filter，默认只查没有被删除的内容。

    S3 Vectors 凭证经 Nexus 密钥注入（key_name=s3vectors_kb，类型 aws_credentials）。

    Args:
        query: 自然语言问题（语义检索时提供）
        filters: 过滤条件字典，支持：doc_id（字符串或列表）/ file_name（文件名包含的文字）/ file_format（docx/xlsx/pdf）/ tags（标签列表，任一命中）
        top_k: 返回结果数上限，默认 10，最大 100
        similarity_threshold: 相似度阈值（0~1），低于该值的结果被过滤，默认 0（不过滤）
        include_deleted: 是否包含已软删除的内容，默认 false
        scope: chunks（文本块，默认）/ documents（文档）

    Returns:
        JSON 字符串，包含：
          success (bool)
          results (list) - 每项含 key / doc_id / file_name / chunk_index / content / similarity_score；
                           scope=documents 时每项含 doc_id / file_name / chunk_count / similarity_score
          total_count (int) - 结果数量
          filter (dict) - 实际发给 S3 Vectors 的过滤条件，便于核对
        无结果时 results=[] 且 total_count=0
    """
    try:
        filters = filters or {}
        if not isinstance(filters, dict):
            return _fail("invalid_parameter", "filters 必须是字典", "示例：{\"file_name\": \"管理办法\"}")
        try:
            top_k = max(1, min(int(top_k), _TOP_K_MAX))
            threshold = max(0.0, min(float(similarity_threshold), 1.0))
        except (TypeError, ValueError):
            return _fail("invalid_parameter", "top_k 须为整数、similarity_threshold 须为 0~1 的数字", "使用默认值即可")
        scope = "documents" if str(scope).strip().lower() == "documents" else "chunks"
        query = str(query or "").strip()
        client = _s3v_client(_kb_credentials())

        doc_ids = _as_list(filters.get("doc_id"))[:100]
        if filters.get("file_name"):
            named = _doc_ids_by_name(client, str(filters["file_name"]), include_deleted)
            doc_ids = [d for d in doc_ids if d in named] if doc_ids else named[:100]
            if not doc_ids:
                return _dumps({"success": True, "results": [], "total_count": 0,
                               "tip": f"没有文件名包含「{filters['file_name']}」的文档，可先用 s3vectors_statistics 查看文档清单"})
        fmt = _FORMAT_MAP.get(str(filters.get("file_format") or "").strip().lower()) if filters.get("file_format") else None
        tag_list = _as_list(filters.get("tags"))

        if not query:
            if not doc_ids:
                return _fail("invalid_parameter", "query 与 filters.doc_id / filters.file_name 不能同时为空",
                             "语义检索请提供 query；查看某份文档的内容请提供 filters.doc_id 或 filters.file_name")
            docs = {v["key"]: v.get("metadata") or {} for v in _get(client, _DOC_INDEX, doc_ids)}
            keys = []
            for d in doc_ids:
                md = docs.get(d)
                if md and (include_deleted or md.get("status") != "deleted"):
                    keys += [_chunk_key(d, i) for i in range(int(md.get("chunk_count") or 0))]
            keys = keys[:top_k]
            order = {k: i for i, k in enumerate(keys)}
            found = sorted(_get(client, _CHUNK_INDEX, keys), key=lambda v: order.get(v.get("key"), 0)) if keys else []
            results = [_chunk_hit(v, None) for v in found]
            out = {"success": True, "results": results, "total_count": len(results)}
            if not results:
                out["tip"] = "这些文档没有可列出的文本块（文档不存在、已删除或尚未入库完成）"
            return _dumps(out)

        try:
            qvec = _embed_texts([query], "query")[0][0]
        except Exception as e:  # noqa: BLE001
            return _embed_fail(e)

        if scope == "documents":
            conds = [] if include_deleted else [{"status": {"$eq": "ingested"}}]
            if doc_ids:
                conds.append({"doc_id": {"$in": doc_ids}})
            if fmt:
                conds.append({"file_format": {"$eq": fmt}})
            conds.append(_any_tag(tag_list))
            flt = _and(conds)
            kw = {"vectorBucketName": _VECTOR_BUCKET, "indexName": _DOC_INDEX, "topK": _fetch_k(top_k),
                  "queryVector": {"float32": qvec}, "returnMetadata": True, "returnDistance": True}
            if flt:
                kw["filter"] = flt
            r = client.query_vectors(**kw)
            results = []
            for v in sorted(r.get("vectors") or [], key=lambda x: float(x.get("distance", 1.0)))[:top_k]:
                sim = round(1.0 - float(v.get("distance", 1.0)), 6)
                if sim < threshold:
                    continue
                md = v.get("metadata") or {}
                results.append({"doc_id": v.get("key"), "file_name": md.get("file_name"), "file_format": md.get("file_format"),
                                "chunk_count": int(md.get("chunk_count") or 0), "status": md.get("status"),
                                "similarity_score": sim})
            out = {"success": True, "results": results, "total_count": len(results), "filter": flt, "scope": "documents"}
            if not results:
                out["tip"] = "未找到相关文档，建议换个说法或降低相似度阈值"
            return _dumps(out)

        conds = [] if include_deleted else [{"active": {"$eq": True}}]
        if doc_ids:
            conds.append({"doc_id": {"$in": doc_ids}})
        if fmt:
            conds.append({"file_format": {"$eq": fmt}})
        conds.append(_any_tag(tag_list))
        flt = _and(conds)
        kw = {"vectorBucketName": _VECTOR_BUCKET, "indexName": _CHUNK_INDEX, "topK": _fetch_k(top_k),
              "queryVector": {"float32": qvec}, "returnMetadata": True, "returnDistance": True}
        if flt:
            kw["filter"] = flt
        r = client.query_vectors(**kw)
        results = []
        for v in sorted(r.get("vectors") or [], key=lambda x: float(x.get("distance", 1.0)))[:top_k]:
            sim = round(1.0 - float(v.get("distance", 1.0)), 6)
            if sim >= threshold:
                results.append(_chunk_hit(v, sim))
        out = {"success": True, "results": results, "total_count": len(results), "filter": flt}
        if not results:
            out["tip"] = "未找到相关内容，建议调整查询词或降低相似度阈值；也可用 s3vectors_statistics 确认知识库里已有文档"
        return _dumps(out)
    except _CredentialsMissing:
        return _credentials_fail()
    except Exception as e:  # noqa: BLE001
        return _aws_fail(e, "检索知识库")


# ═══════════════════════════════════════════════════════════════
# 工具 5：s3vectors_manager（对应 PostgreSQL 版的 vector_manager）
# ═══════════════════════════════════════════════════════════════
def _set_chunks_active(client, doc_id: str, chunk_count: int, active: bool) -> int:
    """软删除 / 恢复：改写该文档每个文本块的 active 标记（S3 Vectors 只能整条覆盖，所以连向量一起取回再写）。"""
    keys = [_chunk_key(doc_id, i) for i in range(chunk_count)]
    changed = 0
    for s in range(0, len(keys), _GET_BATCH):
        batch = []
        for v in _get(client, _CHUNK_INDEX, keys[s:s + _GET_BATCH], with_data=True):
            md = dict(v.get("metadata") or {})
            if md.get("active") is active:
                continue
            md["active"] = active
            batch.append({"key": v["key"], "data": v["data"], "metadata": md})
        if batch:
            _put(client, _CHUNK_INDEX, batch)
            changed += len(batch)
    return changed


def _set_doc_status(client, doc: dict, status: str) -> None:
    md = dict(doc.get("metadata") or {})
    md["status"] = status
    md["updated_at"] = _now()
    _put(client, _DOC_INDEX, [{"key": doc["key"], "data": doc["data"], "metadata": md}])


@tool
def s3vectors_manager(
    operation: str,
    doc_id: str = "",
    delete_mode: str = "hard",
) -> str:
    """
    S3 Vectors 知识库管理工具：按文档删除（硬删除 / 软删除）、恢复软删除的文档、一致性校验。

    支持操作类型：
      - delete: 按 doc_id 删除一份文档
                hard（硬删除）：物理删除该文档的全部文本块和登记记录，不可恢复
                soft（软删除）：文本块标记为已删除（检索默认不再返回），登记状态改为 deleted，可用 restore 恢复
      - restore: 恢复一份软删除的文档（文本块重新可检索，登记状态改回 ingested）
      - consistency_check: 扫描文本块索引与文档登记表，报告孤立文本块、块数不一致、删除标记不一致、
                           未完成的入库；只读，不做任何修改
    每次 delete / restore 都写一条操作记录（audit_log_id）。
    S3 Vectors 凭证经 Nexus 密钥注入（key_name=s3vectors_kb，类型 aws_credentials）。

    Args:
        operation: 操作类型枚举：delete / restore / consistency_check
        doc_id: 文档 ID（delete / restore 必填），可通过 s3vectors_statistics 的 document_list 获取
        delete_mode: 删除模式：hard（硬删除）/ soft（软删除），默认 hard

    Returns:
        JSON 字符串：
          delete：success / operation / deleted_doc / file_name / deleted_chunks / delete_mode / audit_log_id
          restore：success / operation / restored_doc / file_name / restored_chunks / audit_log_id
          consistency_check：success / operation / orphan_vectors / missing_records / chunk_count_mismatches /
                             status_mismatches / unfinished_documents / consistency_passed / maintenance_report
        失败时：success=false，附带 error_type / message / suggestion
    """
    try:
        if operation not in ("delete", "restore", "consistency_check"):
            return _fail("invalid_parameter", f"operation 无效：{operation}，支持：delete / restore / consistency_check",
                         "请选择正确的操作类型")
        if delete_mode not in ("soft", "hard"):
            return _fail("invalid_parameter", f"delete_mode 无效：{delete_mode}，支持：soft / hard",
                         "请选择 soft（软删除）或 hard（硬删除）")
        doc_id = str(doc_id or "").strip()
        if operation in ("delete", "restore"):
            if not doc_id:
                return _fail("invalid_parameter", f"{operation} 操作必须提供 doc_id", "请先用 s3vectors_statistics 查询文档清单")
            if not _DOC_ID_RE.match(doc_id):
                return _fail("invalid_parameter", f"doc_id 格式不对：{doc_id}（应为 doc_ 加 24 位十六进制）",
                             "请使用 s3vectors_statistics 返回的 doc_id，不要自己构造")
        client = _s3v_client(_kb_credentials())
        if operation == "consistency_check":
            return _op_consistency_check(client)

        doc = _get_doc(client, doc_id, with_data=True)
        if not doc:
            return _fail("document_not_found", f"文档 ID「{doc_id}」在知识库中不存在",
                         "请确认 doc_id 正确，可通过 s3vectors_statistics 查询文档清单获取正确 ID")
        md = doc.get("metadata") or {}
        file_name, count = md.get("file_name"), int(md.get("chunk_count") or 0)

        if operation == "restore":
            if md.get("status") != "deleted":
                return _fail("not_deleted", f"文档「{file_name}」当前状态是 {md.get('status')}，不需要恢复",
                             "只有软删除（status=deleted）的文档可以恢复")
            restored = _set_chunks_active(client, doc_id, count, True)
            _set_doc_status(client, doc, "ingested")
            log_id = _audit(client, "restore", doc_id, {"file_name": file_name, "restored_chunks": restored})
            return _dumps({"success": True, "operation": "restore", "restored_doc": doc_id, "file_name": file_name,
                           "restored_chunks": count, "audit_log_id": log_id,
                           "message": f"已恢复文档「{file_name}」，共 {count} 个文本块重新可检索"})

        if delete_mode == "hard":
            _delete(client, _CHUNK_INDEX, [_chunk_key(doc_id, i) for i in range(count)])
            _delete(client, _DOC_INDEX, [doc_id])
        else:
            if md.get("status") == "deleted":
                return _fail("already_deleted", f"文档「{file_name}」已经是软删除状态",
                             "如需物理删除请用 delete_mode=hard；如需恢复请用 operation=restore")
            _set_chunks_active(client, doc_id, count, False)
            _set_doc_status(client, doc, "deleted")
        log_id = _audit(client, f"delete_{delete_mode}", doc_id,
                        {"file_name": file_name, "deleted_chunks": count, "delete_mode": delete_mode})
        return _dumps({
            "success": True,
            "operation": "delete",
            "deleted_doc": doc_id,
            "file_name": file_name,
            "deleted_chunks": count,
            "delete_mode": delete_mode,
            "audit_log_id": log_id,
            "message": f"已{'软' if delete_mode == 'soft' else '硬'}删除文档「{file_name}」，共 {count} 个文本块",
        })
    except _CredentialsMissing:
        return _credentials_fail()
    except Exception as e:  # noqa: BLE001
        return _aws_fail(e, "知识库管理操作")


def _chunks_flagged(client, doc_ids: list, active: bool) -> dict:
    """这些文档里 active 等于给定值的文本块各有多少（最多数到 100）。
    用带过滤的 QueryVectors 判存在：ENHANCED 索引先过滤再找近邻，查询向量取什么都不影响命中集合。"""
    probe = [1.0] + [0.0] * (_EMBED_DIMENSION - 1)
    found: dict = {}
    for s in range(0, len(doc_ids), 50):
        part = doc_ids[s:s + 50]
        r = client.query_vectors(vectorBucketName=_VECTOR_BUCKET, indexName=_CHUNK_INDEX, topK=100,
                                 queryVector={"float32": probe}, returnMetadata=False, returnDistance=False,
                                 filter={"$and": [{"doc_id": {"$in": part}}, {"active": {"$eq": active}}]})
        for v in r.get("vectors") or []:
            d = str(v.get("key", "")).split("#")[0]
            found[d] = found.get(d, 0) + 1
    return found


def _op_consistency_check(client) -> str:
    """只读扫描：文本块索引（只取键）× 文档登记表；删除标记用带过滤的查询核对。"""
    incomplete: list = []
    docs, _ = _list(client, _DOC_INDEX)
    chunks, truncated = _list(client, _CHUNK_INDEX, limit=_SCAN_LIMIT, with_metadata=False)
    if truncated:
        incomplete.append(f"文本块超过 {_SCAN_LIMIT} 条，只扫描了前 {len(chunks)} 条")
    registry = {v["key"]: v.get("metadata") or {} for v in docs}
    per_doc: dict = {}
    orphans: list = []
    for v in chunks:
        d = str(v.get("key", "")).split("#")[0]
        per_doc[d] = per_doc.get(d, 0) + 1
        if d not in registry:
            orphans.append(v.get("key"))

    mismatches, status_mismatches, unfinished = [], [], []
    deleted_ids, live_ids = [], []
    for d, md in registry.items():
        expected, actual, status = int(md.get("chunk_count") or 0), per_doc.get(d, 0), md.get("status")
        if status in ("ingesting", "failed"):
            unfinished.append({"doc_id": d, "file_name": md.get("file_name"), "status": status})
            continue
        if not truncated and expected != actual:
            mismatches.append({"doc_id": d, "file_name": md.get("file_name"), "indexed_count": expected,
                               "actual_count": actual})
        (deleted_ids if status == "deleted" else live_ids).append(d)
    try:
        for d, n in _chunks_flagged(client, deleted_ids, True).items():
            status_mismatches.append({"doc_id": d, "file_name": registry[d].get("file_name"), "status": "deleted",
                                      "active_chunks": n})
        for d, n in _chunks_flagged(client, live_ids, False).items():
            status_mismatches.append({"doc_id": d, "file_name": registry[d].get("file_name"), "status": "ingested",
                                      "inactive_chunks": n})
    except Exception as e:  # noqa: BLE001
        incomplete.append(f"删除标记核对未完成（{_error_code(e) or type(e).__name__}）")

    report = []
    if orphans:
        report.append(f"发现 {len(orphans)} 个孤立文本块（登记表里没有对应文档），建议按 doc_id 重新入库或清理")
    if mismatches:
        report.append(f"发现 {len(mismatches)} 份文档的 chunk_count 与实际文本块数不一致，建议用 overwrite 重新入库")
    if status_mismatches:
        report.append(f"发现 {len(status_mismatches)} 份文档的删除标记与登记状态不一致，建议再执行一次 delete（soft）或 restore")
    if unfinished:
        report.append(f"发现 {len(unfinished)} 份文档入库没有完成（ingesting / failed），再次入库会自动重写")
    passed = not (orphans or mismatches or status_mismatches or unfinished or incomplete)
    if not report and not incomplete:
        report.append("知识库一致性检测通过，未发现孤立文本块或数据不一致问题")
    text = "；".join(report)
    if incomplete:
        text += "（注意：部分检测项未完成：" + "；".join(incomplete) + "）"
    return _dumps({
        "success": True,
        "operation": "consistency_check",
        "orphan_vectors": len(orphans),
        "orphan_keys_sample": orphans[:20],
        "missing_records": len(mismatches),
        "chunk_count_mismatches": mismatches[:50],
        "status_mismatches": status_mismatches[:50],
        "unfinished_documents": unfinished[:50],
        "scanned": {"documents": len(docs), "chunks": len(chunks)},
        "consistency_passed": passed,
        "maintenance_report": text,
        "incomplete_checks": incomplete,
    })


# ═══════════════════════════════════════════════════════════════
# 工具 6：s3vectors_statistics（对应 PostgreSQL 版的 kb_statistics）
# ═══════════════════════════════════════════════════════════════
@tool
def s3vectors_statistics(
    query_type: str,
    filters: dict = None,
    page: int = 1,
    page_size: int = 20,
) -> str:
    """
    S3 Vectors 知识库统计与查看工具，提供 Dashboard 指标、文档清单、文档详情与内容抽样能力。

    支持查询类型：
      - dashboard_stats: 文档总数、文本块总数、按格式分布、最近导入、软删除与未完成的文档数、索引配置、最近 7 天的操作
      - document_list:   分页 / 过滤的文档清单（file_name / file_format / status / ingested_at / chunk_count）
      - document_detail: 指定文档的详细信息（需 filters.doc_id）
      - content_sample:  指定文档的前 20 个文本块（需 filters.doc_id），供生成总结使用
    数据来自文档登记表（docs 索引），不扫描全部文本块。
    S3 Vectors 凭证经 Nexus 密钥注入（key_name=s3vectors_kb，类型 aws_credentials）。

    Args:
        query_type: 查询类型枚举：dashboard_stats / document_list / document_detail / content_sample
        filters: 过滤条件字典，支持：
                 doc_id (str) - 文档 ID（document_detail / content_sample 必填）
                 file_format (str) - 按格式过滤：docx / xlsx / pdf
                 file_name (str) - 文件名包含的文字
                 status (str) - 按状态过滤：ingested / deleted / ingesting / failed（默认列出未删除的）
                 tag (str) - 按标签过滤
        page: 分页页码（document_list 使用），默认 1，从 1 开始
        page_size: 每页条数（document_list 使用），默认 20，最大 100

    Returns:
        JSON 字符串：
          dashboard_stats: success / total_documents / total_chunks / format_distribution / recent_imports /
                           deleted_documents / unfinished_documents / index / recent_operations / storage_tip
          document_list:  success / documents / total_count / page / page_size / total_pages
          document_detail: success / document
          content_sample:  success / doc_id / file_name / sample_chunks / total_chunks / sampled_chunks / sample_note
    """
    try:
        valid = {"dashboard_stats", "document_list", "document_detail", "content_sample"}
        if query_type not in valid:
            return _fail("invalid_parameter", f"query_type 无效：{query_type}，支持：{' / '.join(sorted(valid))}",
                         "请选择正确的查询类型")
        filters = filters or {}
        if not isinstance(filters, dict):
            return _fail("invalid_parameter", "filters 必须是字典", "示例：{\"doc_id\": \"doc_…\"}")
        if query_type in ("document_detail", "content_sample") and not filters.get("doc_id"):
            return _fail("invalid_parameter", f"{query_type} 查询需要提供 filters.doc_id", "请先通过 document_list 获取 doc_id")
        if not isinstance(page, int) or page < 1:
            return _fail("invalid_parameter", f"page 必须为正整数，当前值：{page}", "请使用从 1 开始的正整数")
        page_size = max(1, min(int(page_size), _MAX_PAGE_SIZE))
        client = _s3v_client(_kb_credentials())

        if query_type == "document_detail":
            doc = _get_doc(client, str(filters["doc_id"]).strip())
            if not doc:
                return _fail("document_not_found", f"文档 ID「{filters['doc_id']}」不存在", "请通过 document_list 查询获取正确的 doc_id")
            return _dumps({"success": True, "document": _doc_view(doc["key"], doc.get("metadata") or {})})

        if query_type == "content_sample":
            doc_id = str(filters["doc_id"]).strip()
            doc = _get_doc(client, doc_id)
            if not doc:
                return _fail("document_not_found", f"文档 ID「{doc_id}」不存在", "请通过 document_list 查询获取正确的 doc_id")
            md = doc.get("metadata") or {}
            total = int(md.get("chunk_count") or 0)
            keys = [_chunk_key(doc_id, i) for i in range(min(total, 20))]
            order = {k: i for i, k in enumerate(keys)}
            found = sorted(_get(client, _CHUNK_INDEX, keys), key=lambda v: order.get(v.get("key"), 0)) if keys else []
            sample = [{"chunk_index": int((v.get("metadata") or {}).get("chunk_index") or 0),
                       "content": _clip((v.get("metadata") or {}).get("text"))} for v in found]
            return _dumps({
                "success": True, "doc_id": doc_id, "file_name": md.get("file_name"), "status": md.get("status"),
                "sample_chunks": sample, "total_chunks": total, "sampled_chunks": len(sample),
                "sample_note": (f"以下是文档「{md.get('file_name')}」的内容抽样（共 {total} 块，已抽取前 {len(sample)} 块）。"
                                "请根据这些内容生成该文档的主要主题与内容摘要。"),
            })

        items, _ = _list(client, _DOC_INDEX)
        docs = [_doc_view(v["key"], v.get("metadata") or {}) for v in items]
        docs.sort(key=lambda d: d.get("ingested_at") or "", reverse=True)

        if query_type == "dashboard_stats":
            live = [d for d in docs if d["status"] == "ingested"]
            fmt_dist: dict = {}
            for d in live:
                fmt_dist[d["file_format"]] = fmt_dist.get(d["file_format"], 0) + 1
            result = {
                "success": True,
                "total_documents": len(live),
                "total_chunks": sum(d["chunk_count"] for d in live),
                "format_distribution": dict(sorted(fmt_dist.items(), key=lambda kv: -kv[1])),
                "recent_imports": [{"doc_id": d["doc_id"], "file_name": d["file_name"], "file_format": d["file_format"],
                                    "chunk_count": d["chunk_count"], "imported_at": d["ingested_at"]} for d in live[:5]],
                "deleted_documents": sum(1 for d in docs if d["status"] == "deleted"),
                "unfinished_documents": sum(1 for d in docs if d["status"] in ("ingesting", "failed")),
            }
            try:
                idx = client.get_index(vectorBucketName=_VECTOR_BUCKET, indexName=_CHUNK_INDEX).get("index") or {}
                result["index"] = {"vector_bucket": _VECTOR_BUCKET, "index": _CHUNK_INDEX, "dimension": idx.get("dimension"),
                                   "distance_metric": idx.get("distanceMetric"), "index_mode": idx.get("indexMode"),
                                   "region": _REGION}
            except Exception:  # noqa: BLE001
                result["index"] = {"vector_bucket": _VECTOR_BUCKET, "index": _CHUNK_INDEX, "region": _REGION}
            result["recent_operations"] = _recent_operations(client)
            if not live:
                result["storage_tip"] = "知识库暂无内容，请上传文档开始构建知识库"
            return _dumps(result)

        # document_list
        status = str(filters.get("status") or "").strip()
        if status:
            docs = [d for d in docs if d["status"] == status]
        else:
            docs = [d for d in docs if d["status"] != "deleted"]
        if filters.get("file_format"):
            docs = [d for d in docs if d["file_format"] == str(filters["file_format"]).strip().lower()]
        if filters.get("file_name"):
            part = str(filters["file_name"]).strip().lower()
            docs = [d for d in docs if part in str(d["file_name"] or "").lower()]
        if filters.get("tag"):
            docs = [d for d in docs if str(filters["tag"]) in (d.get("tags") or [])]
        total = len(docs)
        start = (page - 1) * page_size
        return _dumps({
            "success": True,
            "documents": docs[start:start + page_size],
            "total_count": total,
            "page": page,
            "page_size": page_size,
            "total_pages": max(1, (total + page_size - 1) // page_size),
        })
    except _CredentialsMissing:
        return _credentials_fail()
    except Exception as e:  # noqa: BLE001
        return _aws_fail(e, "统计查询")


def _recent_operations(client, days: int = 7, limit: int = 5) -> dict:
    """最近 7 天的操作记录：audit 索引的向量都相同，用时间条件过滤后取回，再按时间排序。"""
    try:
        r = client.query_vectors(vectorBucketName=_VECTOR_BUCKET, indexName=_AUDIT_INDEX, topK=100,
                                 queryVector={"float32": [1.0]}, filter={"at": {"$gte": _now() - days * 86400}},
                                 returnMetadata=True, returnDistance=False)
        ops = sorted((v.get("metadata") or {} for v in r.get("vectors") or []), key=lambda m: m.get("at") or 0, reverse=True)
        return {"days": days, "count": len(ops), "count_capped": len(ops) >= 100,
                "latest": [{"operation": m.get("operation"), "doc_id": m.get("doc_id"), "at": _iso(m.get("at"))}
                           for m in ops[:limit]]}
    except Exception:  # noqa: BLE001
        return {"days": days, "count": None, "latest": []}
