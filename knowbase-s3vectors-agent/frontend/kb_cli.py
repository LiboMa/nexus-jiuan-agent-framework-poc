"""前端后端直连 S3 Vectors 知识库的命令行：直接调用 Agent 用的同一份工具代码，所以写进去的数据与 Agent 完全兼容。

每个子命令向 stdout 输出一行 JSON（就是工具的返回值），适合 Node / Python 后端用子进程调用：
  kb_cli.py ingest <文件> [--strategy skip|insert|overwrite] [--tags a,b] [--chunk-size 512] [--chunk-overlap 64]
  kb_cli.py search "<问题>" [--top-k 8] [--file-name 片段] [--doc-id doc_…] [--tags a,b] [--threshold 0.3] [--documents]
  kb_cli.py show <doc_id> [--limit 50]          文档的文本块（按块序号）
  kb_cli.py list [--file-name 片段] [--status ingested|deleted] [--page 1] [--page-size 20]
  kb_cli.py detail <doc_id> | sample <doc_id> | stats
  kb_cli.py delete <doc_id> [--soft] | restore <doc_id> | check

环境变量：
  KB_S3V_TOOLS             工具文件路径，缺省 ../.build/s3vectors_kb_tools.py（scripts/render.py tools 生成，带本环境的桶名）
  KB_S3V_CREDENTIALS_FILE  可选：S3 Vectors 凭证 JSON 文件（600）；不给就用本进程的 AWS 默认凭证链
  AWS_REGION / AWS_PROFILE Bedrock 嵌入走 AWS 默认凭证链（需要 bedrock:InvokeModel 调 Cohere Embed v4）

运行：uv run --no-project --with boto3 --with python-docx --with openpyxl --with pdfplumber python -I kb_cli.py …
"""
import argparse
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "_shim"))


def load_tools():
    path = os.environ.get("KB_S3V_TOOLS") or os.path.join(HERE, "..", ".build", "s3vectors_kb_tools.py")
    if not os.path.isfile(path):
        raise SystemExit(json.dumps({"success": False, "error_type": "tools_missing",
                                     "message": f"找不到工具文件 {path}；先运行 scripts/render.py tools"}, ensure_ascii=False))
    spec = importlib.util.spec_from_file_location("s3vectors_kb_tools", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def csv(v):
    return [x.strip() for x in v.split(",") if x.strip()] if v else None


def main():
    ap = argparse.ArgumentParser(description="S3 Vectors 知识库命令行（与 Agent 共用工具代码）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("ingest")
    p.add_argument("file")
    p.add_argument("--strategy", default="skip", choices=["skip", "insert", "overwrite"])
    p.add_argument("--tags")
    p.add_argument("--chunk-size", type=int, default=512)
    p.add_argument("--chunk-overlap", type=int, default=64)
    p = sub.add_parser("search")
    p.add_argument("query")
    p.add_argument("--top-k", type=int, default=8)
    p.add_argument("--file-name")
    p.add_argument("--doc-id")
    p.add_argument("--tags")
    p.add_argument("--threshold", type=float, default=0.0)
    p.add_argument("--documents", action="store_true")
    p = sub.add_parser("show")
    p.add_argument("doc_id")
    p.add_argument("--limit", type=int, default=50)
    p = sub.add_parser("list")
    p.add_argument("--file-name")
    p.add_argument("--status")
    p.add_argument("--page", type=int, default=1)
    p.add_argument("--page-size", type=int, default=20)
    for name in ("detail", "sample", "restore"):
        sub.add_parser(name).add_argument("doc_id")
    p = sub.add_parser("delete")
    p.add_argument("doc_id")
    p.add_argument("--soft", action="store_true")
    sub.add_parser("stats")
    sub.add_parser("check")
    a = ap.parse_args()

    T = load_tools()
    if a.cmd == "ingest":
        r = T.s3vectors_writer(file_path=os.path.abspath(a.file), write_strategy=a.strategy, tags=csv(a.tags),
                               chunk_size=a.chunk_size, chunk_overlap=a.chunk_overlap)
    elif a.cmd == "search":
        filters = {k: v for k, v in {"file_name": a.file_name, "doc_id": a.doc_id, "tags": csv(a.tags)}.items() if v}
        r = T.s3vectors_search(query=a.query, filters=filters, top_k=a.top_k, similarity_threshold=a.threshold,
                               scope="documents" if a.documents else "chunks")
    elif a.cmd == "show":
        r = T.s3vectors_search(filters={"doc_id": a.doc_id}, top_k=min(a.limit, 100))
    elif a.cmd == "list":
        filters = {k: v for k, v in {"file_name": a.file_name, "status": a.status}.items() if v}
        r = T.s3vectors_statistics(query_type="document_list", filters=filters, page=a.page, page_size=a.page_size)
    elif a.cmd == "detail":
        r = T.s3vectors_statistics(query_type="document_detail", filters={"doc_id": a.doc_id})
    elif a.cmd == "sample":
        r = T.s3vectors_statistics(query_type="content_sample", filters={"doc_id": a.doc_id})
    elif a.cmd == "stats":
        r = T.s3vectors_statistics(query_type="dashboard_stats")
    elif a.cmd == "delete":
        r = T.s3vectors_manager(operation="delete", doc_id=a.doc_id, delete_mode="soft" if a.soft else "hard")
    elif a.cmd == "restore":
        r = T.s3vectors_manager(operation="restore", doc_id=a.doc_id)
    else:
        r = T.s3vectors_manager(operation="consistency_check")
    print(r)
    sys.exit(0 if json.loads(r).get("success") else 1)


if __name__ == "__main__":
    main()
