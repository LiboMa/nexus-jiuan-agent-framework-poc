#!/usr/bin/env bash
#
# 在 PG 主机上（经 SSM）读出应用用户密码，经 seal（本次运行的一次性公钥，见 lib/common.sh ssm_read_secret）
# 加密后输出一行密文。SSM 命令历史里只留密文；本地解密后写进 600 临时文件。
#
# 输入：PG_BASE_DIR SEAL_PUB_B64
set -euo pipefail
: "${PG_BASE_DIR:?}" "${SEAL_PUB_B64:?}"
pw="$(sed -n 's/^NEXUS_DB_PASSWORD=//p' "$PG_BASE_DIR/.env")"
[ -n "$pw" ] || { echo "$PG_BASE_DIR/.env 里没有 NEXUS_DB_PASSWORD" >&2; exit 1; }
printf '%s' "$pw" | seal
