"""audit-agent/deploy_env.py：和 poc/infra/lib/deploy-env.sh 同一套规则读配置文件；fixtures 与 expected.json 两边共用。"""
import json
import sys
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

    def test_keys_are_the_ones_in_example_env(self):
        lines = (ROOT / "poc/infra/env/example.env").read_text(encoding="utf-8").splitlines()
        keys = [line.split("=", 1)[0] for line in lines if line[:1].isupper() and "=" in line]
        self.assertEqual(tuple(keys), deploy_env.KEYS)


if __name__ == "__main__":
    unittest.main()
