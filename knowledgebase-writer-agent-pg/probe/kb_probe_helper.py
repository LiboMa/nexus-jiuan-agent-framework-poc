"""探针的同目录模块：kb_probe_entry.py 用相对 import 引它（from . import kb_probe_helper），验证同一个工具目录里的文件能互相引用。
只用标准库；没有 @tool 函数，也没有与工具同名的函数。"""


def probe_helper_reply() -> str:
    """回一行能看出「装在哪个包里」的文字：VM 里是 nexus_toolpkg_<目录名>_<版本>.kb_probe_helper。"""
    return f"kb_probe_helper 已加载（{__name__}）"
