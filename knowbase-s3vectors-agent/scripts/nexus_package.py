"""包描述 nexus-package.json：一个交付包有哪些工具模块、各自怎么导入 Nexus、提示词模板在哪。render.py 与 nexus_admin.py 共用，
两个包（knowbase-s3vectors-agent、knowledgebase-writer-agent-pg）各有一份。只用标准库，不连任何服务。

格式（路径都相对包目录，用 /）：
  {"name": "<包名，也是包目录名>", "title": "<中文名，可选>",
   "modules": {                                   # 第一个是缺省模块（nexus_admin.py 不给 --module 时）
     "<模块名>": {
       "module": "<工具文件的模块名>",            # 导入后的模块路径 imported_tools/<目录名>/<module>
       "title": "<提示里的叫法，可选>",           # 例如「规则模块」
       "build": ".build/<module>.py | .build/<名>.zip",
                                                  # .py：单文件导入；.zip：多文件导入（压缩包里的文件原样放进同一个工具目录）
       "manifest": "MANIFEST.json",               # 可选，只给 .zip：构建时写在压缩包旁边的 {"files": {文件名: sha256}}
       "label": "<导入时的目录标签>",             # Nexus 的目录名 = 标签 + _ + 8 位十六进制
       "state": ".state/<名>.json",               # 导入结果（目录名、模块路径、工具 ID）
       "render": "<生成 build 的命令>",           # 在包目录里运行；只出现在提示里
       "key": {"name": "<key_name>", "type": "<key_type>", "fields": [{"field", "required", "description"}, …],
               "description": "<key-create 建密钥时的说明，可选；{iam_user} 换成 IAM 用户名>"},
                                                  # 可选：没有 = 这个模块的工具都不要密钥
       "guards": [{"pattern": "<正则>", "message": "<为什么不能导入>", "unless": "<命令行参数，可选>"}],
                                                  # 可选：build 里匹配（re.M）就拒绝导入 / 发布；命令行带了 unless 的参数就不查这一条
       "tools": [["<函数名>", <要不要密钥>, "<说明>"], …]}},
   "prompt": {"template": "prompt/<名>.yaml.tmpl",
              "placeholders": {"<占位符>": "<模块名>"},   # {{TOOL_DIR}} 换成那个模块导入后的目录名（render.py --tool-dir）
              "sections": {"<段名>": "<占位符>"}}}        # 可选：{{#段名}}…{{/段名}} 只在给了那个占位符时保留
"""
import json
import os
import re

FILE = "nexus-package.json"
NAME_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")
MODULE_KEY_RE = re.compile(r"[a-z][a-z0-9_]{0,31}")
IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
LABEL_RE = re.compile(r"[a-z0-9_]{1,32}")
PLACEHOLDER_RE = re.compile(r"[A-Z][A-Z0-9_]*")
MODULE_FIELDS = {"module", "title", "build", "manifest", "label", "state", "render", "key", "guards", "tools"}


def path(pkg, rel):
    """包里的相对路径（/ 分隔）→ 绝对路径。"""
    return os.path.join(pkg, *rel.split("/"))


def option(placeholder):
    """占位符 → render.py 的参数名：TOOL_DIR → --tool-dir，RULES_TOOL_DIR → --rules-tool-dir。"""
    return "--" + placeholder.lower().replace("_", "-")


def load(pkg):
    """读 <pkg>/nexus-package.json 并检查格式；不合规就退出（SystemExit，说明是哪一项）。"""
    where = os.path.join(pkg, FILE)
    if not os.path.isfile(where):
        raise SystemExit(f"{pkg} 里没有 {FILE}（--package / NEXUS_PKG_ROOT 要指向一个交付包的目录）")
    try:
        with open(where, encoding="utf-8") as f:
            desc = json.load(f)
    except ValueError as e:
        raise SystemExit(f"{where} 不是合法的 JSON：{e}") from None

    def bad(why):
        raise SystemExit(f"{where} 不合规：{why}")

    def text(value, name, pattern=None):
        if not isinstance(value, str) or not value or (pattern is not None and not pattern.fullmatch(value)):
            bad(f"{name} 不合规：{value!r}")
        return value

    def rel_path(value, name, suffixes):
        text(value, name)
        parts = value.split("/")
        if value.startswith("/") or "\\" in value or any(p in ("", ".", "..") for p in parts):
            bad(f"{name} 要是包里的相对路径（不能含 ../ 或空段）：{value!r}")
        if not value.endswith(suffixes):
            bad(f"{name} 要是 {' 或 '.join(suffixes)}：{value!r}")
        return value

    if not isinstance(desc, dict):
        bad("顶层要是一个对象")
    text(desc.get("name"), "name", NAME_RE)
    if "title" in desc:
        text(desc["title"], "title")
    modules = desc.get("modules")
    if not isinstance(modules, dict) or not modules:
        bad("modules 至少要有一个模块")
    states = {}
    for key, m in modules.items():
        at = f"modules.{key}"
        text(key, f"{at} 的模块名", MODULE_KEY_RE)
        if not isinstance(m, dict):
            bad(f"{at} 要是一个对象")
        unknown = sorted(set(m) - MODULE_FIELDS)
        if unknown:
            bad(f"{at} 有不认识的字段：{unknown}")
        text(m.get("module"), f"{at}.module", IDENT_RE)
        if "title" in m:
            text(m["title"], f"{at}.title")
        rel_path(m.get("build"), f"{at}.build", (".py", ".zip"))
        if "manifest" in m:
            if not m["build"].endswith(".zip"):
                bad(f"{at}.manifest 只用于 .zip 的 build")
            text(m["manifest"], f"{at}.manifest", re.compile(r"[A-Za-z0-9_.-]+\.json"))
        text(m.get("label"), f"{at}.label", LABEL_RE)
        rel_path(m.get("state"), f"{at}.state", (".json",))
        if m["state"] in states:
            bad(f"{at}.state 与 modules.{states[m['state']]} 相同：两个模块的导入结果会互相覆盖")
        states[m["state"]] = key
        text(m.get("render"), f"{at}.render")
        key_decl = m.get("key")
        if key_decl is not None:
            if not isinstance(key_decl, dict):
                bad(f"{at}.key 要是一个对象")
            text(key_decl.get("name"), f"{at}.key.name", IDENT_RE)
            text(key_decl.get("type"), f"{at}.key.type", IDENT_RE)
            fields = key_decl.get("fields")
            if not isinstance(fields, list) or not fields or not all(
                    isinstance(f, dict) and set(f) == {"field", "required", "description"} and isinstance(f["field"], str)
                    and isinstance(f["required"], bool) and isinstance(f["description"], str) for f in fields):
                bad(f"{at}.key.fields 要是 [{{field, required, description}}, …]")
            if "description" in key_decl:
                text(key_decl["description"], f"{at}.key.description")
        guards = m.get("guards", [])
        if not isinstance(guards, list):
            bad(f"{at}.guards 要是一个列表")
        for i, g in enumerate(guards):
            if not isinstance(g, dict) or not {"pattern", "message"} <= set(g) <= {"pattern", "message", "unless"}:
                bad(f"{at}.guards[{i}] 要是 {{pattern, message, unless?}}")
            try:
                re.compile(text(g["pattern"], f"{at}.guards[{i}].pattern"), re.M)
            except re.error as e:
                bad(f"{at}.guards[{i}].pattern 不是合法的正则：{e}")
            text(g["message"], f"{at}.guards[{i}].message")
            if "unless" in g:
                text(g["unless"], f"{at}.guards[{i}].unless", re.compile(r"--[a-z][a-z0-9-]*"))
        tools = m.get("tools")
        if not isinstance(tools, list) or not tools:
            bad(f"{at}.tools 至少要有一个工具")
        seen = set()
        for t in tools:
            if not (isinstance(t, list) and len(t) == 3 and isinstance(t[0], str) and IDENT_RE.fullmatch(t[0])
                    and isinstance(t[1], bool) and isinstance(t[2], str) and t[2]):
                bad(f"{at}.tools 的每一项要是 [函数名, 要不要密钥, 说明]：{t!r}")
            if t[0] in seen:
                bad(f"{at}.tools 里 {t[0]} 重复")
            seen.add(t[0])
            if t[1] and key_decl is None:
                bad(f"{at}.tools 里 {t[0]} 要密钥，但模块没有 key")

    prompt = desc.get("prompt")
    if not isinstance(prompt, dict):
        bad("prompt 要是一个对象")
    rel_path(prompt.get("template"), "prompt.template", (".tmpl",))
    placeholders = prompt.get("placeholders")
    if not isinstance(placeholders, dict) or not placeholders:
        bad("prompt.placeholders 至少要有一个占位符")
    for name, module in placeholders.items():
        text(name, "prompt.placeholders 的占位符名", PLACEHOLDER_RE)
        if module not in modules:
            bad(f"prompt.placeholders.{name} 指向不存在的模块 {module!r}")
    sections = prompt.get("sections", {})
    if not isinstance(sections, dict):
        bad("prompt.sections 要是一个对象")
    for name, placeholder in sections.items():
        text(name, "prompt.sections 的段名", PLACEHOLDER_RE)
        if placeholder not in placeholders:
            bad(f"prompt.sections.{name} 指向不存在的占位符 {placeholder!r}")
    if set(sections.values()) >= set(placeholders):
        bad("prompt.placeholders 里至少要有一个占位符是必给的（不作 sections 的条件）")
    unknown = sorted(set(prompt) - {"template", "placeholders", "sections"})
    if unknown:
        bad(f"prompt 有不认识的字段：{unknown}")
    return desc
