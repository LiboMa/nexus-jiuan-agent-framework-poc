"""
探针工具 kb_import_probe（线上实测用）：在 Nexus 的运行环境（VM）里验证两件事。不要参数、不要密钥、不连任何服务、不读写文件。

1. 同一个工具目录里的文件能不能相对 import：PG 版的工具 pg_kb_tools 就靠 from . import … 引 kb/lib 的核心模块。
   入口用 from . import kb_probe_helper 引同目录的 helper；失败时不抛（否则模块装不上，什么也报不回来），把错误写进回复。
2. 运行环境里有没有 PG 版工具要的包：psycopg（3，连库）、pdfplumber（读 PDF），以及 boto3（只作对照：工具本身不用它）。

回复一行 JSON：
  {"relative_import": "ok" | "<错误类型>: <说明>", "helper": <helper 回的文字；相对 import 失败时 null>,
   "package": <本模块的 __package__，VM 里是 nexus_toolpkg_<目录名>_<版本>>, "python": <版本>,
   "psycopg": <版本> | "absent", "pdfplumber": <版本> | "absent", "boto3": <版本> | "absent"}
打包：python3 -I knowledgebase-writer-agent-pg/scripts/build_tools.py probe → .build/kb_probe.zip（两个文件在压缩包根）；
导入：bash knowledgebase-writer-agent-pg/scripts/admin_run.sh import --module probe（目录标签 kb_pg_probe）。
"""

import importlib
import json
import platform

from strands import tool

try:
    from . import kb_probe_helper
    _RELATIVE_IMPORT = "ok"
except Exception as e:  # noqa: BLE001 — 探针要把失败原样报回来
    kb_probe_helper = None
    _RELATIVE_IMPORT = f"{type(e).__name__}: {e}"

_PACKAGES = ("psycopg", "pdfplumber", "boto3")


def _version(name: str) -> str:
    """包的版本：装不上是 absent；装得上但导入出错报错误类型；没有 __version__ 时查安装记录，再没有是 unknown。"""
    try:
        module = importlib.import_module(name)
    except ImportError:
        return "absent"
    except Exception as e:  # noqa: BLE001 — 装了但导入出错，也要报回来
        return f"error: {type(e).__name__}"
    version = getattr(module, "__version__", None)
    if version is None:
        try:
            from importlib import metadata
            version = metadata.version(name)
        except Exception:  # noqa: BLE001
            version = "unknown"
    return str(version)


@tool
def kb_import_probe() -> str:
    """
    探针：同一工具目录里的相对 import 能不能用，以及运行环境的 Python 与 psycopg / pdfplumber / boto3 版本。
    不要参数、不要密钥、不连任何服务。

    Returns:
        JSON 字符串：relative_import（"ok" 或错误）/ helper（同目录模块回的文字）/ package（本模块的 __package__）/ python /
        psycopg / pdfplumber / boto3（版本或 "absent"）
    """
    helper = kb_probe_helper.probe_helper_reply() if kb_probe_helper is not None else None
    reply = {"relative_import": _RELATIVE_IMPORT, "helper": helper, "package": __package__, "python": platform.python_version()}
    reply.update({name: _version(name) for name in _PACKAGES})
    return json.dumps(reply, ensure_ascii=False)
