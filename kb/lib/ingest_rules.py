"""把 parse_rules.py 的输出写入 pgvector：建表（幂等）→ 生成向量 → 按 rule_id upsert →（可选）清理已删除的规则。

用法（由 deploy.sh ingest 调用；连接经 SSM 端口转发到 127.0.0.1:<port>）:
    python -I ingest_rules.py --rules rules.json --port 15432 --db nexus --user nexus --password-file <600 文件> \
        --table approval_rules --ddl ../sql/approval_rules.sql --source-tag finance-approval-v4 \
        --source-doc <文件名> --source-version <版本说明> --model amazon.titan-embed-text-v2:0 --dim 1024 \
        --region us-east-1 [--embed bedrock|sql] [--prune] [--dry-run] [--smoke-question "..."]

  --embed sql：向量在库里由 kb_embed()（sql/kb_search.sql，PL/Python 调 Bedrock）生成，本进程不需要 AWS 凭证、不 import boto3；
               「制度知识库」页的入库走这条（测试台上的外壳没有 AWS 凭证）。默认 bedrock：本机经 boto3 调 Bedrock。
               两种参数一样（同一模型、维度、normalize），所以来回换着入库不会造成改动。

幂等:
  - 每条规则存 record_sha256 = 除向量外全部列（含 source_tag / source_doc / source_version）的 SHA-256。
    与库里一致且已有向量 → 不写库；content 没变、其他列变了 → 只更新这些列，不重新生成向量（接管手工入库的旧表、
    或新版文档只改了章节说明时就是这种情况）；新规则或 content 变了 → 重新生成向量后 upsert。
  - --prune：删除同一 source_tag 下、本次文档里已不存在的 rule_id（文档改版删掉的规则）。
    没有 source_tag 的行（手工写入、或本工具之前的入库）不删，只在摘要 untagged_not_in_doc 里计数。
  - --dry-run：只连库对比，输出将新增 / 更新 / 删除的数量与将删除的 rule_id，不调 Bedrock、不写库。
  - 表已存在但 owner 不是当前用户时直接报错（建索引 / 补列需要 owner 权限），dry-run 也会报。

输出最后一行是 JSON 摘要（deploy.sh 解析）。不输出数据库密码。
"""
import argparse
import hashlib
import json
import re
import sys

COLUMNS = ("rule_id", "rule_type", "chapter_no", "chapter", "seq_no", "business_item", "segment", "amount_tier",
           "approval_path", "approval_path_text", "final_approver", "post_actions", "not_applicable", "extra",
           "scope_controls", "chapter_note", "content", "embedding", "source_doc", "source_version",
           "source_tag", "record_sha256")
JSONB = {"approval_path", "extra"}


def record_hash(row):
    """除向量与 record_sha256 自身外全部列的稳定哈希。"""
    body = {c: row.get(c) for c in COLUMNS if c not in ("embedding", "record_sha256")}
    return hashlib.sha256(json.dumps(body, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")).hexdigest()


def embed(client, model, dim, text):
    body = json.dumps({"inputText": text, "dimensions": dim, "normalize": True})
    resp = client.invoke_model(modelId=model, body=body, contentType="application/json", accept="application/json")
    vec = json.loads(resp["body"].read())["embedding"]
    if len(vec) != dim:
        raise RuntimeError(f"embedding 维度 {len(vec)} != {dim}")
    return "[" + ",".join(f"{x:.7f}" for x in vec) + "]"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rules", required=True)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--db", required=True)
    ap.add_argument("--user", required=True)
    ap.add_argument("--password-file", required=True)
    ap.add_argument("--table", required=True)
    ap.add_argument("--ddl", required=True)
    ap.add_argument("--source-tag", required=True)
    ap.add_argument("--source-doc", required=True)
    ap.add_argument("--source-version", default="")
    ap.add_argument("--model", required=True)
    ap.add_argument("--dim", type=int, required=True)
    ap.add_argument("--region", required=True)
    ap.add_argument("--prune", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--smoke-question", default="")
    ap.add_argument("--embed", choices=["bedrock", "sql"], default="bedrock")
    a = ap.parse_args()
    import psycopg

    if not re.fullmatch(r"[a-z_][a-z0-9_]*", a.table):
        sys.exit(f"非法表名 {a.table}")
    rules = json.load(open(a.rules, encoding="utf-8"))
    pw = open(a.password_file, encoding="utf-8").read().strip()
    ddl = open(a.ddl, encoding="utf-8").read().replace("{table}", a.table).replace("{dim}", str(a.dim))
    t = a.table
    summary = {"table": t, "rules_in_doc": len(rules), "inserted": 0, "updated": 0, "unchanged": 0, "pruned": 0,
               "dry_run": a.dry_run}

    with psycopg.connect(host=a.host, port=a.port, dbname=a.db, user=a.user, password=pw, connect_timeout=15) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass(%s) IS NOT NULL", (f"public.{t}",))
            table_exists = cur.fetchone()[0]
            existing = {}
            if table_exists:
                cur.execute("SELECT tableowner, current_user FROM pg_tables WHERE schemaname = 'public' AND tablename = %s", (t,))
                owner, me = cur.fetchone()
                if owner != me:
                    sys.exit(f"表 {t} 的 owner 是 {owner}，不是当前用户 {me}：补列 / 建索引会失败。"
                             f"请以 postgres 执行 ALTER TABLE {t} OWNER TO {me}; 后重试")
                cur.execute("SELECT column_name FROM information_schema.columns WHERE table_name = %s", (t,))
                cols = {r[0] for r in cur.fetchall()}
                sha_expr = "record_sha256" if "record_sha256" in cols else "NULL"
                tag_expr = "source_tag" if "source_tag" in cols else "NULL"
                cur.execute(f"SELECT rule_id, {sha_expr}, embedding IS NOT NULL, {tag_expr}, content FROM {t}")
                existing = {r[0]: r[1:] for r in cur.fetchall()}
            if a.dry_run:
                print(f"[dry-run] 表 {t} {'已存在' if table_exists else '不存在（将创建）'}，现有 {len(existing)} 行", file=sys.stderr)
            else:
                cur.execute(ddl)

            # 分三类：unchanged（不写）；retag（正文没变、已有向量，只更新元数据列，不调 Bedrock）；
            # embed（新规则或正文变了，重新生成向量后 upsert）
            todo = []
            for r in rules:
                row = {c: r.get(c) for c in COLUMNS}
                row["approval_path"] = json.dumps(r.get("approval_path") or [], ensure_ascii=False)
                row["extra"] = json.dumps(r.get("extra") or {}, ensure_ascii=False)
                row.update(source_doc=a.source_doc, source_version=a.source_version, source_tag=a.source_tag)
                row["record_sha256"] = h = record_hash(row)
                cur_row = existing.get(r["rule_id"])
                if cur_row is None:
                    todo.append((row, "insert"))
                    continue
                c_sha, has_emb, _c_tag, c_content = cur_row
                if has_emb and c_sha == h:
                    summary["unchanged"] += 1
                else:
                    todo.append((row, "retag" if (has_emb and c_content == r["content"]) else "embed"))
            summary["retagged"] = 0
            doc_ids = {r["rule_id"] for r in rules}
            # 只清理同一 source_tag 的行；没有标签（手工写入或旧版本入库）且不在本文档里的行一律保留，只报告
            prune_ids = sorted(rid for rid, row in existing.items()
                               if rid not in doc_ids and row[2] == a.source_tag) if a.prune else []
            summary["untagged_not_in_doc"] = sum(1 for rid, row in existing.items()
                                                 if rid not in doc_ids and row[2] is None)

            if a.dry_run:
                summary["inserted"] = sum(1 for _, k in todo if k == "insert")
                summary["updated"] = sum(1 for _, k in todo if k == "embed")
                summary["retagged"] = sum(1 for _, k in todo if k == "retag")
                summary["pruned"] = len(prune_ids)
                summary["pruned_ids"] = prune_ids
                print(json.dumps(summary, ensure_ascii=False))
                return

            if a.embed == "sql":
                def vector_of(text):
                    cur.execute("SELECT kb_embed(%s)::text", (text,))
                    return cur.fetchone()[0]
            else:
                import boto3
                bedrock = boto3.client("bedrock-runtime", region_name=a.region)

                def vector_of(text):
                    return embed(bedrock, a.model, a.dim, text)
            placeholders = ", ".join(f"%({c})s::jsonb" if c in JSONB else ("%(embedding)s::vector" if c == "embedding" else f"%({c})s")
                                     for c in COLUMNS)
            updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in COLUMNS if c != "rule_id")
            upsert = (f"INSERT INTO {t} ({', '.join(COLUMNS)}, ingested_at) VALUES ({placeholders}, now()) "
                      f"ON CONFLICT (rule_id) DO UPDATE SET {updates}, ingested_at = now()")
            retag = (f"UPDATE {t} SET " + ", ".join(
                f"{c} = %({c})s::jsonb" if c in JSONB else f"{c} = %({c})s"
                for c in COLUMNS if c not in ("rule_id", "embedding")) + ", ingested_at = now() WHERE rule_id = %(rule_id)s")
            for i, (row, kind) in enumerate(todo, start=1):
                if kind == "retag":
                    cur.execute(retag, row)
                    summary["retagged"] += 1
                else:
                    row["embedding"] = vector_of(row["content"])
                    cur.execute(upsert, row)
                    summary["inserted" if kind == "insert" else "updated"] += 1
                if i % 20 == 0:
                    print(f"  upserted {i}/{len(todo)}", file=sys.stderr, flush=True)
            if prune_ids:
                cur.execute(f"DELETE FROM {t} WHERE rule_id = ANY(%s)", (prune_ids,))
                summary["pruned"] = cur.rowcount
                summary["pruned_ids"] = prune_ids
            conn.commit()

            cur.execute(f"SELECT rule_type, count(*) FROM {t} GROUP BY 1 ORDER BY 1")
            summary["rows_by_type"] = {k: v for k, v in cur.fetchall()}
            cur.execute(f"SELECT count(*) FROM {t} WHERE embedding IS NULL")
            summary["rows_without_embedding"] = cur.fetchone()[0]
            if a.smoke_question and a.embed == "sql":
                cur.execute("SELECT rule_id, score FROM kb_search(%s, 3, NULL, 'ingest')", (a.smoke_question,))
                summary["smoke_top3"] = [f"{rid}:{sim}" for rid, sim in cur.fetchall()]
            elif a.smoke_question:
                q = embed(bedrock, a.model, a.dim, a.smoke_question)
                cur.execute(f"SELECT rule_id, round((1 - (embedding <=> %s::vector))::numeric, 4) "
                            f"FROM {t} ORDER BY embedding <=> %s::vector LIMIT 3", (q, q))
                summary["smoke_top3"] = [f"{rid}:{sim}" for rid, sim in cur.fetchall()]
    print(json.dumps(summary, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
