#!/usr/bin/env python3
"""导出交接仓库、生成交付包时的脱敏：把暂存目录里 AWS 账户与 EC2 的标识换成 AWS 文档的示例值。

用法：sanitize.py <暂存目录> <对照表>
- 对照表（docs/delivery/sanitize.conf，只在开发目录）一行「真实值 => 示例值」，先按它逐字替换；
- 再按格式替换没列进对照表的：实例、VPC、子网、安全组、快照、卷、AMI、网卡、EIP 分配、构件桶名、ARN 里的账号；
- 只处理 UTF-8 文本文件，图片等二进制文件不动；
- 替换后还留着对照表里的任何一个真实值，就以退出码 1 结束，并列出文件名（不打印值）。
没有对照表时（比如在交接仓库里运行）只按格式替换。
"""
import pathlib
import re
import sys

EXAMPLE_HEX = '0123456789abcdef'


def load_pairs(conf):
    pairs = []
    if not conf.is_file():
        return pairs
    for line in conf.read_text(encoding='utf-8').splitlines():
        real, sep, example = line.strip().partition(' => ')
        if sep and real and not real.startswith('#'):
            pairs.append((real.strip(), example.strip()))
    return pairs


def keep_examples(example):
    return lambda match: match.group(0) if EXAMPLE_HEX in match.group(0) else example


PATTERNS = [(re.compile(r'\b' + kind + r'-[0-9a-f]{8,17}\b'), keep_examples(kind + '-' + EXAMPLE_HEX + '0'))
            for kind in ('i', 'vpc', 'subnet', 'sg', 'snap', 'vol', 'ami', 'eni', 'eipalloc')]
PATTERNS += [(re.compile(r'artifactbucket-[a-z0-9]+'), lambda match: 'artifactbucket-example'),
             (re.compile(r'(arn:aws:[a-z0-9-]+:[a-z0-9-]*:)\d{12}'), lambda match: match.group(1) + '123456789012')]


def sanitize(stage, pairs):
    changed, left = 0, []
    for path in sorted(stage.rglob('*')):
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding='utf-8')
        except (UnicodeDecodeError, OSError):
            continue
        new = text
        for real, example in pairs:
            new = new.replace(real, example)
        for pattern, replace in PATTERNS:
            new = pattern.sub(replace, new)
        if new != text:
            path.write_text(new, encoding='utf-8')
            changed += 1
        if any(real in new for real, _ in pairs):
            left.append(str(path.relative_to(stage)))
    return changed, left


def main(argv):
    if len(argv) != 3:
        print('用法：sanitize.py <暂存目录> <对照表>', file=sys.stderr)
        return 2
    stage, conf = pathlib.Path(argv[1]), pathlib.Path(argv[2])
    pairs = load_pairs(conf)
    if not pairs:
        print('没有对照表，只按格式脱敏')
    changed, left = sanitize(stage, pairs)
    print(f'脱敏了 {changed} 个文件')
    if left:
        print('还有没换掉的真实值，不出包：' + '、'.join(left), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
