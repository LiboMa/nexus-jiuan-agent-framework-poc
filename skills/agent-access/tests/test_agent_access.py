import io, json, os, stat, sys, tempfile, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import agent_access as aa  # noqa: E402


class PureTests(unittest.TestCase):
    def test_redact_hides_every_key_kind(self):
        text = 'a nxc_' + 'k' * 20 + ' b nxa_' + 'x' * 30 + ' c afp_' + 'y' * 12 + ' d nxp_' + 'z' * 9 + ' e nxa_short'
        out = aa.redact(text)
        self.assertNotIn('kkkk', out); self.assertNotIn('xxxx', out); self.assertNotIn('yyyy', out); self.assertNotIn('zzzz', out)
        self.assertEqual(out.count('[已隐藏]'), 4)
        self.assertIn('nxa_short', out)

    def test_exit_codes_follow_the_shared_table(self):
        cases = [(401, None, 3), (409, 'POC_NEXUS_NOT_CONNECTED', 3), (400, 'POC_NEXUS_API_KEY_INVALID', 4), (400, 'POC_CALL_KEY_INVALID', 4),
                 (404, 'POC_PUBLICATION_NOT_MINE', 5), (409, 'POC_CARD_UNAVAILABLE', 6), (409, 'POC_AGENT_NOT_ENABLED', 6), (429, 'POC_ME_RATE_LIMIT', 7),
                 (502, 'POC_NEXUS_UNREACHABLE', 8), (500, None, 8), (400, 'INVALID_REQUEST', 2), (403, 'POC_ISSUE_NOT_ALLOWED', 4)]
        for status, code, expected in cases:
            self.assertEqual(aa.exit_for(status, code), expected, (status, code))

    def test_global_flags_anywhere(self):
        flags, rest = aa.split_globals(['enable', 'pub_x', '--yes', '--profile', 'work', '--key-stdin', '--json'])
        self.assertEqual(flags, {'yes': True, 'json': True, 'profile': 'work'})
        self.assertEqual(rest, ['enable', 'pub_x', '--key-stdin'])

    def test_write_without_yes_is_exit_9_before_any_request(self):
        with tempfile.TemporaryDirectory() as home:
            code = aa.main(['disable', 'pub_xxxx'], env={'AGENT_ACCESS_HOME': home}, stdin=io.StringIO(''), stdout=io.StringIO(), stderr=io.StringIO())
            self.assertEqual(code, 9)

    def test_store_permissions(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / 'aa'
            store = aa.Store(home)
            store.save_profile('default', {'origin': 'http://x', 'cookie': 'jiuan_analysis=1'})
            self.assertEqual(stat.S_IMODE(os.stat(home).st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(os.stat(home / 'credentials.json').st_mode), 0o600)
            self.assertEqual(store.profile('default')['origin'], 'http://x')
            self.assertTrue(store.drop_profile('default'))
            self.assertIsNone(store.profile('default'))

    def test_secret_must_come_from_stdin(self):
        class Tty(io.StringIO):
            def isatty(self): return True
        with self.assertRaises(aa.CliError) as ctx:
            aa.read_secret(Tty('nxa_x'), 'API 密钥')
        self.assertEqual(ctx.exception.exit_code, 2)
        with self.assertRaises(aa.CliError):
            aa.read_secret(io.StringIO('\n'), 'API 密钥')
        self.assertEqual(aa.read_secret(io.StringIO('  nxa_value \n'), '调用密钥'), 'nxa_value')


if __name__ == '__main__':
    unittest.main()
