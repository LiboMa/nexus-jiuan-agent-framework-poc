"""本地测试用的 strands 替身：@tool 原样返回函数，让工具文件能在没有 Strands 运行时的机器上直接调用。"""


def tool(f=None, **kw):
    return f if f else (lambda g: g)
