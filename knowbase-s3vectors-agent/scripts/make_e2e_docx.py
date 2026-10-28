"""生成端到端测试用的合成 .docx（不含任何业务数据，测试结束后硬删除）。用法：make_e2e_docx.py <out.docx>

内容分三节、约 1,500 字，按默认 512 字分块会得到 3~4 个文本块；第二节里有唯一暗号「白鹭-5831」，
检索这个暗号应当命中第二节所在的文本块。表格行在解析时排在正文之后（与 PostgreSQL 版的解析器一致）。
"""
import sys
from docx import Document

doc = Document()
doc.add_heading("知识库写入链路自检（S3 Vectors 版 · E2E 测试文档）", level=1)
doc.add_heading("一、文档目的", level=2)
doc.add_paragraph("这是一份为验证「知识库文档管家（S3 Vectors 版）」写入链路而生成的合成测试文档，不包含任何业务数据，"
                  "测试结束后会被硬删除。它覆盖解析、分块、向量化、写入、检索、软删除与恢复、一致性校验与统计。")
doc.add_paragraph("测试使用 Amazon Bedrock 的 Cohere Embed v4 生成 1536 维向量：向量化走运行环境的 IAM 角色，"
                  "写入 Amazon S3 Vectors 用平台注入的专用密钥，这把密钥只对本知识库的向量桶有读写权限。" * 2)
doc.add_heading("二、检索暗号", level=2)
doc.add_paragraph("本文档的唯一暗号是：白鹭-5831。检索这个暗号，应当能命中本节所在的文本块，而不是其他文档。")
doc.add_paragraph("暗号只用于验证语义检索与元数据过滤：软删除之后再检索它应当查不到，恢复之后应当重新查到。" * 3)
doc.add_heading("三、清理方式", level=2)
doc.add_paragraph("端到端测试结束时，用 s3vectors_manager 的 delete 操作（delete_mode=hard）物理删除本文档的全部文本块与登记记录，"
                  "再用一致性校验确认知识库里没有遗留的孤立文本块。" * 2)
t = doc.add_table(rows=1, cols=2)
t.rows[0].cells[0].text, t.rows[0].cells[1].text = "项目", "说明"
for a, b in [("向量模型", "Cohere Embed v4，1536 维，余弦距离"), ("向量库", "Amazon S3 Vectors（chunks / docs / audit 三个索引）"),
             ("清理方式", "测试结束后硬删除本文档")]:
    r = t.add_row().cells
    r[0].text, r[1].text = a, b
doc.save(sys.argv[1])
