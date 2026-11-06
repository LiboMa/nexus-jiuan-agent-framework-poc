# 测试台的启动密钥：缺了才补，已有的永远不改（deploy.sh 和 pg-prepare.sh 共用；source 本文件后调 ensure_bench_secrets <secrets 文件>）。
#   BENCH_MYSQL_ROOT_PASSWORD、JIUAN_MYSQL_APP_PASSWORD：MySQL（切到 PostgreSQL 之后留着给回退用）
#   BENCH_PG_SUPERUSER_PASSWORD、JIUAN_PG_APP_PASSWORD：九安的 PostgreSQL（容器 jiuan-pg）
#   JIUAN_DATA_KEY：九安存储的数据密钥；换了，九安库里加密的启用记录就打不开了
# 口令是 32 位十六进制，数据密钥是 32 字节 base64。只打印补了哪一项，不打印值。
# 2026-11-02 之前的文件里 JIUAN_MYSQL_APP_PASSWORD、JIUAN_DATA_KEY 叫 JIUAN07_…：先原地改名（值不变），免得当成缺了另生成。
ensure_bench_secrets() {
  local file="$1" name legacy value
  for name in JIUAN_MYSQL_APP_PASSWORD JIUAN_DATA_KEY; do
    legacy="JIUAN07_${name#JIUAN_}"
    if grep -q "^${legacy}=" "$file" && ! grep -q "^${name}=" "$file"; then
      ( umask 077; sed "s/^${legacy}=/${name}=/" "$file" > "$file.new" ) && mv "$file.new" "$file"
      echo "已把 ${file} 里的 ${legacy} 改名为 ${name}（值不变）"
    fi
  done
  for name in BENCH_MYSQL_ROOT_PASSWORD JIUAN_MYSQL_APP_PASSWORD JIUAN_DATA_KEY BENCH_PG_SUPERUSER_PASSWORD JIUAN_PG_APP_PASSWORD; do
    grep -q "^${name}=" "$file" && continue
    if [[ "$name" == *_DATA_KEY ]]; then value="$(openssl rand -base64 32)"; else value="$(openssl rand -hex 16)"; fi
    printf '%s\n' "# 测试台：只补不换（${name}）" "${name}=${value}" >> "$file"
    echo "已在 ${file} 里补上 ${name}"
  done
  chmod 600 "$file"
}
