#!/usr/bin/env bash
#
# 在 PG 主机上（经 SSM，以 root）删除本工具创建的 pgvector 容器；可选删除数据卷与密码目录（不可恢复）。
# 只删「本工具创建的」：容器与数据卷须带 label managed-by=pgvector-rules-kb，密码目录须有标记文件
# .managed-by-pgvector-rules-kb（均由 pgvector-up.sh 在创建时打上）。不满足的一律不删，只报告。
#
# 输入：PG_CONTAINER_NAME PG_DATA_VOLUME PG_BASE_DIR PG_PURGE_VOLUME PG_PURGE_BASEDIR
set -euo pipefail
: "${PG_CONTAINER_NAME:?}" "${PG_DATA_VOLUME:?}" "${PG_BASE_DIR:?}" "${PG_PURGE_VOLUME:=false}" "${PG_PURGE_BASEDIR:=false}"
LABEL=pgvector-rules-kb

if docker inspect "$PG_CONTAINER_NAME" >/dev/null 2>&1; then
  if [ "$(docker inspect -f '{{index .Config.Labels "managed-by"}}' "$PG_CONTAINER_NAME")" = "$LABEL" ]; then
    docker rm -f "$PG_CONTAINER_NAME" >/dev/null
    echo "RESULT container=removed"
  else
    echo "RESULT container=not-managed"
  fi
else
  echo "RESULT container=absent"
fi

if [ "$PG_PURGE_VOLUME" = "true" ]; then
  if ! docker volume inspect "$PG_DATA_VOLUME" >/dev/null 2>&1; then
    echo "RESULT volume=absent"
  elif [ "$(docker volume inspect -f '{{index .Labels "managed-by"}}' "$PG_DATA_VOLUME")" != "$LABEL" ]; then
    echo "RESULT volume=not-managed"
  elif docker ps -a --filter "volume=$PG_DATA_VOLUME" --format '{{.Names}}' | grep -q .; then
    echo "RESULT volume=in-use"
  else
    docker volume rm "$PG_DATA_VOLUME" >/dev/null
    echo "RESULT volume=removed"
  fi
else
  echo "RESULT volume=kept"
fi

if [ "$PG_PURGE_BASEDIR" = "true" ]; then
  if [ ! -d "$PG_BASE_DIR" ]; then
    echo "RESULT base_dir=absent"
  elif [ ! -f "$PG_BASE_DIR/.managed-by-pgvector-rules-kb" ]; then
    echo "RESULT base_dir=not-managed"
  else
    rm -rf -- "$PG_BASE_DIR"
    echo "RESULT base_dir=removed"
  fi
else
  echo "RESULT base_dir=kept"
fi
