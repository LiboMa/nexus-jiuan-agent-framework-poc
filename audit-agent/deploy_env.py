"""读一个环境的配置文件（poc/infra/env/<环境名>.env）。规则和 poc/infra/lib/deploy-env.sh 一样：
逐行 KEY=VALUE；# 开头的行和空行跳过；值可以用一对 " 或 ' 包起来，原样取（不展开 $）；空值等于没写；
不认识的键、重复的键、格式不对的行、没写 STACK / AWS_REGION 都报 ValueError（带文件名和行号）。
KB_MODE 只能是 pg 或 s3vectors，不写就是 pg（读出来没有这个键）；KB_MODE=s3vectors 时 S3V_KEYS 这五项都要写，缺了一次列出缺哪几项。
KB_PG_PUBLICATION_ID（pg 方式「制度知识库」页经的 PG 知识库 Agent 的发布）写了就要是 pub_ 加 16 位小写十六进制（报错带行号），不写也行。"""
import re

KEYS = ("STACK", "AWS_REGION", "VPC_ID", "SUBNET_ID", "INSTANCE_TYPE", "DOMAIN_NAME", "ORIGIN_DOMAIN_NAME", "JIUAN07_DOMAIN_NAME",
        "HOSTED_ZONE_ID", "CERTIFICATE_ARN", "CLOUDFRONT_PREFIX_LIST_ID", "NEXUS_ORIGIN", "NEXUS_PROFILE", "ADVISORY_PUBLICATION_ID",
        "KB_MODE", "KB_ALLOWED_CIDR", "KB_SETTINGS", "CONNECTOR_ID", "KB_PG_PUBLICATION_ID",
        "KB_S3V_BUCKET", "KB_S3V_RULES_INDEX", "RULES_TOOL_DIR", "KB_S3V_KEY_ID", "KB_S3V_PUBLICATION_ID",
        "AGENT_NAME", "AGENT_DISPLAY_NAME", "AGENT_MODEL", "AGENT_ID", "PUBLICATION_ID")
KB_MODES = ("pg", "s3vectors")
# KB_MODE=s3vectors 时必须写的几项（向量桶、规则索引、规则工具目录、文档管家的写入密钥编号和发布）
S3V_KEYS = ("KB_S3V_BUCKET", "KB_S3V_RULES_INDEX", "RULES_TOOL_DIR", "KB_S3V_KEY_ID", "KB_S3V_PUBLICATION_ID")
LINE = re.compile(r"^([A-Z][A-Z0-9_]*)=(.*)$")
PUBLICATION = re.compile(r"pub_[0-9a-f]{16}")


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
        if key == "KB_MODE" and value and value not in KB_MODES:
            raise ValueError(f"{path}:{number}：KB_MODE 只能是 pg 或 s3vectors：{value}")
        if key == "KB_PG_PUBLICATION_ID" and value and not PUBLICATION.fullmatch(value):
            raise ValueError(f"{path}:{number}：KB_PG_PUBLICATION_ID 应是 PG 知识库 Agent 的发布编号（pub_ 加 16 位十六进制）：{value}")
        if value:
            values[key] = value
    for key in ("STACK", "AWS_REGION"):
        if key not in values:
            raise ValueError(f"{path}：没写 {key}（用配置文件时栈名和区域都要写明，免得动到别的栈）")
    missing = [key for key in S3V_KEYS if key not in values] if values.get("KB_MODE") == "s3vectors" else []
    if missing:
        raise ValueError(f"{path}：KB_MODE=s3vectors 时还要写：{'、'.join(missing)}（S3 Vectors 方式的几项见 poc/infra/env/example.env）")
    return values
