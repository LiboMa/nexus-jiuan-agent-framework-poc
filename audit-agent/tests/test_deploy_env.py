"""audit-agent/deploy_env.py：和 poc/infra/lib/deploy-env.sh 同一套规则读配置文件；fixtures 与 expected.json 两边共用。"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "poc/app/test/fixtures/deploy-env"
sys.path.insert(0, str(ROOT / "audit-agent"))

import deploy_env  # noqa: E402

EXPECTED = json.loads((FIXTURES / "expected.json").read_text(encoding="utf-8"))


class DeployEnvTest(unittest.TestCase):
    def test_values_match_the_bash_loader(self):
        for name, want in EXPECTED["values"].items():
            self.assertEqual(deploy_env.read_deploy_env(str(FIXTURES / name)), want, name)

    def test_errors_name_the_line_and_the_key(self):
        for name, want in EXPECTED["errors"].items():
            with self.assertRaises(ValueError, msg=name) as caught:
                deploy_env.read_deploy_env(str(FIXTURES / name))
            if want["line"]:
                self.assertIn(f"{name}:{want['line']}", str(caught.exception))
            self.assertIn(want["text"], str(caught.exception))
        with self.assertRaises(ValueError):
            deploy_env.read_deploy_env(str(FIXTURES / "no-such.env"))

    def test_kb_mode_is_pg_or_s3vectors_and_absent_means_pg(self):
        for name in ("basic.env", "kb-empty.env"):
            self.assertNotIn("KB_MODE", deploy_env.read_deploy_env(str(FIXTURES / name)), name)
        with self.assertRaises(ValueError) as caught:
            deploy_env.read_deploy_env(str(FIXTURES / "badmode.env"))
        self.assertIn(f"{FIXTURES / 'badmode.env'}:3：KB_MODE 只能是 pg 或 s3vectors：mongo", str(caught.exception))

    def test_s3vectors_needs_all_five_keys_and_names_only_the_missing_ones(self):
        with self.assertRaises(ValueError) as caught:
            deploy_env.read_deploy_env(str(FIXTURES / "s3v-missing.env"))
        self.assertIn("还要写：KB_S3V_KEY_ID（", str(caught.exception))
        for present in ("KB_S3V_BUCKET", "KB_S3V_RULES_INDEX", "RULES_TOOL_DIR", "KB_S3V_PUBLICATION_ID"):
            self.assertNotIn(present, str(caught.exception))
        with self.assertRaises(ValueError) as caught:
            deploy_env.read_deploy_env(str(FIXTURES / "s3v-bare.env"))
        self.assertIn("还要写：KB_S3V_BUCKET、KB_S3V_RULES_INDEX、RULES_TOOL_DIR、KB_S3V_KEY_ID、KB_S3V_PUBLICATION_ID（", str(caught.exception))

    def test_kb_pg_publication_id_is_format_checked_but_not_required(self):
        self.assertEqual(deploy_env.read_deploy_env(str(FIXTURES / "kb-pg-pub.env"))["KB_PG_PUBLICATION_ID"], "pub_fedcba9876543210")
        for name in ("kb-pg.env", "basic.env", "s3v.env"):
            self.assertNotIn("KB_PG_PUBLICATION_ID", deploy_env.read_deploy_env(str(FIXTURES / name)), name)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.env"
            for bad in ("pub_0123456789ABCDEF", "pub_0123456789abcdef0", "pub_0123456789abcde", "agent_0123456789abcdef",
                        "pub_0123456789abcdef x", "pub_0123456789abcdef' && reboot '"):
                path.write_text(f"STACK=s\nAWS_REGION=us-east-1\nKB_MODE=pg\nKB_PG_PUBLICATION_ID={bad}\n", encoding="utf-8")
                with self.assertRaises(ValueError, msg=bad) as caught:
                    deploy_env.read_deploy_env(str(path))
                self.assertIn(f"{path}:4：KB_PG_PUBLICATION_ID 应是 PG 知识库 Agent 的发布编号", str(caught.exception))

    def test_keys_are_the_ones_in_example_env(self):
        lines = (ROOT / "poc/infra/env/example.env").read_text(encoding="utf-8").splitlines()
        keys = [line.split("=", 1)[0] for line in lines if line[:1].isupper() and "=" in line]
        self.assertEqual(tuple(keys), deploy_env.KEYS)


if __name__ == "__main__":
    unittest.main()
