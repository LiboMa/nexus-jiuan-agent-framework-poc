"""拼装 PG 知识库工具目录：入口 tools/pg_kb_tools.py + kb/lib 的核心模块，逐个文件放进同一个目录，再打成导入用的 .zip。

    python3 -I knowledgebase-writer-agent-pg/scripts/build_tools.py [tools] [--env deploy.env] [--out .build/tools]
    python3 -I knowledgebase-writer-agent-pg/scripts/build_tools.py probe [--out .build/probe]

- 核心模块（CORE）从 kb/lib 原样拷过去，只在第 1 行加一行「由 kb/lib@<短提交号>[-dirty] 生成，勿改」；Nexus 把一个版本的
  文件装成一个包，模块之间用相对 import（kb/lib 的固定写法），所以不改源码。
- 入口只改渲染段（# >>> deploy-config … # <<< deploy-config）：_TABLE = deploy.env 的 RULES_TABLE（缺省 approval_rules），
  _BUILD = 同一个提交号。
- 输出（--out 缺省是包里的 .build/tools；另两样放在它的上一级目录）：
    <out>/                  6 个 .py（目录里原有的 .py 先删掉，免得留下改名前的旧文件）
    <out>/../MANIFEST.json  {"source_commit", "files": {文件名: sha256}}
    <out>/../pg_kb_tools.zip  文件在压缩包根、按名字排序、时间戳固定：同样的源码打出同样的字节
- probe：探针（线上实测同目录相对 import 与运行环境的包）。probe/ 下的两个文件原样拷进 <out>（缺省 .build/probe），
  打成 <out>/../kb_probe.zip（同样可重复）；不读 --env，不写 MANIFEST.json。
- 每个文件 compile() 一遍；最后打印一行 JSON。只用标准库。出错时打印原因到 stderr，退出码 2。
"""
import argparse
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import zipfile
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent          # knowledgebase-writer-agent-pg/
REPO = PKG.parent
LIB = REPO / "kb" / "lib"
ENTRY = PKG / "tools" / "pg_kb_tools.py"
CORE = ("doc_blocks.py", "parse_rules.py", "clauses.py", "kb_parse.py", "kb_store.py")
ZIP_NAME = "pg_kb_tools.zip"
PROBE_DIR = PKG / "probe"
PROBE_FILES = ("kb_probe_entry.py", "kb_probe_helper.py")
PROBE_ZIP = "kb_probe.zip"
HEADER = "# 由 kb/lib@{commit} 生成，勿改（knowledgebase-writer-agent-pg/scripts/build_tools.py）\n"
BEGIN, END = "# >>> deploy-config", "# <<< deploy-config"
ZIP_TIME = (1980, 1, 1, 0, 0, 0)
TABLE_RE = re.compile(r"[a-z_][a-z0-9_]*")


class BuildError(Exception):
    pass


def read_env(path):
    """KEY=VALUE（# 开头是注释，值两边的引号去掉）。"""
    out = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out[key.strip()] = value
    return out


def source_commit():
    """kb/lib@<短提交号>，拷的源文件（核心模块与入口）有未提交的改动就加 -dirty；不在 git 里是 unknown。"""
    def git(*args):
        return subprocess.run(["git", "-C", str(REPO), *args], capture_output=True, text=True, check=True).stdout.strip()
    try:
        commit = git("rev-parse", "--short", "HEAD")
        paths = [str((LIB / name).relative_to(REPO)) for name in CORE] + [str(ENTRY.relative_to(REPO))]
        dirty = bool(git("status", "--porcelain", "--", *paths))
    except (OSError, subprocess.CalledProcessError):
        return "unknown"
    return commit + ("-dirty" if dirty else "")


def render(src, table, build):
    """渲染段换成 _TABLE / _BUILD 两行；段外原样。"""
    lines = src.splitlines(keepends=True)
    begins = [i for i, line in enumerate(lines) if line.startswith(BEGIN)]
    ends = [i for i, line in enumerate(lines) if line.startswith(END)]
    if len(begins) != 1 or len(ends) != 1 or begins[0] > ends[0]:
        raise BuildError(f"{ENTRY.name} 里要有且只有一对 {BEGIN} / {END}")
    body = [f"_TABLE = {json.dumps(table)}\n", f"_BUILD = {json.dumps(build)}\n"]
    return "".join(lines[:begins[0] + 1] + body + lines[ends[0]:])


def zip_bytes(files):
    """files：{文件名: 字节} → 压缩包的字节（按名字排序、固定时间戳与权限，同样的输入同样的输出）。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, date_time=ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            z.writestr(info, files[name], compresslevel=9)
    return buf.getvalue()


def write(path, data):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def build(env_path, out):
    env = read_env(env_path) if env_path else {}
    table = env.get("RULES_TABLE") or "approval_rules"
    if len(table) > 55 or not TABLE_RE.fullmatch(table):
        raise BuildError(f"RULES_TABLE 不合规：{table!r}（小写字母、数字、下划线，以字母或下划线开头，至多 55 位）")
    commit = source_commit()
    files = {}
    for name in CORE:
        files[name] = (HEADER.format(commit=commit) + (LIB / name).read_text(encoding="utf-8")).encode("utf-8")
    files[ENTRY.name] = render(ENTRY.read_text(encoding="utf-8"), table, commit).encode("utf-8")
    compile_all(files)
    write_dir(out, files)
    manifest = {"source_commit": commit, "files": {name: hashlib.sha256(files[name]).hexdigest() for name in sorted(files)}}
    write(out.parent / "MANIFEST.json", (json.dumps(manifest, ensure_ascii=False, indent=1) + "\n").encode("utf-8"))
    archive = zip_bytes(files)
    write(out.parent / ZIP_NAME, archive)
    return {"out": str(out), "zip": str(out.parent / ZIP_NAME), "zip_sha256": hashlib.sha256(archive).hexdigest(),
            "manifest": str(out.parent / "MANIFEST.json"), "source_commit": commit, "table": table, "files": sorted(files)}


def build_probe(out):
    """探针：probe/ 下的两个文件原样拷进 out，打成 out/../kb_probe.zip。"""
    files = {}
    for name in PROBE_FILES:
        path = PROBE_DIR / name
        if not path.is_file():
            raise BuildError(f"找不到 {path.relative_to(REPO)}")
        files[name] = path.read_bytes()
    compile_all(files)
    write_dir(out, files)
    archive = zip_bytes(files)
    write(out.parent / PROBE_ZIP, archive)
    return {"out": str(out), "zip": str(out.parent / PROBE_ZIP), "zip_sha256": hashlib.sha256(archive).hexdigest(),
            "files": sorted(files)}


def compile_all(files):
    for name, data in files.items():
        try:
            compile(data.decode("utf-8"), name, "exec")
        except SyntaxError as e:
            raise BuildError(f"{name} 编译不过：{e}") from None


def write_dir(out, files):
    """files 写进 out；out 里原有、这次没有的 .py 先删掉。"""
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*.py"):
        if old.name not in files:
            old.unlink()
    for name, data in files.items():
        write(out / name, data)


def main(argv=None):
    ap = argparse.ArgumentParser(description="拼装 PG 知识库工具目录（入口 + kb/lib 核心模块）并打包；probe：打包探针")
    ap.add_argument("what", nargs="?", choices=["tools", "probe"], default="tools", help="tools（缺省）= PG 工具；probe = 探针")
    ap.add_argument("--env", help="部署参数文件（读 RULES_TABLE）；不给时用包里的 deploy.env，没有就用缺省值。probe 不读")
    ap.add_argument("--out", help="工具目录（缺省 .build/tools；probe：.build/probe）")
    a = ap.parse_args(argv)
    try:
        if a.what == "probe":
            result = build_probe(Path(a.out or PKG / ".build" / "probe").resolve())
        else:
            env = a.env
            if env is None and (PKG / "deploy.env").is_file():
                env = str(PKG / "deploy.env")
            if env is not None and not Path(env).is_file():
                raise BuildError(f"找不到部署参数文件 {env}")
            result = build(env, Path(a.out or PKG / ".build" / "tools").resolve())
    except BuildError as e:
        print(f"build_tools：{e}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
