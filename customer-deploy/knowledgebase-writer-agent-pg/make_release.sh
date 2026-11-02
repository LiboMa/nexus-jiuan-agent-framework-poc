#!/usr/bin/env bash
#
# 组装「知识库文档管家（PG 版）」的交付 zip，并在一个干净的临时目录里自检。不连任何服务（Nexus / AWS / 数据库都不碰）。
#
# 用法：
#   bash make_release.sh --source <去敏后的源码目录> --tools-zip <pg_kb_tools.zip> --manifest <MANIFEST.json> \
#        [--version 1.0.0] [--out <目录>] [--deny-file <文件>] [--keep-temp]
#
#   --source     make-package.sh --export 产出的去敏源码（有 kb/、knowledgebase-writer-agent-pg/、knowbase-s3vectors-agent/、poc/）
#   --tools-zip  预打好的工具包（入口 pg_kb_tools.py + 5 个核心模块），原样放进 nexus/
#   --manifest   与它配套的 MANIFEST.json（逐文件 sha256 与来源提交）
#   --version    交付版本，缺省 1.0.1
#   --out        产物目录，缺省是本脚本旁边的 release/
#   --deny-file  另加的去敏词（每行一个，按字面、不分大小写；# 开头是注释）。这个文件放在交付仓库外
#   --keep-temp  保留临时目录（排查自检失败时用）
#
# 产物（--out 下）：
#   knowledgebase-writer-agent-pg-<版本>.zip   交付 zip（布局见 zip-root/START-HERE.md）
#   pg_kb_tools.zip                           工具包单独一份（与 zip 里 nexus/pg_kb_tools.zip 相同）
#   SHA256SUMS                                上面两个文件的 sha256
#
# 拒绝打包的情况（只打印文件名，不打印内容）：
#   - 工具包与 MANIFEST.json 逐文件 sha256 对不上，或文件集合不同；
#   - 暂存目录里出现去敏词（真实环境的域名、账号、实例、密钥 / 发布 / Agent / 工具目录编号、私网 IP……，
#     词表以加盐哈希内置在本脚本里，不写明文），或出现形似密钥的串；
#   - 暂存目录里有 .build/、.state/、deploy.env、__pycache__/、.DS_Store、*.pyc，或虚构样例之外的 .docx。
#
# 同样的输入打出同样的字节：文件按路径排序、时间戳固定为 1980-01-01、权限只分 644 / 755。
# 交付文档（GUIDE.zh.md、DELIVERY.zh.md、assets/*.svg）有就拷进 docs/，还没写好就跳过并提示（不算失败）。
#
# 只用 bash、python3（标准库）、node；macOS 与 Linux 都能跑。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="knowledgebase-writer-agent-pg"
SOURCE=""; TOOLS_ZIP=""; MANIFEST=""; VERSION="1.0.1"; OUT="${HERE}/release"; DENY_FILE=""; KEEP=false

usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }
need_arg() { [ -n "${2:-}" ] || die "$1 后面要跟一个值（bash make_release.sh --help）"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --source)    need_arg "$1" "${2:-}"; SOURCE="$2"; shift ;;
    --tools-zip) need_arg "$1" "${2:-}"; TOOLS_ZIP="$2"; shift ;;
    --manifest)  need_arg "$1" "${2:-}"; MANIFEST="$2"; shift ;;
    --version)   need_arg "$1" "${2:-}"; VERSION="$2"; shift ;;
    --out)       need_arg "$1" "${2:-}"; OUT="$2"; shift ;;
    --deny-file) need_arg "$1" "${2:-}"; DENY_FILE="$2"; shift ;;
    --keep-temp) KEEP=true ;;
    -h|--help)   usage; exit 0 ;;
    *)           die "不认识的参数 $1（bash make_release.sh --help）" ;;
  esac
  shift
done

[ -n "${SOURCE}" ] && [ -n "${TOOLS_ZIP}" ] && [ -n "${MANIFEST}" ] || { usage >&2; exit 2; }
[ -d "${SOURCE}" ] || die "--source 不是目录：${SOURCE}"
[ -f "${TOOLS_ZIP}" ] || die "--tools-zip 不存在：${TOOLS_ZIP}"
[ -f "${MANIFEST}" ] || die "--manifest 不存在：${MANIFEST}"
[ -z "${DENY_FILE}" ] || [ -f "${DENY_FILE}" ] || die "--deny-file 不存在：${DENY_FILE}"
printf '%s' "${VERSION}" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$' || die "--version 要像 1.0.0：${VERSION}"
command -v python3 >/dev/null 2>&1 || die "需要 python3"
command -v node >/dev/null 2>&1 || die "需要 node（自检用 node --check 查 a2a_rules.mjs）"

SOURCE="$(cd "${SOURCE}" && pwd)"
TOP="${NAME}-${VERSION}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pgkb-release.XXXXXX")"
cleanup() { if ${KEEP}; then printf '临时目录留着：%s\n' "${WORK}" >&2; else rm -rf "${WORK}"; fi; }
trap cleanup EXIT
export PYTHONDONTWRITEBYTECODE=1
HELPER="${WORK}/release_helper.py"

# ───────────────────────── 辅助程序（python3 标准库） ─────────────────────────
cat > "${HELPER}" <<'PY'
"""make_release.sh 的辅助命令。只读写给定的目录，不连任何服务。"""
import hashlib
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import zipfile
import zlib
from glob import glob
from pathlib import Path

ZIP_TIME = (1980, 1, 1, 0, 0, 0)

# 交付 zip 的 repo/ 里放什么（相对 --source）。每一项必须至少找到一个文件；只收这些，别的一概不收。
WHITELIST = [
    # PG 知识库（kb/）：部署脚本、核心模块、SQL、主机脚本、CloudFormation、共用提示词片段、审核 Agent 的受管规则
    "kb/.gitignore", "kb/README.md", "kb/GUIDE.md", "kb/deploy.sh", "kb/deploy.env.example",
    "kb/lib/*.py", "kb/lib/*.sh", "kb/sql/*.sql", "kb/host/*.sh", "kb/cfn/*.yaml", "kb/prompt/*.md", "kb/agent/*.txt",
    # kb/tests：make_e2e_docs.py 用的文档生成器；local_test.py 用的 PGlite 底座、假向量函数、虚构样例
    "kb/tests/sample_docs.py", "kb/tests/make_sample_docx.py",
    "kb/tests/pg_harness.py", "kb/tests/run_pglite.sh", "kb/tests/fake_kb_embed.sql", "kb/tests/fixtures/sample-matrix.docx",
    # 知识库文档管家（PG 版）
    "knowledgebase-writer-agent-pg/.gitignore", "knowledgebase-writer-agent-pg/README.md",
    "knowledgebase-writer-agent-pg/nexus-package.json", "knowledgebase-writer-agent-pg/deploy.env.example",
    "knowledgebase-writer-agent-pg/tools/pg_kb_tools.py",
    "knowledgebase-writer-agent-pg/prompt/knowledgebase_writer_agent_pg.yaml.tmpl",
    "knowledgebase-writer-agent-pg/probe/kb_probe_entry.py", "knowledgebase-writer-agent-pg/probe/kb_probe_helper.py",
    "knowledgebase-writer-agent-pg/scripts/admin_run.sh", "knowledgebase-writer-agent-pg/scripts/build_tools.py",
    "knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs", "knowledgebase-writer-agent-pg/scripts/make_e2e_docs.py",
    "knowledgebase-writer-agent-pg/tests/local_test.py", "knowledgebase-writer-agent-pg/tests/admin_test.py",
    "knowledgebase-writer-agent-pg/tests/contract.test.mjs", "knowledgebase-writer-agent-pg/tests/e2e_results.json",
    # 两个文档管家共用的管理员脚本与包描述；本机测试的替身（strands、nexus_utils.secret_key）；
    # S3 Vectors 版的提示词模板与 deploy.env 样例只给 admin_test.py 用（它钉住共用脚本对 S3 Vectors 版的输出不变、
    # 两个样例原样复制都会被占位符检查拦下）
    "knowbase-s3vectors-agent/nexus-package.json", "knowbase-s3vectors-agent/deploy.env.example",
    "knowbase-s3vectors-agent/scripts/admin_run.sh", "knowbase-s3vectors-agent/scripts/nexus_admin.py",
    "knowbase-s3vectors-agent/scripts/render.py", "knowbase-s3vectors-agent/scripts/nexus_package.py",
    "knowbase-s3vectors-agent/scripts/e2e_upload.py",   # 端到端：经 Operator 把文件传成会话附件（presign → PUT → confirm）
    "knowbase-s3vectors-agent/prompt/knowbase_s3vectors_agent.yaml.tmpl",
    "knowbase-s3vectors-agent/tests/stubs/strands/__init__.py",
    "knowbase-s3vectors-agent/tests/stubs/nexus_utils/__init__.py",
    "knowbase-s3vectors-agent/tests/stubs/nexus_utils/secret_key.py",
    # a2a_rules.mjs / contract.test.mjs 实际 import 到的测试台客户端
    "poc/app/nexus/a2a-client.mjs", "poc/app07/kb-steward-client.mjs", "poc/app07/kb-docx.mjs",
]
# 唯一允许进 zip 的 .docx：虚构样例（kb/tests/make_sample_docx.py 生成）
ALLOWED_DOCX = {"repo/kb/tests/fixtures/sample-matrix.docx"}

# 去敏词：(长度, crc32, 加盐 sha256 的前 24 位)，按小写字节比。明文不写进本文件（本文件在交付仓库里）。
DENY_SALT = b"pgkb-release-deid-v1:"
DENY = [
    (8, 0x6c00f9f7, "b4696544aae343199068bf6a"), (9, 0x64e49082, "7cd2649d0e930f4e9738a402"),
    (8, 0x134e011d, "98feb4dfa76afb11463f816f"), (8, 0x3954774d, "612dd92fe0ac204ec99928e7"),
    (10, 0xeae6d2f8, "55ae3109f32a27ab023fd141"), (8, 0x3c7c6a9a, "8208589ca79ec0cd14428daf"),
    (12, 0x5ff71cd0, "ea19f882c1e59b6fe804fd6d"), (9, 0x19aa6ecb, "45406975cb5a07554790fc23"),
    (6, 0xcbc6682e, "38337b7b7a9513ca39f55514"),
    # 规格之外、另外加上的参考环境编号（复制来源、连接器、绑定、调用密钥、探针、会话、工具 ID）
    (8, 0xeda75cbe, "5a498153e0ff85384f9848dd"), (12, 0x2637e2ef, "226e4d8ed51d007babdaed6e"),
    (12, 0x6f12789b, "04193fc1becf22165dbbb952"), (12, 0xe3cd88e6, "65ae7fcdb45234f843d404fe"),
    (8, 0x29dc5973, "f65ab829284ea107256e77d9"), (12, 0xa3f76dac, "503370a4309201f8cbc705b4"),
    (8, 0x30b612d1, "db617ef181242db24aa6aca3"), (8, 0x434ddd09, "81d487995a35b1920c0a7ba9"),
    (8, 0xce1ea657, "07b1306015fbd3322ed206f0"), (8, 0x78343727, "d211493543c73257d93efed6"),
    (8, 0x19145b8b, "c9bd5f5d4c3c42d44c31ec54"),
    # 交接审查（10-31）加上的：测试台的配置目录名、服务 / 主机路径名、构件名
    (13, 0x78055827, "4a30fee4d5a68ab2a97a56f6"), (7, 0x0a4b1848, "097998bb1cd056d445dd3fc0"),
    (7, 0xf7d284fe, "c82d12751c4911c9ab229276"),
]
SECRET_RE = re.compile(rb"nx[acp]_[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----")
# 形似真实编号的串：调用密钥 crd_、密钥绑定 tkb-、会话 sess-、发布 pub_、密钥 key-、Agent agent_、工具目录 kb_pg_steward_ /
# kb_pg_probe_、EC2 实例 i-、12 位账号。交付件里只许出现 ID_ALLOW 里这些一眼看得出是虚构的值；新的虚构值要先加进来
ID_RE = re.compile(rb"(?<![0-9A-Za-z])(?:crd_[0-9a-f]{12,}|tkb-[0-9a-f]{8,}|sess-[0-9a-f]{6,}|pub_[0-9a-f]{12,}|key-[0-9a-f]{8,}"
                   rb"|agent_[0-9a-f]{16,}|kb_pg_(?:steward|probe)_[0-9a-f]{8}|i-0[0-9a-f]{8,17})(?![0-9a-f])"
                   rb"|(?<![0-9A-Za-z.])[0-9]{12}(?![0-9A-Za-z.])")   # 12 位账号：前后不是字母数字（十六进制摘要里的一串数字不算）
ID_ALLOW = {b"kb_pg_steward_0a1b2c3d", b"kb_pg_steward_1a2b3c4d", b"kb_pg_steward_99999999", b"kb_pg_steward_00000000",
            b"kb_pg_probe_0a1b2c3d", b"pub_0123456789abcdef", b"key-0123456789ab", b"i-0123456789abcdef0"}
JUNK_PARTS = {".build", ".state", "__pycache__"}
JUNK_NAMES = {"deploy.env", ".DS_Store"}


def fail(msg, code=1):
    print(f"✗ {msg}", file=sys.stderr)
    sys.exit(code)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_zip(path):
    with zipfile.ZipFile(path) as z:
        return {i.filename: z.read(i) for i in z.infolist() if not i.is_dir()}


def files_under(root):
    root = Path(root)
    return sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())


# ─────────────── 工具包与 MANIFEST ───────────────
def cmd_check_tools(zip_path, manifest_path):
    """工具包里的文件集合与 sha256 必须与 MANIFEST.json 完全相同；路径都在压缩包根、没有缓存文件。"""
    try:
        manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
        expected = manifest["files"]
        commit = manifest["source_commit"]
    except (OSError, ValueError, KeyError, TypeError) as e:
        fail(f"读不了 MANIFEST.json（{type(e).__name__}）")
    try:
        files = read_zip(zip_path)
    except (OSError, zipfile.BadZipFile) as e:
        fail(f"读不了工具包（{type(e).__name__}）")
    bad = sorted(n for n in files if "/" in n or n.startswith(".") or n.endswith((".pyc", ".pyo")))
    if bad:
        fail(f"工具包里有不该有的路径：{bad}")
    actual = {n: sha256(b) for n, b in files.items()}
    differ = sorted(n for n in set(expected) | set(actual) if expected.get(n) != actual.get(n))
    if differ:
        fail(f"工具包与 MANIFEST.json 逐文件对不上：{differ}")
    print(json.dumps({"files": len(actual), "source_commit": commit}, ensure_ascii=False))


# ─────────────── 暂存 ───────────────
def copy(src, dst):
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)
    executable = os.stat(src).st_mode & 0o111 or dst.suffix == ".sh"
    os.chmod(dst, 0o755 if executable else 0o644)


def cmd_stage(source, pkg, stage, tools_zip, manifest, version, commit):
    source, pkg, stage = Path(source), Path(pkg), Path(stage)
    if stage.exists():
        fail(f"暂存目录已存在：{stage}")
    stage.mkdir(parents=True)
    picked = []
    for pattern in WHITELIST:
        hits = sorted(p for p in glob(str(source / pattern)) if os.path.isfile(p))
        if not hits:
            fail(f"--source 里找不到 {pattern}（是 make-package.sh --export 的产出吗？）")
        for hit in hits:
            rel = Path(hit).relative_to(source)
            if rel.name in JUNK_NAMES or JUNK_PARTS & set(rel.parts) or rel.suffix in (".pyc", ".pyo"):
                continue
            copy(Path(hit), stage / "repo" / rel)
            picked.append(rel.as_posix())
    # A1 的文档与指针
    own = {
        "skill/SKILL.md": "repo/skills/pg-kb-steward-deploy/SKILL.md",
        "AI-DEPLOY.zh.md": "docs/AI-DEPLOY.zh.md",
        "AGENTS.md": "AGENTS.md",
        "kiro/steering/pg-kb-steward-deploy.md": "kiro/steering/pg-kb-steward-deploy.md",
        "zip-root/START-HERE.md": "START-HERE.md",
        "zip-root/nexus/IMPORT.md": "nexus/IMPORT.md",
        "zip-root/nexus/import-api.sh": "nexus/import-api.sh",
    }
    for src, dst in own.items():
        if not (pkg / src).is_file():
            fail(f"交付件目录里缺 {src}")
        copy(pkg / src, stage / dst)
    # A2 的文档：有就拷，没有就记下来
    missing = []
    for doc in ("GUIDE.zh.md", "DELIVERY.zh.md"):
        if (pkg / doc).is_file():
            copy(pkg / doc, stage / "docs" / doc)
        else:
            missing.append(doc)
    svgs = sorted((pkg / "assets").glob("*.svg")) if (pkg / "assets").is_dir() else []
    for svg in svgs:
        copy(svg, stage / "docs" / "assets" / svg.name)
    if not svgs:
        missing.append("assets/*.svg")
    # 预打好的工具包
    copy(Path(tools_zip), stage / "nexus" / "pg_kb_tools.zip")
    copy(Path(manifest), stage / "nexus" / "MANIFEST.json")
    # START-HERE 里的版本与来源提交
    start = stage / "START-HERE.md"
    text = start.read_text(encoding="utf-8")
    text = text.replace("@VERSION@", version).replace("@SOURCE_COMMIT@", commit)
    text = text.replace("@TOOLS_SHA256@", sha256(Path(tools_zip).read_bytes()))
    if "@" + "VERSION@" in text or "@" + "SOURCE_COMMIT@" in text:
        fail("START-HERE.md 里还有没替换的占位符")
    start.write_text(text, encoding="utf-8")
    print(json.dumps({"repo_files": len(picked), "total": len(files_under(stage)), "missing_docs": missing},
                     ensure_ascii=False))


# ─────────────── 扫描：去敏、密钥、杂物 ───────────────
def deny_list(extra_file):
    table = {}
    for length, crc, digest in DENY:
        table.setdefault(length, {}).setdefault(crc, set()).add(digest)
    literals = []
    if extra_file:
        for line in Path(extra_file).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                literals.append(line.lower().encode("utf-8"))
    return table, literals


ZIP_LIKE = (".zip", ".docx", ".xlsx")


def zip_blobs(data, depth):
    """压缩包字节里每个成员的名字和内容；成员本身又是压缩包类的，再往里扫（至多 3 层）。"""
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            member = z.read(info)
            yield info.filename.encode("utf-8", "replace")
            yield member
            if depth < 3 and info.filename.lower().endswith(ZIP_LIKE) and zipfile.is_zipfile(io.BytesIO(member)):
                yield from zip_blobs(member, depth + 1)


def blobs(path):
    """一个文件要扫的内容：本身；压缩包类（.zip / .docx / .xlsx）另加每个成员（嵌套的也扫）。"""
    data = path.read_bytes()
    yield data
    if path.suffix.lower() in ZIP_LIKE and zipfile.is_zipfile(io.BytesIO(data)):
        yield from zip_blobs(data, 1)


def hits_deny(data, table, literals):
    low = data.lower()
    for length, by_crc in table.items():
        crc32 = zlib.crc32
        for i in range(len(low) - length + 1):
            window = low[i:i + length]
            digests = by_crc.get(crc32(window))
            if digests and sha256(DENY_SALT + window)[:24] in digests:
                return True
    return any(lit in low for lit in literals)


def cmd_scan(root, extra_file=""):
    root = Path(root)
    table, literals = deny_list(extra_file)
    deny, secret, ids, junk = [], [], [], []
    for rel in files_under(root):
        parts = set(Path(rel).parts)
        name = Path(rel).name
        inner = rel.split("/", 1)[1] if rel.startswith("knowledgebase-writer-agent-pg-") else rel
        if JUNK_PARTS & parts or name in JUNK_NAMES or name.endswith((".pyc", ".pyo")) or \
                (name.lower().endswith(".docx") and inner not in ALLOWED_DOCX):
            junk.append(rel)
        for data in blobs(root / rel):
            if hits_deny(data, table, literals):
                deny.append(rel)
                break
        for data in blobs(root / rel):
            if SECRET_RE.search(data):
                secret.append(rel)
                break
        kinds = sorted({m.group()[:4].decode("ascii", "replace") + "…" for data in blobs(root / rel)
                        for m in ID_RE.finditer(data) if m.group() not in ID_ALLOW})
        if kinds:
            ids.append(f"{rel}（{' '.join(kinds)}）")   # 只报前 4 个字符，不把编号本身打进日志
    for title, items in (("去敏词", deny), ("形似密钥的串", secret), ("形似真实编号的串", ids), ("不该进 zip 的文件", junk)):
        if items:
            print(f"✗ {title}出现在这些文件里：", file=sys.stderr)
            for rel in items:
                print(f"    {rel}", file=sys.stderr)
    if deny or secret or ids or junk:
        sys.exit(1)
    print(json.dumps({"files": len(files_under(root)), "deny": 0, "secret": 0, "ids": 0, "junk": 0}))


# ─────────────── SHA256SUMS、zip ───────────────
def cmd_sums(root):
    root = Path(root)
    lines = [f"{sha256((root / rel).read_bytes())}  {rel}" for rel in files_under(root) if rel != "SHA256SUMS"]
    (root / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.chmod(root / "SHA256SUMS", 0o644)
    print(json.dumps({"files": len(lines)}))


def zip_tree(root, top):
    """root 下的全部文件 → 压缩包字节：条目 = top/相对路径，按路径排序，时间戳固定，权限 644 / 755。"""
    root = Path(root)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for rel in files_under(root):
            info = zipfile.ZipInfo(f"{top}/{rel}", date_time=ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            mode = 0o755 if os.stat(root / rel).st_mode & 0o111 else 0o644
            info.external_attr = (stat.S_IFREG | mode) << 16
            z.writestr(info, (root / rel).read_bytes(), compresslevel=9)
    return buf.getvalue()


def cmd_zip(root, out, top):
    data = zip_tree(root, top)
    tmp = Path(out + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, out)
    print(json.dumps({"zip": out, "bytes": len(data), "sha256": sha256(data)}))


def cmd_release_sums(out_dir, *names):
    out_dir = Path(out_dir)
    lines = [f"{sha256((out_dir / n).read_bytes())}  {n}" for n in names]
    (out_dir / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


# ─────────────── 自检用 ───────────────
def cmd_unzip(zip_path, dest, top):
    dest = Path(dest)
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            parts = info.filename.split("/")
            if info.filename.startswith("/") or "\\" in info.filename or ".." in parts or parts[0] != top:
                fail(f"压缩包里有不合规的路径：{info.filename}")
            target = dest / info.filename
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(z.read(info))
            os.chmod(target, (info.external_attr >> 16) & 0o777 or 0o644)
    print(json.dumps({"files": len(files_under(dest / top))}))


def cmd_verify_sums(root):
    root = Path(root)
    listed = {}
    for line in (root / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        digest, rel = line.split("  ", 1)
        listed[rel] = digest
    present = set(files_under(root)) - {"SHA256SUMS"}
    differ = sorted(rel for rel in present | set(listed) if listed.get(rel) != (
        sha256((root / rel).read_bytes()) if rel in present else None))
    if differ:
        fail(f"SHA256SUMS 对不上：{differ}")
    print(json.dumps({"files": len(listed)}))


def cmd_check_import_doc(doc, scripts, pkg):
    """nexus/IMPORT.md 里第一个 ```json 块（确认请求的完整模板）必须与 nexus_admin.py 实际发的完全相同。"""
    text = Path(doc).read_text(encoding="utf-8")
    m = re.search(r"```json\n(.*?)\n```", text, re.S)
    if not m:
        fail("IMPORT.md 里没有 ```json 模板")
    template = json.loads(m.group(1))
    sys.path.insert(0, scripts)
    import nexus_admin  # noqa: E402
    nexus_admin.use_package(pkg)
    nexus_admin.use_module("pg")
    want = {"review_id": "<REVIEW_ID>", "tools": nexus_admin.tool_declarations(), "dir_label": nexus_admin.MODULES["pg"]["label"]}
    if template != want:
        fail("IMPORT.md 的确认请求模板与 nexus_admin.py 的 tool_declarations() 不同")
    tools = template["tools"]
    print(json.dumps({"tools": [t["name"] for t in tools], "key": f"{tools[0]['key_name']} / {tools[0]['key_type']}",
                      "fields": [f["field"] for f in tools[0]["key_fields_schema"]], "dir_label": template["dir_label"]},
                     ensure_ascii=False))


def cmd_check_render(printed, prompt_yaml, tool_dir):
    info = json.loads(printed.strip().splitlines()[-1])
    text = Path(prompt_yaml).read_text(encoding="utf-8")
    refs = sorted(set(re.findall(rf"imported_tools/{re.escape(tool_dir)}/pg_kb_tools/(\w+)", text)))
    if info.get("tools") != 3 or refs != ["rules_manager", "rules_search", "rules_writer"] or "{{" in text:
        fail(f"render.py prompt 的结果不对：{info}，引用 {refs}")
    body = json.loads((Path(prompt_yaml).parent / "prompt-body.json").read_text(encoding="utf-8"))
    if body.get("file_type") != "prompt" or body.get("content") != text:
        fail("prompt-body.json 与 prompt.yaml 不一致")
    print(json.dumps({"tools": info["tools"], "refs": refs, "chars": len(text)}))


def cmd_compare_rebuild(rebuild_dir, manifest_path):
    """重新打出的 6 个文件与 MANIFEST 逐个比。解开的目录不是 git 仓库，build_tools.py 记的提交号是 unknown：
    先把第 1 行「由 kb/lib@<提交号> 生成」和入口的 _BUILD 换成 MANIFEST 的 source_commit，再比 sha256。"""
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    commit, expected = manifest["source_commit"], manifest["files"]
    out = Path(rebuild_dir)
    got = {p.name for p in out.glob("*.py")}
    if got != set(expected):
        fail(f"重打出的文件集合不同：{sorted(got ^ set(expected))}")
    recorded, raw_same, same = set(), [], []
    for name in sorted(expected):
        data = (out / name).read_bytes()
        if sha256(data) == expected[name]:
            raw_same.append(name)
        text = data.decode("utf-8")
        m = re.match(r"# 由 kb/lib@(\S+) 生成", text)
        if m:
            recorded.add(m.group(1))
            text = text.replace(f"kb/lib@{m.group(1)} ", f"kb/lib@{commit} ", 1)
        b = re.search(r'^_BUILD = "([^"]*)"$', text, re.M)
        if b:
            recorded.add(b.group(1))
            text = text.replace(b.group(0), f'_BUILD = "{commit}"', 1)
        if sha256(text.encode("utf-8")) == expected[name]:
            same.append(name)
    differ = sorted(set(expected) - set(same))
    if differ:
        fail(f"重打出的文件与 MANIFEST 不同（换过提交号之后）：{differ}")
    print(json.dumps({"files": len(same), "byte_identical_as_built": raw_same, "recorded_commit": sorted(recorded),
                      "manifest_commit": commit}, ensure_ascii=False))


def cmd_check_parse(rules_json, expect_total):
    rules = json.loads(Path(rules_json).read_text(encoding="utf-8"))
    items = rules if isinstance(rules, list) else rules.get("rules", [])
    if len(items) != int(expect_total):
        fail(f"解析出 {len(items)} 条，应是 {expect_total} 条")
    print(json.dumps({"rules": len(items)}))


def cmd_check_e2e_docs(scripts, out):
    """make_e2e_docs.py 的生成器（docx / md / xlsx 只用标准库；pdf 要 reportlab，有才生成）。"""
    sys.path.insert(0, scripts)
    import make_e2e_docs as m  # noqa: E402
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    made = []
    for name, (build, tag) in m.DOCS.items():
        if name.endswith(".pdf"):
            try:
                import reportlab  # noqa: F401
            except ImportError:
                continue
        build(out / name)
        made.append(name)
    print(json.dumps({"made": made, "source_ids": [tag for _, tag in m.DOCS.values()]}))


def cmd_check_skill(path):
    text = Path(path).read_text(encoding="utf-8")
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    if not m or not re.search(r"^name: pg-kb-steward-deploy$", m.group(1), re.M) or \
            not re.search(r"^description: .+", m.group(1), re.M):
        fail(f"{path} 的 frontmatter 要有 name: pg-kb-steward-deploy 和 description")
    print(json.dumps({"name": "pg-kb-steward-deploy", "lines": text.count("\n")}))


DOC_PATH_RE = re.compile(r"(?<![\w/.<-])((?:repo|nexus|docs|kiro)/[A-Za-z0-9_./*-]+[A-Za-z0-9_/*-])")
GENERATED_RE = re.compile(r"(/\.build(/|$)|/\.state(/|$)|/deploy\.env$|\*)")
OWN_DOCS = ["START-HERE.md", "AGENTS.md", "kiro/steering/pg-kb-steward-deploy.md", "nexus/IMPORT.md",
            "docs/AI-DEPLOY.zh.md", "repo/skills/pg-kb-steward-deploy/SKILL.md"]
OTHER_DOCS = ["docs/GUIDE.zh.md", "docs/DELIVERY.zh.md"]


def cmd_check_doc_paths(root):
    """文档里写到的 repo/、nexus/、docs/、kiro/ 路径都要在包里（部署时才生成的 .build/、.state/、deploy.env 除外）。
    本脚本这一方的文档缺了就失败；交付说明与指南（另一位写的）缺了只提示。"""
    root = Path(root)
    report, failed = {}, False
    for rel in OWN_DOCS + OTHER_DOCS:
        doc = root / rel
        if not doc.is_file():
            continue
        refs = set(DOC_PATH_RE.findall(doc.read_text(encoding="utf-8")))
        missing = sorted(p for p in refs if not GENERATED_RE.search(p) and not (root / p.rstrip("/")).exists())
        report[rel] = {"refs": len(refs), "missing": missing}
        if missing:
            print(f"{'✗' if rel in OWN_DOCS else '!'} {rel} 写到的这些路径包里没有：{missing}", file=sys.stderr)
            failed = failed or rel in OWN_DOCS
    if failed:
        sys.exit(1)
    print(json.dumps({rel: v["refs"] for rel, v in report.items()}, ensure_ascii=False))


def cmd_same_bytes(a, b):
    if Path(a).read_bytes() != Path(b).read_bytes():
        fail(f"{a} 与 {b} 不同")


def cmd_rezip_equals(root, top, zip_path):
    if zip_tree(root, top) != Path(zip_path).read_bytes():
        fail("把解开的目录重新打包，字节与发布的 zip 不同（打包不可重复）")


COMMANDS = {name[4:].replace("_", "-"): fn for name, fn in globals().items() if name.startswith("cmd_")}

if __name__ == "__main__":
    COMMANDS[sys.argv[1]](*sys.argv[2:])
PY

h() { python3 -B -I "${HELPER}" "$@"; }
ok() { printf '  ✓ %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

# ───────────────────────── 1. 工具包 ─────────────────────────
step "工具包与 MANIFEST.json"
tools_info="$(h check-tools "${TOOLS_ZIP}" "${MANIFEST}")"
COMMIT="$(printf '%s' "${tools_info}" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["source_commit"])')"
ok "逐文件 sha256 一致：${tools_info}"

# ───────────────────────── 2. 暂存 ─────────────────────────
step "暂存（只收白名单里的文件）"
STAGE="${WORK}/stage/${TOP}"
stage_info="$(h stage "${SOURCE}" "${HERE}" "${STAGE}" "${TOOLS_ZIP}" "${MANIFEST}" "${VERSION}" "${COMMIT}")"
ok "${stage_info}"
MISSING_DOCS="$(printf '%s' "${stage_info}" | python3 -I -c 'import json,sys; print(" ".join(json.load(sys.stdin)["missing_docs"]))')"
[ -z "${MISSING_DOCS}" ] || printf '  ! 交付文档还没写好，这次没放进 docs/：%s（写好后重跑本脚本）\n' "${MISSING_DOCS}"

# ───────────────────────── 3. 扫描 ─────────────────────────
step "去敏、密钥、杂物扫描（只打印文件名）"
h scan "${WORK}/stage" "${DENY_FILE}" >/dev/null || die "暂存目录没通过扫描，没有打包"
ok "0 处去敏词、0 处形似密钥的串、0 处形似真实编号的串、0 个杂物"

# ───────────────────────── 4. 打包 ─────────────────────────
step "打包（可重复）"
h sums "${STAGE}" >/dev/null
mkdir -p "${OUT}"
OUT="$(cd "${OUT}" && pwd)"
ZIP_NAME="${TOP}.zip"
zip_info="$(h zip "${STAGE}" "${OUT}/${ZIP_NAME}" "${TOP}")"
cp "${TOOLS_ZIP}" "${OUT}/pg_kb_tools.zip.tmp" && mv "${OUT}/pg_kb_tools.zip.tmp" "${OUT}/pg_kb_tools.zip"
ok "${zip_info}"
h release-sums "${OUT}" "${ZIP_NAME}" pg_kb_tools.zip | sed 's/^/    /'
others="$(cd "${OUT}" && ls -1 | grep -vxE "${ZIP_NAME//./\\.}|pg_kb_tools\.zip|SHA256SUMS" || true)"
[ -z "${others}" ] || printf '  ! %s 里还有别的文件（没动它们，也不在 SHA256SUMS 里）：%s\n' "${OUT}" "$(printf '%s' "${others}" | tr '\n' ' ')"

# ───────────────────────── 5. 自检 ─────────────────────────
step "自检：在干净的临时目录里解开（不连任何服务）"
V="${WORK}/verify"; mkdir -p "${V}"
R="${V}/${TOP}"
ok "解开 $(h unzip "${OUT}/${ZIP_NAME}" "${V}" "${TOP}")"
ok "SHA256SUMS 逐个一致 $(h verify-sums "${R}")"
h same-bytes "${R}/nexus/pg_kb_tools.zip" "${OUT}/pg_kb_tools.zip"
ok "nexus/pg_kb_tools.zip 与 MANIFEST.json 逐文件一致，与 release/pg_kb_tools.zip 相同 $(h check-tools "${R}/nexus/pg_kb_tools.zip" "${R}/nexus/MANIFEST.json")"
h scan "${V}" "${DENY_FILE}" >/dev/null || die "解开的目录没通过扫描"
ok "解开的目录再扫一遍：0 处"
h rezip-equals "${R}" "${TOP}" "${OUT}/${ZIP_NAME}"
ok "把解开的目录重新打包：与发布的 zip 逐字节相同"

PKGDIR="${R}/repo/${NAME}"
SCRIPTS="${R}/repo/knowbase-s3vectors-agent/scripts"
(cd "${R}" && bash repo/kb/deploy.sh --help >/dev/null) || die "repo/kb/deploy.sh --help 失败"
ok "bash repo/kb/deploy.sh --help"

# admin_run.sh：PG 版 → 共用的 admin_run.sh → nexus_admin.py。临时 deploy.env 与假的 uv（只把参数交给 python3，不联网）
FAKEBIN="${V}/fakebin"; mkdir -p "${FAKEBIN}"
cat > "${FAKEBIN}/uv" <<'SH'
#!/usr/bin/env bash
# 自检用的 uv 替身：跳过「run --quiet --no-project --python 3.12 --with boto3」，把 python 之后的参数交给 python3
while [ $# -gt 0 ] && [ "$1" != python ]; do shift; done
shift
exec python3 -B "$@"
SH
chmod 755 "${FAKEBIN}/uv"
: > "${V}/fake-password"; chmod 600 "${V}/fake-password"
printf 'RULES_TABLE=approval_rules\nNEXUS_URL=https://nexus.example.invalid\nNEXUS_ADMIN_USER=admin\nNEXUS_PASSWORD_FILE=%s\n' "${V}/fake-password" > "${PKGDIR}/deploy.env"
admin_help="$(cd "${R}" && PATH="${FAKEBIN}:${PATH}" bash repo/${NAME}/scripts/admin_run.sh --help)" || die "admin_run.sh --help 失败"
rm -f "${PKGDIR}/deploy.env"
printf '%s' "${admin_help}" | grep -q 'import,check,publish,verify,bind,key-create,issue-call-key' || die "admin_run.sh --help 的输出不对"
ok "bash repo/${NAME}/scripts/admin_run.sh --help（经共用脚本到 nexus_admin.py，读本包的 nexus-package.json）"

bash -n "${R}/nexus/import-api.sh" || die "nexus/import-api.sh 语法不对（bash -n）"
import_help="$(cd "${R}" && bash nexus/import-api.sh --help)" || die "nexus/import-api.sh --help 失败"
printf '%s' "${import_help}" | grep -q -- '--force-new' && printf '%s' "${import_help}" | grep -q -- '--password-file' \
  || die "nexus/import-api.sh --help 的输出不对"
grep -q 'nexus/import-api.sh' "${R}/nexus/IMPORT.md" || die "nexus/IMPORT.md 没写到 nexus/import-api.sh"
ok "bash -n nexus/import-api.sh；--help 列出 --password-file、--force-new；IMPORT.md 第 ② 节指向它"

ok "IMPORT.md 的确认请求模板 = nexus_admin.py 实际发的声明 $(cd "${R}" && h check-import-doc nexus/IMPORT.md "${SCRIPTS}" "${PKGDIR}")"

render_out="$(cd "${R}" && python3 -B -I repo/knowbase-s3vectors-agent/scripts/render.py prompt --package repo/${NAME} --tool-dir kb_pg_steward_00000000)" \
  || die "render.py prompt 失败"
ok "render.py prompt --tool-dir kb_pg_steward_00000000 $(h check-render "${render_out}" "${PKGDIR}/.build/prompt.yaml" kb_pg_steward_00000000)"

(cd "${R}" && python3 -B -I repo/${NAME}/scripts/build_tools.py --env repo/${NAME}/deploy.env.example --out "${V}/rebuild/tools" >/dev/null) \
  || die "build_tools.py 重打失败"
ok "build_tools.py 重打 6 个文件，与 MANIFEST 相同 $(h compare-rebuild "${V}/rebuild/tools" "${R}/nexus/MANIFEST.json")"

node --check "${PKGDIR}/scripts/a2a_rules.mjs" || die "node --check a2a_rules.mjs 失败"
node --check "${PKGDIR}/tests/contract.test.mjs" || die "node --check contract.test.mjs 失败"
python3 -I -c 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())' "${SCRIPTS}/e2e_upload.py" || die "e2e_upload.py 解析不过"
set +e
usage_err="$(cd "${R}" && NEXUS_A2A_URL= node repo/${NAME}/scripts/a2a_rules.mjs 2>&1 >/dev/null)"; rc=$?
set -e
[ "${rc}" -eq 2 ] && printf '%s' "${usage_err}" | grep -q '用法' || die "a2a_rules.mjs 不带参数应退出码 2（用法），实际 ${rc}：poc/ 里的依赖可能不全"
ok "node --check a2a_rules.mjs、contract.test.mjs；a2a_rules.mjs 不带参数退出码 2（它 import 的 poc/ 文件都在）；e2e_upload.py 语法正确"

# admin_test.py 在解开的包里整套跑一遍（不连网、不碰真钥匙）：测试读到的文件包里缺了，这里就停下。要 uv（与 README 第 2 节同一组依赖）
if command -v uv >/dev/null 2>&1; then
  set +e
  admin_test_out="$(cd "${R}" && uv run --quiet --no-project --python 3.12 --with psycopg --with psycopg-binary --with pdfplumber \
    --with reportlab --with openpyxl --with pyyaml python -B repo/${NAME}/tests/admin_test.py 2>&1)"; rc=$?
  set -e
  [ "${rc}" -eq 0 ] || { printf '%s\n' "${admin_test_out}" | tail -40 >&2; die "admin_test.py 在解开的包里没过（见上）"; }
  ok "admin_test.py 在解开的包里跑：$(printf '%s' "${admin_test_out}" | sed -n 's/^Ran \([0-9]*\) tests.*/\1/p') 个全过"
else
  printf '  ! 没有 uv：跳过 admin_test.py（装上 uv 后重跑本脚本）\n'
fi

(cd "${R}" && python3 -B -I repo/kb/lib/parse_rules.py repo/kb/tests/fixtures/sample-matrix.docx "${V}/sample-rules.json" >/dev/null) \
  || die "parse_rules.py 解析虚构样例失败"
ok "parse_rules.py 解析虚构样例 $(h check-parse "${V}/sample-rules.json" 18)"

(cd "${R}" && python3 -B -I repo/${NAME}/scripts/make_e2e_docs.py --help >/dev/null) || die "make_e2e_docs.py --help 失败"
ok "make_e2e_docs.py --help；生成器 $(h check-e2e-docs "${PKGDIR}/scripts" "${V}/e2e")"
(cd "${R}" && python3 -B -I repo/kb/lib/parse_rules.py "${V}/e2e/e2e-matrix.docx" "${V}/e2e-rules.json" >/dev/null) \
  || die "parse_rules.py 解析虚构矩阵失败"
ok "虚构矩阵 e2e-matrix.docx 解析 $(h check-parse "${V}/e2e-rules.json" 7)（端到端「将新增 7 条」）"

ok "部署手册 $(h check-skill "${R}/repo/skills/pg-kb-steward-deploy/SKILL.md")"
doc_refs="$(h check-doc-paths "${R}")" || die "文档里写到的路径包里没有（见上）"
ok "文档里写到的 repo/、nexus/、docs/、kiro/ 路径都在包里（各文档的引用数）${doc_refs}"
docs_line=""
for d in docs/GUIDE.zh.md docs/AI-DEPLOY.zh.md docs/DELIVERY.zh.md; do
  if [ -f "${R}/${d}" ]; then docs_line="${docs_line} ${d} ✓"; else docs_line="${docs_line} ${d} ✗"; fi
done
n_svg="$(find "${R}/docs" -name '*.svg' 2>/dev/null | wc -l | tr -d ' ')"
printf '  %s 文档：%s；配图 %s 张\n' "$([ -z "${MISSING_DOCS}" ] && echo '✓' || echo '!')" "${docs_line# }" "${n_svg}"

step "完成"
printf '  %s\n' "${OUT}/${ZIP_NAME}" "${OUT}/pg_kb_tools.zip" "${OUT}/SHA256SUMS"
[ -z "${MISSING_DOCS}" ] || printf '  ! 还缺：%s。写好后重跑：bash %s/make_release.sh --source … --tools-zip … --manifest …\n' "${MISSING_DOCS}" "${HERE}"
