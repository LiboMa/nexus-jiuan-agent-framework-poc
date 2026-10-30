"""生成端到端测试用的虚构制度文档（Task 11），写到 .build/e2e/。内容全部虚构；与真实制度无关。

    uv run --no-project --python 3.12 --with reportlab python -B -I knowledgebase-writer-agent-pg/scripts/make_e2e_docs.py [--out <目录>]

五份文档、各自的用途：
  e2e-matrix.docx     审批矩阵，章号从「十一、」起（编号 C11-…、C12-…，不会撞上真实制度）：新增 → 检索 → 下线 → 恢复 → 删除
  e2e-conflict.docx   审批矩阵，「三、」下有 1.2（编号 C03-1.2、C03-NOTE，已属于真实制度）：应整份拒绝（rule_conflict），一条不写
  e2e-prose.md        正文条款（第 X 章 / 第 X 条），故意用审批、合同、付款、板块、金额这类财务用语
  e2e-prose.pdf       正文条款，同样的用语（PDF 文字层）
  e2e-prose.xlsx      不是矩阵的表（一行一条），同样的用语
正文三份用来验证「入库的正文不挤掉矩阵规则」：入库前后各跑一次检索回归，命中率不降。
文档生成器复用 kb/tests 的 sample_docs / make_sample_docx（不另写一份 docx / xlsx / pdf 的拼法）。
"""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PKG = HERE.parent
sys.path.insert(0, str(PKG.parent / "kb" / "tests"))

import sample_docs  # noqa: E402

MATRIX_HEADER = ["序号", "业务事项", "板块", "金额档 / 触发情形", "经办人", "部门主管", "财务经理", "总经理", "适用范围与控制要点"]
# 只有一行标题（按封面不入库）。不写「制度说明」：parse_rules 的制度说明编号 G-01… 不带制度标识，会撞上已入库制度的同号条目
PREFACE = [("p", "虚构集团差旅与会议费审批办法（端到端测试样例，内容虚构）")]


def matrix_docx(path):
    body = list(PREFACE)
    body += [("p", "十一、虚构差旅费审批"), ("p", "差旅费以出差审批单为前提，住宿按城市标准报销。"),
             ("table", MATRIX_HEADER,
              [["1.1", "国内差旅报销", "虚构甲板块", "单笔≤5 千", "①", "②√", "", "", "出差审批单与住宿发票"],
               ["1.2", None, "虚构甲板块", "单笔＞5 千", "①", "②", "③√", "", "出差审批单、住宿发票与行程单"],
               ["1.3", "境外差旅报销", "虚构乙板块", "不限金额", "①", "②", "③", "④√", "境外出差批文与汇率说明"]])]
    body += [("p", "十二、虚构会议费审批"), ("p", "会议费以会议通知和签到表为依据，超预算须事前审批。"),
             ("table", MATRIX_HEADER,
              [["2.1", "内部会议费", "虚构甲板块", "单场≤2 万", "①", "②√", "", "", "会议通知与签到表"],
               ["2.2", None, "虚构甲板块", "单场＞2 万", "①", "②", "③", "④√", "会议通知、签到表与预算审批单"]])]
    return sample_docs.docx(path, body)


def conflict_docx(path):
    body = list(PREFACE)
    body += [("p", "三、虚构合同用印审批"), ("p", "本章编号与已入库的制度重复，用来验证整份拒绝。"),
             ("table", MATRIX_HEADER,
              [["1.2", "虚构采购合同用印", "虚构甲板块", "总金额＞20 万", "①", "②", "③", "④√", "合同文本与比价记录"]])]
    return sample_docs.docx(path, body)


PROSE_TITLE = "虚构集团费用报销与付款审批补充规定（端到端测试样例，内容虚构）"
PROSE = [
    ("第一章 总则", [
        ("第一条", "为规范虚构集团各板块的费用报销与对公付款审批，明确合同付款、预付款与报销单据的审批要求，制定本规定。"),
        ("第二条", "本规定适用于虚构甲板块、虚构乙板块的全部报销与对公付款事项；单据金额以本次付款金额为准。"),
    ]),
    ("第二章 付款审批", [
        ("第三条", "对公付款须附合同、发票与验收单，三者金额一致；合同约定分期付款的，按当期应付金额审批。"),
        ("第四条", "预付款不得超过合同总金额的百分之三十；超过的，须经财务经理与总经理审批，并在付款审批单上注明理由。"),
        ("第五条", "同一供应商同一月份内多笔付款合计超过二十万元的，按合计金额对应的审批路径执行，不得拆分审批。"),
    ]),
    ("第三章 报销审批", [
        ("第六条", "费用报销须在费用发生后三十日内提交，逾期报销须由部门负责人书面说明原因后方可审批。"),
        ("第七条", "报销金额与发票金额不一致的，以较低者为准；差额部分不予报销，审批人不得代为签批。"),
    ]),
]


def prose_md(path):
    lines = [f"# {PROSE_TITLE}", ""]
    for chapter, articles in PROSE:
        lines += [f"## {chapter}", ""]
        for no, text in articles:
            lines += [f"{no} {text}", ""]
    return sample_docs.md(path, lines)


def prose_pdf(path):
    page = [PROSE_TITLE[:24]]
    for chapter, articles in PROSE:
        page.append(chapter)
        for no, text in articles:
            # 一行放不下：每 30 字折一行（PDF 一行一块，解析器按条把折行拼回去）
            full = f"{no} {text}"
            page += [full[i:i + 30] for i in range(0, len(full), 30)]
    return sample_docs.pdf(path, [page[:26], page[26:]] if len(page) > 26 else [page])


def prose_xlsx(path):
    rows = [["费用类别", "审批要求", "单据要求"],
            ["对公付款", "合同金额二十万元以上的付款须经总经理审批", "合同、发票、验收单"],
            ["预付款", "不超过合同总金额的百分之三十，超过须注明理由", "合同与预付款申请单"],
            ["差旅报销", "三十日内提交，逾期须部门负责人说明", "出差审批单与发票"]]
    return sample_docs.xlsx(path, [("费用审批要求", rows, [])])


DOCS = {
    "e2e-matrix.docx": (matrix_docx, "e2e-matrix-1030"),
    "e2e-conflict.docx": (conflict_docx, "e2e-conflict-1030"),
    "e2e-prose.md": (prose_md, "e2e-prose-md"),
    "e2e-prose.pdf": (prose_pdf, "e2e-prose-pdf"),
    "e2e-prose.xlsx": (prose_xlsx, "e2e-prose-xlsx"),
}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=str(PKG / ".build" / "e2e"))
    out = Path(ap.parse_args().out)
    out.mkdir(parents=True, exist_ok=True)
    made = {}
    for name, (build, tag) in DOCS.items():
        build(out / name)
        made[name] = {"source_id": tag, "bytes": (out / name).stat().st_size}
    print(json.dumps({"out": str(out), "docs": made}, ensure_ascii=False))


if __name__ == "__main__":
    main()
