"""setup.py：在 Nexus 上找或建审核 Agent、它的 A2A 发布，并把知识库连接器绑进发布的动态配置。幂等；写操作只在需要时做。"""
import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import nexus_common  # noqa: E402

CONNECTOR = "conn-0123456789ab"


class FakeNexus:
    """按路径回 Nexus 的现状；写操作记下来并改现状。"""

    def __init__(self, agents=(), publications=(), configs=None, clone_polls=2):
        self.agents = [dict(a) for a in agents]
        self.publications = [dict(p) for p in publications]
        self.configs = dict(configs or {})
        self.writes, self.clone_polls, self.prompts = [], clone_polls, {}

    def __call__(self, method, path, params=(), body=None, write=False, dry_run=False, *, target, query=(), missing_ok=False):
        values = dict(item.split("=", 1) for item in params)
        if write:
            self.writes.append((method, path, values, body))
            if dry_run:
                return None
        if method == "GET" and path == "/api/v2/agents":
            return list(self.agents)
        if method == "POST" and path.endswith("/clone"):
            new = {"agent_id": "agent_" + "a" * 32, "agent_name": body["name_en"], "status": "creating"}
            self.agents.append(new)
            return {"agent_id": new["agent_id"], "status": "queued"}
        if path.endswith("/clone-status"):
            self.clone_polls -= 1
            return {"status": "completed" if self.clone_polls <= 0 else "running"}
        if method == "PUT" and path.endswith("/files/prompt"):
            self.prompts[values["agent_id"]] = body["content"]
            return {}
        if method == "GET" and path == "/api/v2/publications":
            return {"items": list(self.publications)}
        if method == "POST" and path == "/api/v2/publications":
            new = {"publish_id": "pub_" + "b" * 16, "agent_id": body["agent_id"], "access": "owner", "description": body["description"]}
            self.publications.append(new)
            return {"publication": new}
        if method == "PATCH" and path == "/api/v2/publications/{publish_id}":
            next(p for p in self.publications if p["publish_id"] == values["publish_id"]).update(body)
            return {}
        if method == "GET" and path == "/api/v2/publications/{publish_id}/dynamic-config":
            config = self.configs.get(values["publish_id"])
            if config is None and missing_ok:
                return None
            return config
        if method == "POST" and path == "/api/v2/publications/{publish_id}/dynamic-config":
            config = {"dynamic_id": "dyn-new", **body}
            self.configs[values["publish_id"]] = config
            return {"dynamic_id": "dyn-new"}
        if method == "DELETE":
            if "publish_id" in values:
                self.publications = [p for p in self.publications if p["publish_id"] != values["publish_id"]]
            else:
                self.agents = [a for a in self.agents if a["agent_id"] != values["agent_id"]]
            return {}
        raise AssertionError(f"没想到的调用 {method} {path}")


def env_file(extra=""):
    handle = tempfile.NamedTemporaryFile("w", suffix=".env", delete=False, encoding="utf-8")
    handle.write("# 演练\nSTACK=andon-finance-rehearsal\nAWS_REGION=us-east-1\nNEXUS_ORIGIN=https://nexus.example.com\nNEXUS_PROFILE=p\n"
                 f"CONNECTOR_ID={CONNECTOR}\nAGENT_ID=\nPUBLICATION_ID=\n" + extra)
    handle.close()
    return handle.name


EXISTING_AGENT = {"agent_id": "agent_" + "1" * 32, "agent_name": "jiuan_audit_ai_poc", "status": "running"}
EXISTING_PUB = {"publish_id": "pub_" + "2" * 16, "agent_id": EXISTING_AGENT["agent_id"], "access": "owner", "description": nexus_common.DESCRIPTION}
EXISTING_CONFIG = {"dynamic_id": "dyn-1", "config_name": "demo", "connectors": [CONNECTOR], "key_match_mode": "exact"}


class SetupTest(unittest.TestCase):
    def run_setup(self, fake, *args, env=None):
        sys.modules.pop("setup", None)
        import setup
        setup.nexus = fake
        setup.sleep = lambda seconds: None
        path = env or env_file()
        out = io.StringIO()
        with redirect_stdout(out):
            setup.main(["--env", path, *args])
        return out.getvalue(), path

    def test_existing_environment_writes_nothing(self):
        fake = FakeNexus([EXISTING_AGENT], [EXISTING_PUB], {EXISTING_PUB["publish_id"]: EXISTING_CONFIG})
        out, path = self.run_setup(fake)
        self.assertEqual(fake.writes, [])
        self.assertEqual([line.split()[0] for line in out.splitlines() if line.strip()[:1] in "=+~"], ["=", "=", "="])
        text = Path(path).read_text(encoding="utf-8")
        self.assertIn(f"AGENT_ID={EXISTING_AGENT['agent_id']}\n", text)
        self.assertIn(f"PUBLICATION_ID={EXISTING_PUB['publish_id']}\n", text)
        self.assertTrue(text.startswith("# 演练\nSTACK=andon-finance-rehearsal\n"), "其他行原样不动")

    def test_from_zero_clones_writes_prompt_publishes_and_binds_the_connector(self):
        fake = FakeNexus()
        out, path = self.run_setup(fake)
        steps = [(method, path_) for method, path_, _, _ in fake.writes]
        self.assertEqual(steps, [("POST", "/api/v2/agents/{source_id}/clone"), ("PUT", "/api/v2/agents/{agent_id}/files/prompt"),
                                 ("POST", "/api/v2/publications"), ("POST", "/api/v2/publications/{publish_id}/dynamic-config")])
        clone = fake.writes[0]
        self.assertEqual(clone[2], {"source_id": "featured_general_assistant"})
        self.assertEqual((clone[3]["name_en"], clone[3]["name_cn"], clone[3]["locale"]), ("jiuan_audit_ai_poc", "九安审核AI（PoC）", "zh-CN"))
        prompt = fake.prompts["agent_" + "a" * 32]
        self.assertIn(CONNECTOR, prompt)
        self.assertNotIn("${", prompt)
        publication = fake.writes[2][3]
        self.assertEqual((publication["channels"], publication["follow_updates"], publication["description"], publication["model_id"]),
                         (["a2a", "mcp"], True, nexus_common.DESCRIPTION, "global.anthropic.claude-opus-5-5"))
        self.assertNotIn("issue_initial_key", publication)
        config = fake.writes[3][3]
        self.assertEqual((config["connectors"], config["key_match_mode"]), ([CONNECTOR], "exact"))
        self.assertIn("PUBLICATION_ID=pub_" + "b" * 16, Path(path).read_text(encoding="utf-8"))
        self.assertIn("调用密钥", out, "最后提示下一步：网页上签发调用密钥、九安上启用")

    def test_rerun_after_a_failure_halfway_does_not_clone_again(self):
        fake = FakeNexus([EXISTING_AGENT])
        self.run_setup(fake)
        self.assertEqual([path for _, path, _, _ in fake.writes], ["/api/v2/publications", "/api/v2/publications/{publish_id}/dynamic-config"])

    def test_wrong_description_is_patched_and_missing_connector_is_added(self):
        pub = {**EXISTING_PUB, "description": "旧的说明"}
        config = {**EXISTING_CONFIG, "connectors": []}
        fake = FakeNexus([EXISTING_AGENT], [pub], {pub["publish_id"]: config})
        self.run_setup(fake)
        self.assertEqual([(m, p) for m, p, _, _ in fake.writes], [("PATCH", "/api/v2/publications/{publish_id}"), ("POST", "/api/v2/publications/{publish_id}/dynamic-config")])
        resave = fake.writes[1][3]
        self.assertEqual((resave["connectors"], resave["overwrite_dynamic_id"], resave["config_name"]), ([CONNECTOR], "dyn-1", "demo"))

    def test_ambiguity_is_refused_without_writing(self):
        twin = {**EXISTING_AGENT, "agent_id": "agent_" + "3" * 32}
        fake = FakeNexus([EXISTING_AGENT, twin])
        with self.assertRaises(SystemExit) as caught:
            self.run_setup(fake)
        self.assertIn("两个", str(caught.exception.code))
        self.assertEqual(fake.writes, [])
        fake = FakeNexus([EXISTING_AGENT])
        mismatch = env_file()
        Path(mismatch).write_text(Path(mismatch).read_text(encoding="utf-8").replace("AGENT_ID=\n", "AGENT_ID=agent_" + "9" * 32 + "\n"), encoding="utf-8")
        with self.assertRaises(SystemExit) as caught:
            self.run_setup(fake, env=mismatch)
        self.assertIn("AGENT_ID", str(caught.exception.code))
        self.assertEqual(fake.writes, [])

    def test_dry_run_writes_nothing(self):
        fake = FakeNexus()
        out, path = self.run_setup(fake, "--dry-run")
        self.assertTrue(all(len(w) == 4 for w in fake.writes))
        self.assertEqual(fake.agents, [], "dry-run 不建 Agent")
        self.assertIn("AGENT_ID=\n", Path(path).read_text(encoding="utf-8"), "dry-run 不写回配置")

    def test_delete_only_for_rehearsal_names_and_leaves_nothing(self):
        with self.assertRaises(SystemExit):
            self.run_setup(FakeNexus([EXISTING_AGENT], [EXISTING_PUB]), "--delete")
        rehearsal = {**EXISTING_AGENT, "agent_name": "jiuan_audit_ai_rehearsal"}
        fake = FakeNexus([rehearsal], [EXISTING_PUB], {})
        out, path = self.run_setup(fake, "--delete", env=env_file("AGENT_NAME=jiuan_audit_ai_rehearsal\n"))
        self.assertEqual([m for m, _, _, _ in fake.writes], ["DELETE", "DELETE"])
        self.assertEqual((fake.agents, fake.publications), ([], []))
        self.assertIn("没有残留", out)

    def test_no_env_file_is_refused(self):
        sys.modules.pop("setup", None)
        import setup
        setup.nexus = FakeNexus()
        with self.assertRaises(SystemExit):
            setup.main([])


if __name__ == "__main__":
    unittest.main()
