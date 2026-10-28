"""把 Operator `--json call POST …/stream` 的输出（一个 JSON，events 数组；也兼容逐行 JSON）摘要成：
工具调用（入参摘要 + 结果；长正文截断）+ 耗时 + 最终回复。用法：summarize_turn.py <turn.out> [--full-text]"""
import json
import sys


def brief(obj):
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k in ("embeddings", "embedding", "query_vector") and isinstance(v, list):
                out[k] = f"<vector x{len(v)}>"
            elif k in ("content", "structured_text", "text") and isinstance(v, str) and len(v) > 120:
                out[k] = v[:120] + f"…<{len(v)} chars>"
            else:
                out[k] = brief(v)
        return out
    if isinstance(obj, list):
        return [brief(x) for x in obj[:12]]
    return obj


def parse(s):
    try:
        return json.loads(s)
    except Exception:
        return s


def events(path):
    raw = open(path, encoding="utf-8").read()
    try:
        d = json.loads(raw)
        if isinstance(d, dict) and isinstance(d.get("events"), list):
            return d["events"]
    except ValueError:
        pass
    out = []
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def ts(e):
    try:
        return int(str(e.get("_event_id", "")).split("-")[0])
    except ValueError:
        return None


evs = events(sys.argv[1])
texts, started = [], {}
first = next((ts(e) for e in evs if ts(e)), None)
for e in evs:
    ev, t = e.get("event"), e.get("type")
    if ev == "message" and t == "tool_use":
        started[e.get("tool_id")] = ts(e)
    elif ev == "message" and t == "tool_end":
        dt = (ts(e) - started.get(e.get("tool_id"), ts(e))) / 1000 if ts(e) else 0
        print(f"\n>> {e.get('tool_name')}  ({dt:.1f}s)")
        print("   in :", json.dumps(brief(parse(e.get("tool_input") or "{}")), ensure_ascii=False)[:900])
        print("   out:", json.dumps(brief(parse(e.get("tool_result") or "")), ensure_ascii=False)[:1800])
    elif ev == "message" and t == "text":
        texts.append(e.get("data") or "")
    elif ev in ("error", "done") or (ev == "status" and e.get("code")):
        print(f"[{ev}]", json.dumps({k: v for k, v in e.items() if k not in ("event", "_event_id")}, ensure_ascii=False)[:300])
last = next((ts(e) for e in reversed(evs) if ts(e)), None)
if first and last:
    print(f"\n本轮耗时 {(last - first) / 1000:.1f}s（从连上会话到 done）")
print("\n=== final reply ===")
final = texts[-1] if texts else ""
print(final if "--full-text" in sys.argv else final[:2500])
