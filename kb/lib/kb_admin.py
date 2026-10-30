"""「规则库 › 制度知识库」页的管理命令：上传历史、现有标签、语义检索、检索日志（表和函数由 sql/kb_search.sql 建）。
SQL 都在 kb_store（与 Nexus 工具同一份），这里只是命令行。

用法（外壳 poc/app07 在测试台上以子进程调用；每个命令只打印一行 JSON）:
    python3 -I kb_admin.py --host H --port P --db D --user U --password-file F [--table approval_rules] <命令> ...

    record --name N --sha256 S --size B --by U --report FILE      记一次上传（已解析）→ {"id": int}
    status ID --status S [--result FILE] [--error TEXT] [--source-tag T --doc-title T --source-version V]
                                                                     改状态 → {"ok": true}；ingested 时同标签之前入库的记成 superseded
    recover                                                          服务重启时：入库中的改成失败 → {"recovered": int}
    history [--limit 50] / show ID                                   历史列表 / 一条详情
    tags                                                             规则表里现有的 source_tag 与来源文档、版本说明、行数
    search Q [--k 8] [--segment S]                                   调 kb_search（caller=page）
    search-log [--limit 50]                                          最近的检索（审核 Agent、页面、verify）

出错时打印 {"error": "..."}，退出码 1。密码只从文件读，不出现在输出里。
"""
import argparse
import json
import os
import re
import sys
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

if __package__:
    from . import kb_store
else:  # python -I kb/lib/kb_admin.py：-I 不把脚本所在目录放进 sys.path
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import kb_store


def connect(a):
    password = Path(a.password_file).read_text(encoding="utf-8").strip()
    return kb_store.connect({"host": a.host, "port": a.port, "database": a.db, "username": a.user, "password": password},
                            application_name="kb-admin", timeout=15)


def plain(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    raise TypeError(type(value).__name__)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8")) if path else None


def cmd_record(cur, a):
    return {"id": kb_store.record_document(cur, file_name=a.name, sha256=a.sha256, size_bytes=a.size, uploaded_by=a.by, source_tag=None,
                                           doc_title=None, source_version=None, report=read_json(a.report))}


def cmd_status(cur, a):
    kb_store.set_document_status(cur, a.id, a.status, result=read_json(a.result), error=a.error, source_tag=a.source_tag,
                                 doc_title=a.doc_title, source_version=a.source_version)
    return {"ok": True}


def cmd_recover(cur, a):
    return {"recovered": kb_store.recover(cur, 0)}   # 服务重启时：入库中的全部记成失败


def cmd_history(cur, a):
    return {"items": kb_store.history(cur, a.limit)}


def cmd_show(cur, a):
    return {"item": kb_store.show(cur, a.id)}


def cmd_tags(cur, a):
    return {"items": kb_store.tags(cur, a.table)}


def cmd_search(cur, a):
    return {"items": kb_store.search(cur, a.question, a.k, a.segment, "page")}


def cmd_search_log(cur, a):
    return {"items": kb_store.search_log(cur, a.limit)}


WRITES = {"record", "status", "recover"}


def parser():
    ap = argparse.ArgumentParser(description="制度知识库的管理命令")
    for flag, kw in (("--host", {"default": "127.0.0.1"}), ("--port", {"type": int, "required": True}), ("--db", {"required": True}),
                     ("--user", {"required": True}), ("--password-file", {"required": True}), ("--table", {"default": "approval_rules"})):
        ap.add_argument(flag, **kw)
    sub = ap.add_subparsers(dest="command", required=True)
    p = sub.add_parser("record")
    for flag in ("--name", "--sha256", "--by", "--report"):
        p.add_argument(flag, required=True)
    p.add_argument("--size", type=int, required=True)
    p = sub.add_parser("status")
    p.add_argument("id", type=int)
    p.add_argument("--status", required=True, choices=["parsed", "ingesting", "ingested", "failed", "superseded"])
    for flag in ("--result", "--error", "--source-tag", "--doc-title", "--source-version"):
        p.add_argument(flag)
    sub.add_parser("recover")
    for name in ("history", "search-log"):
        sub.add_parser(name).add_argument("--limit", type=int, default=50)
    sub.add_parser("show").add_argument("id", type=int)
    sub.add_parser("tags")
    p = sub.add_parser("search")
    p.add_argument("question")
    p.add_argument("--k", type=int, default=8)
    p.add_argument("--segment")
    return ap


def main(argv=None, connect=connect):
    a = parser().parse_args(argv)
    try:
        if not re.fullmatch(r"[a-z_][a-z0-9_]*", a.table):
            raise ValueError(f"非法表名 {a.table}")
        handler = globals()["cmd_" + a.command.replace("-", "_")]
        with connect(a) as conn:
            with conn.cursor() as cur:
                result = handler(cur, a)
            if a.command in WRITES:
                conn.commit()
    except Exception as error:  # noqa: BLE001 — 一律回成一行 JSON，让外壳照原因显示
        print(json.dumps({"error": str(error)[:500]}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, default=plain))
    return 0


if __name__ == "__main__":
    sys.exit(main())
