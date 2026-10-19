import re, sys, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import agent_access as aa  # noqa: E402

SECRET = re.compile(r'(?:nx[acp]|afp)_[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}')


def read(name):
    path = ROOT / name
    if not path.is_file():
        raise AssertionError('缺少 %s' % name)
    return path.read_text(encoding='utf-8')


def front_matter(text):
    match = re.match(r'^---\n(.*?)\n---\n', text, re.S)
    if not match:
        raise AssertionError('SKILL.md 要以 --- 包起来的头部开始')
    return match.group(1)


def subcommands():
    parser = aa.build_parser()
    sub = next(action for action in parser._actions if action.dest == 'command')
    names = set(sub.choices)
    nexus = next(action for action in sub.choices['nexus']._actions if action.dest == 'nexus_command')
    return names - {'nexus'} | {'nexus ' + name for name in nexus.choices}


class SkillPackageTests(unittest.TestCase):
    """编码工具（Claude Code、Codex、Kiro CLI）能安装的 Skill：SKILL.md 给工具读，README.md 给人读。"""

    def test_skill_md_header_names_the_skill_and_its_dangerous_commands(self):
        head = front_matter(read('SKILL.md'))
        self.assertRegex(head, r'(?m)^name: agent-access$')
        self.assertRegex(head, r'(?m)^description: ".+TRIGGER.+"$')
        self.assertRegex(head, r'(?m)^allowed-tools: Bash\(python3:\*\), Read$')
        for command in ('scripts/agent_access.py nexus disconnect', 'scripts/agent_access.py disable'):
            self.assertIn('  - "%s"' % command, head)

    def test_skill_md_covers_every_command_of_the_script(self):
        text = read('SKILL.md')
        for name in sorted(subcommands()):
            self.assertIn('agent_access.py %s' % name, text, name)

    def test_skill_md_has_the_shared_exit_code_table(self):
        text = read('SKILL.md')
        for code in (0, 2, 3, 4, 5, 6, 7, 8, 9):
            self.assertRegex(text, r'(?m)^\| %d \|' % code)

    def test_skill_md_states_the_confirmation_and_key_rules(self):
        text = read('SKILL.md')
        for phrase in ('--yes', '--key-stdin', '--password-stdin', '标准输入', '[已隐藏]', 'nexus-ai-operator', '不可信'):
            self.assertIn(phrase, text, phrase)

    def test_readme_tells_a_person_where_to_install_it(self):
        text = read('README.md')
        for path in ('~/.claude/skills/agent-access/', '~/.agents/skills/agent-access/', '~/.kiro/skills/agent-access/'):
            self.assertIn(path, text, path)
        self.assertIn('Python 3.9', text)

    def test_references_exist(self):
        self.assertIn('agent-access-v1', read('references/interface.md'))
        self.assertIn('enable', read('references/recipes.md'))

    def test_no_secrets_in_the_skill_package(self):
        for path in ROOT.rglob('*'):
            if path.is_file() and path.suffix in ('.md', '.json', '.py') and '__pycache__' not in path.parts:
                self.assertIsNone(SECRET.search(path.read_text(encoding='utf-8')), str(path))


if __name__ == '__main__':
    unittest.main()
