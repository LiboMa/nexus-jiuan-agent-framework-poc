"""按 deploy.env 生成本环境要上传 / 保存的文件。只写本地 .build/，不连任何服务。

用法：
  render.py tools  [--env deploy.env]
      → .build/s3vectors_kb_tools.py：把工具文件的 deploy-config 段换成本环境的区域与向量桶
  render.py rules-tools [--env deploy.env]
      → .build/s3vectors_rules_tools.py：规则工具模块，同样换 deploy-config 段（区域、向量桶、RULES_INDEX，缺省 rules）
  render.py prompt --tool-dir <导入后的目录名> [--rules-tool-dir <规则模块导入后的目录名>] [--env deploy.env]
      → .build/prompt.yaml 与 .build/prompt-body.json（Operator `PUT /api/v2/agents/{id}/files/prompt` 的请求体）
      给了 --rules-tool-dir 才带上模板里 {{#RULES}}…{{/RULES}} 的部分（「规则请求」一节与三个规则工具）；
      不给时与只有文档工具时的输出逐字相同
  render.py connector [--env deploy.env]
      → .build/connector-body.json（Operator `POST /api/v2/connectors` 的请求体：s3_vector、未绑定密钥、只读）
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
BUILD = os.path.join(PKG, ".build")
BEGIN, END = "# >>> deploy-config", "# <<< deploy-config"


def load_env(path):
    env = {}
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.split(" #", 1)[0].strip().strip("'\"")
    return env


def region_and_bucket(env):
    region, bucket = env.get("AWS_REGION", ""), env.get("VECTOR_BUCKET", "")
    if not re.fullmatch(r"[a-z]{2}(-[a-z]+)+-\d", region):
        sys.exit(f"AWS_REGION 不像区域名：{region!r}")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", bucket):
        sys.exit(f"VECTOR_BUCKET 不合法：{bucket!r}")
    return region, bucket


def splice_config(module, values):
    """把 tools/<module>.py 的 deploy-config 段换成 values（名字 → 值，按顺序），写到 .build/<module>.py。"""
    src = open(os.path.join(PKG, "tools", f"{module}.py"), encoding="utf-8").read()
    if src.count(BEGIN) != 1 or src.count(END) != 1:
        sys.exit("工具文件里的 deploy-config 段不完整")
    head, rest = src.split(BEGIN, 1)
    _, tail = rest.split(END, 1)
    block = f"{BEGIN}：scripts/render.py 按 deploy.env 改写这一段；其余代码各环境相同\n" + \
        "".join(f'{k} = "{v}"\n' for k, v in values)
    out = head + block + END + tail
    compile(out, f"{module}.py", "exec")
    os.makedirs(BUILD, exist_ok=True)
    dst = os.path.join(BUILD, f"{module}.py")
    open(dst, "w", encoding="utf-8").write(out)
    return dst


def render_tools(env):
    region, bucket = region_and_bucket(env)
    dst = splice_config("s3vectors_kb_tools", [("_REGION", region), ("_VECTOR_BUCKET", bucket), ("_CHUNK_INDEX", "chunks"),
                                               ("_DOC_INDEX", "docs"), ("_AUDIT_INDEX", "audit")])
    print(json.dumps({"file": os.path.relpath(dst, PKG), "region": region, "vector_bucket": bucket}, ensure_ascii=False))


# 同一个向量桶里其余的索引（infra/aws_setup.sh 建）：规则索引不能和它们同名
OTHER_INDEXES = ("chunks", "docs", "audit", "rule_sources")


def render_rules_tools(env):
    region, bucket = region_and_bucket(env)
    rules_index = env.get("RULES_INDEX") or "rules"
    # S3 Vectors 索引名：3~63 位小写字母、数字、连字符、点，首尾是字母或数字
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", rules_index) or rules_index in OTHER_INDEXES:
        sys.exit(f"RULES_INDEX 不合法（3~63 位小写字母、数字、连字符、点，且不能是 {' / '.join(OTHER_INDEXES)}）：{rules_index!r}")
    dst = splice_config("s3vectors_rules_tools", [("_REGION", region), ("_VECTOR_BUCKET", bucket),
                                                  ("_RULES_INDEX", rules_index), ("_SOURCES_INDEX", "rule_sources"),
                                                  ("_AUDIT_INDEX", "audit")])
    print(json.dumps({"file": os.path.relpath(dst, PKG), "region": region, "vector_bucket": bucket,
                      "rules_index": rules_index}, ensure_ascii=False))


TOOL_DIR_RE = r"[a-z0-9_]{1,32}_[0-9a-f]{8}"
# 模板里只在有规则模块时才要的部分：单独成行的 {{#RULES}} … {{/RULES}}（两行标记本身不进输出）
RULES_BLOCK = re.compile(r"^[ \t]*\{\{#RULES\}\}\n(.*?)^[ \t]*\{\{/RULES\}\}\n", re.M | re.S)


def render_prompt(tool_dir, rules_tool_dir=None):
    if not re.fullmatch(TOOL_DIR_RE, tool_dir):
        sys.exit(f"--tool-dir 应是导入返回的目录名（形如 kb_s3vectors_1a2b3c4d），收到：{tool_dir!r}")
    if rules_tool_dir is not None:
        if not re.fullmatch(TOOL_DIR_RE, rules_tool_dir):
            sys.exit(f"--rules-tool-dir 应是规则模块导入返回的目录名（形如 kb_s3v_rules_1a2b3c4d），收到：{rules_tool_dir!r}")
        if rules_tool_dir == tool_dir:
            sys.exit("--rules-tool-dir 与 --tool-dir 相同：规则模块是单独导入的另一个目录（.state/import-rules.json 的 dir_name）")
    text = open(os.path.join(PKG, "prompt", "knowbase_s3vectors_agent.yaml.tmpl"), encoding="utf-8").read()
    text = RULES_BLOCK.sub(lambda m: m.group(1) if rules_tool_dir else "", text)
    text = text.replace("{{TOOL_DIR}}", tool_dir)
    if rules_tool_dir:
        text = text.replace("{{RULES_TOOL_DIR}}", rules_tool_dir)
    if "{{" in text:
        sys.exit("提示词模板里还有没替换的占位符")
    os.makedirs(BUILD, exist_ok=True)
    open(os.path.join(BUILD, "prompt.yaml"), "w", encoding="utf-8").write(text)
    json.dump({"content": text, "file_type": "prompt"}, open(os.path.join(BUILD, "prompt-body.json"), "w", encoding="utf-8"),
              ensure_ascii=False)
    summary = {"prompt": ".build/prompt.yaml", "body": ".build/prompt-body.json", "tool_dir": tool_dir,
               "tools": text.count(f"imported_tools/{tool_dir}/")}
    if rules_tool_dir:
        summary.update({"rules_tool_dir": rules_tool_dir, "rules_tools": text.count(f"imported_tools/{rules_tool_dir}/")})
    print(json.dumps(summary, ensure_ascii=False))


CONNECTOR_DESC = (
    "Amazon S3 Vectors 知识库（由「知识库文档管家（S3 Vectors 版）」写入）：向量桶 {bucket}，索引 chunks，一条 = 一个文本块。"
    "向量 = Cohere Embed v4，1536 维，余弦距离（distance 越小越相关，相似度 = 1 − distance）。"
    "元数据：doc_id、chunk_index、active（false = 已软删除）、file_format、ingested_at（Unix 秒）、tags（列表）、"
    "text（正文，不可过滤）、file_name（不可过滤）。检索时务必带过滤排除软删除："
    "data_connector_query(connector_id, query=\"问题\", params='{{\"top_k\":8,\"filter\":{{\"active\":{{\"$eq\":true}}}}}}')；"
    "限定文档加 {{\"doc_id\":{{\"$in\":[\"doc_…\"]}}}}，按标签加 {{\"tags\":{{\"$eq\":\"标签\"}}}}，多个条件用 {{\"$and\":[…]}}。"
    "近似检索可能返回少于 top_k 的结果，top_k 不要小于 8。本连接器只读；写入、删除请用知识库文档管家（S3 Vectors 版）。")


def render_connector(env):
    bucket, region = env.get("VECTOR_BUCKET", ""), env.get("AWS_REGION", "")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", bucket):
        sys.exit(f"VECTOR_BUCKET 不合法：{bucket!r}")
    body = {"name": f"{bucket}（S3 Vectors 知识库）", "type": "s3_vector",
            "connection": {"bucket": bucket, "index_name": "chunks", "region": region,
                           "embedding_model": "global.cohere.embed-v4:0"},
            "access_control": {"permission": "read_only", "allow_write": False, "max_rows": 100},
            "tags": ["knowledge_base", "s3_vectors", "knowbase-s3vectors-agent"],
            "description": CONNECTOR_DESC.format(bucket=bucket)}
    os.makedirs(BUILD, exist_ok=True)
    json.dump(body, open(os.path.join(BUILD, "connector-body.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps({"body": ".build/connector-body.json", "name": body["name"]}, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["tools", "rules-tools", "prompt", "connector"])
    ap.add_argument("--env", default=os.path.join(PKG, "deploy.env"))
    ap.add_argument("--tool-dir")
    ap.add_argument("--rules-tool-dir")
    a = ap.parse_args()
    if a.what == "tools":
        render_tools(load_env(a.env))
    elif a.what == "rules-tools":
        render_rules_tools(load_env(a.env))
    elif a.what == "connector":
        render_connector(load_env(a.env))
    else:
        if not a.tool_dir:
            sys.exit("prompt 需要 --tool-dir")
        render_prompt(a.tool_dir, a.rules_tool_dir)


if __name__ == "__main__":
    main()
