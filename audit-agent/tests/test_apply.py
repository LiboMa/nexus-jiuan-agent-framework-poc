"""审核 Agent 的下发：提示词里不写环境值（连接器、规则工具目录、Agent 名、模型按环境配置替换），知识库那几段按 KB_MODE 渲染成
pg / s3vectors 两种，两种都有自定义规则一段；apply.py 的目标来自环境配置。"""
import difflib
import io
import re
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import replace
from pathlib import Path

HERE = Path(__file__).resolve().parent
AGENT = HERE.parent
sys.path.insert(0, str(AGENT))

import nexus_common  # noqa: E402

PROMPT = (AGENT / "prompt.yaml").read_text(encoding="utf-8")
EXPECTED = (HERE / "fixtures/prompt-expected-beine1013.yaml").read_text(encoding="utf-8")
# 改动前（agentVersion jiuan-audit-ai-kb-2026-10-26.1）的 pg 渲染结果，也就是现有环境线上的提示词
BEFORE = (HERE / "fixtures/prompt-expected-beine1013-2026-10-26.1.yaml").read_text(encoding="utf-8")
EXPECTED_S3V = (HERE / "fixtures/prompt-expected-beine1013-s3vectors.yaml").read_text(encoding="utf-8")
KB_TEMPLATE = (AGENT.parent / "kb/agent/prompt-rules.txt").read_text(encoding="utf-8")
RULES_TOOL_DIR = "kb_s3v_rules_0a1b2c3d"
S3V_KEYS = ("KB_MODE=s3vectors\nKB_S3V_BUCKET=knowbase-s3v-example\nKB_S3V_RULES_INDEX=rules\n"
            f"RULES_TOOL_DIR={RULES_TOOL_DIR}\nKB_S3V_KEY_ID=key-0123456789ab\nKB_S3V_PUBLICATION_ID=pub_0123456789abcdef\n")
OLD_VERSION, NEW_VERSION = "jiuan-audit-ai-kb-2026-10-26.1", "jiuan-audit-ai-kb-2026-10-28.1"


def env_file(text):
    handle = tempfile.NamedTemporaryFile("w", suffix=".env", delete=False, encoding="utf-8")
    handle.write("STACK=andon-finance-rehearsal\nAWS_REGION=us-east-1\n" + text)
    handle.close()
    return handle.name


def s3v_target():
    """现有环境（Agent 名、模型同 beine1013）切到 s3vectors：从环境配置读，不写 CONNECTOR_ID。"""
    return nexus_common.target_from(env_file("NEXUS_ORIGIN=https://nxs-beine1013.tinyboat.blog\nNEXUS_PROFILE=beine1013\n" + S3V_KEYS))


def changes(old, new):
    """两段文字逐行比，返回不相同的那几处 (tag, 旧行, 新行)。"""
    a, b = old.splitlines(keepends=True), new.splitlines(keepends=True)
    return [(tag, a[i1:i2], b[j1:j2], a[i1 - 1] if i1 else "")
            for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes() if tag != "equal"]


def custom_rules_paragraph(rendered):
    """第 9 条 c 里 ③ 和 ④ 之间的那几行（自定义规则一段）。"""
    lines = rendered.splitlines(keepends=True)
    start = next(i for i, line in enumerate(lines) if line.lstrip().startswith("③ 判断")) + 1
    end = next(i for i, line in enumerate(lines) if line.lstrip().startswith("④ 结论"))
    return "".join(lines[start:end])


def tools_dependencies(rendered):
    lines = rendered.splitlines()
    start = lines.index("      tools_dependencies:") + 1
    return [line[len("      - "):] for line in lines[start:] if line.startswith("      - ")]


class PromptTest(unittest.TestCase):
    def test_render_pg_matches_online(self):
        """pg 渲染 = 期望文件；期望文件和改动前（线上现在的）只差 agentVersion 和第 9 条 c 里 ③ 之后的自定义规则一段。"""
        self.assertEqual(nexus_common.render_prompt(PROMPT, nexus_common.target_from(None)), EXPECTED)
        found = changes(BEFORE, EXPECTED)
        self.assertEqual([tag for tag, *_ in found], ["replace", "insert"], found)
        (_, old, new, _), (_, removed, added, before_insert) = found
        self.assertEqual((len(old), len(new), removed), (1, 1, []))
        self.assertIn(f'"agentVersion":"{OLD_VERSION}"', old[0])
        self.assertEqual(old[0].replace(OLD_VERSION, NEW_VERSION), new[0])
        self.assertTrue(before_insert.lstrip().startswith("③ 判断"), before_insert)
        self.assertEqual("".join(added), custom_rules_paragraph(EXPECTED))

    def test_custom_rules_paragraph_is_the_same_in_both_modes_and_keeps_the_output_contract(self):
        pg = custom_rules_paragraph(EXPECTED)
        self.assertEqual(custom_rules_paragraph(EXPECTED_S3V), pg)
        for text in ("input.customRules", "附加审核要求", "公司制度判 fail 的，不因为自定义规则改成 pass", "第 3 条",
                     "note 以「（含 <customRules.owner> 的自定义规则）」开头", 'kind 为 "rule"', "ref 以「自定义：<title>」开头",
                     "不编规则编号", "不超过 200 字", "不超过 500 字", "不超过 1000 字", "至多 10 条", "fail 时至少 1 条",
                     "没有 customRules 时，note 里不出现「自定义规则」"):
            self.assertIn(text, pg)
        for rendered in (EXPECTED, EXPECTED_S3V):
            self.assertEqual(rendered.count(f'"agentVersion":"{NEW_VERSION}"'), 1)
            self.assertNotIn(OLD_VERSION, rendered)

    def test_render_s3vectors(self):
        rendered = nexus_common.render_prompt(PROMPT, s3v_target())
        self.assertEqual(rendered, EXPECTED_S3V)
        for absent in ("data_connector", "approval_rules", "kb_search", "SELECT", "pgvector", "conn-", "#<kb:", "#</kb:", "${"):
            self.assertNotIn(absent, rendered)
        self.assertIn("rules_search(", rendered)
        self.assertIn(f"imported_tools/{RULES_TOOL_DIR}/s3vectors_rules_tools/rules_search", rendered)
        self.assertEqual(tools_dependencies(rendered), [f"imported_tools/{RULES_TOOL_DIR}/s3vectors_rules_tools/rules_search"])
        lines = rendered.splitlines()
        self.assertFalse([line for line in lines if line.startswith("      7. ")], "s3vectors 方式没有第 7 条")
        rule4 = next(line for line in lines if line.startswith("      4. "))
        self.assertIn("只调用 rules_search", rule4)
        self.assertIn("② 第 8 条", rule4)
        self.assertIn("rules_search", next(line for line in lines if line.startswith("      8. 规则查询模式")))
        step2 = rendered[rendered.index("② 查规则"):rendered.index("③ 判断")]
        self.assertIn('rules_search(question="<业务事项的 2–4 个关键词>", segment="<所属板块>", amount=<支付金额，元>, top_k=8)', step2)
        self.assertIn("一共不超过 3 次", step2)
        self.assertIn("板块拿不准时不填 segment", step2)
        self.assertIn("金额读不出数字时不填 amount", step2)
        self.assertIn("invalid_parameter", step2)
        self.assertIn("9. 信封模式", rendered)

    def test_render_pg_keeps_the_connector_sql_and_tools(self):
        rendered = nexus_common.render_prompt(PROMPT, nexus_common.target_from(None))
        self.assertNotIn("rules_search", rendered)
        self.assertNotIn("RULES_TOOL_DIR", rendered)
        self.assertEqual(tools_dependencies(rendered), [f"system_tools/data_connector/data_connector_{name}" for name in ("query", "read", "schema", "write")])

    def test_pg_rules_7_and_8_are_the_ones_kb_sh_agent_manages(self):
        """kb/agent/prompt-rules.txt（kb.sh agent 管）的第 7、8 条按现有环境的变量替换后，和 pg 渲染里的那两行逐字一致。"""
        values = {"CONNECTOR_ID": "conn-f0c7233959d9", "RULES_TABLE": "approval_rules",
                  "RULES_DOC_TITLE": "《财务事项审批及授权管理办法》V4.0 正式签批版", "RULES_SEGMENTS_HINT": "九安 / 柯顿 / 新零售 / O+O 等"}
        managed = [re.sub(r"\$\{([A-Z_]+)\}", lambda m: values[m.group(1)], line) for line in KB_TEMPLATE.splitlines() if re.match(r"[78]\. ", line)]
        self.assertEqual(len(managed), 2)
        lines = [line[6:] for line in EXPECTED.splitlines() if re.match(r"      [78]\. ", line)]
        self.assertEqual(lines, managed)

    def test_prompt_source_has_no_environment_values(self):
        for pattern in (r"conn-[0-9a-f]{6,}", r"agent_[0-9a-f]{16,}", r"pub_[0-9a-f]{8,}", r"\b10\.\d+\.\d+\.\d+\b", r"nxs-beine1013", r"Agents as a Tool",
                        r"key-[0-9a-f]{6,}", r"knowbase-s3v", r"kb_s3v_rules_"):
            self.assertIsNone(re.search(pattern, PROMPT), pattern)
        for name in ("${CONNECTOR_ID}", "${RULES_TOOL_DIR}", "${AGENT_NAME}", "${AGENT_MODEL}"):
            self.assertIn(name, PROMPT)

    def test_unknown_placeholder_is_refused(self):
        with self.assertRaises(ValueError):
            nexus_common.render_prompt("a ${SOMETHING} b", nexus_common.target_from(None))

    def test_placeholder_of_the_other_mode_is_refused(self):
        with self.assertRaises(ValueError) as caught:
            nexus_common.render_prompt("a ${RULES_TOOL_DIR} b", nexus_common.target_from(None))
        self.assertIn("s3vectors", str(caught.exception))
        with self.assertRaises(ValueError) as caught:
            nexus_common.render_prompt("a ${CONNECTOR_ID} b", s3v_target())
        self.assertIn("pg", str(caught.exception))


class BlockTest(unittest.TestCase):
    """方式块：单独一行 #<kb:pg> / #</kb:pg>、#<kb:s3vectors> / #</kb:s3vectors>（行首可有缩进）；留当前方式的块，删另一种（连同标记行）。"""
    TEXT = ("a ${AGENT_NAME}\n"
            "  #<kb:pg>\n  pg ${CONNECTOR_ID}\n  #</kb:pg>\n"
            "      #<kb:s3vectors>\n  s3v ${RULES_TOOL_DIR}\n  second\n#</kb:s3vectors>\n"
            "b\n")

    def test_blocks_keep_the_current_mode_and_drop_the_other(self):
        pg = nexus_common.target_from(None)
        self.assertEqual(nexus_common.render_prompt(self.TEXT, pg), "a jiuan_audit_ai_poc\n  pg conn-f0c7233959d9\nb\n")
        self.assertEqual(nexus_common.render_prompt(self.TEXT, s3v_target()), f"a jiuan_audit_ai_poc\n  s3v {RULES_TOOL_DIR}\n  second\nb\n")
        self.assertEqual(nexus_common.render_prompt("no blocks\n", pg), "no blocks\n")

    def test_blocks_must_pair(self):
        target = nexus_common.target_from(None)
        for text in ("a\n#<kb:pg>\nb\n",                                   # 缺结束标记
                     "a\n#</kb:pg>\nb\n",                                  # 只有结束标记
                     "#<kb:pg>\nb\n#</kb:s3vectors>\n",                    # 结束标记不是同一种
                     "#<kb:pg>\n#<kb:s3vectors>\nb\n#</kb:s3vectors>\n#</kb:pg>\n",   # 嵌套
                     "#<kb:pg>\n#<kb:pg>\nb\n#</kb:pg>\n#</kb:pg>\n",      # 同种嵌套
                     "#<kb:other>\nb\n#</kb:other>\n",                     # 不认识的方式
                     "  #<kb:pg> 多写了字\nb\n#</kb:pg>\n"):                # 标记行写错，不能当正文留下
            with self.subTest(text=text), self.assertRaises(ValueError):
                nexus_common.render_prompt(text, target)

    def test_unknown_kb_mode_is_refused(self):
        with self.assertRaises(ValueError):
            nexus_common.render_prompt("a\n", replace(nexus_common.target_from(None), kb_mode="bedrock"))


class TargetTest(unittest.TestCase):
    def test_no_env_file_is_the_existing_environment(self):
        self.assertEqual(nexus_common.target_from(None), nexus_common.Target(
            origin="https://nxs-beine1013.tinyboat.blog", profile="beine1013", agent_name="jiuan_audit_ai_poc", display_name="九安审核AI（PoC）",
            model="global.anthropic.claude-opus-5-5", agent_id="agent_56d44dd9350f4a568bca387319e12ae4", publication_id="pub_5c53e70d8dc7ddea",
            connector_id="conn-f0c7233959d9"))
        self.assertEqual((nexus_common.EXISTING.kb_mode, nexus_common.EXISTING.rules_tool_dir, nexus_common.EXISTING.kb_key_id), ("pg", "", ""))

    def test_env_file_without_kb_mode_is_pg(self):
        target = nexus_common.target_from(env_file("NEXUS_ORIGIN=https://nexus.example.com\nNEXUS_PROFILE=p\nCONNECTOR_ID=conn-0123456789ab\n"))
        self.assertEqual((target.kb_mode, target.connector_id, target.rules_tool_dir, target.kb_key_id), ("pg", "conn-0123456789ab", "", ""))

    def test_s3vectors_env_needs_the_rules_tool_and_its_key_not_the_connector(self):
        target = s3v_target()
        self.assertEqual((target.kb_mode, target.rules_tool_dir, target.kb_key_id, target.connector_id),
                         ("s3vectors", RULES_TOOL_DIR, "key-0123456789ab", ""))
        kept = nexus_common.target_from(env_file("NEXUS_ORIGIN=https://nexus.example.com\nNEXUS_PROFILE=p\nCONNECTOR_ID=conn-0123456789ab\n" + S3V_KEYS))
        self.assertEqual(kept.connector_id, "conn-0123456789ab", "CONNECTOR_ID 留着时读进来（setup.py 用它找要解绑的连接器）")
        for missing in ("NEXUS_ORIGIN", "NEXUS_PROFILE", "RULES_TOOL_DIR", "KB_S3V_KEY_ID"):
            text = "NEXUS_ORIGIN=https://nexus.example.com\nNEXUS_PROFILE=p\n" + S3V_KEYS
            text = re.sub(rf"^{missing}=.*\n", "", text, flags=re.M)
            with self.subTest(missing=missing), self.assertRaises(ValueError) as caught:
                nexus_common.target_from(env_file(text))
            self.assertIn(missing, str(caught.exception))

    def test_env_file_must_name_nexus_profile_and_connector(self):
        for missing in ("NEXUS_ORIGIN", "NEXUS_PROFILE", "CONNECTOR_ID"):
            values = {"NEXUS_ORIGIN": "https://nexus.example.com", "NEXUS_PROFILE": "p", "CONNECTOR_ID": "conn-0123456789ab"}
            del values[missing]
            path = env_file("".join(f"{k}={v}\n" for k, v in values.items()))
            with self.assertRaises(ValueError) as caught:
                nexus_common.target_from(path)
            self.assertIn(missing, str(caught.exception))

    def test_env_file_defaults_for_agent_name_display_name_and_model(self):
        target = nexus_common.target_from(env_file("NEXUS_ORIGIN=https://nexus.example.com/\nNEXUS_PROFILE=p\nCONNECTOR_ID=conn-0123456789ab\n"))
        self.assertEqual((target.origin, target.agent_name, target.display_name, target.model, target.agent_id, target.publication_id),
                         ("https://nexus.example.com", "jiuan_audit_ai_poc", "九安审核AI（PoC）", "global.anthropic.claude-opus-5-5", "", ""))


class NexusCallTest(unittest.TestCase):
    """nexus()：路径参数用 -p，查询参数用 -q（operator 不让混用）；missing_ok 时 404 回 None，别的错误照样退出。"""

    def run_call(self, returncode, stdout, **kwargs):
        seen = {}

        class Done:
            pass

        def fake_run(args, **_):
            seen["args"] = args
            done = Done()
            done.returncode, done.stdout, done.stderr = returncode, stdout, "boom"
            return done
        original = nexus_common.subprocess.run
        nexus_common.subprocess.run = fake_run
        try:
            return nexus_common.nexus("GET", "/api/v2/agents", **kwargs, target=nexus_common.target_from(None)), seen["args"]
        finally:
            nexus_common.subprocess.run = original

    def test_query_parameters_use_q(self):
        _, args = self.run_call(0, '{"data": []}', params=["agent_id=a"], query=["limit=100", "page=2"])
        self.assertEqual(args[args.index("call"):], ["call", "GET", "/api/v2/agents", "-p", "agent_id=a", "-q", "limit=100", "-q", "page=2"])
        self.assertEqual(args[args.index("--profile") + 1], "beine1013")

    def test_missing_ok_turns_404_into_none(self):
        result, _ = self.run_call(1, '{"ok": false, "status": 404}', missing_ok=True)
        self.assertIsNone(result)
        with self.assertRaises(SystemExit):
            self.run_call(1, '{"ok": false, "status": 500}', missing_ok=True)


class ApplyTest(unittest.TestCase):
    def setUp(self):
        sys.modules.pop("apply", None)
        import apply
        self.apply = apply
        self.calls = []

    def fake(self, live):
        def nexus(method, path, params=(), body=None, write=False, dry_run=False, *, target):
            self.calls.append((method, path, tuple(params), write, target.profile, dry_run, body))
            if path.endswith("/files/prompt") and method == "GET":
                return {"content": live}
            if path.endswith("/dynamic-config") and method == "GET":
                return {"dynamic_id": "dyn-1", "connectors": ["conn-0123456789ab"], "key_match_mode": "exact"}
            if method == "GET":
                return {"description": nexus_common.DESCRIPTION}
            return None
        return nexus

    def test_apply_targets_come_from_the_env_file(self):
        path = env_file("NEXUS_ORIGIN=https://nexus.example.com\nNEXUS_PROFILE=rehearsal\nCONNECTOR_ID=conn-0123456789ab\n"
                        "AGENT_ID=agent_0123456789abcdef0123\nPUBLICATION_ID=pub_0123456789ab\n")
        self.apply.nexus = self.fake(live="old prompt")
        base = env_file("")
        Path(base).write_text("old prompt", encoding="utf-8")
        with redirect_stdout(io.StringIO()):
            self.apply.main(["--env", path, "--base", base, "--dry-run"])
        self.assertTrue(self.calls)
        self.assertTrue(all(call[4] == "rehearsal" for call in self.calls))
        self.assertIn("agent_id=agent_0123456789abcdef0123", self.calls[0][2])
        self.assertTrue(any("publish_id=pub_0123456789ab" in call[2] for call in self.calls))

    def test_apply_without_publication_says_run_setup_first(self):
        path = env_file("NEXUS_ORIGIN=https://nexus.example.com\nNEXUS_PROFILE=p\nCONNECTOR_ID=conn-0123456789ab\n")
        with self.assertRaises(SystemExit) as caught:
            self.apply.main(["--env", path, "--base", path, "--dry-run"])
        self.assertIn("setup.py", str(caught.exception.code))

    IDS = "AGENT_ID=agent_0123456789abcdef0123\nPUBLICATION_ID=pub_0123456789ab\n"

    def dry_run(self, env_text, live, *extra):
        self.apply.nexus = self.fake(live=live)
        out = io.StringIO()
        with redirect_stdout(out):
            self.apply.main(["--env", env_file(env_text + self.IDS), "--dry-run", *extra])
        self.assertTrue(all(call[5] for call in self.calls if call[3]), "dry-run 的写操作都只打印")
        return out.getvalue()

    @staticmethod
    def diff_lines(out):
        return ([line[1:] for line in out.splitlines() if line.startswith("-") and not line.startswith("---")],
                [line[1:] for line in out.splitlines() if line.startswith("+") and not line.startswith("+++")])

    def test_dry_run_without_base_prints_the_diff_against_the_live_prompt(self):
        """现有环境（pg，线上是改动前的版本）：diff 只有 agentVersion 那一行和自定义规则一段。"""
        out = self.dry_run("NEXUS_ORIGIN=https://nxs-beine1013.tinyboat.blog\nNEXUS_PROFILE=beine1013\nCONNECTOR_ID=conn-f0c7233959d9\n", BEFORE)
        removed, added = self.diff_lines(out)
        old_line = next(line for line in BEFORE.splitlines() if OLD_VERSION in line)
        self.assertEqual(removed, [old_line])
        self.assertEqual(added, [old_line.replace(OLD_VERSION, NEW_VERSION), *custom_rules_paragraph(EXPECTED).splitlines()])
        put = next(call for call in self.calls if call[0] == "PUT")
        self.assertEqual(put[6]["content"], EXPECTED)

    def test_dry_run_with_base_still_checks_the_base(self):
        base = env_file("")
        Path(base).write_text("someone edited it on the web", encoding="utf-8")
        with self.assertRaises(SystemExit) as caught:
            self.dry_run("NEXUS_ORIGIN=https://nexus.example.com\nNEXUS_PROFILE=p\nCONNECTOR_ID=conn-f0c7233959d9\n", BEFORE, "--base", base)
        self.assertIn("底稿", str(caught.exception.code))

    def test_live_prompt_already_rendered_prints_no_diff(self):
        out = self.dry_run("NEXUS_ORIGIN=https://nexus.example.com\nNEXUS_PROFILE=p\nCONNECTOR_ID=conn-f0c7233959d9\n", EXPECTED)
        self.assertEqual(self.diff_lines(out), ([], []))
        self.assertIn("跳过", out)
        self.assertFalse([call for call in self.calls if call[0] == "PUT"])

    def test_s3vectors_dry_run_renders_the_s3vectors_prompt(self):
        out = self.dry_run("NEXUS_ORIGIN=https://nexus.example.com\nNEXUS_PROFILE=p\n" + S3V_KEYS, EXPECTED)
        removed, added = self.diff_lines(out)
        self.assertIn(f"      - imported_tools/{RULES_TOOL_DIR}/s3vectors_rules_tools/rules_search", added)
        self.assertIn("      - system_tools/data_connector/data_connector_query", removed)
        self.assertFalse([line for line in removed + added if "自定义规则" in line], "自定义规则一段两种方式一样，不在 diff 里")
        put = next(call for call in self.calls if call[0] == "PUT")
        self.assertEqual(put[6]["content"], nexus_common.render_prompt(PROMPT, nexus_common.target_from(
            env_file("NEXUS_ORIGIN=https://nexus.example.com\nNEXUS_PROFILE=p\n" + S3V_KEYS))))

    def test_writing_for_real_needs_the_base(self):
        path = env_file("NEXUS_ORIGIN=https://nexus.example.com\nNEXUS_PROFILE=p\nCONNECTOR_ID=conn-f0c7233959d9\n" + self.IDS)
        self.apply.nexus = self.fake(live=BEFORE)
        with self.assertRaises(SystemExit), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.apply.main(["--env", path])
        self.assertEqual(self.calls, [], "没给底稿就不读也不写")


if __name__ == "__main__":
    unittest.main()
