"""审核 Agent 的下发：提示词里不写环境值（连接器、Agent 名、模型按环境配置替换），apply.py 的目标来自环境配置。"""
import io
import re
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
AGENT = HERE.parent
sys.path.insert(0, str(AGENT))

import nexus_common  # noqa: E402

PROMPT = (AGENT / "prompt.yaml").read_text(encoding="utf-8")
EXPECTED = (HERE / "fixtures/prompt-expected-beine1013.yaml").read_text(encoding="utf-8")


def env_file(text):
    handle = tempfile.NamedTemporaryFile("w", suffix=".env", delete=False, encoding="utf-8")
    handle.write("STACK=andon-finance-rehearsal\nAWS_REGION=us-east-1\n" + text)
    handle.close()
    return handle.name


class PromptTest(unittest.TestCase):
    def test_existing_environment_renders_the_live_prompt_without_the_stray_line(self):
        self.assertEqual(nexus_common.render_prompt(PROMPT, nexus_common.target_from(None)), EXPECTED)

    def test_prompt_source_has_no_environment_values(self):
        for pattern in (r"conn-[0-9a-f]{6,}", r"agent_[0-9a-f]{16,}", r"pub_[0-9a-f]{8,}", r"\b10\.\d+\.\d+\.\d+\b", r"nxs-beine1013", r"Agents as a Tool"):
            self.assertIsNone(re.search(pattern, PROMPT), pattern)
        for name in ("${CONNECTOR_ID}", "${AGENT_NAME}", "${AGENT_MODEL}"):
            self.assertIn(name, PROMPT)

    def test_unknown_placeholder_is_refused(self):
        with self.assertRaises(ValueError):
            nexus_common.render_prompt("a ${SOMETHING} b", nexus_common.target_from(None))


class TargetTest(unittest.TestCase):
    def test_no_env_file_is_the_existing_environment(self):
        self.assertEqual(nexus_common.target_from(None), nexus_common.Target(
            origin="https://nxs-beine1013.tinyboat.blog", profile="beine1013", agent_name="jiuan_audit_ai_poc", display_name="九安审核AI（PoC）",
            model="global.anthropic.claude-opus-5-5", agent_id="agent_56d44dd9350f4a568bca387319e12ae4", publication_id="pub_5c53e70d8dc7ddea",
            connector_id="conn-f0c7233959d9"))

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
            self.calls.append((method, path, tuple(params), write, target.profile))
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


if __name__ == "__main__":
    unittest.main()
