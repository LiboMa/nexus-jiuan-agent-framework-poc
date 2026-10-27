"""读一个环境的配置文件（poc/infra/env/<环境名>.env）。规则和 poc/infra/lib/deploy-env.sh 一样：
逐行 KEY=VALUE；# 开头的行和空行跳过；值可以用一对 " 或 ' 包起来，原样取（不展开 $）；空值等于没写；
不认识的键、重复的键、格式不对的行、没写 STACK / AWS_REGION 都报 ValueError（带文件名和行号）。"""
import re

KEYS = ("STACK", "AWS_REGION", "VPC_ID", "SUBNET_ID", "INSTANCE_TYPE", "DOMAIN_NAME", "ORIGIN_DOMAIN_NAME", "JIUAN07_DOMAIN_NAME",
        "HOSTED_ZONE_ID", "CERTIFICATE_ARN", "CLOUDFRONT_PREFIX_LIST_ID", "NEXUS_ORIGIN", "NEXUS_PROFILE", "ADVISORY_PUBLICATION_ID",
        "KB_ALLOWED_CIDR", "KB_SETTINGS", "CONNECTOR_ID", "AGENT_NAME", "AGENT_DISPLAY_NAME", "AGENT_MODEL", "AGENT_ID", "PUBLICATION_ID")
LINE = re.compile(r"^([A-Z][A-Z0-9_]*)=(.*)$")


def read_deploy_env(path):
    try:
        with open(path, encoding="utf-8") as handle:
            lines = handle.read().splitlines()
    except OSError:
        raise ValueError(f"DEPLOY_ENV={path}：找不到这个文件（从 poc/infra/env/example.env 复制一份再改）") from None
    values, seen = {}, set()
    for number, line in enumerate(lines, start=1):
        line = line.rstrip("\r")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = LINE.match(line)
        if not match:
            raise ValueError(f"{path}:{number}：格式不对，要写成 KEY=VALUE（不写 export）：{line}")
        key, value = match.groups()
        if key not in KEYS:
            raise ValueError(f"{path}:{number}：不认识的键 {key}（能写的键见 poc/infra/env/example.env）")
        if key in seen:
            raise ValueError(f"{path}:{number}：键 {key} 写了两次")
        seen.add(key)
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if value:
            values[key] = value
    for key in ("STACK", "AWS_REGION"):
        if key not in values:
            raise ValueError(f"{path}：没写 {key}（用配置文件时栈名和区域都要写明，免得动到别的栈）")
    return values
