"""「我的规则」：把一份 .docx 的正文转成纯文本，写到标准输出（UTF-8）。

    python3 -I docx_text.py <文件>

只用标准库（zipfile + ElementTree），只读 word/document.xml，不执行宏、不跟外部引用。
正文段落和表格按文档里的顺序，每段一行（空段落去掉）；表格每行一句，单元格用「 | 」连起来（全空的行去掉）。
不是 zip、没有 word/document.xml、正文不是合格的 XML（或带 DOCTYPE / 实体声明）时退出码 2，stderr 写原因。
"""
import sys
import xml.etree.ElementTree as ET
import zipfile

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
FALLBACK = '{http://schemas.openxmlformats.org/markup-compatibility/2006}Fallback'
# 段落、表格、行、单元格外面可能套着内容控件（w:sdt → w:sdtContent）或 w:customXml，往里找
WRAPPERS = (W + 'sdt', W + 'sdtContent', W + 'customXml')
MAX_XML = 64 * 1024 * 1024


def fail(message):
    sys.stderr.write(message + '\n')
    sys.exit(2)


def children(element, tag):
    for child in element:
        if child.tag == tag:
            yield child
        elif child.tag in WRAPPERS:
            yield from children(child, tag)


def inline(element, out):
    """段落里的文字：w:t 照抄，w:tab 是制表符，w:br / w:cr 换行；兼容块只取一份（跳过 mc:Fallback）。"""
    for child in element:
        tag = child.tag
        if tag == W + 't':
            out.append(child.text or '')
        elif tag == W + 'tab':
            out.append('\t')
        elif tag in (W + 'br', W + 'cr'):
            out.append('\n')
        elif tag == FALLBACK:
            continue
        elif tag == W + 'p':
            # 文本框里的段落
            inline(child, out)
            out.append('\n')
        else:
            inline(child, out)


def paragraph(element):
    out = []
    inline(element, out)
    return ''.join(out).strip()


def blocks(container, lines):
    """容器（正文、单元格）里的段落和表格，按顺序一行一行追加到 lines。"""
    for child in container:
        if child.tag == W + 'p':
            text = paragraph(child)
            if text:
                lines.append(text)
        elif child.tag == W + 'tbl':
            for row in children(child, W + 'tr'):
                cells = []
                for cell in children(row, W + 'tc'):
                    inner = []
                    blocks(cell, inner)
                    cells.append(' '.join(' '.join(line.split('\n')) for line in inner).strip())
                if any(cells):
                    lines.append(' | '.join(cells))
        elif child.tag in WRAPPERS:
            blocks(child, lines)


def main(argv):
    if len(argv) != 2:
        sys.stderr.write('用法：python3 -I docx_text.py <文件>\n')
        return 64
    try:
        with zipfile.ZipFile(argv[1]) as archive:
            try:
                info = archive.getinfo('word/document.xml')
            except KeyError:
                fail('不是 Word 文件：没有 word/document.xml')
            if info.file_size > MAX_XML:
                fail('word/document.xml 太大')
            data = archive.read(info)
    except Exception as error:  # 不是 zip、加密、压缩方式不支持、校验和不对……都算读不出
        fail('不是有效的 zip：' + type(error).__name__)
    # Word 写的正文是 UTF-8、没有 DTD；带 NUL（UTF-16 等）或 DOCTYPE / 实体声明的不解析
    if b'\x00' in data or b'<!DOCTYPE' in data or b'<!ENTITY' in data:
        fail('word/document.xml 不是 Word 写的正文')
    try:
        root = ET.fromstring(data)
    except ET.ParseError as error:
        fail('word/document.xml 不是合格的 XML：' + str(error))
    body = root.find(W + 'body')
    if root.tag != W + 'document' or body is None:
        fail('word/document.xml 里没有正文')
    lines = []
    blocks(body, lines)
    sys.stdout.buffer.write('\n'.join(lines).encode('utf-8'))
    sys.stdout.buffer.flush()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
