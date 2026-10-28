"""把 .build/e2e/t*.out（Operator 的 --json stream 输出）摘成去敏的 tests/e2e_results.json：每轮调了哪些工具、
各自耗时、关键结果字段与整轮耗时。会话 / Agent / 发布 / 密钥 ID、域名、账号一律换成占位符，不带正文。
用法：e2e_digest.py <e2e 输出目录> <输出 json>"""
import glob
import json
import os
import re
import sys

KEEP = ("success", "error_type", "doc_id", "written_chunks", "status", "dedup_status", "embedding_model", "dimension",
        "total_count", "total_documents", "total_chunks", "deleted_chunks", "restored_chunks", "delete_mode",
        "consistency_passed", "orphan_vectors", "missing_records", "rows", "execution_time", "sampled_chunks")
SUBS = [(r"sess-[0-9a-f-]{36}", "<SESSION_ID>"), (r"agent_[0-9a-f]{32}", "<AGENT_ID>"), (r"pub_[0-9a-f]{16}", "<PUBLISH_ID>"),
        (r"conn-[0-9a-f]{12}", "<CONNECTOR_ID>"), (r"key-[0-9a-f]{12}", "<KEY_ID>"), (r"\d{12}", "<ACCOUNT>"),
        (r"[a-z0-9-]+\.tinyboat\.blog", "<env>.<domain>"), (r"kb_s3vectors_[0-9a-f]{8}", "kb_s3vectors_<hash>")]


def scrub(s):
    s = str(s)
    for pat, rep in SUBS:
        s = re.sub(pat, rep, s)
    return s


def ts(e):
    try:
        return int(str(e.get("_event_id", "")).split("-")[0])
    except ValueError:
        return None


def digest(path):
    evs = json.load(open(path, encoding="utf-8"))["events"]
    first = next((ts(e) for e in evs if ts(e)), None)
    last = next((ts(e) for e in reversed(evs) if ts(e)), None)
    started, tools = {}, []
    for e in evs:
        if e.get("event") != "message":
            continue
        if e.get("type") == "tool_use":
            started[e.get("tool_id")] = ts(e)
        elif e.get("type") == "tool_end":
            try:
                inp = json.loads(e.get("tool_input") or "{}")
            except ValueError:
                inp = {}
            try:
                out = json.loads(e.get("tool_result") or "{}")
            except ValueError:
                out = {}
            if isinstance(out, dict) and isinstance(out.get("results"), list):
                out["top"] = [{"chunk_index": r.get("chunk_index"), "similarity": r.get("similarity_score")} for r in out["results"][:3]]
            if isinstance(out, dict) and isinstance(out.get("data"), list):   # data_connector_query
                out["top"] = [{"key_suffix": str(r.get("key", ""))[-6:], "distance": round(float(r.get("distance", 0)), 4)}
                              for r in out["data"][:3]]
            res = {k: out.get(k) for k in KEEP + ("top",) if isinstance(out, dict) and k in out}
            args = {k: v for k, v in inp.items() if k in ("operation", "delete_mode", "write_strategy", "query", "top_k",
                                                          "similarity_threshold", "query_type", "tags", "chunk_size")}
            if "params" in inp:
                args["params"] = inp["params"]
            tools.append({"tool": e.get("tool_name"), "seconds": round((ts(e) - started.get(e.get("tool_id"), ts(e))) / 1000, 1),
                          "args": json.loads(scrub(json.dumps(args, ensure_ascii=False))),
                          "result": json.loads(scrub(json.dumps(res, ensure_ascii=False)))})
    return {"turn": os.path.basename(path)[:-4], "seconds": round((last - first) / 1000, 1) if first and last else None,
            "runtime": next((e.get("runtime_type") for e in evs if e.get("event") == "connected"), None),
            "model": next((e.get("model_id") for e in evs if e.get("event") == "agent_info"), None), "tools": tools}


def main():
    src, dst = sys.argv[1], sys.argv[2]
    turns = [digest(p) for p in sorted(glob.glob(os.path.join(src, "t[0-9].out")))]
    json.dump({"date": "2026-10-28", "env": "reference (us-east-1)", "turns": turns}, open(dst, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    for t in turns:
        print(t["turn"], t["seconds"], "s |", ", ".join(f'{x["tool"]}({x["seconds"]}s)' for x in t["tools"]))


if __name__ == "__main__":
    main()
