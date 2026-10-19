#!/usr/bin/env python3
"""agent-access：把你在 Nexus 上发布的 Agent 接入实现了 agent-access-v1 的应用（例如九安 PoC）。

只用 Python 3.9+ 标准库；约定与 nexus-ai-operator 一致：
- 写操作要加 --yes；没加时不发请求，只说明将要执行的操作，退出码 9；
- 口令、API 密钥、调用密钥只经标准输入传入，不出现在命令行参数里；
- 所有输出都先脱敏：nxc_ / nxa_ / nxp_ / afp_ 开头的串换成 [已隐藏]；
- 退出码：0 成功，2 用法，3 重新登录或先连接 Nexus，4 凭证被拒，5 不存在，6 状态不对或等待超时，7 限流，8 应用或 Nexus 不可用，9 需要确认。
会话保存在 $AGENT_ACCESS_HOME（缺省 ~/.agent-access）/credentials.json（0600，目录 0700），按 --profile 分开；不保存口令。
"""
import argparse
import base64
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

INTERFACE = 'agent-access-v1'
EXIT_OK, EXIT_USAGE, EXIT_RELOGIN, EXIT_REJECTED, EXIT_NOT_FOUND, EXIT_STATE, EXIT_LIMITED, EXIT_UNAVAILABLE, EXIT_CONFIRM = 0, 2, 3, 4, 5, 6, 7, 8, 9
CLIENTS = ('claude_code', 'codex', 'kiro', 'cli', 'other')
SECRET_RE = re.compile(r'(?:nx[acp]|afp)_[A-Za-z0-9_-]{8,}')
SESSION_SECONDS = 8 * 3600
CODE_EXIT = {
    'POC_NEXUS_NOT_CONNECTED': EXIT_RELOGIN, 'POC_NEXUS_API_KEY_INVALID': EXIT_REJECTED, 'POC_CALL_KEY_INVALID': EXIT_REJECTED,
    'POC_ISSUE_NOT_ALLOWED': EXIT_REJECTED, 'POC_PUBLICATION_NOT_MINE': EXIT_NOT_FOUND, 'NOT_FOUND': EXIT_NOT_FOUND,
    'POC_CARD_UNAVAILABLE': EXIT_STATE, 'POC_AGENT_NOT_ENABLED': EXIT_STATE, 'POC_ME_RATE_LIMIT': EXIT_LIMITED,
    'POC_INVOKE_RATE_LIMIT': EXIT_LIMITED, 'POC_NEXUS_UNREACHABLE': EXIT_UNAVAILABLE,
}
WRITE_LABEL = {'login': '登录应用', 'logout': '删除本机的会话', 'connect': '把你的 Nexus 身份连接到应用', 'disconnect': '断开应用里的 Nexus 连接',
               'enable': '启用', 'disable': '停用', 'invoke': '调用测试（每次约 0.05 美元，记在发布者名下）'}


def redact(text):
    return SECRET_RE.sub('[已隐藏]', str(text))


class CliError(Exception):
    def __init__(self, exit_code, message, code=None):
        super().__init__(message)
        self.exit_code, self.message, self.code = exit_code, message, code


def exit_for(status, code):
    if code in CODE_EXIT:
        return CODE_EXIT[code]
    if status == 401:
        return EXIT_RELOGIN
    if status == 403:
        return EXIT_REJECTED
    if status == 404:
        return EXIT_NOT_FOUND
    if status == 409:
        return EXIT_STATE
    if status == 429:
        return EXIT_LIMITED
    if status >= 500:
        return EXIT_UNAVAILABLE
    return EXIT_USAGE


def split_globals(argv):
    flags, rest, index = {'yes': False, 'json': False, 'profile': 'default'}, [], 0
    while index < len(argv):
        arg = argv[index]
        if arg == '--yes':
            flags['yes'] = True
        elif arg == '--json':
            flags['json'] = True
        elif arg == '--profile' and index + 1 < len(argv):
            flags['profile'] = argv[index + 1]
            index += 1
        elif arg.startswith('--profile='):
            flags['profile'] = arg.split('=', 1)[1]
        else:
            rest.append(arg)
        index += 1
    return flags, rest


def read_secret(stream, label):
    if stream is None or stream.isatty():
        raise CliError(EXIT_USAGE, '%s要经标准输入传入，例如：… < key.txt' % label, 'secret_not_on_stdin')
    value = stream.readline().strip()
    if not value:
        raise CliError(EXIT_USAGE, '标准输入里没有读到%s。' % label, 'secret_empty')
    return value


class Store:
    def __init__(self, home):
        self.home = Path(home)
        self.path = self.home / 'credentials.json'

    def read(self):
        try:
            data = json.loads(self.path.read_text('utf-8'))
        except FileNotFoundError:
            return {'version': 1, 'profiles': {}}
        except (OSError, ValueError):
            raise CliError(EXIT_RELOGIN, '本机的会话文件 %s 已损坏，请重新登录。' % self.path, 'credentials_corrupt')
        if not isinstance(data, dict) or not isinstance(data.get('profiles'), dict):
            raise CliError(EXIT_RELOGIN, '本机的会话文件 %s 已损坏，请重新登录。' % self.path, 'credentials_corrupt')
        return data

    def write(self, data):
        self.home.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.home, 0o700)
        fd, tmp = tempfile.mkstemp(dir=str(self.home), prefix='.credentials.')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as handle:
                json.dump(data, handle, ensure_ascii=False, indent=2)
            os.chmod(tmp, 0o600)
            os.replace(tmp, str(self.path))
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def profile(self, name):
        return self.read()['profiles'].get(name)

    def save_profile(self, name, record):
        data = self.read()
        data['profiles'][name] = record
        self.write(data)

    def drop_profile(self, name):
        data = self.read()
        removed = data['profiles'].pop(name, None) is not None
        self.write(data)
        return removed


class App:
    def __init__(self, origin, cookie=None, csrf=None, timeout=120):
        self.origin, self.cookie, self.csrf, self.timeout = origin, cookie, csrf, timeout

    def request(self, method, path, body=None):
        headers = {'Accept': 'application/json'}
        data = None
        if body is not None:
            data = json.dumps(body).encode('utf-8')
            headers['Content-Type'] = 'application/json'
        if method != 'GET':
            headers['Origin'] = self.origin
        if self.cookie:
            headers['Cookie'] = self.cookie
        if self.csrf and method != 'GET':
            headers['X-CSRF-Token'] = self.csrf
        req = urllib.request.Request(self.origin + '/api/analysis/v1' + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                status, raw, cookies = resp.status, resp.read(), resp.headers.get_all('Set-Cookie') or []
        except urllib.error.HTTPError as err:
            status, raw, cookies = err.code, err.read(), err.headers.get_all('Set-Cookie') or []
        except (urllib.error.URLError, OSError) as err:
            raise CliError(EXIT_UNAVAILABLE, '连不上应用 %s：%s' % (self.origin, getattr(err, 'reason', err)), 'network_error')
        for value in cookies:
            if value.startswith('jiuan_analysis='):
                self.cookie = value.split(';', 1)[0]
        try:
            payload = json.loads(raw.decode('utf-8') or 'null')
        except ValueError:
            payload = None
        if status >= 400:
            error = (payload or {}).get('error') or {}
            code = error.get('code')
            raise CliError(exit_for(status, code), '%s（%s）' % (error.get('message') or 'HTTP %d' % status, code or status), code)
        return (payload or {}).get('data')


class Context:
    def __init__(self, flags, args, env, stdin, stdout):
        self.flags, self.args, self.stdin, self.stdout = flags, args, stdin, stdout
        self.store = Store(env.get('AGENT_ACCESS_HOME') or os.path.join(os.path.expanduser('~'), '.agent-access'))
        self.profile = flags['profile']

    def emit(self, data, text):
        self.stdout.write(redact(json.dumps(data, ensure_ascii=False, indent=2) if self.flags['json'] else text) + '\n')

    def confirm(self, action):
        if not self.flags['yes']:
            raise CliError(EXIT_CONFIRM, '将要执行：%s。用户确认后加 --yes 重新运行。' % action, 'confirmation_required')

    def app(self):
        record = self.store.profile(self.profile)
        if not record:
            raise CliError(EXIT_RELOGIN, '还没有登录：先运行 login。', 'not_logged_in')
        if record.get('expiresAt', 0) <= time.time():
            raise CliError(EXIT_RELOGIN, '会话已过期：重新运行 login。', 'session_expired')
        return App(record['origin'], record.get('cookie'), record.get('csrf')), record


def group_of(publication):
    enablement = publication.get('enablement')
    if enablement and enablement.get('status') != 'active':
        return 'problem'
    if publication.get('listed') is not False and (publication.get('status') != 'active' or (publication.get('a2a') or {}).get('enabled') is False
                                                   or ((publication.get('card') or {}).get('error'))):
        return 'problem'
    return 'enabled' if enablement else 'pending'


def summary(view):
    connection = view.get('connection') or {}
    lines = ['接口：%s' % view.get('interfaceVersion', '—'), '连接：%s' % connection.get('status', '—')]
    if connection.get('nexusUser'):
        lines.append('Nexus 账号：%s（%s）' % (connection['nexusUser'].get('name'), connection['nexusUser'].get('role')))
    for name, label in (('pending', '待启用'), ('enabled', '已启用'), ('problem', '有问题')):
        items = [p for p in view.get('publications') or [] if group_of(p) == name]
        lines.append('%s（%d）：%s' % (label, len(items), '、'.join('%s %s' % (p['publishId'], p.get('displayName', '')) for p in items) or '—'))
    lines.append('系统提供：%s' % ('、'.join(s['publishId'] for s in view.get('system') or []) or '—'))
    return '\n'.join(lines)


def cmd_login(ctx):
    if ctx.args.client not in CLIENTS:
        raise CliError(EXIT_USAGE, '--client 只能是 %s 之一。' % ' / '.join(CLIENTS), 'client_invalid')
    origin = ctx.args.origin.rstrip('/')
    ctx.confirm('%s：以 %s 登录 %s' % (WRITE_LABEL['login'], ctx.args.account, origin))
    password = read_secret(ctx.stdin, '口令')
    app = App(origin)
    ticket = (app.request('POST', '/poc/login', {'account': ctx.args.account, 'password': password}) or {}).get('ticket')
    app.request('POST', '/auth/exchange', {'ticket': ticket})
    session = app.request('GET', '/session') or {}
    ctx.store.save_profile(ctx.profile, {'origin': origin, 'account': ctx.args.account, 'client': ctx.args.client, 'cookie': app.cookie,
                                         'csrf': session.get('csrfToken', ''), 'expiresAt': int(time.time()) + SESSION_SECONDS})
    ctx.emit({'ok': True, 'profile': ctx.profile, 'origin': origin, 'account': ctx.args.account}, '已登录 %s（%s），会话 8 小时内有效。' % (origin, ctx.args.account))
    return EXIT_OK


def cmd_logout(ctx):
    ctx.confirm(WRITE_LABEL['logout'])
    removed = ctx.store.drop_profile(ctx.profile)
    ctx.emit({'ok': True, 'removed': removed}, '已删除本机的会话。' if removed else '这个 profile 没有保存的会话。')
    return EXIT_OK


def cmd_status(ctx):
    app, _ = ctx.app()
    view = app.request('GET', '/poc/nexus/me')
    ctx.emit(view, summary(view))
    return EXIT_OK


def cmd_refresh(ctx):
    app, _ = ctx.app()
    view = app.request('POST', '/poc/nexus/me/refresh', {})
    ctx.emit(view, summary(view))
    return EXIT_OK


def cmd_agents(ctx):
    app, _ = ctx.app()
    view = app.request('GET', '/poc/nexus/me')
    items = [p for p in view.get('publications') or [] if not ctx.args.state or group_of(p) == ctx.args.state]
    ctx.emit({'items': items}, '\n'.join('%s  %s  %s' % (group_of(p), p['publishId'], p.get('displayName', '')) for p in items) or '没有符合条件的发布。')
    return EXIT_OK


def cmd_nexus(ctx):
    connect = ctx.args.nexus_command == 'connect'
    ctx.confirm(WRITE_LABEL['connect' if connect else 'disconnect'])   # 先确认、再检查登录：没加 --yes 时一律退出码 9
    app, record = ctx.app()
    if connect:
        view = app.request('POST', '/poc/nexus/me/connect', {'apiKey': read_secret(ctx.stdin, 'API 密钥'), 'client': record.get('client', 'cli')})
    else:
        view = app.request('POST', '/poc/nexus/me/disconnect', {'client': record.get('client', 'cli')})
    ctx.emit(view, summary(view))
    return EXIT_OK


def cmd_enable(ctx):
    cost = '' if ctx.args.no_capabilities else '，并读一次能力清单（约 0.03 美元）'
    ctx.confirm('%s %s%s' % (WRITE_LABEL['enable'], ctx.args.publish_id, cost))
    app, record = ctx.app()
    body = {'loadCapabilities': not ctx.args.no_capabilities, 'client': record.get('client', 'cli')}
    if ctx.args.key_stdin:
        body['token'] = read_secret(ctx.stdin, '调用密钥')
    publication = app.request('POST', '/poc/nexus/me/agents/%s/enable' % ctx.args.publish_id, body)
    enablement = publication.get('enablement') or {}
    ctx.emit(publication, '已启用 %s：指纹 %s，能力清单 %s。' % (publication.get('displayName'), enablement.get('fingerprint'), enablement.get('capabilitiesVersion') or '没有读到'))
    return EXIT_OK


def cmd_disable(ctx):
    ctx.confirm('%s %s' % (WRITE_LABEL['disable'], ctx.args.publish_id))
    app, record = ctx.app()
    view = app.request('POST', '/poc/nexus/me/agents/%s/disable' % ctx.args.publish_id, {'client': record.get('client', 'cli')})
    ctx.emit(view, '已停用 %s。' % ctx.args.publish_id)
    return EXIT_OK


def cmd_invoke(ctx):
    ctx.confirm('%s：%s' % (WRITE_LABEL['invoke'], ctx.args.publish_id))
    app, _ = ctx.app()
    if ctx.args.task:
        raw = ctx.args.input or '{}'
        text = Path(raw).read_text('utf-8') if os.path.isfile(raw) else raw
        try:
            task_input = json.loads(text)
        except ValueError:
            raise CliError(EXIT_USAGE, '--input 要是 JSON 串或 JSON 文件。', 'input_invalid')
        if not isinstance(task_input, dict):
            raise CliError(EXIT_USAGE, '--input 要是一个 JSON 对象。', 'input_invalid')
        message = json.dumps({'task': ctx.args.task, 'input': task_input}, ensure_ascii=False)
    else:
        message = ctx.args.text
    attachments = [{'name': os.path.basename(f), 'type': '', 'data': base64.b64encode(Path(f).read_bytes()).decode('ascii')} for f in ctx.args.attach]
    body = {'publishId': ctx.args.publish_id, 'mode': 'text', 'text': message}
    if attachments:
        body['attachments'] = attachments
    run_id = (app.request('POST', '/poc/nexus/invoke', body) or {}).get('runId')
    if not ctx.args.wait:
        ctx.emit({'runId': run_id}, '已发起 %s，稍后用 run %s 查看结果。' % (run_id, run_id))
        return EXIT_OK
    deadline = time.time() + ctx.args.timeout
    while True:
        run = app.request('GET', '/poc/nexus/runs/%s' % run_id)
        if run.get('status') != 'running':
            ctx.emit(run, '结果：%s，用时 %s 毫秒\n%s' % (run.get('status'), run.get('latencyMs'), run.get('rawText') or run.get('errorCode') or ''))
            return EXIT_OK if run.get('status') == 'ok' else EXIT_STATE
        if time.time() > deadline:
            raise CliError(EXIT_STATE, '等了 %d 秒还没结束，稍后用 run %s 查看。' % (ctx.args.timeout, run_id), 'wait_timeout')
        time.sleep(3)


def cmd_runs(ctx):
    app, _ = ctx.app()
    page = app.request('GET', '/poc/nexus/runs?limit=%d' % max(1, min(50, ctx.args.limit)))
    items = page.get('items') or []
    ctx.emit(page, '\n'.join('%s  %s  %s  %s' % (r.get('id'), r.get('publishId'), r.get('task'), r.get('status')) for r in items) or '还没有调用记录。')
    return EXIT_OK


def cmd_run(ctx):
    app, _ = ctx.app()
    run = app.request('GET', '/poc/nexus/runs/%s' % ctx.args.run_id)
    ctx.emit(run, '%s  %s\n%s' % (run.get('status'), run.get('errorCode') or '', run.get('rawText') or ''))
    return EXIT_OK


def build_parser():
    parser = argparse.ArgumentParser(prog='agent_access.py', description='把 Nexus 上的 Agent 接入实现了 agent-access-v1 的应用。全局选项 --yes / --json / --profile 可以写在任何位置。')
    sub = parser.add_subparsers(dest='command', required=True)
    login = sub.add_parser('login', help='登录应用（口令只经标准输入）')
    login.add_argument('--origin', required=True)
    login.add_argument('--account', required=True)
    login.add_argument('--password-stdin', action='store_true', required=True)
    login.add_argument('--client', default='cli')
    for name in ('logout', 'status', 'refresh'):
        sub.add_parser(name)
    nexus = sub.add_parser('nexus', help='连接或断开你的 Nexus 身份')
    nexus_sub = nexus.add_subparsers(dest='nexus_command', required=True)
    nexus_sub.add_parser('connect', help='API 密钥只经标准输入')
    nexus_sub.add_parser('disconnect')
    agents = sub.add_parser('agents')
    agents.add_argument('--state', choices=('pending', 'enabled', 'problem'))
    enable = sub.add_parser('enable', help='启用；不带 --key-stdin 时用已保存的密钥重新验证')
    enable.add_argument('publish_id')
    enable.add_argument('--key-stdin', action='store_true')
    enable.add_argument('--no-capabilities', action='store_true')
    disable = sub.add_parser('disable')
    disable.add_argument('publish_id')
    invoke = sub.add_parser('invoke')
    invoke.add_argument('publish_id')
    group = invoke.add_mutually_exclusive_group(required=True)
    group.add_argument('--text')
    group.add_argument('--task')
    invoke.add_argument('--input')
    invoke.add_argument('--attach', action='append', default=[])
    invoke.add_argument('--wait', action='store_true')
    invoke.add_argument('--timeout', type=int, default=300)
    runs = sub.add_parser('runs')
    runs.add_argument('--limit', type=int, default=20)
    run = sub.add_parser('run')
    run.add_argument('run_id')
    return parser


HANDLERS = {'login': cmd_login, 'logout': cmd_logout, 'status': cmd_status, 'refresh': cmd_refresh, 'agents': cmd_agents, 'nexus': cmd_nexus,
            'enable': cmd_enable, 'disable': cmd_disable, 'invoke': cmd_invoke, 'runs': cmd_runs, 'run': cmd_run}


def main(argv=None, env=None, stdin=None, stdout=None, stderr=None):
    env = os.environ if env is None else env
    stdin, stdout, stderr = stdin or sys.stdin, stdout or sys.stdout, stderr or sys.stderr
    flags, rest = split_globals(list(sys.argv[1:] if argv is None else argv))
    try:
        args = build_parser().parse_args(rest)
    except SystemExit as exit_:
        return int(exit_.code or 0)
    ctx = Context(flags, args, env, stdin, stdout)
    try:
        return HANDLERS[args.command](ctx)
    except CliError as err:
        if flags['json']:
            stdout.write(redact(json.dumps({'ok': False, 'error': {'code': err.code, 'message': err.message}, 'exitCode': err.exit_code}, ensure_ascii=False)) + '\n')
        else:
            stderr.write(redact(err.message) + '\n')
        return err.exit_code
    except KeyboardInterrupt:
        return 130


if __name__ == '__main__':
    sys.exit(main())
