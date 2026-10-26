-- 审批规则表（lib/ingest_rules.py 在每次入库前执行，全部语句幂等）。
-- {table} 由入库脚本替换为 RULES_TABLE（已校验为小写标识符）。
--
-- 一行一条规则：
--   rule_type = matrix        审批矩阵的一行 = 一条审批路径（业务事项 × 板块 × 金额档 / 触发情形），rule_id 形如 C05-3.2
--   rule_type = general       制度说明与图例（rule_id 形如 G-01）
--   rule_type = chapter_note  章节标题下的说明段落（rule_id 形如 C03-NOTE）
-- content 是拼好的可检索全文（Agent 用 ILIKE 查）；embedding 是 content 的向量（语义检索用）。

CREATE TABLE IF NOT EXISTS {table} (
  rule_id            text PRIMARY KEY,
  rule_type          text NOT NULL,
  chapter_no         int,
  chapter            text,
  seq_no             text,
  business_item      text,
  segment            text,
  amount_tier        text,
  approval_path      jsonb,
  approval_path_text text,
  final_approver     text,
  post_actions       text,
  not_applicable     text,
  extra              jsonb,
  scope_controls     text,
  chapter_note       text,
  content            text NOT NULL,
  embedding          vector({dim}),
  source_doc         text,
  source_version     text,
  ingested_at        timestamptz DEFAULT now()
);

-- 后加的列（老版本表上补齐）
ALTER TABLE {table} ADD COLUMN IF NOT EXISTS source_tag text;
ALTER TABLE {table} ADD COLUMN IF NOT EXISTS record_sha256 text;

COMMENT ON TABLE {table} IS '审批规则库：rule_type=matrix 每行一条审批路径（业务事项×板块×金额档），general=制度说明/图例，chapter_note=章节说明；content 为可检索全文，embedding 为 content 的向量';

CREATE INDEX IF NOT EXISTS {table}_embedding_hnsw ON {table} USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS {table}_chapter_idx ON {table} (chapter_no, seq_no);
CREATE INDEX IF NOT EXISTS {table}_source_tag_idx ON {table} (source_tag);
