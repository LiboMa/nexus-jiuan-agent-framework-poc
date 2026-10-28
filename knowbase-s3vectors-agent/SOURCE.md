# 来源

知识库文档管家（S3 Vectors 版）的包，从下面的目录复制进来：

- 来源目录：`nexus-customer-deploy/knowbase-s3vectors-agent/`（与 `application-deploy/audit-nexus/` 同级的 `nexus-customer-deploy/` 下）
- 复制日期：2026-10-28
- 复制方式：

  ```
  rsync -a --exclude deploy.env --exclude .state --exclude .build --exclude 'build/out' --exclude __pycache__ --exclude .DS_Store \
    --include 'tests/fixtures/*.docx' --exclude '*.docx' <来源目录>/ knowbase-s3vectors-agent/
  ```

## 没有复制的

| 排除 | 是什么 |
|---|---|
| `deploy.env` | 部署人的设置（环境信息）；只提交 `deploy.env.example` |
| `.state/` | 运行状态，含 A2A 调用密钥 |
| `.build/` | 渲染后的工具、提示词、连接器请求体、预览页、端到端过程文件 |
| `build/out/` | 包的 `.gitignore` 列出的生成物目录（来源目录里当时没有） |
| `__pycache__/`、`.DS_Store` | 缓存 |
| `*.docx`（`tests/fixtures/*.docx` 除外） | 制度原文不进仓库；来源目录里当时没有 `.docx`，也没有 `tests/fixtures/` |

## 复制后的检查与改动

- 看过 `tests/e2e_results.json`（`tests/` 下唯一的 JSON）和 `assets/` 的 14 张图：只有环境标识（文档 ID、向量桶名、区域），没有密钥、调用密钥或制度原文，没有删任何一项。
- `tests/local_test.py` 第 25 行假凭证的 Access Key ID 改成 `FAKE-ACCESS-KEY-ID-LOCAL-TEST`：原值是假的，但以 `AKIA` 开头、符合 AWS 访问密钥的格式，交付包的密钥检查（`docs/delivery/make-package.sh`）会把它当成真密钥拦下（这里也不照抄原值，免得本文件被拦）。测试只比对这个值是否相等，改了不影响 62 项检查。

## 之后的改动

来源目录不动。之后的改动只在仓库里这一份。
