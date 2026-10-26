"""「规则库 › 制度知识库」页的管理命令：上传历史、现有标签、语义检索、检索日志（表和函数由 sql/kb_search.sql 建）。

用法（外壳 poc/app07 在测试台上以子进程调用；每个命令只打印一行 JSON）:
    python3 -I kb_admin.py --host H --port P --db D --user U --password-file F [--table approval_rules] <命令> ...

    record --name N --sha256 S --size B --by U --report FILE      记一次上传（已解析）→ {"id": int}
    status ID --status S [--result FILE] [--error TEXT] [--source-tag T --doc-title T --source-version V]
                                                                     改状态 → {"ok": true}；ingested 时同标签之前入库的记成 superseded
    recover                                                          服务重启时：入库中的改成失败 → {"recovered": int}
    history [--limit 50] / show ID                                   历史列表 / 一条详情
    tags                                                             规则表里现有的 source_tag 与来源文档、行数
    search Q [--k 8] [--segment S]                                   调 kb_search（caller=page）
    search-log [--limit 50]                                          最近的检索（审核 Agent、页面、verify）

出错时打印 {"error": "..."}，退出码 1。密码只从文件读，不出现在输出里。
"""
import argparse
import json
import re
import sys
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

DOCUMENT_COLUMNS = ("id, file_name, sha256, size_bytes, uploaded_by, uploaded_at, status, source_tag, doc_title, source_version, "
                    "report, result, error, started_at, finished_at")


def connect(a):
    import psycopg
    password = Path(a.password_file).read_text(encoding="utf-8").strip()
    return psycopg.connect(host=a.host, port=a.port, dbname=a.db, user=a.user, password=password, connect_timeout=15)


def plain(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    raise TypeError(type(value).__name__)


def rows(cur):
    names = [d[0] for d in cur.description or []]
    return [dict(zip(names, row)) for row in cur.fetchall()]


def read_json(path):
    return json.dumps(json.loads(Path(path).read_text(encoding="utf-8")), ensure_ascii=False) if path else None


def cmd_record(cur, a):
    cur.execute("INSERT INTO kb_documents (file_name, sha256, size_bytes, uploaded_by, status, report) "
                "VALUES (%s, %s, %s, %s, 'parsed', %s::jsonb) RETURNING id",
                (a.name, a.sha256, a.size, a.by, read_json(a.report)))
    return {"id": cur.fetchone()[0]}


def cmd_status(cur, a):
    if a.status == "ingesting":
        cur.execute("UPDATE kb_documents SET status = 'ingesting', started_at = now(), error = NULL, "
                    "source_tag = coalesce(%s, source_tag), doc_title = coalesce(%s, doc_title), source_version = coalesce(%s, source_version) WHERE id = %s",
                    (a.source_tag, a.doc_title, a.source_version, a.id))
    elif a.status == "ingested":
        if a.source_tag:
            cur.execute("UPDATE kb_documents SET status = 'superseded' WHERE source_tag = %s AND status = 'ingested' AND id <> %s", (a.source_tag, a.id))
        cur.execute("UPDATE kb_documents SET status = 'ingested', result = %s::jsonb, error = NULL, finished_at = now(), "
                    "source_tag = coalesce(%s, source_tag), doc_title = coalesce(%s, doc_title), source_version = coalesce(%s, source_version) WHERE id = %s",
                    (read_json(a.result), a.source_tag, a.doc_title, a.source_version, a.id))
    else:
        cur.execute("UPDATE kb_documents SET status = %s, error = %s, result = coalesce(%s::jsonb, result), finished_at = now() WHERE id = %s",
                    (a.status, (a.error or "")[:2000] or None, read_json(a.result), a.id))
    return {"ok": True}


def cmd_recover(cur, a):
    cur.execute("UPDATE kb_documents SET status = 'failed', error = %s, finished_at = now() WHERE status = 'ingesting' RETURNING id",
                ("服务重启，入库中断",))
    return {"recovered": len(cur.fetchall())}


def cmd_history(cur, a):
    cur.execute(f"SELECT {DOCUMENT_COLUMNS} FROM kb_documents ORDER BY id DESC LIMIT %s", (a.limit,))
    return {"items": rows(cur)}


def cmd_show(cur, a):
    cur.execute(f"SELECT {DOCUMENT_COLUMNS} FROM kb_documents WHERE id = %s", (a.id,))
    found = rows(cur)
    return {"item": found[0] if found else None}


def cmd_tags(cur, a):
    cur.execute(f"SELECT source_tag, source_doc, count(*) AS rows FROM {a.table} WHERE source_tag IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2")
    return {"items": rows(cur)}


def cmd_search(cur, a):
    cur.execute("SELECT * FROM kb_search(%s, %s, %s, 'page')", (a.question, a.k, a.segment))
    return {"items": rows(cur)}


def cmd_search_log(cur, a):
    cur.execute("SELECT id, at, caller, db_user, question, k, segment, hits, took_ms FROM kb_search_log ORDER BY id DESC LIMIT %s", (a.limit,))
    return {"items": rows(cur)}


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
