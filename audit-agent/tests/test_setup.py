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

    def __init__(self, agents=(), publications=(), configs=None, clone_polls=2, key_rows=()):
        self.agents = [dict(a) for a in agents]
        self.publications = [dict(p) for p in publications]
        self.configs = dict(configs or {})
        self.writes, self.clone_polls, self.prompts, self.calls = [], clone_polls, {}, []
        self.key_rows = key_rows  # GET /api/v2/keys/tools-requiring-key 的回复；None 是 Operator 调不了这个接口

    def __call__(self, method, path, params=(), body=None, write=False, dry_run=False, *, target, query=(), missing_ok=False):
        values = dict(item.split("=", 1) for item in params)
        self.calls.append((method, path, tuple(query)))
        if write:
            self.writes.append((method, path, values, body))
            if dry_run:
                return None
        if method == "GET" and path == "/api/v2/agents":
            return list(self.agents)
        if method == "GET" and path == "/api/v2/keys/tools-requiring-key":
            if self.key_rows is None:
                raise SystemExit(f"{method} {path} 失败（退出码 1）：HTTP 403 forbidden")
            return [dict(row) for row in self.key_rows]
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

    def test_setup_pg_unchanged(self):
        """pg（不写 KB_MODE，或写 pg）：写操作的顺序和以前一样，不读规则工具的密钥绑定。"""
        for extra in ("", "KB_MODE=pg\n"):
            with self.subTest(extra=extra):
                fake = FakeNexus()
                self.run_setup(fake, env=env_file(extra))
                self.assertEqual([(m, p) for m, p, _, _ in fake.writes], [
                    ("POST", "/api/v2/agents/{source_id}/clone"), ("PUT", "/api/v2/agents/{agent_id}/files/prompt"),
                    ("POST", "/api/v2/publications"), ("POST", "/api/v2/publications/{publish_id}/dynamic-config")])
                self.assertEqual(fake.writes[3][3]["connectors"], [CONNECTOR])
                self.assertFalse([c for c in fake.calls if "tools-requiring-key" in c[1]])
                fake = FakeNexus([EXISTING_AGENT], [EXISTING_PUB], {EXISTING_PUB["publish_id"]: {**EXISTING_CONFIG, "connectors": ["conn-other"]}})
                self.run_setup(fake, env=env_file(extra))
                self.assertEqual([w[3]["connectors"] for w in fake.writes], [["conn-other", CONNECTOR]])


S3V_DIR = "kb_s3v_rules_0a1b2c3d"
LIVE_CONNECTOR = "conn-f0c7233959d9"
S3V_ENV = ("KB_MODE=s3vectors\nKB_S3V_BUCKET=knowbase-s3v-example\nKB_S3V_RULES_INDEX=rules\n"
           f"RULES_TOOL_DIR={S3V_DIR}\nKB_S3V_KEY_ID=key-0123456789ab\nKB_S3V_PUBLICATION_ID=pub_0123456789abcdef\n")
BOUND = [{"tool_name": "rules_writer", "module_path": f"imported_tools/{S3V_DIR}/s3vectors_rules_tools.py", "configured": True},
         {"tool_name": "rules_search", "module_path": f"imported_tools/{S3V_DIR}/s3vectors_rules_tools.py", "configured": True},
         {"tool_name": "rules_search", "module_path": "imported_tools/kb_s3v_rules_other/s3vectors_rules_tools.py", "configured": False}]


def s3v_env(connector=LIVE_CONNECTOR):
    """s3vectors 方式的环境配置；CONNECTOR_ID 留着（setup.py 用它找要解绑的 PG 连接器）。"""
    path = env_file(S3V_ENV)
    Path(path).write_text(Path(path).read_text(encoding="utf-8").replace(f"CONNECTOR_ID={CONNECTOR}\n", f"CONNECTOR_ID={connector}\n"), encoding="utf-8")
    return path


class SetupS3VectorsTest(unittest.TestCase):
    """s3vectors：先核对规则工具 rules_search 的密钥绑定（只读），再找或建 Agent、发布；动态配置里去掉 PG 连接器，其余字段原样带回。"""
    run_setup = SetupTest.run_setup

    def config(self, connectors):
        return {"dynamic_id": "dyn-1", "config_name": "demo", "connectors": connectors, "keys": ["key-aaaaaaaaaaaa"], "key_match_mode": "exact",
                "skills": ["s1"], "tools": None, "agents": [], "cowork_mode": None, "directive_ids": ["d1"]}

    def test_setup_s3vectors_unbinds(self):
        config = self.config([LIVE_CONNECTOR, "conn-other"])
        fake = FakeNexus([EXISTING_AGENT], [EXISTING_PUB], {EXISTING_PUB["publish_id"]: config}, key_rows=BOUND)
        out, _ = self.run_setup(fake, env=s3v_env())
        self.assertEqual([(m, p) for m, p, _, _ in fake.writes], [("POST", "/api/v2/publications/{publish_id}/dynamic-config")])
        saved = fake.writes[0][3]
        self.assertEqual(saved["connectors"], ["conn-other"])
        self.assertEqual(saved["overwrite_dynamic_id"], "dyn-1")
        for field in nexus_common.CONFIG_FIELDS:
            if field != "connectors":
                self.assertEqual(saved[field], config.get(field), field)
        self.assertIn(LIVE_CONNECTOR, out)
        self.assertIn(("GET", "/api/v2/keys/tools-requiring-key", ("limit=500",)), fake.calls)
        reads = [c for c in fake.calls if c[:2] == ("GET", "/api/v2/publications/{publish_id}/dynamic-config")]
        self.assertEqual(len(reads), 2, "保存后再读一次确认")

    def test_setup_s3vectors_unbind_is_confirmed_by_reading_back(self):
        class Stubborn(FakeNexus):
            def __call__(self, method, path, params=(), body=None, write=False, dry_run=False, **kwargs):
                if write and method == "POST" and path.endswith("/dynamic-config"):
                    self.writes.append((method, path, {}, body))
                    return {"dynamic_id": "dyn-1"}
                return super().__call__(method, path, params, body, write, dry_run, **kwargs)
        fake = Stubborn([EXISTING_AGENT], [EXISTING_PUB], {EXISTING_PUB["publish_id"]: self.config([LIVE_CONNECTOR])}, key_rows=BOUND)
        with self.assertRaises(SystemExit) as caught:
            self.run_setup(fake, env=s3v_env())
        self.assertIn(LIVE_CONNECTOR, str(caught.exception.code))

    def test_setup_s3vectors_already_unbound_writes_nothing(self):
        fake = FakeNexus([EXISTING_AGENT], [EXISTING_PUB], {EXISTING_PUB["publish_id"]: self.config(["conn-other"])}, key_rows=BOUND)
        out, _ = self.run_setup(fake, env=s3v_env())
        self.assertEqual(fake.writes, [])
        self.assertEqual([line.split()[0] for line in out.splitlines() if line.strip()[:1] in "=+~"], ["=", "=", "=", "="])

    def test_setup_s3vectors_dry_run_only_prints_the_unbind(self):
        fake = FakeNexus([EXISTING_AGENT], [EXISTING_PUB], {EXISTING_PUB["publish_id"]: self.config([LIVE_CONNECTOR])}, key_rows=BOUND)
        out, path = self.run_setup(fake, "--dry-run", env=s3v_env())
        self.assertEqual(len(fake.writes), 1)
        self.assertEqual(fake.configs[EXISTING_PUB["publish_id"]]["connectors"], [LIVE_CONNECTOR], "dry-run 不改")
        self.assertIn("[dry-run]", out)
        self.assertIn("AGENT_ID=\n", Path(path).read_text(encoding="utf-8"))

    def test_setup_s3vectors_binding_missing(self):
        """rules_search 的密钥没绑（configured=False）、Nexus 上没有这个目录的 rules_search、Operator 调不了接口：都非 0 退出，什么都不写。"""
        not_bound = [{**row, "configured": False} if S3V_DIR in row["module_path"] else row for row in BOUND]
        for rows, expect in ((not_bound, "configured"), ([BOUND[2]], S3V_DIR), (None, f"admin_run.sh verify --dir {S3V_DIR}")):
            with self.subTest(rows=rows):
                fake = FakeNexus([EXISTING_AGENT], [EXISTING_PUB], {EXISTING_PUB["publish_id"]: self.config([LIVE_CONNECTOR])}, key_rows=rows)
                with self.assertRaises(SystemExit) as caught:
                    self.run_setup(fake, env=s3v_env())
                self.assertNotIn(caught.exception.code, (0, None))
                self.assertIn(expect, str(caught.exception.code))
                self.assertEqual(fake.writes, [])

    def test_setup_s3vectors_from_zero_writes_the_s3vectors_prompt(self):
        fake = FakeNexus(key_rows=BOUND)
        self.run_setup(fake, env=s3v_env())
        self.assertEqual([(m, p) for m, p, _, _ in fake.writes], [
            ("POST", "/api/v2/agents/{source_id}/clone"), ("PUT", "/api/v2/agents/{agent_id}/files/prompt"), ("POST", "/api/v2/publications")])
        prompt = fake.prompts["agent_" + "a" * 32]
        self.assertIn(f"imported_tools/{S3V_DIR}/s3vectors_rules_tools/rules_search", prompt)
        self.assertNotIn("data_connector", prompt)
        self.assertNotIn(LIVE_CONNECTOR, prompt)

    def test_setup_s3vectors_without_connector_id_leaves_connectors_alone(self):
        fake = FakeNexus([EXISTING_AGENT], [EXISTING_PUB], {EXISTING_PUB["publish_id"]: self.config([LIVE_CONNECTOR])}, key_rows=BOUND)
        path = s3v_env()
        Path(path).write_text(Path(path).read_text(encoding="utf-8").replace(f"CONNECTOR_ID={LIVE_CONNECTOR}\n", ""), encoding="utf-8")
        out, _ = self.run_setup(fake, env=path)
        self.assertEqual(fake.writes, [])
        self.assertIn("CONNECTOR_ID", out)


if __name__ == "__main__":
    unittest.main()
