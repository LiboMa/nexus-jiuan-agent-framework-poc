"""把 parse_rules.py 的输出写入 pgvector：建表（幂等）→ 对比 → 生成向量 → 按 rule_id upsert →（可选）清理已删除的规则。
对比、冲突、写入都由 kb_store.ingest 做（与 Nexus 工具同一份实现、同一把锁），这里只是命令行。

用法（由 deploy.sh ingest 调用；连接经 SSM 端口转发到 127.0.0.1:<port>）:
    python -I ingest_rules.py --rules rules.json --port 15432 --db nexus --user nexus --password-file <600 文件> \
        --table approval_rules --ddl ../sql/approval_rules.sql --source-tag finance-approval-v4 \
        --source-doc <文件名> --source-version <版本说明> --model us.cohere.embed-v4:0 --dim 1024 \
        --region us-east-1 [--embed sql|bedrock] [--prune] [--dry-run] [--smoke-question "..."]

  --embed sql：向量在库里由 kb_embed_batch()（sql/kb_search.sql，PL/Python 调 Bedrock）一次算出，本进程不需要 AWS 凭证、
               不 import boto3；模型是库里 kb_meta 登记的那个。库里的 kb_search.sql 早于 kb_embed_batch 时逐条调 kb_embed(text)
               （kb_store.ingest(embed="sql-legacy")；Agent 的工具不回落，报 kb_not_ready）。
  --embed bedrock（缺省，旧用法）：本机经 boto3 调 Bedrock，只给 Titan 的库用。--model 是 Cohere 时直接退出（改用 --embed sql）；
               库里 kb_meta 登记的模型不是 --model / --dim 时报 embedding_model_mismatch，不写库。

幂等（kb_store.ingest）:
  - 每条规则存 record_sha256 = 除向量外全部列（含 source_tag / source_doc / source_version）的 SHA-256。
    与库里一致且已有向量 → 不写库；content 没变、其他列变了 → 只更新这些列，不重新生成向量（摘要里的 retagged）；
    新规则或 content 变了 → 重新生成向量后 upsert（inserted / updated）。
  - --prune：删除同一 source_tag 下、本次文档里已不存在的 rule_id（文档改版删掉的规则）。
    没有 source_tag 的行（手工写入、或本工具之前的入库）不删，只在摘要 untagged_not_in_doc 里计数。
  - 规则编号已属于另一份文档（别的标签；没有标签时看来源文档）→ 整份拒绝、一条不写；--dry-run 时在摘要 conflicts 里报。
  - 这份制度已下线（在归档表里）→ 拒绝，先恢复或删除。
  - 规则文件是空的 → 退出（empty_document），不连库：否则 --prune 会删光这份制度。
  - --dry-run：只连库对比，输出将新增 / 更新 / 删除的数量与将删除的 rule_id，不算向量、不写库、不建表。
  - 表已存在但 owner 不是当前用户时直接报错（建索引 / 补列需要 owner 权限），dry-run 也会报。
  - 建表（--ddl）和入库各是一个事务，都先拿同一把入库锁：与 Agent 的入库、换模型脚本不会同时写。

输出最后一行是 JSON 摘要（deploy.sh 解析）。不输出数据库密码。
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

if __package__:
    from . import kb_store
else:  # python -I kb/lib/ingest_rules.py：-I 不把脚本所在目录放进 sys.path
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import kb_store

COLUMNS, JSONB, record_hash = kb_store.COLUMNS, kb_store.JSONB, kb_store.record_hash   # 原来从这里取的照样能取


def embed(client, model, dim, text):
    body = json.dumps({"inputText": text, "dimensions": dim, "normalize": True})
    resp = client.invoke_model(modelId=model, body=body, contentType="application/json", accept="application/json")
    vec = json.loads(resp["body"].read())["embedding"]
    if len(vec) != dim:
        raise RuntimeError(f"embedding 维度 {len(vec)} != {dim}")
    return "[" + ",".join(f"{x:.7f}" for x in vec) + "]"


def model_family(model):
    """kb_meta.embed_model 记的模型族：去掉推理配置文件的区域前缀。"""
    return re.sub(r"^(us|global|eu|apac)\.", "", model)


def titan(a):
    """--embed bedrock：本机调 Titan，用到时才 import boto3、建客户端。"""
    client = []

    def vector_of(text):
        if not client:
            import boto3
            client.append(boto3.client("bedrock-runtime", region_name=a.region))
        return embed(client[0], a.model, a.dim, text)
    return vector_of


def check_titan(cur, a):
    meta = kb_store.embed_model(cur)   # 没有 kb_meta：Titan 时代的库，照旧
    if meta and (meta["model"] != model_family(a.model) or meta["dim"] != a.dim):
        sys.exit(f"embedding_model_mismatch：库里 kb_meta 登记的向量模型是 {meta['model']}（{meta['dim']} 维），"
                 f"--embed bedrock 配的是 {model_family(a.model)}（{a.dim} 维）。换过模型的库请用 --embed sql（向量在库里算）；没有写库")


def run(conn, a, rules, ddl):
    t = a.table
    with conn.cursor() as cur:
        if a.dry_run:
            kb_store.ensure_owner(cur, t)
            if a.embed == "bedrock":
                check_titan(cur, a)
            cur.execute("SELECT to_regclass(%s) IS NOT NULL", (f"public.{t}",))
            row = cur.fetchone()
            if row and row[0]:
                cur.execute(f"SELECT count(*) FROM {t}")
                n = cur.fetchone()
                print(f"[dry-run] 表 {t} 已存在，现有 {n[0] if n else 0} 行", file=sys.stderr)
            else:
                print(f"[dry-run] 表 {t} 不存在（将创建）", file=sys.stderr)
        else:
            kb_store.lock(cur, t)   # 建表 / 补列也和入库、换模型串行
            kb_store.ensure_owner(cur, t)
            if a.embed == "bedrock":
                check_titan(cur, a)
            cur.execute(ddl)
    conn.commit()

    rows = kb_store.prepare(rules, source_tag=a.source_tag, source_doc=a.source_doc, source_version=a.source_version)
    vector_of = titan(a) if a.embed == "bedrock" else None
    conflicts = []
    try:
        res = kb_store.ingest(conn, t, rows, source_tag=a.source_tag, prune=a.prune, dry_run=a.dry_run,
                              embed=(lambda texts: [vector_of(x) for x in texts]) if vector_of else "sql-legacy")
    except kb_store.KbError as e:
        if not (a.dry_run and e.code == "rule_conflict"):
            raise
        res, conflicts = e.extra["plan"], e.extra["conflicts"]   # dry-run：冲突照样报计划，实跑才拒绝
    # 摘要的键名与口径照旧：updated = 重算了向量的；retagged = 只更新了其他列的；pruned = 删掉的
    summary = {"table": t, "rules_in_doc": len(rules), "inserted": res["inserted"], "updated": res["reembedded"], "unchanged": res["unchanged"],
               "pruned": res["removed"], "dry_run": a.dry_run, "retagged": res["updated"], "untagged_not_in_doc": res["untagged_not_in_doc"],
               "conflicts": len(conflicts), "conflict_ids": conflicts}
    if a.dry_run:
        summary["pruned_ids"] = res["will_remove"]
        return summary
    if res["will_remove"]:
        summary["pruned_ids"] = res["will_remove"]

    with conn.cursor() as cur:
        cur.execute(f"SELECT rule_type, count(*) FROM {t} GROUP BY 1 ORDER BY 1")
        summary["rows_by_type"] = {k: v for k, v in cur.fetchall()}
        cur.execute(f"SELECT count(*) FROM {t} WHERE embedding IS NULL")
        summary["rows_without_embedding"] = cur.fetchone()[0]
        if a.smoke_question and a.embed == "sql":
            summary["smoke_top3"] = [f"{r['rule_id']}:{r['score']}" for r in kb_store.search(cur, a.smoke_question, 3, None, "ingest")]
        elif a.smoke_question:
            q = vector_of(a.smoke_question)
            cur.execute(f"SELECT rule_id, round((1 - (embedding <=> %s::vector))::numeric, 4) "
                        f"FROM {t} ORDER BY embedding <=> %s::vector LIMIT 3", (q, q))
            summary["smoke_top3"] = [f"{rid}:{sim}" for rid, sim in cur.fetchall()]
    return summary


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

    if a.embed == "bedrock" and "cohere" in a.model.lower():
        sys.exit(f"--embed bedrock 只给 Titan 用（本机调 Bedrock）；{a.model} 请改用 --embed sql：向量在库里由 kb_embed_batch 生成")
    if not re.fullmatch(r"[a-z_][a-z0-9_]*", a.table):
        sys.exit(f"非法表名 {a.table}")
    rules = json.loads(Path(a.rules).read_text(encoding="utf-8"))
    if not rules:   # 空的新版本加上 --prune 会删光这份制度：不连库就拒绝
        sys.exit(f"empty_document：{a.rules} 里一条规则都没有（解析失败或不是审批矩阵文档），没有连库、没有写库")
    pw = Path(a.password_file).read_text(encoding="utf-8").strip()
    ddl = Path(a.ddl).read_text(encoding="utf-8").replace("{table}", a.table).replace("{dim}", str(a.dim))
    creds = {"host": a.host, "port": a.port, "database": a.db, "username": a.user, "password": pw}
    try:
        with kb_store.connect(creds, application_name="kb-ingest-rules", timeout=15) as conn:
            summary = run(conn, a, rules, ddl)
    except kb_store.KbError as e:
        sys.exit(e.message)
    print(json.dumps(summary, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
