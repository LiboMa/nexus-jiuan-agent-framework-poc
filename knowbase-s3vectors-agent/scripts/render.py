"""按 deploy.env 生成本环境要上传 / 保存的文件。只写本地 .build/，不连任何服务。

用法：
  render.py tools  [--env deploy.env]
      → .build/s3vectors_kb_tools.py：把工具文件的 deploy-config 段换成本环境的区域与向量桶
  render.py rules-tools [--env deploy.env]
      → .build/s3vectors_rules_tools.py：规则工具模块，同样换 deploy-config 段（区域、向量桶、RULES_INDEX，缺省 rules）
  render.py prompt [--package <包目录>] --tool-dir <导入后的目录名> [--rules-tool-dir <规则模块导入后的目录名>] [--env deploy.env]
      → <包>/.build/prompt.yaml 与 prompt-body.json（Operator `PUT /api/v2/agents/{id}/files/prompt` 的请求体）
      模板与占位符读包描述 nexus-package.json 的 prompt（见 nexus_package.py）；--package 缺省是本包（knowbase-s3vectors-agent），
      PG 版：render.py prompt --package knowledgebase-writer-agent-pg --tool-dir <目录名>。
      本包给了 --rules-tool-dir 才带上模板里 {{#RULES}}…{{/RULES}} 的部分（「规则请求」一节与三个规则工具）；
      不给时与只有文档工具时的输出逐字相同
  render.py connector [--env deploy.env]
      → .build/connector-body.json（Operator `POST /api/v2/connectors` 的请求体：s3_vector、未绑定密钥、只读）
  tools / rules-tools / connector 只用于本包；别的包的工具文件用它描述里 modules.*.render 的命令生成。

提示词模板的写法（render.py prompt）：
  {{占位符}}                描述 prompt.placeholders 里的占位符 → 那个模块导入后的目录名（--tool-dir、--rules-tool-dir …）
  {{#段名}} … {{/段名}}     各自单独成行；描述 prompt.sections 里段名对应的占位符给了才保留中间的行，两行标记不进输出
  {{> 片段}}                单独成行；换成仓库 kb/prompt/<片段>.zh.md 的全文（两个包共用，如 kb_rules_v1），每个非空行加上这一行的缩进
  {{$空位}} … {{/空位}}     给片段里的空位 {{$空位}} 填的文字，写在模板里（一般紧跟 {{> 片段}}），定义本身不进输出：
                            标记各自单独成行 = 多行文字（原样，含缩进），换掉片段里单独成行的 {{$空位}}；
                            写在同一行里（{{$空位}}文字{{/空位}}）= 行内文字，换掉片段行内的 {{$空位}}。
                            片段里的空位都要填，模板里多给的也报错
  {{! 注释 }}               单独成行的注释（模板和片段里都可以写），不进输出
  渲染完还有 {{ 就报错。
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)   # python -I 不把脚本所在目录放进 sys.path；nexus_package.py 与本脚本同目录
import nexus_package  # noqa: E402

OWN_PKG = os.path.dirname(HERE)
BEGIN, END = "# >>> deploy-config", "# <<< deploy-config"
# 当前的包：use_package 设定（缺省是本包）。BUILD 是渲染结果的目录，测试会改成临时目录
PKG = BUILD = DESC = None


def use_package(path):
    """改用 path 这个包（读它的 nexus-package.json）；渲染结果写到它的 .build/。"""
    global PKG, BUILD, DESC
    PKG = os.path.abspath(path)
    BUILD = os.path.join(PKG, ".build")
    DESC = nexus_package.load(PKG)


use_package(OWN_PKG)


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
OTHER_INDEXES = ("chunks", "docs", "audit", "rule-sources")


def render_rules_tools(env):
    region, bucket = region_and_bucket(env)
    rules_index = env.get("RULES_INDEX") or "rules"
    # S3 Vectors 索引名：3~63 位小写字母、数字、连字符、点，首尾是字母或数字
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", rules_index) or rules_index in OTHER_INDEXES:
        sys.exit(f"RULES_INDEX 不合法（3~63 位小写字母、数字、连字符、点，且不能是 {' / '.join(OTHER_INDEXES)}）：{rules_index!r}")
    dst = splice_config("s3vectors_rules_tools", [("_REGION", region), ("_VECTOR_BUCKET", bucket),
                                                  ("_RULES_INDEX", rules_index), ("_SOURCES_INDEX", "rule-sources"),
                                                  ("_AUDIT_INDEX", "audit")])
    print(json.dumps({"file": os.path.relpath(dst, PKG), "region": region, "vector_bucket": bucket,
                      "rules_index": rules_index}, ensure_ascii=False))


TOOL_DIR_RE = r"[a-z0-9_]{1,32}_[0-9a-f]{8}"
COMMENT_RE = re.compile(r"^[ \t]*\{\{!.*\}\}[ \t]*\n", re.M)
INCLUDE_RE = re.compile(r"^([ \t]*)\{\{> ?([a-z0-9_]+)\}\}[ \t]*\n", re.M)
SLOT_BLOCK_RE = re.compile(r"^[ \t]*\{\{\$([a-z_]+)\}\}[ \t]*\n(.*?)^[ \t]*\{\{/\1\}\}[ \t]*\n", re.M | re.S)
SLOT_INLINE_RE = re.compile(r"^[ \t]*\{\{\$([a-z_]+)\}\}(.*?)\{\{/\1\}\}[ \t]*\n", re.M)
SLOT_LINE_RE = re.compile(r"^\{\{\$([a-z_]+)\}\}$")
SLOT_RE = re.compile(r"\{\{\$([a-z_]+)\}\}")


def section_re(name):
    """模板里只在给了某个占位符时才要的部分：单独成行的 {{#名}} … {{/名}}（两行标记本身不进输出）。"""
    return re.compile(rf"^[ \t]*\{{\{{#{name}\}}\}}\n(.*?)^[ \t]*\{{\{{/{name}\}}\}}\n", re.M | re.S)


def fragment_text(name):
    """共用片段 kb/prompt/<name>.zh.md（在包目录的上一级，即仓库根下）的文字，注释行去掉。"""
    where = os.path.join(os.path.dirname(PKG), "kb", "prompt", f"{name}.zh.md")
    if not os.path.isfile(where):
        sys.exit(f"找不到共用片段 kb/prompt/{name}.zh.md（应在 {where}）")
    with open(where, encoding="utf-8") as f:
        return COMMENT_RE.sub("", f.read())


def collect_slots(text):
    """模板里给空位填的文字 → (去掉这些定义的模板, {空位: (是不是多行, 文字)})。
    多行：{{$名}} 与 {{/名}} 各占一行，中间的行原样（含缩进）；行内：一行里的 {{$名}}文字{{/名}}。"""
    slots = {}

    def keep(multiline):
        def sub(m):
            if m.group(1) in slots:
                sys.exit(f"提示词模板里的空位 {m.group(1)} 定义了两次")
            slots[m.group(1)] = (multiline, m.group(2))
            return ""
        return sub

    text = SLOT_BLOCK_RE.sub(keep(True), text)
    return SLOT_INLINE_RE.sub(keep(False), text), slots


def fill_fragment(name, indent, slots, used):
    """片段的文字：每个非空行加上 indent，空位换成模板里定义的文字（多行的原样放进去）；用到的空位记进 used。"""
    out, missing = [], []
    for line in fragment_text(name).splitlines():
        whole = SLOT_LINE_RE.fullmatch(line)
        for key in [whole.group(1)] if whole else SLOT_RE.findall(line):
            if key not in slots:
                missing.append(key)
                continue
            if slots[key][0] != bool(whole):
                where = "单独占一行，模板里却写成了行内（要 {{$名}} 与 {{/名}} 各占一行）" if whole else \
                    "在行内，模板里却写成了多行（要写成行内的 {{$名}}文字{{/名}}）"
                sys.exit(f"共用片段 {name} 的空位 {key} {where}")
            used.add(key)
        if whole:
            out.append(slots.get(whole.group(1), (True, ""))[1])
        else:
            line = SLOT_RE.sub(lambda s: slots.get(s.group(1), (False, ""))[1], line)
            out.append(f"{indent}{line}\n" if line else "\n")
    if missing:
        sys.exit(f"共用片段 {name} 的空位没有填：{'、'.join(dict.fromkeys(missing))}（在模板里用 {{{{$名}}}}…{{{{/名}}}} 写）")
    return "".join(out)


def expand_includes(text):
    """{{> 片段}} → 片段全文，空位用模板里 {{$空位}}…{{/空位}} 的定义填；定义了却没有片段用的空位报错。"""
    text, slots = collect_slots(text)
    used = set()
    text = INCLUDE_RE.sub(lambda m: fill_fragment(m.group(2), m.group(1), slots, used), text)
    extra = sorted(set(slots) - used)
    if extra:
        sys.exit(f"提示词模板里多余的空位：{'、'.join(extra)}（没有哪个共用片段用它）")
    return text


def count_key(placeholder):
    """回复里数工具引用的键：TOOL_DIR → tools，RULES_TOOL_DIR → rules_tools。"""
    key = placeholder.lower()
    return key[:-len("tool_dir")] + "tools" if key.endswith("tool_dir") else key + "_tools"


def render_prompt_dirs(dirs):
    """dirs：占位符 → 导入后的目录名（None = 没给）。按包描述的 prompt 渲染模板，写 .build/prompt.yaml 与 prompt-body.json。"""
    spec = DESC["prompt"]
    modules = DESC["modules"]
    optional = set(spec.get("sections", {}).values())
    unknown = sorted(k for k, v in dirs.items() if v is not None and k not in spec["placeholders"])
    if unknown:
        sys.exit(f"{DESC['name']} 的提示词没有这些占位符：{'、'.join('{{' + k + '}}' for k in unknown)}")
    given = {}
    for name, module in spec["placeholders"].items():
        value = dirs.get(name)
        if value is None:
            if name not in optional:
                sys.exit(f"prompt 需要 {nexus_package.option(name)}")
            continue
        m = modules[module]
        if not re.fullmatch(TOOL_DIR_RE, value):
            sys.exit(f"{nexus_package.option(name)} 应是{m.get('title', '')}导入返回的目录名（形如 {m['label']}_1a2b3c4d），收到：{value!r}")
        for earlier, earlier_value in given.items():
            if value == earlier_value:
                sys.exit(f"{nexus_package.option(name)} 与 {nexus_package.option(earlier)} 相同：{m.get('title') or '模块 ' + module}"
                         f"是单独导入的另一个目录（{m['state']} 的 dir_name）")
        given[name] = value
    with open(nexus_package.path(PKG, spec["template"]), encoding="utf-8") as f:
        text = f.read()
    text = COMMENT_RE.sub("", text)
    for section, placeholder in spec.get("sections", {}).items():
        text = section_re(section).sub(lambda m: m.group(1) if placeholder in given else "", text)
    text = expand_includes(text)
    for name, value in given.items():
        text = text.replace("{{" + name + "}}", value)
    if "{{" in text:
        sys.exit("提示词模板里还有没替换的占位符")
    os.makedirs(BUILD, exist_ok=True)
    with open(os.path.join(BUILD, "prompt.yaml"), "w", encoding="utf-8") as f:
        f.write(text)
    with open(os.path.join(BUILD, "prompt-body.json"), "w", encoding="utf-8") as f:
        json.dump({"content": text, "file_type": "prompt"}, f, ensure_ascii=False)
    summary = {"prompt": ".build/prompt.yaml", "body": ".build/prompt-body.json"}
    for name, value in given.items():
        summary.update({name.lower(): value, count_key(name): text.count(f"imported_tools/{value}/")})
    print(json.dumps(summary, ensure_ascii=False))


def render_prompt(tool_dir, rules_tool_dir=None):
    """本包原来的调用方式：--tool-dir 与（可选的）--rules-tool-dir。"""
    render_prompt_dirs({"TOOL_DIR": tool_dir, "RULES_TOOL_DIR": rules_tool_dir})


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


def main(argv=None):
    pre = argparse.ArgumentParser(add_help=False)
    pre.add_argument("--package")
    known, _ = pre.parse_known_args(argv)
    use_package(known.package or OWN_PKG)
    ap = argparse.ArgumentParser(description=f"生成 {DESC['name']} 要上传 / 保存的文件（只写本地 .build/）")
    ap.add_argument("what", choices=["tools", "rules-tools", "prompt", "connector"])
    ap.add_argument("--package", help="包目录（读它的 nexus-package.json），缺省是本包 knowbase-s3vectors-agent")
    ap.add_argument("--env", default=os.path.join(PKG, "deploy.env"))
    for name, module in DESC["prompt"]["placeholders"].items():
        ap.add_argument(nexus_package.option(name), dest=name, help=f"模块 {module} 导入后的目录名（{{{{{name}}}}}）")
    a = ap.parse_args(argv)
    if a.what != "prompt" and PKG != OWN_PKG:
        renders = "、".join(dict.fromkeys(m["render"] for m in DESC["modules"].values()))
        sys.exit(f"render.py {a.what} 只用于 knowbase-s3vectors-agent；{DESC['name']} 的工具文件用 {renders} 生成（在包目录里运行）")
    if a.what == "tools":
        render_tools(load_env(a.env))
    elif a.what == "rules-tools":
        render_rules_tools(load_env(a.env))
    elif a.what == "connector":
        render_connector(load_env(a.env))
    else:
        render_prompt_dirs({name: getattr(a, name) for name in DESC["prompt"]["placeholders"]})


if __name__ == "__main__":
    main()
