#!/usr/bin/env bash
#
# 在 deployer 上（经 SSM）从 Nexus 的 deploy.yaml 里取 auth_password，经 seal 加密后输出一行密文。
# 只在 admin 密码从未在界面上改过时有效（之后请改用 NEXUS_ADMIN_PASSWORD_FILE）。
#
# 输入：YAML_PATH SEAL_PUB_B64
set -euo pipefail
: "${YAML_PATH:?}" "${SEAL_PUB_B64:?}"
pw="$(sed -nE "s/^auth_password:[[:space:]]*['\"]?([^'\"]*)['\"]?[[:space:]]*\$/\1/p" "$YAML_PATH" | head -1)"
[ -n "$pw" ] || { echo "$YAML_PATH 里没有 auth_password" >&2; exit 1; }
printf '%s' "$pw" | seal
