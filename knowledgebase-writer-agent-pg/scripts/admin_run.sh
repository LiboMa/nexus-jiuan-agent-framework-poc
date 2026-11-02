#!/usr/bin/env bash
# 知识库文档管家（PG 版）的管理员操作：与 S3 Vectors 版共用 knowbase-s3vectors-agent/scripts/admin_run.sh 和 nexus_admin.py，
# 读本包的 deploy.env（Nexus 地址、管理员密码来源）与 nexus-package.json（模块 pg、probe）。管理员密码不经命令行、不打印。
# 用法：bash knowledgebase-writer-agent-pg/scripts/admin_run.sh <import|check|publish|verify|bind|issue-call-key> [参数…]
#   import --module pg                                    导入 .build/pg_kb_tools.zip（先跑 scripts/build_tools.py），结果在 .state/import.json
#   import --module probe                                 导入探针 .build/kb_probe.zip（scripts/build_tools.py probe）
#   verify --dir <DIR>                                    要密钥的工具与绑定情况，服务端每个文件与本地构建逐个比
#   bind --key-id <key-…>                                 管理员就是 Agent 与发布的属主时，把 pg_kb 绑到这把密钥
#   check / publish --tool-id <ID> --expect-version <N>   发布新构建（整个目录换成本地的文件集合）
#   issue-call-key --publish-id <PUB>                     调用密钥写进 .state/a2a-call-key（600）
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NEXUS_PKG_ROOT="$(cd "$HERE/.." && pwd)"
SHARED="$NEXUS_PKG_ROOT/../knowbase-s3vectors-agent/scripts/admin_run.sh"
[ -f "$SHARED" ] || { echo "需要同仓库的 knowbase-s3vectors-agent（管理员脚本与它共用）" >&2; exit 2; }
export NEXUS_PKG_ROOT
exec bash "$SHARED" "$@"
