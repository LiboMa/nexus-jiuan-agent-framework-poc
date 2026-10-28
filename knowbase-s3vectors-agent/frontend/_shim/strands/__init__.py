"""Nexus 之外运行工具文件用的 strands 替身：@tool 原样返回函数。"""


def tool(f=None, **kw):
    return f if f else (lambda g: g)
