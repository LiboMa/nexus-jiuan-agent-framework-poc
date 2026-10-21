#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""nexus-ai-operator 接入包命令行：让第三方 Agent（Claude Code / Codex / Cursor / Kiro …）代表用户操作 Nexus-AI 平台。

设计要点（规格 docs/superpowers/specs/2026-10-07-v0328-agent-mode-design.md §5）：

- 通用：不内置任何业务模块或业务端点。只认三类协议性接口——连接（/api/v2/connect/*）、能力发现
  （/api/v2/capabilities*）、会话流；业务操作一律经 `call METHOD PATH`，操作清单与风险等级来自发现接口，
  所以平台模块增减不需要更新本文件。
- 凭证：用户交给 Agent 的是「连接密钥」（长期身份）。第一次 login 时平台就把它换成新的（对话里那串随即作废），
  CLI 用新的连接密钥换取短期「访问密钥」（默认 60 分钟），之后自动续期、定期轮换；Agent 不再接触任何密钥。
- 只用 Python 3.9+ 标准库；macOS / Linux 可用，Windows 尽力而为（文件锁用 msvcrt，没有则降级为不加锁）。
- 任何 stdout / stderr 输出都经统一脱敏器；人类可读输出用中文，--json 输出的字段名用英文；退出码见 EXIT_*。

配置目录默认 ~/.nexus/（环境变量 NEXUS_HOME 可覆盖）：credentials.json（0600，目录 0700）、.lock（文件锁）、cache/。
"""
import argparse
import contextlib
import datetime as _dt
import email.utils
import hashlib
import http.client
import io
import ipaddress
import json
import os
import platform as _platform
import re
import shutil
import socket
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

try:  # POSIX 文件锁
    import fcntl  # type: ignore
except ImportError:  # pragma: no cover - Windows
    fcntl = None  # type: ignore
try:  # Windows 文件锁
    import msvcrt  # type: ignore
except ImportError:
    msvcrt = None  # type: ignore

CLI_VERSION = "1.1.0"
SUPPORTED_DISCOVERY_VERSION = 1
USER_AGENT = "nexus-ai-operator/%s (python/%s; %s)" % (
    CLI_VERSION, _platform.python_version(), _platform.system() or "unknown")

# ---------------------------------------------------------------------------------------------- 退出码（规格 §5.3）
EXIT_OK = 0
EXIT_USAGE = 2          # 用法错误（参数不对、请求体不合法）
EXIT_RECONNECT = 3      # 需要重新连接（连接密钥 / 访问密钥失效、还没连接）
EXIT_FORBIDDEN = 4      # 权限不足
EXIT_NOT_FOUND = 5      # 不存在
EXIT_CONFLICT = 6       # 冲突或忙（含等待超时、会话一直忙）
EXIT_LIMITED = 7        # 额度或限流
EXIT_PLATFORM = 8       # 平台错误 / 不可用（含网络不通）
EXIT_CONFIRM = 9        # 需要用户确认（写操作缺 --yes，高风险缺 --confirm-destructive）
EXIT_INTERRUPTED = 130  # 被 Ctrl-C 中断

# ---------------------------------------------------------------------------------------------- 协议性接口（只有这三类）
TOKEN_PATH = "/api/v2/connect/token"
REVOKE_PATH = "/api/v2/connect/revoke"
CAPABILITIES_PATH = "/api/v2/capabilities"
# 账号密码方式（只作兼容）：普通登录 → 建连接 → 立即兑换，随后丢弃密码与登录令牌
LOGIN_PATH = "/api/v2/auth/login"
MFA_VERIFY_PATH = "/api/v2/auth/mfa/verify"
CONNECTIONS_PATH = "/api/v2/agent-connections"
# 会话流（chat 命令）：建会话 → 发消息并流式接收 → 断线续播 → 流过期时读会话历史
AGENT_SESSIONS_PATH = "/api/v2/agents/{agent_id}/sessions"
SESSION_STREAM_PATH = "/api/v2/sessions/{session_id}/stream"
SESSION_EVENTS_PATH = "/api/v2/sessions/{session_id}/stream/events"
SESSION_STATUS_PATH = "/api/v2/sessions/{session_id}/stream/status"
SESSION_MESSAGES_PATH = "/api/v2/sessions/{session_id}/messages"

CONNECTION_KEY_PREFIX = "nxc_"
ACCESS_KEY_PREFIX = "nxp_"
CLIENT_KINDS = ("claude_code", "codex", "cursor", "kiro", "other")
DEFAULT_PROFILE = "default"
PROFILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$")

DEFAULT_HTTP_TIMEOUT = 60.0
RENEW_BEFORE_SECONDS = 300.0       # 访问密钥剩余不足 5 分钟就续期（有效期很短时按 1/4 有效期，见 renew_threshold）
LOCK_TIMEOUT_SECONDS = 30.0
MAX_BODY_BYTES = 64 * 1024 * 1024
MAX_ERROR_BODY_BYTES = 1024 * 1024
MAX_SSE_LINE_BYTES = 4 * 1024 * 1024
MAX_SSE_FRAME_BYTES = 8 * 1024 * 1024
MAX_STREAM_EVENTS = 10000          # call --json 收集流式事件的上限（超出只计数）
REDACTED = "[已隐藏]"
WEB_CONNECTIONS_PAGE = "「个人设置 › API 密钥」"       # 用户生成 / 停用连接密钥的网页位置（界面上叫「API 密钥」）


# ---------------------------------------------------------------------------------------------- 脱敏
# 平台签发的各类密钥（连接密钥即网页上的 API 密钥、访问密钥、应用 API Key、安装令牌、密钥库令牌）都以 nx?_ 开头；
# 登录令牌 / 挑战令牌是 JWT。两者在任何输出里都替换为「[已隐藏]」。
_SECRET_PATTERNS = (
    re.compile(r"(?<![A-Za-z0-9])nx[cpaeik]_[A-Za-z0-9_\-]*"),
    re.compile(r"eyJ[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]*"),
    re.compile(r"(?<![A-Za-z0-9_\-.])[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{16,}"),
)
_BEARER_RE = re.compile(r"(?i)\b(bearer)(\s+)(?!\[已隐藏\])[^\s\"',;]+")
# 打印请求体 / 响应体时，这些字段的字符串值一律替换为 ***（分页游标类 *_token 除外）
_SENSITIVE_KEY_RE = re.compile(
    r"(?i)^(?:.*[_\-])?(?:password|passwd|secret|token|api[_\-]?key|access[_\-]?key|connection[_\-]?key|"
    r"private[_\-]?key|secret[_\-]?key|credential|credentials|authorization|cookie)$")
_CURSOR_KEY_RE = re.compile(r"(?i)^(?:next|page|continuation|cursor|start)[_\-]?token$")


def redact_text(text: Any) -> str:
    """把字符串里的密钥 / 形似 JWT 的串 / Bearer 凭证替换为 [已隐藏]。"""
    if text is None:
        return ""
    if not isinstance(text, str):
        text = str(text)
    if not text:
        return text
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub(REDACTED, text)
    return _BEARER_RE.sub(lambda m: m.group(1) + m.group(2) + REDACTED, text)


_CAMEL_RE = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")


def _is_sensitive_key(key: Any) -> bool:
    """字段名是否敏感：snake / kebab / camelCase 都认（clientSecret、accessToken、SecretAccessKey …）。"""
    if not isinstance(key, str):
        return False
    snake = _CAMEL_RE.sub("_", key)
    return any(bool(_SENSITIVE_KEY_RE.match(k)) and not _CURSOR_KEY_RE.match(k) for k in {key, snake})


def mask_sensitive(value: Any) -> Any:
    """深拷贝 JSON 结构，把敏感字段（password / secret / token / api_key …）的非空字符串值换成 ***。"""
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if _is_sensitive_key(key) and isinstance(item, str) and item:
                out[key] = "***"
            else:
                out[key] = mask_sensitive(item)
        return out
    if isinstance(value, list):
        return [mask_sensitive(item) for item in value]
    return value


class StreamRedactor:
    """流式输出的脱敏：密钥可能被切在两个分片之间，所以尾部「可能属于一串令牌」的字符先扣住，
    等到下一个分隔字符或流结束再放出。"""

    # 尾部可能属于一串令牌：令牌字符；或「Bearer 」本身（令牌在下一个分片里）
    _TAIL_RE = re.compile(r"(?i)(?:\bbearer\s*)?[A-Za-z0-9_\-.]*$")
    _MAX_HOLD = 4096

    def __init__(self, write) -> None:
        self._write = write
        self._buf = ""

    def feed(self, text: str) -> None:
        if not text:
            return
        self._buf += text
        match = self._TAIL_RE.search(self._buf)
        if match and len(self._buf) - match.start() <= self._MAX_HOLD:
            emit, self._buf = self._buf[:match.start()], self._buf[match.start():]
        else:
            emit, self._buf = self._buf, ""
        if emit:
            self._write(redact_text(emit))

    def flush(self) -> None:
        if self._buf:
            self._write(redact_text(self._buf))
            self._buf = ""


class _RedactingWriter:
    """包住 sys.stdout / sys.stderr：所有写入（含 argparse 报错、未捕获异常）都先过脱敏器。"""

    def __init__(self, raw) -> None:
        self._raw = raw

    def write(self, text) -> int:
        self._raw.write(redact_text(text))
        return len(text) if isinstance(text, str) else 0

    def flush(self) -> None:
        with contextlib.suppress(Exception):
            self._raw.flush()

    def isatty(self) -> bool:
        try:
            return bool(self._raw.isatty())
        except Exception:  # noqa: BLE001
            return False

    def fileno(self) -> int:
        return self._raw.fileno()

    @property
    def encoding(self) -> str:
        return getattr(self._raw, "encoding", None) or "utf-8"

    def __getattr__(self, name):
        return getattr(self._raw, name)


def _install_redacting_streams() -> None:
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name)
        if isinstance(stream, _RedactingWriter):
            continue
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            with contextlib.suppress(Exception):
                reconfigure(encoding="utf-8", errors="replace")
        setattr(sys, name, _RedactingWriter(stream))


def _write(stream, text: str) -> None:
    stream.write(redact_text(text))
    with contextlib.suppress(Exception):
        stream.flush()


# ---------------------------------------------------------------------------------------------- 输出与错误
class CliError(Exception):
    """带退出码的失败：main() 统一打印（已脱敏）并以 exit_code 退出。"""

    def __init__(self, exit_code: int, message: str, *, code: Optional[str] = None, hint: Optional[str] = None,
                 http_status: Optional[int] = None, extra: Optional[dict] = None) -> None:
        super().__init__(message)
        self.exit_code = exit_code
        self.message = message
        self.code = code
        self.hint = hint
        self.http_status = http_status
        self.extra = extra or {}

    def to_json(self) -> dict:
        error: Dict[str, Any] = {"code": self.code, "message": self.message}
        if self.hint:
            error["hint"] = self.hint
        if self.http_status is not None:
            error["http_status"] = self.http_status
        out: Dict[str, Any] = {"ok": False, "exit_code": self.exit_code, "error": error}
        out.update(self.extra)
        return out


class Ui:
    """输出通道：人类可读正文 → stdout；过程提示 / 警告 → stderr；--json 时 stdout 只有一个 JSON 文档。"""

    def __init__(self, json_mode: bool) -> None:
        self.json_mode = json_mode

    def say(self, text: str = "") -> None:
        if not self.json_mode:
            _write(sys.stdout, text + "\n")

    def note(self, text: str) -> None:
        _write(sys.stderr, text + "\n")

    def emit(self, obj: Any) -> None:
        _write(sys.stdout, json.dumps(obj, ensure_ascii=False, indent=2) + "\n")

    def fail(self, err: CliError) -> None:
        if self.json_mode:
            self.emit(err.to_json())
            return
        lines = ["错误：" + err.message]
        if err.hint:
            lines.append("提示：" + err.hint)
        self.note("\n".join(lines))


def _sleep_scale() -> float:
    """内部用：测试把所有等待按比例缩短（NEXUS_CLI_SLEEP_SCALE，默认 1）。"""
    try:
        value = float(os.environ.get("NEXUS_CLI_SLEEP_SCALE", "1") or 1)
    except ValueError:
        return 1.0
    return value if 0 <= value <= 10 else 1.0


def _sleep(seconds: float) -> None:
    if seconds > 0:
        time.sleep(seconds * _sleep_scale())


def _deadline(seconds: float) -> float:
    """「再等 seconds 秒」的截止时刻（单调时钟；与 _sleep 同一缩放）。"""
    return time.monotonic() + max(0.0, seconds) * max(_sleep_scale(), 0.001)


def _remaining(deadline: float) -> float:
    """离截止时刻还剩多少「名义秒」（扣除缩放）。"""
    return (deadline - time.monotonic()) / max(_sleep_scale(), 0.001)


def _elapsed(started: float) -> float:
    """自 started（单调时钟）以来经过的「名义秒」。"""
    return (time.monotonic() - started) / max(_sleep_scale(), 0.001)


# ---------------------------------------------------------------------------------------------- 时间
def utcnow() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc)


def parse_time(value: Any) -> Optional[_dt.datetime]:
    """ISO 8601 → aware datetime（UTC）；接受 Z 结尾；无时区按 UTC；解析不了返回 None。"""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text[-1] in "Zz":
        text = text[:-1] + "+00:00"
    try:
        parsed = _dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_dt.timezone.utc)
    return parsed.astimezone(_dt.timezone.utc)


def iso(moment: _dt.datetime) -> str:
    return moment.astimezone(_dt.timezone.utc).isoformat()


def human_duration(seconds: float) -> str:
    seconds = max(0, int(seconds))
    if seconds < 60:
        return "%d 秒" % seconds
    if seconds < 3600:
        return "%d 分钟" % (seconds // 60)
    if seconds < 86400:
        return "%d 小时 %d 分钟" % (seconds // 3600, (seconds % 3600) // 60)
    return "%d 天" % (seconds // 86400)


def local_time_text(value: Any) -> str:
    moment = parse_time(value)
    if moment is None:
        return "—"
    return moment.astimezone().strftime("%Y-%m-%d %H:%M")


# ---------------------------------------------------------------------------------------------- 本地存储
def nexus_home() -> Path:
    raw = os.environ.get("NEXUS_HOME", "").strip()
    return Path(raw).expanduser() if raw else Path.home() / ".nexus"


def _chmod_quiet(path: Path, mode: int) -> None:
    if os.name != "posix":
        return  # Windows：权限位没有意义，尽力而为
    with contextlib.suppress(OSError):
        os.chmod(str(path), mode)


def ensure_private_dir(path: Path) -> Path:
    """建目录并收紧为 0700。目录属于别的用户时拒绝使用：属主能替换里面的凭证与驱动风险闸的发现缓存。"""
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name == "posix":
        try:
            st = path.stat()
        except OSError:
            return path
        if st.st_uid != os.getuid():
            raise CliError(EXIT_USAGE, "配置目录 %s 不属于当前用户，不能用来存放凭证。" % path, code="home_not_owned",
                           hint="把环境变量 NEXUS_HOME 指向自己拥有的目录（缺省 ~/.nexus）。")
        if (st.st_mode & 0o777) != 0o700:
            _chmod_quiet(path, 0o700)
    return path


def _fsync_dir(path: Path) -> None:
    """os.replace 之后把目录项落盘（POSIX；断电后不丢刚写的新连接密钥）。"""
    if os.name != "posix":
        return
    with contextlib.suppress(OSError):
        fd = os.open(str(path), os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def write_private_json(path: Path, data: Any) -> None:
    """原子写（同目录临时文件 → fsync → os.replace → fsync 目录），文件权限 0600。"""
    ensure_private_dir(path.parent)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=".json", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        _chmod_quiet(Path(tmp), 0o600)
        os.replace(tmp, str(path))
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise
    _chmod_quiet(path, 0o600)
    _fsync_dir(path.parent)


class FileLock:
    """~/.nexus/.lock 上的排他锁（fcntl / msvcrt；都没有或文件系统不支持时降级为不加锁）。"""

    def __init__(self, path: Path, timeout: float = LOCK_TIMEOUT_SECONDS) -> None:
        self.path = path
        self.timeout = timeout
        self._fd: Optional[int] = None
        self._locked = False

    def __enter__(self) -> "FileLock":
        ensure_private_dir(self.path.parent)
        self._fd = os.open(str(self.path), os.O_RDWR | os.O_CREAT, 0o600)
        _chmod_quiet(self.path, 0o600)
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                if fcntl is not None:
                    fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                elif msvcrt is not None:  # pragma: no cover - Windows
                    msvcrt.locking(self._fd, msvcrt.LK_NBLCK, 1)
                self._locked = fcntl is not None or msvcrt is not None
                return self
            except (BlockingIOError, PermissionError, InterruptedError):
                if time.monotonic() >= deadline:
                    self._close()
                    # 不提示删锁文件：flock 随进程释放，超时一定说明还有活着的持锁者，删掉会造成两个持锁者
                    raise CliError(EXIT_CONFLICT, "等待本地凭证文件锁超时（另一个 nexus.py 进程正在续期或轮换）。",
                                   code="lock_timeout", hint="稍后重试即可。")
                time.sleep(0.05)
            except OSError:
                # 文件系统不支持加锁（如部分网络盘）：尽力而为，不加锁继续（locked=False，调用方据此不做轮换）
                return self

    @property
    def locked(self) -> bool:
        """是否真的持有排他锁（降级为不加锁时为 False）。"""
        return self._locked

    def _close(self) -> None:
        if self._fd is not None:
            with contextlib.suppress(OSError):
                os.close(self._fd)
            self._fd = None

    def __exit__(self, *exc) -> None:
        if self._fd is not None and self._locked:
            with contextlib.suppress(OSError):
                if fcntl is not None:
                    fcntl.flock(self._fd, fcntl.LOCK_UN)
                elif msvcrt is not None:  # pragma: no cover - Windows
                    msvcrt.locking(self._fd, msvcrt.LK_UNLCK, 1)
        self._close()


class Store:
    """credentials.json：{"version": 1, "profiles": {<profile>: {origin, connection_key, access_key, …}}}。"""

    VERSION = 1

    def __init__(self, home: Path) -> None:
        self.home = home
        self.path = home / "credentials.json"
        self.lock_path = home / ".lock"
        self.cache_root = home / "cache"

    def _read(self, *, tolerant: bool = False) -> dict:
        try:
            raw = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return {"version": self.VERSION, "profiles": {}}
        except OSError as exc:
            raise CliError(EXIT_PLATFORM, "读不了本地凭证文件 %s：%s" % (self.path, exc.strerror or exc),
                           code="credentials_unreadable")
        try:
            data = json.loads(raw)
        except ValueError:
            data = None
        if not isinstance(data, dict) or not isinstance(data.get("profiles"), dict):
            if tolerant:
                return {"version": self.VERSION, "profiles": {}}
            raise CliError(EXIT_RECONNECT, "本地凭证文件 %s 已损坏。" % self.path, code="credentials_corrupt",
                           hint="请重新连接（login）。")
        return data

    def get(self, profile: str) -> Optional[dict]:
        record = self._read()["profiles"].get(profile)
        return dict(record) if isinstance(record, dict) else None

    def put(self, profile: str, record: dict) -> None:
        data = self._read(tolerant=True)
        data["version"] = self.VERSION
        data["profiles"][profile] = record
        write_private_json(self.path, data)

    def delete(self, profile: str) -> bool:
        data = self._read(tolerant=True)
        if profile not in data["profiles"]:
            return False
        del data["profiles"][profile]
        if data["profiles"]:
            write_private_json(self.path, data)
        else:
            with contextlib.suppress(FileNotFoundError):
                self.path.unlink()
        return True

    def lock(self) -> FileLock:
        return FileLock(self.lock_path)

    def cache_dir(self, profile: str) -> Path:
        return self.cache_root / profile

    def ensure_cache_dir(self, profile: str) -> Path:
        """缓存目录逐级收紧为 0700（~/.nexus、cache/、cache/<profile>/）。"""
        for path in (self.home, self.cache_root, self.cache_dir(profile)):
            ensure_private_dir(path)
        return self.cache_dir(profile)

    def clear_cache(self, profile: str) -> None:
        shutil.rmtree(str(self.cache_dir(profile)), ignore_errors=True)


# ---------------------------------------------------------------------------------------------- HTTP
class HttpResponse:
    def __init__(self, status: int, headers: Any, body: bytes = b"", stream: Any = None) -> None:
        self.status = status
        self.headers = headers
        self.body = body
        self.stream = stream            # 流式响应（SSE）时为底层响应对象，调用方负责 close()
        self._json_cache: Any = None
        self._json_done = False

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    def header(self, name: str, default: Optional[str] = None) -> Optional[str]:
        if self.headers is None:
            return default
        value = self.headers.get(name)
        return default if value is None else value

    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")

    def json(self) -> Any:
        if not self._json_done:
            self._json_done = True
            try:
                self._json_cache = json.loads(self.text()) if self.body else None
            except ValueError:
                self._json_cache = None
        return self._json_cache

    def close(self) -> None:
        if self.stream is not None:
            with contextlib.suppress(Exception):
                self.stream.close()
            self.stream = None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """不跟随重定向：urllib 跟随时会把 Authorization 原样带到新地址（可能跨域），宁可报错。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


_OPENER = None


def _opener():
    global _OPENER
    if _OPENER is None:
        cafile = os.environ.get("NEXUS_CA_BUNDLE", "").strip() or None
        context = ssl.create_default_context(cafile=cafile)
        _OPENER = urllib.request.build_opener(_NoRedirect(), urllib.request.HTTPSHandler(context=context))
    return _OPENER


def _network_error(exc: BaseException) -> CliError:
    reason = getattr(exc, "reason", None) or exc
    text = str(reason) or exc.__class__.__name__
    hint = "检查平台地址与网络；平台在维护时请稍后重试。"
    if isinstance(reason, ssl.SSLError) or "CERTIFICATE" in text.upper():
        hint = "TLS 证书校验失败：平台用的是自签证书时，设置环境变量 NEXUS_CA_BUNDLE 指向 CA 证书文件。"
    if isinstance(reason, (socket.timeout, TimeoutError)) or "timed out" in text:
        hint = "请求超时：平台可能繁忙，可稍后重试或用 --timeout 调大单个请求的超时。"
    return CliError(EXIT_PLATFORM, "无法连接平台：%s" % text, code="network_error", hint=hint)


def http_call(method: str, url: str, *, headers: Optional[dict] = None, body: Any = None,
              timeout: float = DEFAULT_HTTP_TIMEOUT, stream: bool = False) -> HttpResponse:
    """发一个请求。非 2xx 也作为 HttpResponse 返回（由调用方映射退出码）；网络错误抛 CliError(8)。"""
    hdrs = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if headers:
        hdrs.update(headers)
    data = None
    if body is not None:
        if isinstance(body, (bytes, bytearray)):
            data = bytes(body)
        else:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            hdrs.setdefault("Content-Type", "application/json")
    request = urllib.request.Request(url, data=data, method=method.upper(), headers=hdrs)
    try:
        resp = _opener().open(request, timeout=timeout)
    except urllib.error.HTTPError as exc:
        try:
            payload = exc.read(MAX_ERROR_BODY_BYTES) or b""
        except Exception:  # noqa: BLE001
            payload = b""
        finally:
            with contextlib.suppress(Exception):
                exc.close()
        return HttpResponse(exc.code, exc.headers, payload)
    except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as exc:
        raise _network_error(exc)
    if stream:
        return HttpResponse(resp.status, resp.headers, b"", stream=resp)
    try:
        payload = resp.read(MAX_BODY_BYTES + 1)
    except (http.client.HTTPException, OSError) as exc:
        raise _network_error(exc)
    finally:
        with contextlib.suppress(Exception):
            resp.close()
    if len(payload) > MAX_BODY_BYTES:
        raise CliError(EXIT_PLATFORM, "平台响应超过 %d MB，已放弃读取。" % (MAX_BODY_BYTES // (1024 * 1024)),
                       code="response_too_large")
    return HttpResponse(resp.status, resp.headers, payload)


def _unwrap(resp: HttpResponse) -> Any:
    """统一外壳 {"success": true, "data": …} → data；没有外壳时原样返回。"""
    body = resp.json()
    if isinstance(body, dict) and "data" in body and ("success" in body or "timestamp" in body):
        return body.get("data")
    return body


def _server_time(resp: HttpResponse) -> Optional[_dt.datetime]:
    body = resp.json()
    if isinstance(body, dict):
        stamp = parse_time(body.get("timestamp"))
        if stamp is not None:
            return stamp
    date = resp.header("Date")
    if date:
        with contextlib.suppress(Exception):
            parsed = email.utils.parsedate_to_datetime(date)
            if parsed is not None:
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=_dt.timezone.utc)
                return parsed.astimezone(_dt.timezone.utc)
    return None


def _retry_after(resp: HttpResponse, default: float, cap: float) -> float:
    raw = resp.header("Retry-After")
    try:
        value = float(raw) if raw is not None else default
    except ValueError:
        value = default
    return max(0.0, min(value, cap))


def _sse_payload(text: str) -> Any:
    try:
        return json.loads(text)
    except ValueError:
        return text


def iter_sse(stream) -> Iterator[Any]:
    """SSE 解析：按空行切帧、拼接 data: 行；data 是 JSON 就解析成对象，否则原样给字符串。

    注释行（: 开头）与其它字段（event: / id: / retry:）忽略——平台把事件类型放在 JSON 的 event / type 里。
    读到 EOF 正常结束；读超时 / 连接被重置时由底层抛出异常（调用方据此断线续播）。"""
    data_lines: List[str] = []
    frame_bytes, oversized = 0, False
    while True:
        raw = stream.readline(MAX_SSE_LINE_BYTES)        # 单行有上限：异常的超长行不会把内存吃光
        if not raw:
            break
        line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
        if line == "":
            if data_lines and not oversized:
                yield _sse_payload("\n".join(data_lines))
            data_lines, frame_bytes, oversized = [], 0, False
            continue
        if line.startswith(":"):
            continue
        name, _sep, value = line.partition(":")
        if name == "data":
            frame_bytes += len(value)
            if frame_bytes > MAX_SSE_FRAME_BYTES:
                oversized, data_lines = True, []         # 超大帧整帧丢弃（不是正常的平台事件）
            elif not oversized:
                data_lines.append(value[1:] if value.startswith(" ") else value)
    if data_lines and not oversized:
        yield _sse_payload("\n".join(data_lines))


# ---------------------------------------------------------------------------------------------- 错误码 → 退出码
_CODE_RE = re.compile(r"^[a-z][a-z0-9_]*(?::[A-Za-z0-9_.,:\-]+)?$")

# 401：连接级失效 → 请用户重新生成连接密钥（退出码 3）
_RECONNECT_LABELS = {
    "connection_key_invalid": "连接密钥无效",
    "connection_key_revoked": "连接密钥已作废",
    "connection_revoked": "这把 API 密钥已被用户停用",
    "connection_expired": "这把 API 密钥因长时间未使用已失效",
    "credential_owner_inactive": "这把 API 密钥所属的账号已不存在",
    "credential_invalid": "访问密钥无效",
    "credential_revoked": "访问密钥已作废",
    "credential_expired": "访问密钥已过期",
    "connection_key_not_accepted": "平台拒绝了这个凭证",
}
_REUSE_CODES = ("connection_key_reused", "connection_suspended")
# 断开时遇到这些码 = 连接本来就已不可用，本地凭证照删
DEAD_CONNECTION_CODES = frozenset(set(_RECONNECT_LABELS) | set(_REUSE_CODES))


def response_detail(resp: HttpResponse) -> Tuple[Optional[str], str]:
    """从 {"detail": …} 取（机器码, 人类可读消息）。detail 可能是码、句子、{code, message} 或校验错误列表。"""
    data = resp.json()
    code: Optional[str] = None
    message = ""
    if isinstance(data, dict):
        detail = data.get("detail", data.get("error"))
        if isinstance(detail, str):
            if _CODE_RE.match(detail):
                code = detail
            else:
                message = detail
        elif isinstance(detail, dict):
            raw_code = detail.get("code") or detail.get("error")
            code = raw_code if isinstance(raw_code, str) else None
            raw_msg = detail.get("message") or detail.get("detail")
            message = raw_msg if isinstance(raw_msg, str) else ""
        elif isinstance(detail, list):
            code = "validation_error"
            parts = []
            for item in detail[:5]:
                if isinstance(item, dict):
                    loc = ".".join(str(x) for x in (item.get("loc") or []))
                    parts.append(("%s：%s" % (loc, item.get("msg", ""))).strip("："))
            message = "；".join(parts)
        if not code and isinstance(data.get("error_code"), str):
            code = data["error_code"]
        if not message and isinstance(data.get("message"), str):
            message = data["message"]
    elif resp.body:
        message = resp.text().strip()[:300]
    return code, message


def _exit_for_status(status: int) -> int:
    if status in (400, 405, 411, 413, 414, 415, 422):
        return EXIT_USAGE
    if status == 401:
        return EXIT_RECONNECT
    if status == 403:
        return EXIT_FORBIDDEN
    if status in (404, 410):
        return EXIT_NOT_FOUND
    if status in (409, 412, 423, 425):
        return EXIT_CONFLICT
    if status in (402, 429):
        return EXIT_LIMITED
    if status == 428:
        return EXIT_CONFIRM
    return EXIT_PLATFORM


def api_error(resp: HttpResponse, *, action: str = "", exchange: bool = False) -> CliError:
    """非 2xx 响应 → CliError（退出码与中文提示）；--json 输出里附带平台的响应体（已脱敏），每种状态码都一样。

    exchange=True 表示这是连接面（/connect/token、/connect/revoke）的响应：只有这里的 404 not_available 才是
    「平台没有开放 API 密钥访问」，业务接口自己的 not_available 不能这么解读。"""
    err = _api_error(resp, action=action, exchange=exchange)
    body = resp.json()
    if body is not None and "response" not in err.extra:
        err.extra["response"] = mask_sensitive(body)
    return err


def _is_credential_401(resp: HttpResponse, code: Optional[str]) -> bool:
    """401 是不是凭证本身的问题：已知的凭证错误码，或带 WWW-Authenticate: Bearer（中间件的凭证错误都带）。
    业务接口自己的 401（如应用访客验证、X-API-Key）两者都没有，不能叫用户重新生成连接密钥。"""
    if code in _RECONNECT_LABELS or code in _REUSE_CODES:
        return True
    return "bearer" in (resp.header("WWW-Authenticate") or "").lower()


def _api_error(resp: HttpResponse, *, action: str = "", exchange: bool = False) -> CliError:
    status = resp.status
    code, message = response_detail(resp)
    where = ("%s：" % action) if action else ""
    if status == 401 and code == "connection_key_reused":
        return CliError(EXIT_RECONNECT, "%s检测到已作废的连接密钥被再次使用（connection_key_reused）。" % where,
                        code=code, http_status=status,
                        hint="如果是把同一段话第二次用来 login，本机原来的连接仍然可用（运行 whoami 查看），不需要处理；"
                             "否则请用户到 Nexus 网页%s查看告警，必要时重新生成连接密钥。" % WEB_CONNECTIONS_PAGE)
    if status == 401 and code in _REUSE_CODES:
        return CliError(EXIT_RECONNECT, "%s已作废的连接密钥曾被再次使用，平台为安全起见暂停了这条连接（%s）。" % (where, code),
                        code=code, http_status=status,
                        hint="请用户到 Nexus 网页%s查看告警并重新生成连接密钥，再把新的交给 Agent 重新 login。"
                             % WEB_CONNECTIONS_PAGE)
    if status == 401 and not _is_credential_401(resp, code):
        return CliError(EXIT_FORBIDDEN, "%s这个接口需要另外的验证（%s）。" % (where, code or message or "HTTP 401"),
                        code=code or "endpoint_auth_required", http_status=status,
                        hint="这不是连接本身的问题，不需要重新生成连接密钥；先用 describe 看这个接口的要求。")
    if status == 401:
        label = _RECONNECT_LABELS.get(code or "", "平台不认这个凭证")
        hint = "请用户在 Nexus 网页%s里重新生成连接密钥，再把新的交给 Agent 重新 login。" % WEB_CONNECTIONS_PAGE
        if code == "credential_invalid":
            hint += "如果所有调用都这样，可能是平台关闭了 API 密钥访问。"
        return CliError(EXIT_RECONNECT, "%s%s（%s）。" % (where, label, code or message or "HTTP 401"),
                        code=code or "unauthorized", http_status=status, hint=hint)
    if status == 403 and code == "credential_forbidden_path":
        return CliError(EXIT_FORBIDDEN, "%s这类操作不允许经 API 密钥进行（credential_forbidden_path）。" % where,
                        code=code, http_status=status,
                        hint="凭证与连接管理、账号安全、对外分享、管理后台等只能由用户本人在网页上完成。")
    if status == 403 and code == "QUOTA_EXCEEDED":
        return CliError(EXIT_LIMITED, "%s本月模型额度已用完（QUOTA_EXCEEDED）。" % where, code=code,
                        http_status=status, hint="请联系管理员调整额度。")
    if exchange and status == 404 and code == "not_available":
        return CliError(EXIT_PLATFORM, "%s这个平台没有开放 API 密钥访问（not_available）。" % where, code=code,
                        http_status=status, hint="请平台管理员开启「API 密钥」功能。")
    if status == 429:
        wait = resp.header("Retry-After")
        return CliError(EXIT_LIMITED, "%s请求太频繁，被平台限流（%s）。" % (where, code or "rate_limited"),
                        code=code or "rate_limited", http_status=status,
                        hint=("请 %s 秒后再试。" % wait) if wait else "请稍后再试。")
    if status == 503 and code == "credential_unavailable":
        return CliError(EXIT_PLATFORM, "%s平台暂时无法校验访问密钥（credential_unavailable）。" % where, code=code,
                        http_status=status, hint="平台数据库暂时异常，请稍后重试。")
    if status == 503 and code == "rate_limit_unavailable":
        return CliError(EXIT_PLATFORM, "%s平台的限流计数暂时不可用（rate_limit_unavailable）。" % where, code=code,
                        http_status=status, hint="请稍后重试。")
    if 300 <= status < 400:
        return CliError(EXIT_PLATFORM, "%s平台返回了重定向（HTTP %d），CLI 不跟随重定向。" % (where, status),
                        code="redirect", http_status=status, hint="请确认平台地址是正式的 https 地址。")
    exit_code = _exit_for_status(status)
    text = message or code or ("HTTP %d" % status)
    if code and message:
        text = "%s（%s）" % (message, code)
    return CliError(exit_code, "%s请求失败：HTTP %d · %s" % (where, status, text), code=code or ("http_%d" % status),
                    http_status=status)


# ---------------------------------------------------------------------------------------------- 平台地址
def _is_loopback(host: str) -> bool:
    """只认真正的本机地址：localhost 与回环 IP（127.0.0.0/8、::1）。127.evil.example 这类域名不算。"""
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def normalize_origin(raw: Optional[str], *, allow_http: bool = False) -> Tuple[str, bool]:
    """平台地址 → scheme://host[:port]。返回（地址, 是否忽略了路径部分）。非本机地址必须 https。"""
    text = (raw or "").strip()
    if not text:
        raise CliError(EXIT_USAGE, "缺少平台地址。", code="origin_required",
                       hint="用 --origin https://<平台地址>（用户给的那段话里有）。")
    if "://" not in text:
        text = "https://" + text
    try:
        parts = urllib.parse.urlsplit(text)
        port = parts.port
    except ValueError:
        raise CliError(EXIT_USAGE, "平台地址格式不对：%s" % raw, code="origin_invalid")
    scheme = (parts.scheme or "").lower()
    host = (parts.hostname or "").lower()
    if scheme not in ("http", "https") or not host or parts.username or parts.password:
        raise CliError(EXIT_USAGE, "平台地址格式不对：%s" % raw, code="origin_invalid",
                       hint="形如 https://nexus.example.com，不要带用户名或密码。")
    if scheme == "http" and not allow_http and not _is_loopback(host):
        raise CliError(EXIT_USAGE, "平台地址必须是 https（只有本机地址可以用 http）。", code="origin_insecure",
                       hint="确需明文 http 时加 --allow-http（不推荐：密钥会明文传输）。")
    netloc = ("[%s]" % host) if ":" in host else host
    if port:
        netloc += ":%d" % port
    dropped = bool((parts.path and parts.path != "/") or parts.query or parts.fragment)
    return "%s://%s" % (scheme, netloc), dropped


def skill_dir() -> Path:
    """本接入包的根目录（scripts/ 的上一级）。"""
    return Path(__file__).resolve().parent.parent


def instance_origin() -> Optional[str]:
    """接入包 config/instance.json 里预置的平台地址（可选）。"""
    path = skill_dir() / "config" / "instance.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    origin = data.get("origin") if isinstance(data, dict) else None
    return origin.strip() if isinstance(origin, str) and origin.strip() else None


# 网页生成 API 密钥时下载的接入包自带：一把还没用过的连接密钥 + 平台地址（平台 skill_package.CONNECTION_FILE 同名同义）。
# 只能用一次：login 用它连接成功（平台已把它换新）后立即删除；不参与内容摘要，自更新时也不保留。
BUNDLED_CONNECTION_FILE = "config/connection.json"
_BUNDLED_CONNECTION_VERSIONS = (None, 1)
# 兑换时遇到这些码 = 随包的那把密钥已经确定用不了了（用过 / 被停用 / 失效）：删掉文件，免得反复出示。
# connection_key_invalid 不算：可能只是 --origin 指错了平台，文件留着换对地址还能用。
_DEAD_BUNDLE_CODES = frozenset({"connection_key_reused", "connection_key_revoked", "connection_revoked",
                                "connection_expired", "connection_suspended", "connection_key_superseded"})
_BUNDLE_DEAD_HINT = "接入包里的 API 密钥已经用过或已被停用：请用户在网页%s重新生成，并把新下载的接入包交给你。"


def bundled_connection_path() -> Path:
    return skill_dir() / BUNDLED_CONNECTION_FILE


def bundled_connection() -> Optional[dict]:
    """接入包 config/connection.json 里附带的连接密钥；没有 / 读不了 / 形态不对 → None（不报错，按没有处理）。"""
    try:
        data = json.loads(bundled_connection_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("version") not in _BUNDLED_CONNECTION_VERSIONS:
        return None
    key = data.get("connection_key")
    key = key.strip() if isinstance(key, str) else ""
    if not _KEY_IN_TEXT_RE.fullmatch(key):
        return None
    origin, cid = data.get("origin"), data.get("connection_id")
    return {"connection_key": key, "origin": origin.strip() if isinstance(origin, str) and origin.strip() else None,
            "connection_id": cid.strip() if isinstance(cid, str) and cid.strip() else None}


def consume_bundled_connection(ui: "Ui") -> bool:
    """删掉随包的密钥文件（密钥已被平台换新或已确定用不了）。删不掉时提示用户手动删，返回 False。"""
    path = bundled_connection_path()
    try:
        path.unlink()
    except FileNotFoundError:
        return True
    except OSError as exc:
        ui.note("提示：没能删除 %s（%s）；里面的密钥已经失效，请手动删除这个文件。" % (path, exc.strerror or exc))
        return False
    return True


def build_url(origin: str, path: str, query: Optional[List[Tuple[str, str]]] = None) -> str:
    """只拼本平台的地址：路径必须以单个 / 开头，不接受完整 URL（访问密钥绝不发往别的地址）。"""
    if not isinstance(path, str) or not path.startswith("/") or path.startswith("//") or "\\" in path \
            or any(ch in path for ch in "\r\n\t "):
        raise CliError(EXIT_USAGE, "路径必须以 / 开头（形如 /api/v2/…），不能是完整网址或含空白字符：%s" % path,
                       code="path_invalid")
    safe_path = urllib.parse.quote(path, safe="/:@!$&'()*+,;=-._~%?")
    url = origin + safe_path
    if query:
        url += ("&" if "?" in safe_path else "?") + urllib.parse.urlencode(query, doseq=True)
    return url


# ---------------------------------------------------------------------------------------------- 连接密钥兑换（规格 §3.6 / §5.4）
class _Superseded(Exception):
    """409 connection_key_superseded：另一个进程刚轮换过连接密钥。"""


class _PartialExchange(Exception):
    """兑换响应里有合法的新连接密钥，但访问密钥那部分不完整：调用方必须先把新连接密钥存下。"""

    def __init__(self, connection_key: str, received: _dt.datetime) -> None:
        super().__init__("partial exchange")
        self.connection_key = connection_key
        self.received = received


def _hostname() -> str:
    with contextlib.suppress(Exception):
        return socket.gethostname()[:80]
    return ""


def client_info(client_kind: Optional[str]) -> dict:
    """兑换时自报的客户端信息（平台只做展示：连接列表里的「最近使用 · 主机名」）。"""
    system = ("%s %s" % (_platform.system(), _platform.release())).strip()
    return {"name": client_kind or "other", "version": CLI_VERSION, "hostname": _hostname(), "os": system[:80]}


def exchange_token(origin: str, connection_key: str, *, rotate: bool, client_kind: Optional[str],
                   timeout: float) -> Tuple[dict, Optional[_dt.datetime], _dt.datetime]:
    """POST /api/v2/connect/token（只带连接密钥）→ (data, 服务端时间, 本地收到时间)。

    429 / 503 rate_limit_unavailable 按 Retry-After 等待后重试（最多 3 次）；409 connection_key_superseded 抛 _Superseded；
    其它失败映射为 CliError。"""
    body = {"rotate": bool(rotate), "client": client_info(client_kind)}
    attempts = 3
    for attempt in range(attempts):
        resp = http_call("POST", origin + TOKEN_PATH, headers={"Authorization": "Bearer " + connection_key},
                         body=body, timeout=timeout)
        received = utcnow()
        if resp.ok:
            data = _unwrap(resp)
            if not isinstance(data, dict):
                raise CliError(EXIT_PLATFORM, "平台返回的兑换结果不完整。", code="token_response_invalid")
            new_key = data.get("connection_key")
            if new_key is not None and (not isinstance(new_key, str) or not new_key.startswith(CONNECTION_KEY_PREFIX)):
                raise CliError(EXIT_PLATFORM, "平台返回的连接密钥格式不对。", code="token_response_invalid")
            if not isinstance(data.get("access_key"), str) or not data["access_key"].startswith(ACCESS_KEY_PREFIX) \
                    or parse_time(data.get("access_key_expires_at")) is None:
                if new_key:
                    raise _PartialExchange(new_key, received)     # 新连接密钥已经生效：交给调用方先存下
                raise CliError(EXIT_PLATFORM, "平台返回的兑换结果不完整。", code="token_response_invalid")
            return data, _server_time(resp), received
        code, _message = response_detail(resp)
        if resp.status == 409 and code == "connection_key_superseded":
            raise _Superseded()
        last = attempt == attempts - 1
        if resp.status == 429 and not last:
            _sleep(_retry_after(resp, 2.0, 30.0))
            continue
        if resp.status == 503 and code == "rate_limit_unavailable" and not last:
            _sleep(2.0 * (attempt + 1))
            continue
        raise api_error(resp, action="连接", exchange=True)
    raise CliError(EXIT_PLATFORM, "连接失败。", code="token_exchange_failed")  # pragma: no cover


_CONNECTION_FIELDS = ("connection_id", "name", "status", "preset", "scopes", "max_role", "client_kind")
_USER_FIELDS = ("user_id", "name", "email", "role")


def apply_exchange(record: dict, data: dict, server_time: Optional[_dt.datetime], received: _dt.datetime) -> dict:
    """把兑换结果并进 profile：只有发生轮换时才换连接密钥；访问密钥、到期时间、轮换建议每次都换。"""
    rec = dict(record)
    if data.get("connection_key"):
        rec["connection_key"] = data["connection_key"]
        rec["connection_key_updated_at"] = iso(received)
    rec["access_key"] = data["access_key"]
    rec["access_key_expires_at"] = data["access_key_expires_at"]
    rec["access_key_received_at"] = iso(received)
    # 本机与平台的时钟差照实记（不设上限：差一天以上时若记 0，每个请求都会判定访问密钥已过期而去兑换）
    skew = (server_time - received).total_seconds() if server_time is not None else 0.0
    rec["clock_skew_seconds"] = round(skew, 3)
    rec["connection_key_rotate_after"] = data.get("connection_key_rotate_after")
    rec["rotate_recommended"] = bool(data.get("rotate_recommended"))
    if not rec["rotate_recommended"]:
        rec.pop("rotate_retry_after", None)
    if data.get("connection_key"):
        rec.pop("rotation_uncertain_at", None)           # 轮换确实成功了
    conn = data.get("connection") if isinstance(data.get("connection"), dict) else {}
    rec["connection_id"] = conn.get("connection_id") or rec.get("connection_id")
    rec["connection"] = {key: conn.get(key) for key in _CONNECTION_FIELDS}
    user = data.get("user") if isinstance(data.get("user"), dict) else {}
    rec["user"] = {key: user.get(key) for key in _USER_FIELDS}
    plat = data.get("platform") if isinstance(data.get("platform"), dict) else {}
    rec["platform"] = {"version": plat.get("version"), "discovery_version": plat.get("discovery_version")}
    rec["updated_at"] = iso(utcnow())
    return rec


def access_remaining(record: dict) -> Optional[float]:
    """访问密钥按服务端时钟还剩多少秒（已扣掉本机与平台的时钟差）。"""
    expires = parse_time(record.get("access_key_expires_at"))
    if expires is None or not record.get("access_key"):
        return None
    skew = float(record.get("clock_skew_seconds") or 0.0)
    return (expires - utcnow()).total_seconds() - skew


def renew_threshold(record: dict) -> float:
    """剩余少于这么多秒就续期：默认 5 分钟；有效期很短时取有效期的 1/4（不少于 5 秒）。"""
    expires = parse_time(record.get("access_key_expires_at"))
    received = parse_time(record.get("access_key_received_at"))
    if expires is not None and received is not None:
        ttl = (expires - received).total_seconds() - float(record.get("clock_skew_seconds") or 0.0)
        if ttl > 0:
            return max(5.0, min(RENEW_BEFORE_SECONDS, ttl * 0.25))
    return RENEW_BEFORE_SECONDS


ROTATE_RETRY_SECONDS = 300.0       # 轮换没成功（访问密钥仍可用）时，隔这么久再试


def needs_exchange(record: dict) -> bool:
    remaining = access_remaining(record)
    if remaining is None or remaining < renew_threshold(record):
        return True
    if record.get("rotate_recommended"):
        retry_at = parse_time(record.get("rotate_retry_after"))
        return retry_at is None or utcnow() >= retry_at
    return False


class Session:
    """一个 profile 的已连接会话：自动续期 / 轮换访问密钥，发业务请求。"""

    def __init__(self, store: Store, profile: str, ui: Ui, http_timeout: float) -> None:
        self.store = store
        self.profile = profile
        self.ui = ui
        self.http_timeout = http_timeout

    def record(self) -> dict:
        rec = self.store.get(self.profile)
        if not rec or not rec.get("origin") or not rec.get("connection_key"):
            hint = ("接入包里附带了 API 密钥：直接运行 login 即可连接。" if bundled_connection() is not None
                    else "先用用户给的平台地址与连接密钥执行 login。")
            raise CliError(EXIT_RECONNECT, "还没有连接 Nexus（profile %s）。" % self.profile, code="not_connected",
                           hint=hint)
        return rec

    def ensure_access(self, *, force: bool = False, rejected_key: Optional[str] = None) -> dict:
        """返回带可用访问密钥的 profile；需要时在文件锁内续期（锁内先重读：别的进程可能刚换过）。"""
        rec = self.record()
        if not force and not needs_exchange(rec):
            return rec
        try:
            with self.store.lock() as lock:
                rec = self.record()
                if force:
                    if rec.get("access_key") != rejected_key and not needs_exchange(rec):
                        return rec
                elif not needs_exchange(rec):
                    return rec
                return self._exchange_locked(rec, can_rotate=lock.locked)
        except CliError as err:
            if err.code != "lock_timeout" or force:
                raise
            # 另一个进程正在续期 / 轮换：当前访问密钥还能用就先用它，下次再续
            current = self.record()
            remaining = access_remaining(current)
            if remaining is not None and remaining > 30 and current.get("access_key"):
                return current
            raise

    def _save(self, rec: dict) -> None:
        """锁内落盘；写不进去时说清后果（平台可能已经换了连接密钥）。"""
        try:
            self.store.put(self.profile, rec)
        except OSError as exc:
            raise CliError(EXIT_PLATFORM, "新的凭证没能保存到本机（%s）。" % (exc.strerror or exc), code="credentials_unwritable",
                           hint="如果这次换了连接密钥，旧的那把会在约 10 分钟后失效、连接被暂停；腾出磁盘空间或修正 %s 的权限后，"
                                "请用户在网页%s重新生成连接密钥再 login。" % (self.store.home, WEB_CONNECTIONS_PAGE))

    def _exchange_locked(self, rec: dict, *, can_rotate: bool = True) -> dict:
        wanted_rotate = bool(rec.get("rotate_recommended"))
        rotate = wanted_rotate and can_rotate
        if rec.get("rotate_recommended") and not can_rotate:
            self.ui.note("提示：本机文件系统不支持加锁，这次先不轮换连接密钥（避免多个进程同时轮换丢失新密钥）。")
        try:
            data, server_time, received = exchange_token(rec["origin"], rec["connection_key"], rotate=rotate,
                                                         client_kind=rec.get("client_kind"),
                                                         timeout=self.http_timeout)
        except _PartialExchange as partial:
            # 平台已经换了连接密钥但访问密钥那部分不完整：先把新连接密钥存下，别让它丢在半路
            self._save(dict(rec, connection_key=partial.connection_key, connection_key_updated_at=iso(partial.received),
                            access_key=None, access_key_expires_at=None, rotate_recommended=False))
            raise CliError(EXIT_PLATFORM, "平台返回的兑换结果不完整（新的连接密钥已保存），请稍后重试。",
                           code="token_response_invalid")
        except CliError as err:
            if not rotate or err.exit_code in (EXIT_RECONNECT, EXIT_FORBIDDEN, EXIT_USAGE):
                raise
            uncertain = err.code == "network_error" or (err.http_status or 0) >= 500
            remaining = access_remaining(rec)
            retry = dict(rec, rotate_retry_after=iso(utcnow() + _dt.timedelta(seconds=ROTATE_RETRY_SECONDS)))
            if uncertain:
                retry["rotation_uncertain_at"] = iso(utcnow())
                self.ui.note("提示：轮换连接密钥的请求没有拿到确定结果（%s）。若平台其实已经完成轮换，本机的旧密钥会在约 10 分钟后"
                             "失效、连接被暂停；届时请用户在网页%s重新生成连接密钥。" % (err.code, WEB_CONNECTIONS_PAGE))
            if remaining is not None and remaining > 60 and rec.get("access_key"):
                self._save(retry)
                self.ui.note("提示：这次没能轮换连接密钥（%s），先继续使用当前访问密钥，稍后自动再试。" % err.code)
                return retry
            self._save(retry)
            raise
        except _Superseded:
            # 另一个进程已轮换过连接密钥：重读本地文件，用文件里的连接密钥重试一次（不再带 rotate）
            again = self.record()
            if again.get("connection_key") == rec.get("connection_key"):
                self.ui.note("提示：这把连接密钥已在别处更换过（同一份凭证可能被复制到了别的机器）；"
                             "本机的这份副本很快会失效，届时需要重新连接。")
            try:
                data, server_time, received = exchange_token(again["origin"], again["connection_key"], rotate=False,
                                                             client_kind=again.get("client_kind"),
                                                             timeout=self.http_timeout)
            except _PartialExchange as partial:
                self._save(dict(again, connection_key=partial.connection_key, access_key=None,
                                access_key_expires_at=None, rotate_recommended=False))
                raise CliError(EXIT_PLATFORM, "平台返回的兑换结果不完整（新的连接密钥已保存），请稍后重试。",
                               code="token_response_invalid")
            except _Superseded:
                raise CliError(EXIT_CONFLICT, "连接密钥刚被另一个进程更换，重试仍冲突。", code="connection_key_superseded",
                               hint="请稍后重试。")
            rec = again
            rotate = False
        updated = apply_exchange(rec, data, server_time, received)
        if updated.get("rotate_recommended") and wanted_rotate and not rotate:
            # 本想轮换却没轮换（不能加锁 / 刚冲突过）：访问密钥还新，别让下一个请求立刻又来兑换。
            # 平台这次才开始建议轮换的情形不在此列：下一个请求照常带 rotate=true 立即轮换
            updated["rotate_retry_after"] = iso(utcnow() + _dt.timedelta(seconds=ROTATE_RETRY_SECONDS))
        self._save(updated)
        return updated

    def request(self, method: str, path: str, *, query: Optional[List[Tuple[str, str]]] = None, body: Any = None,
                headers: Optional[dict] = None, timeout: Optional[float] = None, stream: bool = False) -> HttpResponse:
        """带访问密钥发请求；401 credential_expired / credential_revoked（访问密钥过期，或被每连接上限挤掉）时
        强制续期一次再重试 —— 连接本身失效时续期会以连接级错误码失败（交给调用方映射为退出码 3）。"""
        rec = self.ensure_access()
        resp = self._send(rec, method, path, query, body, headers, timeout, stream)
        if resp.status == 401 and response_detail(resp)[0] in ("credential_expired", "credential_revoked"):
            resp.close()
            rec = self.ensure_access(force=True, rejected_key=rec.get("access_key"))
            resp = self._send(rec, method, path, query, body, headers, timeout, stream)
        return resp

    def _send(self, rec: dict, method: str, path: str, query, body, headers, timeout, stream) -> HttpResponse:
        hdrs = {"Authorization": "Bearer " + rec["access_key"]}
        if headers:
            hdrs.update(headers)
        return http_call(method, build_url(rec["origin"], path, query), headers=hdrs, body=body,
                         timeout=timeout or self.http_timeout, stream=stream)

    def get_data(self, path: str, query: Optional[List[Tuple[str, str]]] = None, *, action: str = "") -> Any:
        resp = self.request("GET", path, query=query)
        if not resp.ok:
            raise api_error(resp, action=action)
        return _unwrap(resp)


def discovery_note(version: Any) -> Optional[str]:
    """平台的发现协议版本高于本接入包支持的版本时给出提示。"""
    if isinstance(version, int) and version > SUPPORTED_DISCOVERY_VERSION:
        return ("提示：平台的发现协议版本是 %d，本接入包只支持 %d，请运行 skill-update 更新接入包。"
                % (version, SUPPORTED_DISCOVERY_VERSION))
    return None


# ---------------------------------------------------------------------------------------------- 命令上下文
class Context:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.ui = Ui(bool(getattr(args, "json", False)))
        profile = getattr(args, "profile", None) or os.environ.get("NEXUS_PROFILE", "").strip() or DEFAULT_PROFILE
        if not PROFILE_RE.match(profile):
            raise CliError(EXIT_USAGE, "profile 名只能用字母、数字、点、下划线和短横线（最多 40 个字符）：%s" % profile,
                           code="profile_invalid")
        self.profile = profile
        self.http_timeout = float(getattr(args, "http_timeout", None) or DEFAULT_HTTP_TIMEOUT)
        self.store = Store(nexus_home())

    def session(self) -> Session:
        return Session(self.store, self.profile, self.ui, self.http_timeout)


# ---------------------------------------------------------------------------------------------- login / logout / whoami
_KEY_IN_TEXT_RE = re.compile(r"nxc_[A-Za-z0-9_\-]{8,}")


def _extract_connection_key(text: str, source: str) -> str:
    found = sorted(set(_KEY_IN_TEXT_RE.findall(text or "")))
    if not found:
        raise CliError(EXIT_USAGE, "没有从%s读到连接密钥。" % source, code="connection_key_missing",
                       hint="把用户给的连接密钥原样传进来（只传密钥本身即可）。")
    if len(found) > 1:
        raise CliError(EXIT_USAGE, "从%s读到了多把连接密钥，只能给一把。" % source, code="connection_key_ambiguous")
    return found[0]


def _read_stdin(what: str) -> str:
    if sys.stdin is None:
        raise CliError(EXIT_USAGE, "没有可读的标准输入（%s）。" % what, code="stdin_missing")
    try:
        return sys.stdin.read()
    except (OSError, ValueError) as exc:
        raise CliError(EXIT_USAGE, "读标准输入失败（%s）：%s" % (what, exc), code="stdin_unreadable")


def _env_value(name: str, what: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise CliError(EXIT_USAGE, "环境变量 %s 没有设置（%s）。" % (name, what), code="env_missing")
    return value


def _password_login(origin: str, args: argparse.Namespace, client_kind: str, timeout: float) -> str:
    """账号密码方式：/auth/login（含 MFA 两步）→ 建连接（预设 builder）→ 返回新连接的连接密钥。

    密码与登录令牌只留在这个函数的局部变量里，不写盘、不打印；函数返回后即丢弃。"""
    if not args.username:
        raise CliError(EXIT_USAGE, "账号密码方式需要 --username。", code="username_required")
    if args.password_stdin and args.password_env:
        raise CliError(EXIT_USAGE, "--password-stdin 与 --password-env 只能选一个。", code="usage")
    if args.password_stdin:
        password = _read_stdin("密码").rstrip("\r\n")
    elif args.password_env:
        password = _env_value(args.password_env, "密码")
    else:
        raise CliError(EXIT_USAGE, "账号密码方式需要 --password-stdin 或 --password-env（不接受命令行明文密码）。",
                       code="password_required")
    if not password:
        raise CliError(EXIT_USAGE, "没有读到密码。", code="password_required")

    resp = http_call("POST", origin + LOGIN_PATH, body={"username": args.username, "password": password},
                     timeout=timeout)
    password = ""
    body = resp.json() if resp.ok else None
    if not resp.ok:
        _code, message = response_detail(resp)
        if resp.status == 400 and "SSO" in message:
            raise CliError(EXIT_PLATFORM, "这个平台启用了单点登录，不能用账号密码连接。", code="sso_enabled",
                           hint="请用户在 Nexus 网页%s生成一把 API 密钥（连接密钥），交给 Agent 后用 --token-stdin 连接。"
                                % WEB_CONNECTIONS_PAGE)
        if resp.status == 401:
            raise CliError(EXIT_RECONNECT, "用户名或密码不正确。", code="invalid_credentials", http_status=401)
        if resp.status == 403:
            raise CliError(EXIT_FORBIDDEN, "账号已被停用。", code="account_disabled", http_status=403)
        raise api_error(resp, action="登录")
    if not isinstance(body, dict):
        raise CliError(EXIT_PLATFORM, "登录响应格式不对。", code="login_response_invalid")
    if body.get("mfa_required"):
        # 恢复码是长期有效的一次性凭证：推荐经环境变量传（--mfa-code-env），不留在进程列表与对话记录里
        mfa_code = _env_value(args.mfa_code_env, "二次验证码") if getattr(args, "mfa_code_env", None) else args.mfa_code
        if not mfa_code:
            raise CliError(EXIT_USAGE, "这个账号开启了二次验证。", code="mfa_required",
                           hint="向用户要当前的动态验证码（或恢复码），放进环境变量后加 --mfa-code-env <变量名>"
                                "（或 --mfa-code <验证码>）重新执行 login。")
        resp = http_call("POST", origin + MFA_VERIFY_PATH,
                         body={"mfa_token": body.get("mfa_token") or "", "code": mfa_code}, timeout=timeout)
        mfa_code = ""
        if not resp.ok:
            _code, message = response_detail(resp)
            if resp.status == 400:
                raise CliError(EXIT_RECONNECT, "二次验证没有通过：%s" % (message or "验证码不正确"),
                               code="mfa_failed", http_status=400, hint="向用户要新的验证码后重新执行 login。")
            if resp.status == 403:
                raise CliError(EXIT_FORBIDDEN, "账号已被停用。", code="account_disabled", http_status=403)
            raise api_error(resp, action="二次验证")
        body = resp.json()
    login_token = body.get("access_token") if isinstance(body, dict) else None
    body = None
    if not isinstance(login_token, str) or not login_token:
        raise CliError(EXIT_PLATFORM, "登录响应里没有登录令牌。", code="login_response_invalid")

    name = (args.name or "%s · %s" % (client_kind, _hostname() or "cli")).strip()[:80]
    resp = http_call("POST", origin + CONNECTIONS_PATH, headers={"Authorization": "Bearer " + login_token},
                     body={"name": name, "preset": "builder", "client_kind": client_kind, "created_via": "password"},
                     timeout=timeout)
    login_token = ""
    if not resp.ok:
        code, _message = response_detail(resp)
        if resp.status == 409 and code == "connection_limit_reached":
            raise CliError(EXIT_CONFLICT, "这个账号的 API 密钥数量已到上限（connection_limit_reached）。",
                           code=code, http_status=409, hint="请用户在网页%s停用不用的密钥后再试。" % WEB_CONNECTIONS_PAGE)
        raise api_error(resp, action="新建连接")
    data = _unwrap(resp)
    key = data.get("connection_key") if isinstance(data, dict) else None
    if not isinstance(key, str) or not key.startswith(CONNECTION_KEY_PREFIX):
        raise CliError(EXIT_PLATFORM, "新建连接的响应里没有连接密钥。", code="connection_response_invalid")
    return key


def _store_put(ctx: Context, record: dict) -> None:
    """login 时落盘：写不进去时说清后果（对话里那串已经作废，新的连接密钥没存上）。"""
    try:
        ctx.store.put(ctx.profile, record)
    except OSError as exc:
        raise CliError(EXIT_PLATFORM, "连接成功了，但新的连接密钥没能保存到本机（%s）。" % (exc.strerror or exc),
                       code="credentials_unwritable",
                       hint="对话里出现过的那串已经作废；修正 %s 的磁盘空间或权限后，请用户在网页%s重新生成连接密钥再 login。"
                            % (ctx.store.home, WEB_CONNECTIONS_PAGE))


def _bundle_already_used(ctx: Context, bundle: dict, origin: str) -> bool:
    """本机这个 profile 已经是接入包里的那条连接（同一平台、同一连接 id）：包里的密钥早就被平台换新了。"""
    cid = bundle.get("connection_id")
    if not cid:
        return False
    current = ctx.store._read(tolerant=True)["profiles"].get(ctx.profile)
    return (isinstance(current, dict) and current.get("connection_id") == cid and current.get("origin") == origin
            and bool(current.get("connection_key")))


def _report_bundle_already_used(ctx: Context, origin: str) -> int:
    """接入包在本机已经用过：只删掉残留的密钥文件，沿用本机已保存的连接（不再向平台出示那把作废的密钥）。"""
    ui = ctx.ui
    removed = consume_bundled_connection(ui)
    record = ctx.store._read(tolerant=True)["profiles"].get(ctx.profile) or {}
    conn = record.get("connection") or {}
    if ui.json_mode:
        ui.emit({"ok": True, "profile": ctx.profile, "origin": origin, "already_connected": True,
                 "connected_via": record.get("connected_via"), "connection_key_rotated": False,
                 "user": record.get("user") or {}, "connection": conn, "home": str(ctx.store.home),
                 "bundled_key": {"used": False, "already_used": True, "file_removed": bool(removed)}})
    else:
        ui.say("本机已经用这个接入包连接过 %s（连接 %s）：包里附带的那把早已换新，不再使用。"
               % (origin, conn.get("name") or record.get("connection_id") or "—"))
        if removed:
            ui.say("已从接入包里删除那把用过的密钥（%s）。" % BUNDLED_CONNECTION_FILE)
        ui.say("运行 whoami 确认连接状态。")
    return EXIT_OK


def cmd_login(ctx: Context) -> int:
    args = ctx.args
    ui = ctx.ui
    client_kind = args.client or os.environ.get("NEXUS_CLIENT", "").strip() or "other"
    if client_kind not in CLIENT_KINDS:
        raise CliError(EXIT_USAGE, "--client 只能是 %s 之一。" % " / ".join(CLIENT_KINDS), code="client_invalid")
    sources = [bool(args.token_stdin), bool(args.token_env), bool(args.password_login)]
    # 一种方式都没指定：用接入包自带的那把（网页生成 API 密钥时下载的接入包里有 config/connection.json）
    bundle = bundled_connection() if not any(sources) else None
    if sum(sources) != 1 and bundle is None:
        raise CliError(EXIT_USAGE, "请选一种连接方式：--token-stdin、--token-env NAME 或 --password-login。",
                       code="usage", hint="推荐把用户给的连接密钥经标准输入传入：login --origin <地址> --token-stdin；"
                                          "接入包里有 %s（网页生成 API 密钥时下载的那份）时，直接运行 login 即可。"
                                          % BUNDLED_CONNECTION_FILE)
    origin, dropped_path = normalize_origin(args.origin or os.environ.get("NEXUS_ORIGIN")
                                            or (bundle or {}).get("origin") or instance_origin(),
                                            allow_http=args.allow_http)
    if dropped_path:
        ui.note("提示：平台地址只需要到域名（和端口），已忽略后面的路径部分。")

    if args.password_login:
        given_key = _password_login(origin, args, client_kind, ctx.http_timeout)
        via = "password"
    elif args.token_stdin:
        given_key = _extract_connection_key(_read_stdin("连接密钥"), "标准输入")
        via = "token"
    elif args.token_env:
        given_key = _extract_connection_key(_env_value(args.token_env, "连接密钥"), "环境变量 %s" % args.token_env)
        via = "token"
    else:
        given_key = bundle["connection_key"]
        via = "token"
        if _bundle_already_used(ctx, bundle, origin):
            # 本机已经用这个接入包连上过（上次没删掉文件）：别再把作废的那把出示给平台（会给用户报「旧密钥被重用」）
            return _report_bundle_already_used(ctx, origin)
        ui.note("使用接入包里附带的 API 密钥连接（%s）。" % BUNDLED_CONNECTION_FILE)

    with ctx.store.lock():
        base = {"origin": origin, "allow_http": bool(args.allow_http), "client_kind": client_kind,
                "connected_via": via}
        try:
            data, server_time, received = exchange_token(origin, given_key, rotate=False, client_kind=client_kind,
                                                         timeout=ctx.http_timeout)
            if not data.get("connection_key"):
                # 交来的这把此前已经兑换过（不是新签发的）：主动轮换一次，保证对话里出现过的那串不再长期有效
                data, server_time, received = exchange_token(origin, given_key, rotate=True, client_kind=client_kind,
                                                             timeout=ctx.http_timeout)
        except _PartialExchange as partial:
            # 平台已经换了连接密钥、访问密钥那部分不完整：先存下新连接密钥，下一条命令会自动完成兑换
            _store_put(ctx, dict(base, connection_key=partial.connection_key, connected_at=iso(partial.received)))
            raise CliError(EXIT_PLATFORM, "平台返回的兑换结果不完整（新的连接密钥已保存在本机）。", code="token_response_invalid",
                           hint="稍后运行 whoami 会自动完成连接。")
        except _Superseded:
            hint = "请用户在网页%s重新生成连接密钥。" % WEB_CONNECTIONS_PAGE
            if bundle is not None:
                # 随包的密钥已经确定用不了：删掉文件，别让下一次 login 又把它出示一遍
                consume_bundled_connection(ui)
                hint = _BUNDLE_DEAD_HINT % WEB_CONNECTIONS_PAGE
            raise CliError(EXIT_RECONNECT, "这把连接密钥已经在别处被更换过，不能再用来连接。",
                           code="connection_key_superseded", hint=hint)
        except CliError as err:
            if via == "password":
                # 账号密码方式刚建的连接没能兑换：用它自己的连接密钥断开，别在平台上留下待连接的孤儿连接
                with contextlib.suppress(Exception):
                    http_call("POST", origin + REVOKE_PATH, headers={"Authorization": "Bearer " + given_key}, body={},
                              timeout=ctx.http_timeout).close()
            if bundle is not None and err.code in _DEAD_BUNDLE_CODES:
                consume_bundled_connection(ui)
                err.hint = _BUNDLE_DEAD_HINT % WEB_CONNECTIONS_PAGE
            raise
        given_key = ""
        previous = ctx.store._read(tolerant=True)["profiles"].get(ctx.profile)
        base.update(connection_key=data["connection_key"], connected_at=iso(received))
        record = apply_exchange(base, data, server_time, received)
        _store_put(ctx, record)
    ctx.store.clear_cache(ctx.profile)
    # 随包的那把已被平台换新（新的只在本机凭证文件里）：删掉包里的旧密钥文件
    bundle_removed = consume_bundled_connection(ui) if bundle is not None else None

    user = record.get("user") or {}
    conn = record.get("connection") or {}
    if ui.json_mode:
        out = {"ok": True, "profile": ctx.profile, "origin": origin, "connected_via": via,
               "connection_key_rotated": True, "user": user, "connection": conn,
               "access_key_expires_at": record.get("access_key_expires_at"),
               "platform": record.get("platform"), "home": str(ctx.store.home)}
        if bundle is not None:
            out["bundled_key"] = {"used": True, "file_removed": bool(bundle_removed)}
        ui.emit(out)
    else:
        if previous and (previous.get("connection_id") != record.get("connection_id")):
            ui.note("提示：profile %s 原来保存的连接已被替换（那条连接并没有断开，可在网页上断开）。" % ctx.profile)
        ui.say("已连接 %s" % origin)
        ui.say("用户：%s（角色 %s）" % (user.get("name") or user.get("email") or user.get("user_id") or "—",
                                    user.get("role") or "—"))
        ui.say("连接：%s（%s）· 权限档位 %s" % (conn.get("name") or "—", record.get("connection_id") or "—",
                                          conn.get("preset") or "—"))
        ui.say("连接密钥已自动更换：对话里出现过的那串已经失效，新的只保存在本机 %s（权限 0600）。" % ctx.store.path)
        if bundle is not None and bundle_removed:
            ui.say("接入包里附带的那把已经用掉，已从接入包里删除（%s）。" % BUNDLED_CONNECTION_FILE)
        ui.say("之后访问密钥会自动续期、连接密钥会定期自动更换，不需要再处理任何密钥。")
        note = discovery_note((record.get("platform") or {}).get("discovery_version"))
        if note:
            ui.note(note)
    return EXIT_OK


def cmd_logout(ctx: Context) -> int:
    ui = ctx.ui
    # 整个过程在文件锁内：锁内读到的才是最新的连接密钥（别的进程可能刚轮换过），断开与删除之间也不会被续期写回
    with ctx.store.lock():
        record = ctx.store._read(tolerant=True)["profiles"].get(ctx.profile)
        rec = dict(record) if isinstance(record, dict) else None
        if not rec:
            if ui.json_mode:
                ui.emit({"ok": True, "profile": ctx.profile, "removed": False, "revoked": False})
            else:
                ui.say("profile %s 没有保存的连接。" % ctx.profile)
            return EXIT_OK
        revoked: Optional[str] = None
        if ctx.args.revoke and rec.get("connection_key") and rec.get("origin"):
            try:
                resp = http_call("POST", rec["origin"] + REVOKE_PATH,
                                 headers={"Authorization": "Bearer " + rec["connection_key"]}, body={},
                                 timeout=ctx.http_timeout)
                if resp.ok:
                    revoked = "revoked"
                else:
                    code, _message = response_detail(resp)
                    if resp.status == 401 and code in DEAD_CONNECTION_CODES:
                        revoked = "already_inactive"     # 连接本来就已不可用：本地凭证照删
                    else:
                        raise api_error(resp, action="断开连接", exchange=True)
            except CliError as err:
                # 没断开成功就不删本地凭证：留着可以重试，避免「平台上还连着、本地却没了密钥」
                err.hint = ((err.hint + " ") if err.hint else "") + "本地凭证已保留，可稍后重试，或请用户在网页%s断开。" \
                    % WEB_CONNECTIONS_PAGE
                raise
        ctx.store.delete(ctx.profile)
    ctx.store.clear_cache(ctx.profile)
    if ui.json_mode:
        ui.emit({"ok": True, "profile": ctx.profile, "removed": True, "revoked": revoked == "revoked",
                 "connection_id": rec.get("connection_id"), "revoke_result": revoked})
    else:
        if revoked == "revoked":
            ui.say("已在平台上停用这把 API 密钥（连接 %s），并删除了本机凭证。" % (rec.get("connection_id") or "—"))
        elif revoked == "already_inactive":
            ui.say("这条连接在平台上已经不可用，已删除本机凭证。")
        else:
            ui.say("已删除本机凭证（profile %s）。平台上的连接没有断开：需要时加 --revoke，或请用户在网页%s断开。"
                   % (ctx.profile, WEB_CONNECTIONS_PAGE))
    return EXIT_OK


def cmd_whoami(ctx: Context) -> int:
    ui = ctx.ui
    session = ctx.session()
    rec = session.ensure_access()
    # 在线核对：访问密钥确实被平台接受，顺带取发现协议版本（平台没有发现接口时 404，不影响身份核对）
    resp = session.request("GET", CAPABILITIES_PATH, query=[("locale", "zh")])
    caps: Optional[dict] = None
    if resp.ok:
        data = _unwrap(resp)
        caps = data if isinstance(data, dict) else None
    elif resp.status != 404:
        raise api_error(resp, action="核对身份")
    rec = ctx.store.get(ctx.profile) or rec
    user = rec.get("user") or {}
    conn = rec.get("connection") or {}
    plat = dict(rec.get("platform") or {})
    if caps:
        info = caps.get("platform") if isinstance(caps.get("platform"), dict) else {}
        plat.update({k: v for k, v in info.items() if v is not None})
        if caps.get("discovery_version") is not None:
            plat["discovery_version"] = caps.get("discovery_version")
    remaining = access_remaining(rec)
    discovery = plat.get("discovery_version")
    compatible = discovery is None or (isinstance(discovery, int) and discovery <= SUPPORTED_DISCOVERY_VERSION)
    if ui.json_mode:
        ui.emit({"ok": True, "profile": ctx.profile, "origin": rec.get("origin"), "user": user, "connection": conn,
                 "access_key_expires_at": rec.get("access_key_expires_at"),
                 "access_key_remaining_seconds": int(remaining) if remaining is not None else None,
                 "connection_key_rotate_after": rec.get("connection_key_rotate_after"),
                 "platform": plat, "discovery": {"supported": SUPPORTED_DISCOVERY_VERSION, "platform": discovery,
                                                 "available": caps is not None, "compatible": compatible},
                 "home": str(ctx.store.home)})
        return EXIT_OK
    ui.say("平台：%s（Nexus-AI %s%s）" % (rec.get("origin"), plat.get("version") or "—",
                                       ("，%s" % plat["edition"]) if plat.get("edition") else ""))
    ui.say("用户：%s%s · 角色 %s（已按连接的权限封顶）" % (
        user.get("name") or "—", (" <%s>" % user["email"]) if user.get("email") else "", user.get("role") or "—"))
    ui.say("连接：%s（%s）· 权限档位 %s · 状态 %s" % (conn.get("name") or "—", rec.get("connection_id") or "—",
                                                conn.get("preset") or "—", conn.get("status") or "—"))
    if remaining is not None:
        ui.say("访问密钥：剩余 %s（自动续期）" % human_duration(remaining))
    ui.say("连接密钥：下次自动更换不早于 %s" % local_time_text(rec.get("connection_key_rotate_after")))
    if caps is None:
        ui.say("能力发现：平台没有提供发现接口（可能版本较旧）")
    elif compatible:
        ui.say("能力发现：协议 %s，与本接入包兼容" % discovery)
    else:
        ui.say("能力发现：协议 %s，本接入包只支持 %d —— 请运行 skill-update" % (discovery, SUPPORTED_DISCOVERY_VERSION))
    ui.say("profile：%s · 配置目录 %s" % (ctx.profile, ctx.store.home))
    return EXIT_OK


# ---------------------------------------------------------------------------------------------- 能力发现（规格 §4.5 / §4.6）
LOCALES = ("zh", "en")
DEFAULT_LOCALE = "zh"
RISK_LEVELS = ("read", "write", "destructive", "high")
HTTP_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD")
API_PREFIX = "/api/v2/"          # 只用于校验 call / wait 的路径落在平台 API 下，不是任何具体端点
PATH_ARG_HELP = "站内路径（形如 /api/v2/…）；可带 {参数} 占位，用 -p 填"
_MODULE_ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")
_OP_ID_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,160}$")
# 路由模板里的占位：{name} 或 {name:path}（path 型可含 /）
_PLACEHOLDER_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)(?::([A-Za-z_]+))?\}")


def pick_locale(value: Any, locale: str) -> Any:
    """双语字段 {zh, en} → 当前语言（缺时回落另一种）；不是双语字段原样返回。"""
    if isinstance(value, dict) and value and set(value) <= {"zh", "en"}:
        for key in (locale, "zh", "en"):
            if value.get(key) not in (None, "", []):
                return value[key]
        return None
    return value


def _text(value: Any, locale: str, default: str = "") -> str:
    picked = pick_locale(value, locale)
    if picked is None:
        return default
    return picked if isinstance(picked, str) else json.dumps(picked, ensure_ascii=False)


def _text_list(value: Any, locale: str) -> List[str]:
    picked = pick_locale(value, locale)
    if isinstance(picked, str):
        return [picked] if picked else []
    if isinstance(picked, list):
        return [item if isinstance(item, str) else json.dumps(item, ensure_ascii=False) for item in picked]
    return []


def _discovery_unavailable() -> CliError:
    return CliError(EXIT_PLATFORM, "这个平台没有提供能力发现接口（平台版本可能较旧）。", code="discovery_unavailable",
                    hint="可以请平台管理员升级；在此之前只能按用户给出的具体路径调用（call 会按请求方法推断风险）。")


class Discovery:
    """能力发现客户端：总览按 ETag 缓存（If-None-Match → 304 用本地缓存），操作索引跟着总览的 ETag（目录版本 + 调用者指纹）走。

    缓存在 ~/.nexus/cache/<profile>/（0700 / 0600）：capabilities-<locale>.json、operations.json。"""

    def __init__(self, session: Session) -> None:
        self.session = session
        self.store = session.store
        self.profile = session.profile

    def _cache_path(self, name: str) -> Path:
        return self.store.cache_dir(self.profile) / name

    def read_cache(self, name: str) -> Optional[dict]:
        try:
            data = json.loads(self._cache_path(name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return data if isinstance(data, dict) else None

    def _write_cache(self, name: str, data: dict) -> None:
        try:
            self.store.ensure_cache_dir(self.profile)
            write_private_json(self._cache_path(name), data)
        except OSError:
            pass  # 缓存写不进去不影响本次结果

    def overview(self, locale: str = DEFAULT_LOCALE, *, refresh: bool = False) -> Tuple[dict, bool, Optional[str]]:
        """→（总览 data，是否来自本地缓存，ETag）。"""
        name = "capabilities-%s.json" % locale
        cached = None if refresh else self.read_cache(name)
        if cached is not None and not isinstance(cached.get("data"), dict):
            cached = None
        headers = {}
        if cached and cached.get("etag"):
            headers["If-None-Match"] = cached["etag"]
        resp = self.session.request("GET", CAPABILITIES_PATH, query=[("locale", locale)], headers=headers)
        if resp.status == 304 and cached:
            return cached["data"], True, cached.get("etag")
        if resp.status == 404:
            raise _discovery_unavailable()
        if not resp.ok:
            raise api_error(resp, action="能力发现")
        data = _unwrap(resp)
        if not isinstance(data, dict):
            raise CliError(EXIT_PLATFORM, "能力发现的响应格式不对。", code="discovery_response_invalid")
        etag = resp.header("ETag")
        self._write_cache(name, {"etag": etag, "catalog_version": data.get("catalog_version"), "locale": locale,
                                 "fetched_at": iso(utcnow()), "data": data})
        return data, False, etag

    def operations_index(self, *, offline: bool = False) -> Optional[dict]:
        """调用者能看到的全部操作（含不可用的，带 denied_reason）→ {"etag", "operations": [...]}。

        offline=True（dry-run）只读本地缓存；平台没有发现接口时返回 None。"""
        cached = self.read_cache("operations.json")
        if cached is not None and not isinstance(cached.get("operations"), list):
            cached = None
        if offline:
            return cached
        try:
            overview, _from_cache, etag = self.overview(DEFAULT_LOCALE)
        except CliError as err:
            if err.code == "discovery_unavailable":
                return None
            raise
        if cached and etag and cached.get("etag") == etag:
            return cached
        resp = self.session.request("GET", CAPABILITIES_PATH + "/operations", query=[("include_denied", "true")])
        if resp.status == 404:
            return None
        if not resp.ok:
            raise api_error(resp, action="能力发现")
        data = _unwrap(resp)
        ops = data.get("operations") if isinstance(data, dict) else None
        if not isinstance(ops, list):
            raise CliError(EXIT_PLATFORM, "能力发现的操作列表格式不对。", code="discovery_response_invalid")
        index = {"etag": etag, "catalog_version": overview.get("catalog_version"), "fetched_at": iso(utcnow()),
                 "operations": [op for op in ops if isinstance(op, dict)]}
        self._write_cache("operations.json", index)
        return index


def _template_regex(template: str) -> "re.Pattern":
    out, pos = [], 0
    for match in _PLACEHOLDER_RE.finditer(template):
        out.append(re.escape(template[pos:match.start()]))
        out.append("(.+)" if match.group(2) == "path" else "([^/]+)")
        pos = match.end()
    out.append(re.escape(template[pos:]))
    return re.compile("^" + "".join(out) + "$")


def find_operation(ops: List[dict], method: str, path: str, *, is_template: bool) -> Optional[dict]:
    """按（方法，路径）找操作：模板直接比结构；具体路径按模板匹配，取字面部分最长、占位最少的那条。"""
    method = method.upper()
    candidates = [op for op in ops if str(op.get("method") or "").upper() == method and isinstance(op.get("path"), str)]
    for op in candidates:
        if op["path"] == path:
            return op
    if is_template:
        shape = _PLACEHOLDER_RE.sub("{}", path)
        for op in candidates:
            if _PLACEHOLDER_RE.sub("{}", op["path"]) == shape:
                return op
        return None
    best, best_key = None, None
    for op in candidates:
        if _template_regex(op["path"]).match(path):
            key = (len(_PLACEHOLDER_RE.sub("", op["path"])), -len(_PLACEHOLDER_RE.findall(op["path"])))
            if best_key is None or key > best_key:
                best, best_key = op, key
    return best


def infer_risk(method: str) -> str:
    """拿不到发现结果时按方法推断（与平台的自动判定同口径）：GET/HEAD 读、DELETE 高风险、其余写。"""
    method = method.upper()
    if method in ("GET", "HEAD"):
        return "read"
    if method == "DELETE":
        return "destructive"
    return "write"


def resolve_risk(op: Optional[dict], method: str) -> Tuple[str, str]:
    """→（风险等级，来源 discovery / method）。不认识的等级一律按 high（宁严勿松）。"""
    if op is not None and isinstance(op.get("risk"), str) and op["risk"].strip():
        risk = op["risk"].strip().lower()
        return (risk if risk in RISK_LEVELS else "high"), "discovery"
    return infer_risk(method), "method"


def required_flags(risk: str) -> List[str]:
    if risk == "read":
        return []
    if risk == "write":
        return ["--yes"]
    return ["--yes", "--confirm-destructive"]


_RISK_LABELS = {"read": "只读", "write": "写操作", "destructive": "高风险（删除或不可撤销）", "high": "高风险"}


def _parse_pairs(items: List[str], flag: str) -> List[Tuple[str, str]]:
    pairs = []
    for item in items or []:
        if "=" not in item or not item.split("=", 1)[0].strip():
            raise CliError(EXIT_USAGE, "%s 的格式是 名称=值：%s" % (flag, item), code="usage")
        key, value = item.split("=", 1)
        pairs.append((key.strip(), value))
    return pairs


def fill_path(template: str, params: List[Tuple[str, str]]) -> str:
    """{name} / {name:path} 占位 → -p 给的值（URL 编码；path 型保留 /）。缺值、多给、. / .. 都是用法错误。"""
    values: Dict[str, str] = {}
    for key, value in params:
        if key in values:
            raise CliError(EXIT_USAGE, "路径参数 %s 给了不止一次。" % key, code="path_param_duplicate")
        if value in ("", ".", ".."):
            raise CliError(EXIT_USAGE, "路径参数 %s 的值不能为空或是 . / ..。" % key, code="path_param_invalid")
        values[key] = value
    used, missing = set(), []

    def repl(match) -> str:
        name, converter = match.group(1), match.group(2)
        if name not in values:
            missing.append(name)
            return match.group(0)
        used.add(name)
        return urllib.parse.quote(values[name], safe="/" if converter == "path" else "")

    filled = _PLACEHOLDER_RE.sub(repl, template)
    if missing:
        raise CliError(EXIT_USAGE, "路径参数没有给值：%s。" % "、".join(missing), code="path_param_missing",
                       hint="用 -p 名称=值 填写（describe 可以看参数）。")
    extra = sorted(set(values) - used)
    if extra:
        raise CliError(EXIT_USAGE, "这些 -p 参数在路径里没有对应的占位：%s。" % "、".join(extra), code="path_param_unknown",
                       hint="查询参数请用 -q 名称=值。")
    return filled


def split_api_path(raw: str) -> Tuple[str, List[Tuple[str, str]]]:
    """校验并拆开用户给的路径：必须是 /api/v2/ 下的站内路径；路径里自带的 ?a=b 并进查询参数。"""
    text = (raw or "").strip()
    if "://" in text or text.startswith("//"):
        raise CliError(EXIT_USAGE, "PATH 只写站内路径（形如 /api/v2/…），不要写完整网址。", code="path_invalid",
                       hint="平台地址已经在 login 时保存。")
    base, _sep, qs = text.partition("?")
    if not base.startswith(API_PREFIX):
        raise CliError(EXIT_USAGE, "PATH 必须以 %s 开头：%s" % (API_PREFIX, raw), code="path_invalid",
                       hint="用 caps / module / ops 查看可用的操作路径。")
    if any(part in (".", "..") for part in base.split("/")):
        raise CliError(EXIT_USAGE, "PATH 里不能有 . 或 .. 段：%s" % raw, code="path_invalid")
    return base, urllib.parse.parse_qsl(qs, keep_blank_values=True) if qs else []


def _masked_query(query: List[Tuple[str, str]]) -> List[Tuple[str, str]]:
    return [(key, "***" if _is_sensitive_key(key) and value else value) for key, value in query]


def request_preview(origin: str, method: str, path: str, query: List[Tuple[str, str]], has_body: bool,
                    body: Any) -> dict:
    """要执行的请求（已脱敏：敏感查询参数与请求体字段换成 ***，密钥串由输出脱敏器兜底）。"""
    preview = {"method": method, "url": build_url(origin, path, _masked_query(query) or None)}
    if has_body:
        preview["body"] = mask_sensitive(body)
    return preview


def _preview_lines(preview: dict) -> List[str]:
    lines = ["  %s %s" % (preview["method"], preview["url"])]
    if "body" in preview:
        lines.append("  请求体：%s" % json.dumps(preview["body"], ensure_ascii=False))
    lines.append("  （自动带上访问密钥，不会显示）")
    return lines


def _render_ops(ui: Ui, ops: List[dict]) -> None:
    for op in ops:
        flags = []
        if op.get("streaming"):
            flags.append("流式")
        if op.get("allowed") is False:
            flags.append("不可用：%s" % (op.get("denied_reason") or "—"))
        ui.say("  %-6s %s  %s  [%s]%s" % (op.get("method") or "?", op.get("path") or "?", op.get("summary") or "",
                                         op.get("risk") or "?", ("  " + "，".join(flags)) if flags else ""))


def cmd_caps(ctx: Context) -> int:
    ui, args = ctx.ui, ctx.args
    data, from_cache, _etag = Discovery(ctx.session()).overview(args.locale, refresh=args.refresh)
    note = discovery_note(data.get("discovery_version"))
    if note:
        ui.note(note)
    if ui.json_mode:
        ui.emit({"ok": True, "from_cache": from_cache, "data": data})
        return EXIT_OK
    locale = args.locale
    plat = data.get("platform") if isinstance(data.get("platform"), dict) else {}
    ui.say("%s %s%s · 发现协议 %s · 目录版本 %s%s" % (
        plat.get("product") or "Nexus-AI", plat.get("version") or "—",
        ("（%s）" % plat["edition"]) if plat.get("edition") else "", data.get("discovery_version", "—"),
        data.get("catalog_version") or "—", "（未变化，用的本地缓存）" if from_cache else ""))
    caller = data.get("caller") if isinstance(data.get("caller"), dict) else {}
    via = ("API 密钥 %s" % caller["connection_id"]) if caller.get("connection_id") else (caller.get("auth_kind") or "—")
    ui.say("调用者：%s · 角色 %s · %s" % (caller.get("name") or caller.get("user_id") or "—", caller.get("role") or "—", via))
    modules = [m for m in (data.get("modules") or []) if isinstance(m, dict)]
    usable = [m for m in modules if m.get("available") is not False]
    ui.say("模块（共 %d 个，可用 %d 个）：" % (len(modules), len(usable)))
    for mod in modules:
        if mod.get("available") is False:
            state = "不可用：%s" % (mod.get("unavailable_reason") or "—")
        else:
            state = "可用操作 %s/%s" % (mod.get("allowed_operation_count", "?"), mod.get("operation_count", "?"))
        ui.say("  %-18s %s —— %s  [%s]" % (mod.get("id") or "?", _text(mod.get("name"), locale, "—"),
                                         _text(mod.get("summary"), locale), state))
        recipes = [r for r in (mod.get("recipes") or []) if isinstance(r, dict)]
        if recipes:
            ui.say("  %-18s 配方：%s" % ("", "；".join("%s（%s）" % (r.get("id"), _text(r.get("title"), locale))
                                                    for r in recipes)))
    ui.say("下一步：module <id> 看指南、配方与操作；describe <METHOD> <PATH> 看参数与请求体。")
    return EXIT_OK


def _render_module(ui: Ui, mod: dict, locale: str) -> None:
    ui.say("%s · %s（%s）" % (mod.get("id") or "?", _text(mod.get("name"), locale, "—"), mod.get("category") or "—"))
    summary = _text(mod.get("summary"), locale)
    if summary:
        ui.say(summary)
    if mod.get("available") is False:
        ui.say("当前不可用：%s" % (mod.get("unavailable_reason") or "—"))
    if mod.get("ui_route"):
        ui.say("对应页面：%s" % mod["ui_route"])
    if mod.get("depends_on"):
        ui.say("依赖模块：%s" % "、".join(str(x) for x in mod["depends_on"]))
    guide = mod.get("guide") if isinstance(mod.get("guide"), dict) else {}
    for key, label in (("when_to_use", "何时用"), ("avoid_when", "别用于"), ("tips", "提示")):
        items = _text_list(guide.get(key), locale)
        if items:
            ui.say(label + "：")
            for item in items:
                ui.say("  - " + item)
    recipes = [r for r in (mod.get("recipes") or []) if isinstance(r, dict)]
    if recipes:
        ui.say("配方：")
        for recipe in recipes:
            ui.say("  %s：%s" % (recipe.get("id") or "?", _text(recipe.get("title"), locale)))
            for number, step in enumerate([s for s in (recipe.get("steps") or []) if isinstance(s, dict)], 1):
                line = "    %d. %s" % (number, step.get("op") or "?")
                note = _text(step.get("note"), locale)
                if note:
                    line += " —— " + note
                poll = step.get("poll")
                if isinstance(poll, dict):
                    line += "（用 wait 轮询 %s 直到 %s，间隔 %s 秒）" % (
                        poll.get("field") or "?", "/".join(str(x) for x in (poll.get("until") or [])),
                        poll.get("interval_sec", 15))
                ui.say(line)
    ops = [op for op in (mod.get("operations") or []) if isinstance(op, dict)]
    if "operations" in mod:
        ui.say("操作（%d）：" % len(ops))
        _render_ops(ui, ops)


def cmd_module(ctx: Context) -> int:
    ui, args = ctx.ui, ctx.args
    module_id = args.module_id
    if not _MODULE_ID_RE.match(module_id or ""):
        raise CliError(EXIT_USAGE, "模块 id 只能是小写字母、数字和下划线：%s" % module_id, code="usage",
                       hint="用 caps 查看全部模块 id。")
    query = [("locale", args.locale)]
    if args.include_denied:
        query.append(("include_denied", "true"))
    resp = ctx.session().request("GET", CAPABILITIES_PATH + "/modules/" + module_id, query=query)
    if resp.status == 404:
        raise CliError(EXIT_NOT_FOUND, "没有这个模块：%s（或平台不支持能力发现）。" % module_id, code="module_not_found",
                       http_status=404, hint="用 caps 查看全部模块。")
    if not resp.ok:
        raise api_error(resp, action="能力发现")
    data = _unwrap(resp)
    if not isinstance(data, dict):
        raise CliError(EXIT_PLATFORM, "模块详情的响应格式不对。", code="discovery_response_invalid")
    if ui.json_mode:
        ui.emit({"ok": True, "data": data})
    else:
        _render_module(ui, data, args.locale)
    return EXIT_OK


def cmd_ops(ctx: Context) -> int:
    ui, args = ctx.ui, ctx.args
    query = []
    if args.module_filter:
        query.append(("module", args.module_filter))
    if args.search:
        query.append(("q", args.search))
    if args.include_denied:
        query.append(("include_denied", "true"))
    session = ctx.session()
    try:
        # 顺手刷新本地操作索引（目录没变时只多一次 304）：之后 call --dry-run 离线也能按能力发现判定风险
        Discovery(session).operations_index()
    except CliError:
        pass  # 预热失败不影响本次列表；真正的错误由下面的请求报告
    resp = session.request("GET", CAPABILITIES_PATH + "/operations", query=query)
    if resp.status == 404:
        raise _discovery_unavailable()
    if not resp.ok:
        raise api_error(resp, action="能力发现")
    data = _unwrap(resp)
    ops = data.get("operations") if isinstance(data, dict) else None
    if not isinstance(ops, list):
        raise CliError(EXIT_PLATFORM, "操作列表的响应格式不对。", code="discovery_response_invalid")
    ops = [op for op in ops if isinstance(op, dict)]
    total = data.get("total", len(ops))
    if ui.json_mode:
        ui.emit({"ok": True, "total": total, "data": ops})
        return EXIT_OK
    ui.say("操作（%s 个）：" % total)
    _render_ops(ui, ops)
    if ops:
        ui.say("下一步：describe <METHOD> <PATH> 看参数与请求体。")
    return EXIT_OK


def _normalize_params(raw: Any) -> List[dict]:
    if isinstance(raw, list):
        return [p for p in raw if isinstance(p, dict)]
    if isinstance(raw, dict):
        out = []
        for where, items in raw.items():
            for item in items if isinstance(items, list) else []:
                if isinstance(item, dict):
                    entry = dict(item)
                    entry.setdefault("in", where)
                    out.append(entry)
        return out
    return []


def _render_operation(ui: Ui, op: dict) -> None:
    ui.say("%s %s" % (op.get("method") or "?", op.get("path") or "?"))
    module = op.get("module")
    module_id = module.get("id") if isinstance(module, dict) else module
    meta = ["id %s" % (op.get("id") or "—"), "模块 %s" % (module_id or "—"), "风险 %s" % (op.get("risk") or "?"),
            "权限 %s" % (op.get("permission") or "—"), "最低角色 %s" % (op.get("min_role") or "—")]
    if op.get("streaming"):
        meta.append("流式")
    ui.say(" · ".join(meta))
    if op.get("summary"):
        ui.say("说明：%s" % op["summary"])
    if op.get("allowed") is False:
        ui.say("对你不可用：%s" % (op.get("denied_reason") or "—"))
    params = _normalize_params(op.get("params"))
    for where, label in (("path", "路径参数（-p）"), ("query", "查询参数（-q）")):
        items = [p for p in params if p.get("in") == where]
        if not items:
            continue
        ui.say(label + "：")
        for param in items:
            schema = param.get("schema") if isinstance(param.get("schema"), dict) else {}
            notes = ["必填" if param.get("required") else "可选"]
            if "default" in schema:
                notes.append("默认 %s" % json.dumps(schema["default"], ensure_ascii=False))
            if isinstance(schema.get("enum"), list):
                notes.append("取值 %s" % "/".join(str(x) for x in schema["enum"]))
            desc = param.get("description") or schema.get("description") or ""
            ui.say("  %s  %s  %s%s" % (param.get("name") or "?", schema.get("type") or "—", "，".join(notes),
                                      ("  " + desc) if desc else ""))
    if op.get("body_schema") is not None:
        loose = op.get("body_typed") is False
        ui.say("请求体 JSON Schema%s：" % ("（宽泛对象：端点没有声明字段，以说明为准）" if loose else ""))
        ui.say(json.dumps(op["body_schema"], ensure_ascii=False, indent=2))
    if op.get("response_schema") is not None:
        ui.say("响应 JSON Schema：")
        ui.say(json.dumps(op["response_schema"], ensure_ascii=False, indent=2))
    path = op.get("path") or ""
    example = "python3 scripts/nexus.py call %s %s" % (op.get("method") or "?", path)
    for name in _PLACEHOLDER_RE.findall(path):
        example += " -p %s=<%s>" % (name[0], name[0])
    if op.get("body_schema") is not None:
        example += " --data '<JSON>'"
    ui.say("调用：%s" % example)
    flags = required_flags(resolve_risk(op, op.get("method") or "GET")[0])
    if flags:
        ui.say("（%s：用户明确同意这一具体操作后才加 %s）" % (_RISK_LABELS.get(op.get("risk") or "", "写操作"), " ".join(flags)))


def cmd_describe(ctx: Context) -> int:
    ui, args = ctx.ui, ctx.args
    session = ctx.session()
    if args.op_id:
        if args.method or args.path:
            raise CliError(EXIT_USAGE, "--id 与 METHOD PATH 只能给一种。", code="usage")
        if not _OP_ID_RE.match(args.op_id):
            raise CliError(EXIT_USAGE, "操作 id 格式不对：%s" % args.op_id, code="usage")
        query = [("id", args.op_id)]
        method, base = "", ""
    else:
        if not (args.method and args.path):
            raise CliError(EXIT_USAGE, "请给出 METHOD PATH（如 describe POST /api/v2/…），或 --id 操作 id。", code="usage")
        method = args.method.upper()
        if method not in HTTP_METHODS:
            raise CliError(EXIT_USAGE, "不认识的请求方法：%s" % args.method, code="usage")
        base, _query = split_api_path(args.path)
        query = [("method", method), ("path", base)]
    resp = session.request("GET", CAPABILITIES_PATH + "/operation", query=query)
    if resp.status == 404 and method and not _PLACEHOLDER_RE.search(base):
        # 给的是具体路径（/api/v2/things/t-1）：用操作索引找到模板再查一次
        index = Discovery(session).operations_index()
        op = find_operation(index["operations"], method, base, is_template=False) if index else None
        if op is not None:
            resp = session.request("GET", CAPABILITIES_PATH + "/operation",
                                   query=[("method", method), ("path", op["path"])])
    if resp.status == 404:
        target = args.op_id or ("%s %s" % (method, base))
        raise CliError(EXIT_NOT_FOUND, "能力发现里没有这个操作：%s。" % target, code="operation_not_found",
                       http_status=404, hint="用 ops --search <关键词> 查找。")
    if not resp.ok:
        raise api_error(resp, action="能力发现")
    data = _unwrap(resp)
    if not isinstance(data, dict):
        raise CliError(EXIT_PLATFORM, "操作详情的响应格式不对。", code="discovery_response_invalid")
    if ui.json_mode:
        ui.emit({"ok": True, "data": data})
    else:
        _render_operation(ui, data)
    return EXIT_OK


# ---------------------------------------------------------------------------------------------- call：通用调用与风险闸（规格 §5.5）
def read_body(args: argparse.Namespace) -> Tuple[bool, Any]:
    """--data / --data-file / --data-stdin → （是否有请求体，JSON 值）。"""
    if args.data is not None:
        text, where = args.data, "--data"
    elif args.data_file is not None:
        where = "--data-file"
        if args.data_file == "-":
            text = _read_stdin("请求体")
        else:
            try:
                text = Path(args.data_file).expanduser().read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError) as exc:
                raise CliError(EXIT_USAGE, "读不了请求体文件 %s：%s" % (args.data_file, getattr(exc, "strerror", None) or exc),
                               code="body_file_unreadable")
    elif args.data_stdin:
        text, where = _read_stdin("请求体"), "--data-stdin"
    else:
        return False, None
    try:
        return True, json.loads(text)
    except ValueError as exc:
        raise CliError(EXIT_USAGE, "请求体不是合法的 JSON（%s）：第 %s 行第 %s 列附近。" % (
            where, getattr(exc, "lineno", "?"), getattr(exc, "colno", "?")), code="body_invalid_json")


def _content_type(resp: HttpResponse) -> str:
    return (resp.header("Content-Type") or "").split(";")[0].strip().lower()


def _is_text_type(ctype: str) -> bool:
    return ctype.startswith("text/") or ctype in ("application/xml", "application/x-ndjson", "application/yaml") \
        or ctype.endswith("+xml")


def _is_json_type(ctype: str) -> bool:
    return ctype == "application/json" or ctype.endswith("+json")


def _save_output(path_text: str, data: bytes) -> Path:
    target = Path(path_text).expanduser()
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(str(target), "wb") as handle:
            handle.write(data)
    except OSError as exc:
        raise CliError(EXIT_USAGE, "写不了输出文件 %s：%s" % (path_text, exc.strerror or exc), code="output_unwritable")
    return target


def _stdout_write(text: str) -> None:
    _write(sys.stdout, text)


def _print_stream(ui: Ui, resp: HttpResponse) -> Tuple[List[Any], int]:
    """流式响应（SSE）：人类可读模式边收边打印；--json 模式收集 data: 里的 JSON 事件（最多 MAX_STREAM_EVENTS 个）。
    两种模式都按字段名脱敏（password / token / api_key …），密钥串再由输出脱敏器兜底。→（事件，丢弃的事件数）"""
    events: List[Any] = []
    dropped = 0
    redactor = StreamRedactor(_stdout_write)
    try:
        for frame in iter_sse(resp.stream):
            frame = mask_sensitive(frame)
            if ui.json_mode:
                if len(events) < MAX_STREAM_EVENTS:
                    events.append(frame)
                else:
                    dropped += 1
            else:
                redactor.feed((json.dumps(frame, ensure_ascii=False) if not isinstance(frame, str) else frame) + "\n")
    finally:
        redactor.flush()
        resp.close()
    return events, dropped


def cmd_call(ctx: Context) -> int:
    ui, args = ctx.ui, ctx.args
    session = ctx.session()
    rec = session.record()                       # 要先连接（dry-run 也要平台地址）；这里不续期
    discovery = Discovery(session)
    params = _parse_pairs(args.param, "-p")
    extra_query = _parse_pairs(args.query, "-q")
    has_body, body = read_body(args)

    op: Optional[dict] = None
    if args.op_id:
        if args.method or args.path:
            raise CliError(EXIT_USAGE, "--id 与 METHOD PATH 只能给一种。", code="usage")
        index = discovery.operations_index(offline=args.dry_run)
        if index is None:
            raise CliError(EXIT_PLATFORM if not args.dry_run else EXIT_USAGE,
                           "按操作 id 调用需要能力发现，但现在拿不到操作列表。", code="discovery_unavailable",
                           hint="改用 call <METHOD> <PATH>。" + ("（dry-run 只读本地缓存，可先运行一次 ops。）" if args.dry_run else ""))
        op = next((o for o in index["operations"] if o.get("id") == args.op_id), None)
        if op is None or not isinstance(op.get("path"), str):
            raise CliError(EXIT_NOT_FOUND, "没有这个操作 id：%s。" % args.op_id, code="operation_not_found",
                           hint="用 ops --search <关键词> 查找。")
        method, raw_path = str(op.get("method") or "").upper(), op["path"]
    else:
        if not (args.method and args.path):
            raise CliError(EXIT_USAGE, "请给出 METHOD PATH，如 call GET /api/v2/…（或 --id 操作 id）。", code="usage")
        method, raw_path = args.method.upper(), args.path
    if method not in HTTP_METHODS:
        raise CliError(EXIT_USAGE, "不认识的请求方法：%s（可用 %s）。" % (method, "/".join(HTTP_METHODS)), code="usage")
    base, inline_query = split_api_path(raw_path)
    is_template = bool(_PLACEHOLDER_RE.search(base))
    path = fill_path(base, params) if (is_template or params) else base
    query = inline_query + extra_query

    if op is None:
        index = discovery.operations_index(offline=args.dry_run)
        if index is not None:
            op = find_operation(index["operations"], method, base if is_template else urllib.parse.unquote(path),
                                is_template=is_template)
    risk, risk_source = resolve_risk(op, method)
    needed = required_flags(risk)
    preview = request_preview(rec["origin"], method, path, query, has_body, body)
    preview.update({"risk": risk, "risk_source": risk_source, "operation_id": (op or {}).get("id"),
                    "required_flags": needed})
    source_text = "能力发现" if risk_source == "discovery" else "按请求方法推断"

    if args.dry_run:
        if ui.json_mode:
            ui.emit({"ok": True, "dry_run": True, "request": preview})
        else:
            ui.say("dry-run：不会发送任何请求。将要执行：")
            for line in _preview_lines(preview):
                ui.say(line)
            ui.say("风险：%s（%s，%s）" % (risk, _RISK_LABELS.get(risk, risk), source_text))
            ui.say("需要的确认：%s" % (" ".join(needed) if needed else "无（只读）"))
        return EXIT_OK

    missing = [flag for flag in needed if not getattr(args, flag.lstrip("-").replace("-", "_"))]
    if missing:
        if risk == "write":
            message = "需要用户确认：这是写操作（risk=write，%s），会修改平台上的数据。" % source_text
            hint = "只有在用户明确同意这一具体操作后，才加 --yes 重新执行；不要为了省事预先加上。"
        else:
            message = "需要用户单独确认：这是%s（risk=%s，%s）。" % (_RISK_LABELS.get(risk, "高风险操作"), risk, source_text)
            hint = "先向用户说明后果，得到对这一操作的单独确认后，再加 --yes --confirm-destructive 重新执行。"
        message += "\n将要执行的请求：\n" + "\n".join(_preview_lines(preview))
        raise CliError(EXIT_CONFIRM, message, code="confirmation_required", hint=hint,
                       extra={"request": preview, "missing_flags": missing})

    if op is not None and op.get("allowed") is False:
        ui.note("提示：能力发现显示这个操作对你不可用（%s），仍按要求尝试调用。" % (op.get("denied_reason") or "—"))
    streaming = bool(op and op.get("streaming"))
    headers = {"Accept": "text/event-stream"} if streaming else {}
    payload = None
    if has_body:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    resp = session.request(method, path, query=query or None, body=payload, headers=headers, stream=streaming)
    if not resp.ok:
        resp.close()
        raise api_error(resp, action="%s %s" % (method, base))

    ctype = _content_type(resp)
    if resp.stream is not None:
        events, dropped = _print_stream(ui, resp)
        if ui.json_mode:
            out = {"ok": True, "status": resp.status, "method": method, "path": path, "risk": risk, "events": events}
            if dropped:
                out["events_dropped"] = dropped
            ui.emit(out)
        return EXIT_OK
    if args.output:
        target = _save_output(args.output, resp.body)
        if ui.json_mode:
            ui.emit({"ok": True, "status": resp.status, "method": method, "path": path, "risk": risk,
                     "saved_to": str(target), "bytes": len(resp.body), "content_type": ctype or None})
        else:
            ui.say("已保存到 %s（%d 字节，%s）。" % (target, len(resp.body), ctype or "未知类型"))
        return EXIT_OK
    parsed = resp.json() if resp.body else None
    if resp.body and parsed is None and not (_is_text_type(ctype) or _is_json_type(ctype)):
        message = "响应是二进制内容（%d 字节，%s），没有直接打印；需要时加 --output 文件 保存。" % (len(resp.body), ctype or "未知类型")
        if ui.json_mode:
            ui.emit({"ok": True, "status": resp.status, "method": method, "path": path, "risk": risk,
                     "binary": True, "bytes": len(resp.body), "content_type": ctype or None})
        else:
            ui.say(message)
        return EXIT_OK
    if args.raw:
        text = json.dumps(mask_sensitive(parsed), ensure_ascii=False, separators=(",", ":")) if parsed is not None \
            else resp.text()
        if ui.json_mode:
            ui.emit({"ok": True, "status": resp.status, "method": method, "path": path, "risk": risk,
                     "body": mask_sensitive(parsed) if parsed is not None else text})
        else:
            ui.say(text)
        return EXIT_OK
    data = _unwrap(resp) if parsed is not None else None
    if ui.json_mode:
        out = {"ok": True, "status": resp.status, "method": method, "path": path, "risk": risk}
        if parsed is not None:
            out["data"] = mask_sensitive(data)
        elif resp.body:
            out["text"] = resp.text()
        ui.emit(out)
        return EXIT_OK
    if parsed is not None:
        ui.say(json.dumps(mask_sensitive(data), ensure_ascii=False, indent=2))
    elif resp.body:
        ui.say(resp.text())
    else:
        ui.say("成功（HTTP %d，没有响应体）。" % resp.status)
    return EXIT_OK


# ---------------------------------------------------------------------------------------------- wait：通用轮询
_TRANSIENT_STATUSES = (429, 502, 503, 504)
MAX_TRANSIENT_FAILURES = 5


def get_field(obj: Any, dotted: str) -> Tuple[bool, Any]:
    """按点路径取值（data.items.0.status）；取不到 → (False, None)。"""
    current = obj
    for part in dotted.split("."):
        if isinstance(current, dict) and part in current:
            current = current[part]
        elif isinstance(current, list) and re.fullmatch(r"-?\d+", part) and -len(current) <= int(part) < len(current):
            current = current[int(part)]
        else:
            return False, None
    return True, current


def scalar_text(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float, str)):
        return str(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def cmd_wait(ctx: Context) -> int:
    ui, args = ctx.ui, ctx.args
    base, inline_query = split_api_path(args.path)
    params = _parse_pairs(args.param, "-p")
    path = fill_path(base, params) if (_PLACEHOLDER_RE.search(base) or params) else base
    query = inline_query + _parse_pairs(args.query, "-q")
    targets = [item.strip() for item in (args.until or "").split(",") if item.strip()]
    if not targets or not (args.field or "").strip():
        raise CliError(EXIT_USAGE, "需要 --field 字段路径 与 --until 值1,值2。", code="usage")
    field_path = args.field.strip()
    interval = float(args.interval)
    total = float(getattr(args, "total_timeout", None) or 3600.0)
    session = ctx.session()
    started = time.monotonic()
    deadline = _deadline(total)
    polls, failures, last_text = 0, 0, None
    while True:
        polls += 1
        wait_for = interval
        try:
            resp = session.request("GET", path, query=query or None)
        except CliError as err:
            if err.code != "network_error" or failures >= MAX_TRANSIENT_FAILURES:
                raise
            failures += 1
            ui.note("提示：第 %d 次轮询没连上平台，稍后继续。" % polls)
            resp = None
        if resp is not None and resp.ok:
            failures = 0
            body = resp.json()
            found, value = get_field(body, field_path)
            if not found:
                keys = sorted(body.keys()) if isinstance(body, dict) else []
                raise CliError(EXIT_USAGE, "响应里没有字段 %s。" % field_path, code="field_missing",
                               hint=("顶层字段有：%s（统一外壳下业务数据在 data 里）。" % "、".join(keys)) if keys else None)
            text = scalar_text(value)
            if text != last_text:
                ui.note("%s = %s（已等待 %s）" % (field_path, text, human_duration(_elapsed(started))))
                last_text = text
            if text in targets:
                data = _unwrap(resp)
                if ui.json_mode:
                    ui.emit({"ok": True, "field": field_path, "value": value, "polls": polls,
                             "elapsed_seconds": int(_elapsed(started)), "data": mask_sensitive(data)})
                else:
                    ui.say("已达到：%s = %s（轮询 %d 次，用时 %s）" % (field_path, text, polls,
                                                                 human_duration(_elapsed(started))))
                    ui.say(json.dumps(mask_sensitive(data), ensure_ascii=False, indent=2))
                return EXIT_OK
        elif resp is not None:
            if resp.status not in _TRANSIENT_STATUSES or failures >= MAX_TRANSIENT_FAILURES:
                raise api_error(resp, action="轮询 %s" % base)
            failures += 1
            if resp.status == 429:
                wait_for = max(interval, _retry_after(resp, interval, 300.0))
            ui.note("提示：平台暂时繁忙（HTTP %d），稍后继续轮询。" % resp.status)
        remaining = _remaining(deadline)
        if remaining <= 0:
            raise CliError(EXIT_CONFLICT, "等待超时（%s）：%s 仍是 %s。" % (human_duration(total), field_path, last_text or "—"),
                           code="wait_timeout", hint="任务可能还在进行，可以再次 wait，或用 call GET 查看详情。",
                           extra={"field": field_path, "value": last_text, "polls": polls})
        _sleep(min(wait_for, remaining))


# ---------------------------------------------------------------------------------------------- chat：会话流（规格 §5.3）
DEFAULT_CHAT_TIMEOUT = 1800.0
MAX_CHAT_MESSAGE_CHARS = 50000         # 与平台 SendMessageRequest.content 上限一致
MAX_RESUME_FAILURES = 5                # 续播连续失败这么多次就放弃（期间收到事件会清零）
MAX_TOOL_TEXT = 2000                   # --json 输出里每个工具的输入 / 结果最多保留这么多字符
MAX_TOOL_ACCUM = 256 * 1024            # 工具输入先攒到这么多再脱敏、截断（JSON 要完整才能按字段名脱敏）
MAX_REMEMBERED_AGENTS = 50
CHAT_MEMORY_FILE = "chat-sessions.json"
_CHAT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:@\-]{0,199}$")
_BUSY_BACKOFF = (5.0, 10.0, 15.0)      # 409 排队：第 1 / 2 / 3+ 次等待秒数


def _chat_id(value: Optional[str], flag: str) -> str:
    text = (value or "").strip()
    if not _CHAT_ID_RE.match(text):
        raise CliError(EXIT_USAGE, "%s 的格式不对：%s" % (flag, value), code="usage",
                       hint="只能是字母、数字与 _ . : @ -（用 ops / call 查到的 id）。")
    return text


class ChatMemory:
    """记住每个 Agent 最近一次对话的会话（~/.nexus/cache/<profile>/chat-sessions.json），chat 默认接着聊。"""

    def __init__(self, session: Session) -> None:
        self.store = session.store
        self.profile = session.profile

    @property
    def path(self) -> Path:
        return self.store.cache_dir(self.profile) / CHAT_MEMORY_FILE

    def _read(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        agents = data.get("agents") if isinstance(data, dict) else None
        return agents if isinstance(agents, dict) else {}

    def _write(self, agents: dict) -> None:
        try:
            self.store.ensure_cache_dir(self.profile)
            write_private_json(self.path, {"version": 1, "agents": agents})
        except OSError:
            pass  # 记不住只影响下次默认接哪个会话

    def get(self, agent_id: str) -> Optional[str]:
        entry = self._read().get(agent_id)
        sid = entry.get("session_id") if isinstance(entry, dict) else None
        return sid if isinstance(sid, str) and _CHAT_ID_RE.match(sid) else None

    def remember(self, agent_id: str, session_id: str) -> None:
        agents = self._read()
        agents[agent_id] = {"session_id": session_id, "updated_at": iso(utcnow())}
        if len(agents) > MAX_REMEMBERED_AGENTS:
            keep = sorted(agents.items(), key=lambda kv: str((kv[1] or {}).get("updated_at") or ""), reverse=True)
            agents = dict(keep[:MAX_REMEMBERED_AGENTS])
        self._write(agents)

    def forget(self, agent_id: str) -> None:
        agents = self._read()
        if agents.pop(agent_id, None) is not None:
            self._write(agents)


def _clip(text: Any, limit: int = MAX_TOOL_TEXT) -> str:
    value = text if isinstance(text, str) else json.dumps(text, ensure_ascii=False)
    return value if len(value) <= limit else value[:limit] + "…（已截断）"


def _masked_tool_text(text: Any) -> Any:
    """工具输入 / 结果：是 JSON 就按字段名脱敏，否则截断成字符串（密钥串由输出脱敏器兜底）。"""
    if isinstance(text, str):
        with contextlib.suppress(ValueError):
            parsed = json.loads(text)
            if isinstance(parsed, (dict, list)):
                return mask_sensitive(parsed) if len(text) <= MAX_TOOL_TEXT else _clip(json.dumps(
                    mask_sensitive(parsed), ensure_ascii=False))
        return _clip(text)
    if isinstance(text, (dict, list)):
        return mask_sensitive(text)
    return text


class ChatTurn:
    """一轮对话的流式结果：正文、工具、警告、结束状态。人类可读模式下正文边收边写 stdout（脱敏），过程提示写 stderr。

    平台事件（data: {json} 帧）：event=message 时按 type 分 text / tool_use / tool_input / tool_end / message_stop；
    其它 event 有 connected / agent_info / warning / error / interrupted / persist_failed / heartbeat / catchup_done /
    done（persisted 三态：true 已落库、false 落库失败、缺省 = 中继合成的结束，状态未知）。
    Valkey 主路径的每个事件都带 _event_id，断线后按它续播；内联回退模式没有 _event_id，也没有可续播的流。"""

    def __init__(self, ui: Ui) -> None:
        self.ui = ui
        self.parts: List[str] = [""]
        self.tools: List[dict] = []
        self.warnings: List[dict] = []
        self.errors: List[str] = []
        self.last_event_id: Optional[str] = None
        self.events = 0
        self.done = False
        self.persisted: Optional[bool] = None
        self.interrupted = False
        self.busy = False
        self.session_gone = False
        self.model_id: Optional[str] = None
        self.from_history = False
        self.reconciled = False          # done 之后已经和会话历史对过账
        self.incomplete = False          # 内联模式断线：平台会停止这一轮，回复可能不完整
        self.raw = ""                    # 全部正文增量原样拼接（与平台落库的 "".join(assistant_chunks) 同口径）
        self.relay_errors = 0            # 中继读流失败的 error 帧（不是 Agent 的错误，随后断流 → 续播）
        self.stream_key: Optional[str] = None   # 发消息响应头 X-Stream-Key：续播前核对还是不是这一轮
        self._current_tool: Optional[dict] = None
        self._redactor = None if ui.json_mode else StreamRedactor(_stdout_write)
        self._open_line = False          # stdout 上有没写完的一行（写 stderr 提示前先换行）
        self._paragraph_pending = False  # 工具调用之后的正文另起一段

    # ------------------------------------------------------------------ 输出
    @property
    def reply(self) -> str:
        return "\n\n".join(part.strip("\n") for part in self.parts if part.strip())

    @property
    def has_output(self) -> bool:
        return bool(self.reply) or bool(self.tools)

    def _say_text(self, text: str) -> None:
        if self._redactor is None or not text:
            return
        self._redactor.feed(text)
        self._open_line = not text.endswith("\n")

    def _end_line(self) -> None:
        if self._redactor is None:
            return
        self._redactor.flush()
        if self._open_line:
            _stdout_write("\n")
            self._open_line = False

    def note(self, text: str) -> None:
        self._end_line()
        self.ui.note(text)

    def finish_output(self) -> None:
        self._end_line()

    # ------------------------------------------------------------------ 事件
    def feed(self, frame: Any) -> None:
        if not isinstance(frame, dict):
            return
        self.events += 1
        event_id = frame.get("_event_id")
        if isinstance(event_id, str) and event_id:
            self.last_event_id = event_id
        kind = frame.get("event")
        if kind == "message":
            self._message(frame)
        elif kind == "agent_info":
            if isinstance(frame.get("model_id"), str) and frame["model_id"]:
                self.model_id = frame["model_id"]
        elif kind == "warning":
            warning = {k: frame.get(k) for k in ("code", "message", "requested", "resolved") if frame.get(k)}
            self.warnings.append(warning)
            if warning.get("code") == "model_not_permitted":
                self.note("提示：模型 %s 不在你的可用范围内，这一轮改用 Agent 的默认模型。" % (warning.get("requested") or "—"))
            else:
                self.note("提示：%s" % (warning.get("message") or warning.get("code") or "平台给出了一条警告"))
        elif kind == "error":
            if not frame.get("_event_id") and self.last_event_id is not None:
                # 走 Valkey 主路径时，Agent 的错误都带 _event_id；不带的是中继自己读流失败（随后断流），
                # 这一轮多半还在正常进行 —— 按断线处理、续播，不能当成 Agent 出错（否则会诱导重发）
                self.relay_errors += 1
                self.note("提示：平台转发这一轮的输出时中断了一下，正在接着读……")
                return
            raw = frame.get("error") or frame.get("message") or frame.get("data") or frame.get("code") or "未知错误"
            text = _clip(raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False), 500)
            self.errors.append(text)
            self.note("Agent 出错：%s" % text)
        elif kind == "interrupted":
            self.interrupted = True
            self.note("这一轮被停止了（可能有人在网页上点了停止）。")
        elif kind == "persist_failed":
            self.note("提示：这一轮的%s消息没能保存到会话历史。" % ("用户" if frame.get("role") == "user" else "回复"))
        elif kind == "done":
            self.done = True
            if isinstance(frame.get("persisted"), bool):
                self.persisted = frame["persisted"]
            self.busy = bool(frame.get("busy"))
            self.session_gone = bool(frame.get("session_gone"))

    def _message(self, frame: dict) -> None:
        mtype = frame.get("type")
        if mtype == "text":
            text = frame.get("data")
            if not isinstance(text, str) or not text:
                return
            if self._paragraph_pending:
                self._paragraph_pending = False
                if self.reply:
                    self._end_line()
                    if self._redactor is not None:
                        _stdout_write("\n")
            self.parts[-1] += text
            self.raw += text
            self._say_text(text)
        elif mtype == "tool_use":
            if self.parts[-1].strip():
                self.parts.append("")
            self._paragraph_pending = True
            tool = {"name": str(frame.get("tool_name") or "?"), "id": frame.get("tool_id") or None, "input": "",
                    "result": None, "finished": False}
            self.tools.append(tool)
            self._current_tool = tool
            self.note("· 调用工具 %s" % tool["name"])
        elif mtype == "tool_input":
            # 先攒到较大的上限再截断：输入是 JSON 时要能完整解析，才能按字段名脱敏
            tool = self._current_tool
            if tool is not None and isinstance(frame.get("data"), str) and len(tool["input"]) <= MAX_TOOL_ACCUM:
                tool["input"] += frame["data"]
        elif mtype == "tool_end":
            tool = self._match_tool(frame)
            if isinstance(frame.get("tool_input"), str) and frame["tool_input"] and not tool["input"]:
                tool["input"] = frame["tool_input"][:MAX_TOOL_ACCUM]
            if "tool_result" in frame and frame.get("tool_result") is not None:
                tool["result"] = frame["tool_result"] if isinstance(frame["tool_result"], str) else json.dumps(
                    frame["tool_result"], ensure_ascii=False)
                if not tool["finished"]:
                    tool["finished"] = True
                    self.note("· 工具 %s 完成" % tool["name"])
            if tool is self._current_tool and tool["finished"]:
                self._current_tool = None

    def _match_tool(self, frame: dict) -> dict:
        tool_id = frame.get("tool_id")
        if tool_id:
            for tool in reversed(self.tools):
                if tool.get("id") == tool_id:
                    return tool
        if self._current_tool is not None:
            return self._current_tool
        name = str(frame.get("tool_name") or "?")
        for tool in reversed(self.tools):
            if tool["name"] == name and not tool["finished"]:
                return tool
        tool = {"name": name, "id": tool_id or None, "input": "", "result": None, "finished": False}
        self.tools.append(tool)
        return tool

    # ------------------------------------------------------------------ 续播与历史
    def restart_replay(self) -> None:
        """没有 _event_id 可续（只能从头回放）：清掉已收的内容，避免重复。"""
        if self.has_output:
            self.note("提示：连接中断后只能从头回放这一轮，下面重新输出完整回复。")
        self.parts, self.tools, self._current_tool = [""], [], None
        self.raw = ""
        self._paragraph_pending = False

    def adopt_history(self, content: str, *, reason: str = "流已经过期") -> None:
        """以会话历史里保存的回复为准（只补打还没输出的部分）。平台落库的是全部正文增量原样拼接，所以拿 raw 比前缀。"""
        streamed = self.raw
        self.from_history = True
        self.done = True
        if self.persisted is None:
            self.persisted = True
        if streamed and content.startswith(streamed):
            rest = content[len(streamed):]
        elif content.strip() in (streamed.strip(), self.reply.strip()):
            rest = ""
        else:
            if streamed:
                self.note("提示：%s，以下为会话历史里保存的完整回复。" % reason)
            rest = content
        self.parts = [content]
        self.raw = content
        if rest:
            self._say_text(rest)

    def summary(self) -> dict:
        return {
            "reply": self.reply,
            "tools": [{"name": t["name"], "id": t.get("id"), "input": _masked_tool_text(t["input"]) if t["input"] else None,
                       "result": _masked_tool_text(t["result"]) if t["result"] is not None else None,
                       "finished": t["finished"]} for t in self.tools],
            "warnings": self.warnings,
            "errors": self.errors,
            "persisted": self.persisted,
            "interrupted": self.interrupted,
            "model_id": self.model_id,
            "from_history": self.from_history,
            "reconciled": self.reconciled,
        }


def _consume_stream(turn: ChatTurn, resp: HttpResponse, deadline: float) -> str:
    """读一段 SSE，直到 done / 断线 / 总时长用完 → "done" | "disconnected" | "timeout"。

    平台在等待期间每 15 秒发一次心跳，所以总时长按帧检查即可；读超时 / 连接被重置都按断线处理（随后续播）。"""
    try:
        for frame in iter_sse(resp.stream):
            turn.feed(frame)
            if turn.done:
                return "done"
            if _remaining(deadline) <= 0:
                return "timeout"
        return "disconnected"
    except (OSError, http.client.HTTPException, ValueError):
        return "disconnected"
    finally:
        resp.close()


def _create_chat_session(session: Session, agent_id: str) -> str:
    resp = session.request("POST", fill_path(AGENT_SESSIONS_PATH, [("agent_id", agent_id)]), body={})
    if resp.status == 404:
        raise CliError(EXIT_NOT_FOUND, "平台上没有这个 Agent：%s。" % agent_id, code="agent_not_found", http_status=404,
                       hint="用 ops --search agent 或 call 列出 Agent，确认 id 后再试。")
    if not resp.ok:
        raise api_error(resp, action="新建会话")
    data = _unwrap(resp)
    sid = data.get("session_id") if isinstance(data, dict) else None
    if not isinstance(sid, str) or not _CHAT_ID_RE.match(sid):
        raise CliError(EXIT_PLATFORM, "新建会话的响应里没有会话 id。", code="session_response_invalid")
    return sid


def _latest_assistant_reply(session: Session, sid: str) -> Optional[str]:
    """会话历史里最新一条消息是 Agent 的回复 → 它的正文；最新一条是用户消息（这一轮没有保存的回复）→ None。"""
    resp = session.request("GET", fill_path(SESSION_MESSAGES_PATH, [("session_id", sid)]), query=[("limit", "20")])
    if not resp.ok:
        raise api_error(resp, action="读取会话历史")
    items = _unwrap(resp)
    for item in reversed(items if isinstance(items, list) else []):
        if not isinstance(item, dict):
            continue
        if item.get("role") == "assistant":
            content = item.get("content")
            return content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
        if item.get("role") == "user":
            return None
    return None


def _open_events(session: Session, sid: str, after: str) -> Optional[HttpResponse]:
    """GET …/stream/events?after=：200 → 流；410（流已过期 / 不存在）→ None；网络错误照抛（调用方重试）。"""
    resp = session.request("GET", fill_path(SESSION_EVENTS_PATH, [("session_id", sid)]), query=[("after", after)],
                           headers={"Accept": "text/event-stream"}, stream=True)
    if resp.status == 410:
        resp.close()
        return None
    if not resp.ok:
        resp.close()
        if resp.status in _TRANSIENT_STATUSES:
            raise CliError(EXIT_PLATFORM, "续播时平台暂时繁忙（HTTP %d）。" % resp.status, code="network_error",
                           http_status=resp.status)
        raise api_error(resp, action="续播会话")
    return resp


def _current_stream_key(session: Session, sid: str) -> Optional[str]:
    """会话当前这一轮的流标识（GET …/stream/status 的 stream_key）；读不到返回 None（不阻断续播）。"""
    try:
        resp = session.request("GET", fill_path(SESSION_STATUS_PATH, [("session_id", sid)]))
    except CliError:
        return None
    if not resp.ok:
        return None
    data = _unwrap(resp)
    key = data.get("stream_key") if isinstance(data, dict) else None
    return key if isinstance(key, str) and key else None


def _follow_turn(turn: ChatTurn, session: Session, sid: str, outcome: str, deadline: float) -> Tuple[str, int]:
    """断线 → 按最后一个 _event_id 续播；流已过期 → 以会话历史为准。→（最终结果，续播次数）。

    续播接口返回的是会话「最近一轮」的流：发消息时拿到了这一轮的 X-Stream-Key 的，续播前先核对会话当前的 stream_key，
    不一致说明会话里已经开始了新的一轮（网页上又发了消息），不能把新一轮的内容拼进来。"""
    resumes, failures = 0, 0
    while outcome == "disconnected":
        if _remaining(deadline) <= 0:
            return "timeout", resumes
        if failures >= MAX_RESUME_FAILURES:
            raise CliError(EXIT_PLATFORM, "和平台的连接反复中断，已停止等待。", code="stream_lost",
                           hint="这一轮可能仍在进行：稍后用 chat --attach（带同一个 --session-id）接着看，不要重发消息。",
                           extra=dict(turn.summary(), session_id=sid, partial=True))
        if failures:
            _sleep(min(2.0 ** failures, 30.0, max(_remaining(deadline), 0.0)))
        failures += 1
        if turn.stream_key:
            current = _current_stream_key(session, sid)
            if current and current != turn.stream_key:
                raise CliError(EXIT_CONFLICT, "会话里已经开始了新的一轮对话，不能再接着读这一轮的输出。", code="turn_superseded",
                               hint="这一轮的回复以会话历史为准：到 Nexus 网页查看这个会话，或稍后用 chat --attach 看最新一轮。",
                               extra=dict(turn.summary(), session_id=sid, partial=True))
        after = turn.last_event_id or "0"
        inline_suspect = after == "0" and turn.events > 0          # 收到过事件却没有 _event_id：内联回退模式
        if after == "0":
            turn.restart_replay()
        try:
            resp = _open_events(session, sid, after)
        except CliError as err:
            if err.code == "network_error":
                continue
            raise
        if resp is None:
            content = _latest_assistant_reply(session, sid)
            if content is not None:
                turn.adopt_history(content)
            else:
                turn.done = True
                turn.note("提示：这一轮的流已经结束，会话历史里也没有它的回复（可能没有保存成功）。")
            # 内联模式下客户端一断开，平台就会停止这一轮：历史里即便有内容，也可能是半截
            turn.incomplete = inline_suspect
            return "done", resumes
        resumes += 1
        before = turn.events
        outcome = _consume_stream(turn, resp, deadline)
        if turn.events > before:
            failures = 0
    return outcome, resumes


def _reconcile_with_history(turn: ChatTurn, session: Session, sid: str) -> None:
    """done 之后与会话历史对账（续播过、--attach 回放、或结束时保存状态未知时做）。

    平台在一轮结束时会把流裁到约 2000 条事件：长轮次从头回放会缺开头，断点被裁掉时续播会缺中间；
    中继发现流已消失时合成的 done 不带 persisted。以历史里保存的回复为准，补上缺的部分。"""
    if turn.from_history or turn.errors or turn.persisted is False:
        return
    try:
        content = _latest_assistant_reply(session, sid)
    except CliError:
        turn.note("提示：没能读取会话历史来核对这一轮的回复，上面的内容可能不完整。")
        return
    if content is None:
        return
    if content.strip() != turn.raw.strip():
        turn.adopt_history(content, reason="中途有部分输出没有收到")
    turn.reconciled = True


def _chat_result(ui: Ui, turn: ChatTurn, *, agent_id: str, sid: str, created: bool, resumes: int, queued: int,
                 started: float, attach: bool) -> int:
    turn.finish_output()
    info = dict(turn.summary(), agent_id=agent_id, session_id=sid, session_created=created, attached=attach,
                resumed=resumes, queued_retries=queued, elapsed_seconds=int(_elapsed(started)))
    if turn.errors:
        raise CliError(EXIT_PLATFORM, "Agent 这一轮出错了：%s" % turn.errors[-1], code="agent_error",
                       hint="先到 Nexus 网页查看这个会话确认结果；确有需要再换个说法重试（避免同一操作执行两次）。", extra=info)
    if turn.incomplete:
        raise CliError(EXIT_PLATFORM, "和平台的连接中断了，这一轮可能没有完成（这种运行方式下平台会在连接断开时停止这一轮）。",
                       code="stream_lost", hint="上面是会话历史里保存下来的部分；需要时到 Nexus 网页查看，或再发一条消息接着做。",
                       extra=dict(info, partial=True))
    if turn.persisted is False:
        ui.note("提示：这一轮的回复没能保存到会话历史（persisted=false），网页上刷新后可能看不到。")
    if ui.json_mode:
        ui.emit(dict(info, ok=True))
        return EXIT_OK
    if not turn.reply:
        ui.say("（这一轮没有文字回复）")
    marks = ["会话 %s" % sid]
    if created:
        marks.append("新建")
    if turn.tools:
        marks.append("调用工具 %d 次" % len(turn.tools))
    if turn.interrupted:
        marks.append("已被停止")
    if turn.persisted is None and not turn.from_history:
        marks.append("保存状态未知")
    ui.say("")
    ui.say("[%s]" % " · ".join(marks))
    return EXIT_OK


def cmd_chat(ctx: Context) -> int:
    ui, args = ctx.ui, ctx.args
    agent_id = _chat_id(args.agent_id, "--agent-id")
    explicit_sid = _chat_id(args.session_id, "--session-id") if args.session_id is not None else None
    if args.attach and args.new_session:
        raise CliError(EXIT_USAGE, "--attach 是接着看已有会话，不能与 --new-session 同时用。", code="usage")
    message = None
    if not args.attach:
        if args.message is not None:
            message = args.message
        elif args.message_stdin:
            message = _read_stdin("消息")
        if message is None or not message.strip():
            raise CliError(EXIT_USAGE, "请用 --message 或 --message-stdin 给出要发的消息（或用 --attach 只看回复）。",
                           code="usage")
        if len(message) > MAX_CHAT_MESSAGE_CHARS:
            raise CliError(EXIT_USAGE, "消息太长（%d 字符，上限 %d）。" % (len(message), MAX_CHAT_MESSAGE_CHARS),
                           code="message_too_long", hint="长材料请先放进会话的工作空间或附件，再在消息里引用。")
    total = float(getattr(args, "total_timeout", None) or DEFAULT_CHAT_TIMEOUT)
    session = ctx.session()
    memory = ChatMemory(session)
    started = time.monotonic()
    deadline = _deadline(total)
    turn = ChatTurn(ui)

    if args.attach:
        sid = explicit_sid or memory.get(agent_id)
        if sid is None:
            raise CliError(EXIT_USAGE, "没有可以接着看的会话：请用 --session-id 指定。", code="usage")
        outcome, resumes = _follow_turn(turn, session, sid, "disconnected", deadline)
        if outcome == "timeout":
            raise _chat_timeout(turn, agent_id, sid, total)
        _reconcile_with_history(turn, session, sid)       # 从头回放的流可能已被裁掉开头
        return _chat_result(ui, turn, agent_id=agent_id, sid=sid, created=False, resumes=max(0, resumes - 1),
                            queued=0, started=started, attach=True)

    sid = explicit_sid or (None if args.new_session else memory.get(agent_id))
    created = False
    if sid is None:
        sid = _create_chat_session(session, agent_id)
        created = True
    elif not explicit_sid:
        ui.note("接着上次和 %s 的会话 %s（开新会话加 --new-session）。" % (agent_id, sid))
    body: Dict[str, Any] = {"content": message, "client_turn_id": uuid.uuid4().hex}
    if args.model_id:
        body["model_id"] = args.model_id
    queued, transient, busy_noted = 0, 0, False
    while True:
        session.ensure_access()             # 续期放在发送之前：续期失败是普通的网络错误，不是「不确定发没发出」
        try:
            resp = session.request("POST", fill_path(SESSION_STREAM_PATH, [("session_id", sid)]), body=body,
                                   headers={"Accept": "text/event-stream"}, stream=True)
        except CliError as err:
            if err.code == "network_error":
                # 不确定平台收没收到：不自动重发，免得同一条指令被执行两次
                raise CliError(EXIT_PLATFORM, "发送消息时网络中断，不确定平台是否收到了这条消息。", code="chat_send_uncertain",
                               hint="先用 chat --attach --session-id %s 看这一轮有没有在进行或已有回复，再决定是否重发。" % sid,
                               extra={"agent_id": agent_id, "session_id": sid})
            raise
        if resp.ok:
            memory.remember(agent_id, sid)
            turn.stream_key = resp.header("X-Stream-Key") or None
            outcome = _consume_stream(turn, resp, deadline)
            outcome, resumes = _follow_turn(turn, session, sid, outcome, deadline)
            if outcome == "timeout":
                raise _chat_timeout(turn, agent_id, sid, total)
            if turn.session_gone:
                memory.forget(agent_id)
                raise CliError(EXIT_NOT_FOUND, "这个会话已被移进回收站，消息没有发出。", code="session_in_trash",
                               extra={"agent_id": agent_id, "session_id": sid})
            if turn.busy and not turn.has_output:
                turn = ChatTurn(ui)           # 平台没受理这条消息（会话忙）：按 409 排队重发
                resp_status = 409
            else:
                if (resumes or turn.persisted is None) and not turn.incomplete:
                    _reconcile_with_history(turn, session, sid)   # 续播过或保存状态未知：以会话历史为准补齐
                return _chat_result(ui, turn, agent_id=agent_id, sid=sid, created=created, resumes=resumes,
                                    queued=queued, started=started, attach=False)
        else:
            resp_status = resp.status
        remaining = _remaining(deadline)
        if resp_status == 409:
            if remaining <= 0:
                raise CliError(EXIT_CONFLICT, "会话里一直有一轮对话在进行，等了 %s 仍没轮到。" % human_duration(total),
                               code="chat_busy", http_status=409,
                               hint="稍后再发；或用 --new-session 开一个新会话。", extra={"session_id": sid})
            if not busy_noted:
                ui.note("会话 %s 里已有一轮对话在进行，消息排队等待（不会丢）。" % sid)
                busy_noted = True
            _sleep(min(_BUSY_BACKOFF[min(queued, len(_BUSY_BACKOFF) - 1)], max(remaining, 0.0)))
            queued += 1
            continue
        if resp_status in (404, 410) and not explicit_sid and not created:
            memory.forget(agent_id)
            ui.note("上次的会话 %s 已不在了，新建一个会话。" % sid)
            sid = _create_chat_session(session, agent_id)
            created = True
            continue
        if resp_status in (500, 502, 504):
            # 网关 / 服务端错误可能发生在平台已经收下消息、开始执行之后：不自动重发，免得同一条指令执行两次
            raise CliError(EXIT_PLATFORM, "发送消息时平台返回 HTTP %d，不确定这条消息是否已被受理。" % resp_status,
                           code="chat_send_uncertain", http_status=resp_status,
                           hint="先用 chat --attach --session-id %s 看这一轮有没有在进行或已有回复，再决定是否重发。" % sid,
                           extra={"agent_id": agent_id, "session_id": sid})
        if resp_status in (429, 503) and transient < MAX_TRANSIENT_FAILURES and remaining > 0:
            transient += 1
            wait_for = _retry_after(resp, 5.0, 120.0)
            if resp_status == 503:
                ui.note("平台暂时不接收新对话（可能在安全重启维护），%s 后自动重试。" % human_duration(max(wait_for, 1)))
            else:
                ui.note("平台暂时繁忙（HTTP %d），稍后自动重试。" % resp_status)
            _sleep(min(wait_for, max(remaining, 0.0)))
            continue
        if resp_status in (404, 410):
            raise CliError(EXIT_NOT_FOUND, "会话 %s 不存在或已被移进回收站。" % sid, code="session_not_found",
                           http_status=resp_status, hint="不带 --session-id（或加 --new-session）即可新开会话。")
        raise api_error(resp, action="发送消息")


def _chat_timeout(turn: ChatTurn, agent_id: str, sid: str, total: float) -> CliError:
    turn.finish_output()
    return CliError(EXIT_CONFLICT, "等待回复超时（%s）：这一轮可能还在进行。" % human_duration(total), code="chat_timeout",
                    hint="稍后用 chat --agent-id %s --session-id %s --attach 接着看（不会重发消息）。" % (agent_id, sid),
                    extra=dict(turn.summary(), agent_id=agent_id, session_id=sid, partial=True))


# ---------------------------------------------------------------------------------------------- skill-update：接入包自更新（规格 §5.7）
SKILL_NAME = "nexus-ai-operator"
SKILL_ZIP_PATH = CAPABILITIES_PATH + "/skill"
SKILL_MANIFEST_PATH = CAPABILITIES_PATH + "/skill/manifest"
SKILL_STANDARD_DIRS = ("scripts", "references", "assets", "agents", "eval-viewer", "evals", "config")
LOCAL_ONLY_FILES = ("config/instance.json",)     # 本机专属：不参与内容摘要，更新时保留本机的
MAX_SKILL_ZIP_BYTES = 20 * 1024 * 1024
MAX_SKILL_UNPACKED_BYTES = 64 * 1024 * 1024
MAX_SKILL_ENTRIES = 2000
KEEP_SKILL_BACKUPS = 3
_SEMVER_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.\-]+))?(?:\+[0-9A-Za-z.\-]+)?$")


def semver_key(text: Any) -> Optional[tuple]:
    match = _SEMVER_RE.match(str(text or "").strip())
    if not match:
        return None
    major, minor, patch, pre = match.groups()
    return int(major), int(minor), int(patch), 0 if pre else 1, pre or ""   # 预发布版排在正式版之前


def skill_frontmatter(root: Path) -> Dict[str, str]:
    """SKILL.md frontmatter 里的简单 键: 值 行（只取 name / version，不依赖 yaml）。"""
    try:
        text = (root / "SKILL.md").read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return {}
    match = re.match(r"^\ufeff?---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)", text, re.S)
    if not match:
        return {}
    out = {}
    for key in ("name", "version"):
        found = re.search(r"(?m)^%s:[ \t]*[\"']?([^\"'\r\n#]+?)[\"']?[ \t]*(?:#.*)?$" % key, match.group(1))
        if found:
            out[key] = found.group(1).strip()
    return out


def _skill_files(root: Path) -> List[str]:
    out = []
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root).as_posix()
        parts = rel.split("/")
        if any(part.startswith(".") or part == "__pycache__" for part in parts):
            continue
        if path.is_symlink() or not path.is_file() or rel in LOCAL_ONLY_FILES or rel == BUNDLED_CONNECTION_FILE:
            continue
        if len(parts) > 1 and parts[0] not in SKILL_STANDARD_DIRS:
            continue        # 与平台打包规则一致：非标准子目录不进包，也不进摘要
        out.append(rel)
    return out


def skill_content_digest(root: Path) -> str:
    """接入包内容摘要：按相对路径排序，逐行「路径 \\0 文件 sha256 \\n」拼接后取 sha256
    （不含隐藏文件、非标准子目录、本机专属文件与随包的一次性密钥文件）。

    与平台 nexus_utils/capabilities/skill_package.content_digest 逐条一致（tests/test_v0328_cli_e2e.py 交叉校验）。"""
    digest = hashlib.sha256()
    for rel in _skill_files(root):
        file_hash = hashlib.sha256((root / rel).read_bytes()).hexdigest()
        digest.update(rel.encode("utf-8") + b"\0" + file_hash.encode("ascii") + b"\n")
    return digest.hexdigest()


def _bad_package(reason: str) -> CliError:
    return CliError(EXIT_PLATFORM, "下载的接入包不合格：%s；没有做任何替换。" % reason, code="skill_package_invalid")


def extract_skill_zip(data: bytes, dest: Path) -> int:
    """校验并解压接入包（顶层目录必须是 nexus-ai-operator/；拒绝绝对路径、..、符号链接、非标准子目录、超大包）。返回文件数。"""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise _bad_package("不是有效的 zip")
    written, total = 0, 0
    with archive:
        infos = archive.infolist()
        if len(infos) > MAX_SKILL_ENTRIES:
            raise _bad_package("文件数超过 %d" % MAX_SKILL_ENTRIES)
        for info in infos:
            name = info.filename
            if "\\" in name or name.startswith("/") or re.match(r"^[A-Za-z]:", name):
                raise _bad_package("含有不安全的路径 %s" % name)
            parts = name.split("/")
            if parts[0] != SKILL_NAME:
                raise _bad_package("顶层目录必须是 %s/" % SKILL_NAME)
            rel_parts = [part for part in parts[1:] if part != ""]
            if any(part in (".", "..") for part in rel_parts):
                raise _bad_package("含有不安全的路径 %s" % name)
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise _bad_package("不能含有符号链接（%s）" % name)
            if info.is_dir() or not rel_parts:
                continue
            if any(part.startswith(".") or part == "__pycache__" for part in rel_parts):
                continue
            if "/".join(rel_parts) == BUNDLED_CONNECTION_FILE:
                continue        # 自更新包里不该有密钥文件，有也不装：密钥只来自用户生成 API 密钥时下载的接入包
            if len(rel_parts) > 1 and rel_parts[0] not in SKILL_STANDARD_DIRS:
                raise _bad_package("含有非标准子目录 %s/" % rel_parts[0])
            total += max(0, info.file_size)
            if total > MAX_SKILL_UNPACKED_BYTES:
                raise _bad_package("解压后超过 %d MB" % (MAX_SKILL_UNPACKED_BYTES // (1024 * 1024)))
            target = dest.joinpath(*rel_parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            try:
                with archive.open(info) as source:
                    content = source.read(MAX_SKILL_UNPACKED_BYTES + 1)
            except (zipfile.BadZipFile, OSError, RuntimeError) as exc:
                raise _bad_package("读取 %s 失败（%s）" % (name, exc.__class__.__name__))
            if len(content) > MAX_SKILL_UNPACKED_BYTES:
                raise _bad_package("解压后超过 %d MB" % (MAX_SKILL_UNPACKED_BYTES // (1024 * 1024)))
            target.write_bytes(content)
            executable = rel_parts[0] == "scripts" and target.suffix in (".py", ".sh")
            _chmod_quiet(target, 0o755 if executable else 0o644)
            written += 1
    if not (dest / "SKILL.md").is_file() or not (dest / "scripts" / "nexus.py").is_file():
        raise _bad_package("缺少 SKILL.md 或 scripts/nexus.py")
    if skill_frontmatter(dest).get("name") != SKILL_NAME:
        raise _bad_package("SKILL.md 里的 name 不是 %s" % SKILL_NAME)
    return written


def _is_platform_source_tree(root: Path) -> bool:
    """接入包就放在平台源码里（skills/system_skills/nexus-ai-operator）：自更新会改掉源码，一律拒绝。"""
    try:
        return root.parent.name == "system_skills" and root.parent.parent.name == "skills" \
            and (root.parent.parent.parent / "nexus_utils").is_dir()
    except IndexError:  # pragma: no cover
        return False


def _backup_ignore(root: Path):
    """备份时跳过缓存文件，以及接入包里残留的一次性密钥文件（密钥不留副本；更新后也不保留它）。"""
    base = shutil.ignore_patterns("__pycache__", "*.pyc")
    secret_dir, secret_name = os.path.normpath(str(root / BUNDLED_CONNECTION_FILE.rsplit("/", 1)[0])), \
        BUNDLED_CONNECTION_FILE.rsplit("/", 1)[1]

    def ignore(directory, names):
        skipped = set(base(directory, names))
        if secret_name in names and os.path.normpath(str(directory)) == secret_dir:
            skipped.add(secret_name)
        return skipped
    return ignore


def _backup_skill(store: Store, root: Path, version: str) -> Path:
    backups = store.home / "skill-backups"
    ensure_private_dir(store.home)
    ensure_private_dir(backups)
    stamp = utcnow().strftime("%Y%m%d%H%M%S")
    target = backups / ("%s-%s-%s" % (SKILL_NAME, re.sub(r"[^0-9A-Za-z.\-]", "_", version or "unknown"), stamp))
    suffix = 1
    while target.exists():
        suffix += 1
        target = backups / ("%s-%s-%s-%d" % (SKILL_NAME, version or "unknown", stamp, suffix))
    shutil.copytree(str(root), str(target), symlinks=True, ignore=_backup_ignore(root))
    old = sorted((p for p in backups.iterdir() if p.is_dir() and p.name.startswith(SKILL_NAME + "-")),
                 key=lambda p: p.stat().st_mtime)
    for stale in old[:-KEEP_SKILL_BACKUPS]:
        shutil.rmtree(str(stale), ignore_errors=True)
    return target


def cmd_skill_update(ctx: Context) -> int:
    ui, args = ctx.ui, ctx.args
    root = skill_dir()
    session = ctx.session()
    manifest = session.get_data(SKILL_MANIFEST_PATH, action="检查接入包版本")
    if not isinstance(manifest, dict) or manifest.get("name") != SKILL_NAME:
        raise CliError(EXIT_PLATFORM, "平台返回的接入包清单不对。", code="skill_manifest_invalid")
    remote_version = str(manifest.get("version") or "")
    remote_key = semver_key(remote_version)
    if remote_key is None:
        raise CliError(EXIT_PLATFORM, "平台返回的接入包版本号不合法：%s" % remote_version, code="skill_manifest_invalid")
    local_version = skill_frontmatter(root).get("version") or CLI_VERSION
    local_key = semver_key(local_version)
    if local_key is None or remote_key > local_key:
        status = "update_available"
    elif remote_key == local_key:
        status = "up_to_date"
    else:
        status = "local_newer"
    expected = str(manifest.get("sha256") or "").strip().lower()
    local_digest = skill_content_digest(root)
    report = {"name": SKILL_NAME, "local_version": local_version, "remote_version": remote_version, "status": status,
              "remote_sha256": expected or None, "local_content_sha256": local_digest,
              "discovery_version": manifest.get("discovery_version"), "skill_dir": str(root)}
    will_install = not args.check and (status == "update_available" or args.force)
    if not will_install:
        if ui.json_mode:
            ui.emit(dict(report, ok=True, updated=False))
        else:
            label = {"update_available": "有新版本 %s（本机 %s）" % (remote_version, local_version),
                     "up_to_date": "已是最新（%s）" % local_version,
                     "local_newer": "本机版本 %s 比平台提供的 %s 新，不降级" % (local_version, remote_version)}[status]
            ui.say("接入包：%s。" % label)
            if status == "update_available":
                ui.say("运行 skill-update（不带 --check）即可更新；更新前会自动备份。")
        return EXIT_OK
    if _is_platform_source_tree(root):
        raise CliError(EXIT_USAGE, "这份接入包在平台源码目录里（%s），不能自更新。" % root, code="skill_in_source_tree",
                       hint="源码里的接入包随代码提交更新；请在下载解压的接入包里运行 skill-update。")
    if not expected:
        raise CliError(EXIT_PLATFORM, "平台的接入包清单没有 sha256，无法校验，已停止更新。", code="skill_manifest_invalid")
    resp = session.request("GET", SKILL_ZIP_PATH, headers={"Accept": "application/zip"},
                           timeout=max(ctx.http_timeout, 120.0))
    if not resp.ok:
        raise api_error(resp, action="下载接入包")
    data = resp.body
    if len(data) > MAX_SKILL_ZIP_BYTES:
        raise _bad_package("超过 %d MB" % (MAX_SKILL_ZIP_BYTES // (1024 * 1024)))
    zip_digest = hashlib.sha256(data).hexdigest()
    try:
        staging = Path(tempfile.mkdtemp(prefix=".nexus-ai-operator-update-", dir=str(root.parent)))
    except OSError as exc:
        raise CliError(EXIT_PLATFORM, "接入包所在目录不可写（%s）：%s" % (root.parent, exc.strerror or exc),
                       code="skill_dir_unwritable")
    try:
        new_root = staging / SKILL_NAME
        new_root.mkdir()
        count = extract_skill_zip(data, new_root)
        content_digest = skill_content_digest(new_root)
        if expected not in (zip_digest, content_digest):
            raise CliError(EXIT_PLATFORM, "接入包校验失败（sha256 与平台清单不符），没有做任何替换。",
                           code="skill_checksum_mismatch", hint="可能是下载被篡改或平台正在更新，请稍后重试。")
        new_version = skill_frontmatter(new_root).get("version") or ""
        if semver_key(new_version) != remote_key:
            raise _bad_package("包里的版本 %s 与清单 %s 不一致" % (new_version or "—", remote_version))
        for rel in LOCAL_ONLY_FILES:                       # 本机专属文件（预置的平台地址）以本机为准
            mine = root / rel
            if mine.is_file():
                (new_root / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(str(mine), str(new_root / rel))
        backup = _backup_skill(ctx.store, root, local_version)
        previous = staging / "previous"
        os.replace(str(root), str(previous))
        try:
            os.replace(str(new_root), str(root))
        except OSError:
            os.replace(str(previous), str(root))            # 换不上：原样放回
            raise
    except OSError as exc:
        raise CliError(EXIT_PLATFORM, "替换接入包目录失败：%s" % (exc.strerror or exc), code="skill_replace_failed",
                       hint="原接入包没有改动；可检查目录权限后重试。")
    finally:
        shutil.rmtree(str(staging), ignore_errors=True)
    if ui.json_mode:
        ui.emit(dict(report, ok=True, updated=True, installed_version=remote_version, files=count,
                     backup=str(backup), verified_by="zip" if expected == zip_digest else "content"))
    else:
        ui.say("接入包已从 %s 更新到 %s（%d 个文件，已校验 sha256）。" % (local_version, remote_version, count))
        ui.say("旧版本备份在 %s。" % backup)
        ui.say("请重新读取 SKILL.md：使用方法可能有变化。")
    return EXIT_OK


# ---------------------------------------------------------------------------------------------- 参数解析
_ARGPARSE_ZH = {
    "usage: ": "用法：",
    "positional arguments": "位置参数",
    "options": "选项",
    "optional arguments": "选项",
    "show this help message and exit": "显示帮助并退出",
    "the following arguments are required: %s": "缺少必填参数：%s",
    "unrecognized arguments: %s": "不认识的参数：%s",
    "expected one argument": "需要一个值",
    "not allowed with argument %s": "不能与 %s 同时使用",
    "one of the arguments %s is required": "必须给出其中之一：%s",
    "invalid choice: %(value)r (choose from %(choices)s)": "无效的选择：%(value)r（可选 %(choices)s）",
    "argument %(argument_name)s: %(message)s": "参数 %(argument_name)s：%(message)s",
    "invalid %(type)s value: %(value)r": "无效的 %(type)s 值：%(value)r",
    "ambiguous option: %(option)s could match %(matches)s": "选项有歧义：%(option)s 可能是 %(matches)s",
    "expected at least one argument": "至少需要一个值",
}


def _localize_argparse() -> None:
    original = getattr(argparse, "_", None)

    def translate(text: str) -> str:
        if text in _ARGPARSE_ZH:
            return _ARGPARSE_ZH[text]
        return original(text) if callable(original) else text

    argparse._ = translate  # type: ignore[attr-defined]


class ArgParser(argparse.ArgumentParser):
    """用法错误 → CliError(退出码 2)；帮助与报错都经脱敏输出；不接受选项缩写（--y 不会被当成 --yes）。"""

    def __init__(self, *args, **kwargs) -> None:
        kwargs.setdefault("allow_abbrev", False)
        super().__init__(*args, **kwargs)

    def error(self, message: str):  # type: ignore[override]
        raise CliError(EXIT_USAGE, "用法错误：%s" % message, code="usage", hint="用 %s --help 查看用法。" % self.prog)

    def _print_message(self, message, file=None):  # noqa: D401
        if message:
            _write(file or sys.stdout, message)


def _positive_float(text: str) -> float:
    try:
        value = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError("需要一个正数：%s" % text)
    if not value > 0:
        raise argparse.ArgumentTypeError("需要一个正数：%s" % text)
    return value


def build_parser() -> ArgParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--profile", default=argparse.SUPPRESS, help="使用哪个 profile（多环境时区分，默认 default）")
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="输出机器可读的 JSON")
    http_timeout = argparse.ArgumentParser(add_help=False)
    http_timeout.add_argument("--timeout", type=_positive_float, dest="http_timeout", default=argparse.SUPPRESS,
                              metavar="SECONDS", help="单个请求的超时秒数（默认 60）")

    parser = ArgParser(prog="nexus.py", description="nexus-ai-operator 接入包：代表用户操作 Nexus-AI 平台（连接、发现、调用、对话）。")
    parser.add_argument("--profile", default=None, help="使用哪个 profile（默认取环境变量 NEXUS_PROFILE，否则 default）")
    parser.add_argument("--json", action="store_true", default=False, help="输出机器可读的 JSON")
    parser.add_argument("--timeout", type=_positive_float, dest="http_timeout", default=DEFAULT_HTTP_TIMEOUT,
                        metavar="SECONDS", help="单个请求的超时秒数（默认 60）")
    parser.add_argument("--version", action="version", version="nexus-ai-operator %s" % CLI_VERSION,
                        help="显示接入包版本")
    sub = parser.add_subparsers(dest="command", metavar="<命令>", parser_class=ArgParser)

    login = sub.add_parser("login", parents=[common, http_timeout], help="连接平台（连接密钥方式，或账号密码兼容方式）",
                           description="连接 Nexus：连接密钥方式会立即兑换（平台强制首次更换），只在本机保存新的连接密钥。"
                                       "网页生成 API 密钥时下载的接入包自带密钥与平台地址，直接运行 login 即可（用后自动删除）。")
    login.add_argument("--origin", help="平台地址，如 https://nexus.example.com（也可用环境变量 NEXUS_ORIGIN；"
                                        "接入包里预置了时可省略）")
    login.add_argument("--token-stdin", action="store_true",
                       help="从标准输入读连接密钥（推荐；三种方式都不指定时，使用接入包 config/connection.json 里附带的那把）")
    login.add_argument("--token-env", metavar="NAME", help="从环境变量 NAME 读连接密钥")
    login.add_argument("--password-login", action="store_true", help="账号密码方式（兼容；平台启用单点登录时不可用）")
    login.add_argument("--username", help="账号密码方式的用户名或邮箱")
    login.add_argument("--password-stdin", action="store_true", help="从标准输入读密码")
    login.add_argument("--password-env", metavar="NAME", help="从环境变量 NAME 读密码")
    mfa = login.add_mutually_exclusive_group()
    mfa.add_argument("--mfa-code", metavar="CODE", help="二次验证的动态码或恢复码（账号开启了二次验证时）")
    mfa.add_argument("--mfa-code-env", metavar="NAME", help="从环境变量 NAME 读二次验证码（恢复码推荐用这种方式）")
    login.add_argument("--name", help="账号密码方式新建的连接名称（默认「客户端 · 主机名」）")
    login.add_argument("--client", choices=CLIENT_KINDS, help="客户端类型（默认 other，也可用环境变量 NEXUS_CLIENT）")
    login.add_argument("--allow-http", action="store_true", help="允许非本机的 http 地址（不推荐：密钥会明文传输）")
    login.set_defaults(handler=cmd_login)

    logout = sub.add_parser("logout", parents=[common, http_timeout], help="删除本机凭证（--revoke 同时在平台上停用这把 API 密钥）")
    logout.add_argument("--revoke", action="store_true", help="先用连接密钥在平台上停用这把 API 密钥，再删本机凭证")
    logout.set_defaults(handler=cmd_logout)

    whoami = sub.add_parser("whoami", parents=[common, http_timeout], help="当前用户、连接、访问密钥剩余时间与平台版本")
    whoami.set_defaults(handler=cmd_whoami)

    caps = sub.add_parser("caps", parents=[common, http_timeout], help="能力总览：平台有哪些模块、对我是否可用",
                          description="能力总览（按目录版本缓存在 ~/.nexus/cache/，未变化时平台返回 304）。")
    caps.add_argument("--locale", choices=LOCALES, default=DEFAULT_LOCALE, help="说明文字的语言（默认 zh）")
    caps.add_argument("--refresh", action="store_true", help="不用本地缓存，重新获取")
    caps.set_defaults(handler=cmd_caps)

    module = sub.add_parser("module", parents=[common, http_timeout], help="模块详情：指南、配方、可用操作")
    module.add_argument("module_id", metavar="ID", help="模块 id（caps 里列出的）")
    module.add_argument("--include-denied", action="store_true", help="同时列出对我不可用的操作及原因")
    module.add_argument("--locale", choices=LOCALES, default=DEFAULT_LOCALE, help="说明文字的语言（默认 zh）")
    module.set_defaults(handler=cmd_module)

    ops = sub.add_parser("ops", parents=[common, http_timeout], help="操作列表（可按模块、关键词过滤）")
    ops.add_argument("--module", dest="module_filter", metavar="ID", help="只看某个模块")
    ops.add_argument("--search", metavar="Q", help="按路径 / 说明 / id 搜索（不区分大小写）")
    ops.add_argument("--include-denied", action="store_true", help="同时列出对我不可用的操作及原因")
    ops.set_defaults(handler=cmd_ops)

    describe = sub.add_parser("describe", parents=[common, http_timeout], help="操作详情：参数、请求体与响应的 schema",
                              description="describe METHOD PATH（PATH 可以是模板或具体路径），或 describe --id 操作 id。")
    describe.add_argument("method", nargs="?", metavar="METHOD")
    describe.add_argument("path", nargs="?", metavar="PATH")
    describe.add_argument("--id", dest="op_id", metavar="ID", help="操作 id（如 agents.list_agents）")
    describe.set_defaults(handler=cmd_describe)

    call = sub.add_parser("call", parents=[common, http_timeout], help="通用调用：call METHOD PATH（写操作要 --yes）",
                          description="通用调用平台 API。风险等级来自能力发现（拿不到时按方法推断）：只读直接执行；"
                                      "写操作要 --yes；删除 / 高风险还要 --confirm-destructive。缺少确认时退出码 9，"
                                      "并打印将要执行的请求（已脱敏）。")
    call.add_argument("method", nargs="?", metavar="METHOD", help="GET / POST / PUT / PATCH / DELETE / HEAD")
    call.add_argument("path", nargs="?", metavar="PATH", help=PATH_ARG_HELP)
    call.add_argument("--id", dest="op_id", metavar="ID", help="用操作 id 代替 METHOD PATH")
    call.add_argument("-p", "--param", action="append", default=[], metavar="K=V", help="路径参数（可重复）")
    call.add_argument("-q", "--query", action="append", default=[], metavar="K=V", help="查询参数（可重复）")
    body = call.add_mutually_exclusive_group()
    body.add_argument("--data", metavar="JSON", help="JSON 请求体")
    body.add_argument("--data-file", metavar="FILE", help="从文件读 JSON 请求体（- 表示标准输入）")
    body.add_argument("--data-stdin", action="store_true", help="从标准输入读 JSON 请求体")
    call.add_argument("--yes", action="store_true", help="用户已明确同意这一具体的写操作")
    call.add_argument("--confirm-destructive", action="store_true", help="用户已单独确认这一删除 / 高风险操作")
    call.add_argument("--dry-run", action="store_true", help="只打印将要执行的请求（已脱敏），不发送任何请求")
    call.add_argument("--raw", action="store_true", help="原样输出完整响应（不拆统一外壳、不排版）")
    call.add_argument("--output", metavar="FILE", help="把响应体原样保存到文件（下载文件时用）")
    call.set_defaults(handler=cmd_call)

    wait = sub.add_parser("wait", parents=[common], help="通用轮询：GET 某个路径直到字段达到指定值",
                          description="反复 GET PATH，直到 --field 指向的字段取到 --until 里的某个值。"
                                      "注意：这里的 --timeout 是总等待时间；单个请求的超时用全局 --timeout（写在 wait 前面）。")
    wait.add_argument("path", metavar="PATH", help=PATH_ARG_HELP)
    wait.add_argument("-p", "--param", action="append", default=[], metavar="K=V", help="路径参数（可重复）")
    wait.add_argument("-q", "--query", action="append", default=[], metavar="K=V", help="查询参数（可重复）")
    wait.add_argument("--field", required=True, metavar="DOTTED", help="响应里的字段路径，如 data.status")
    wait.add_argument("--until", required=True, metavar="A,B", help="达到其中任一值即结束，如 completed,failed")
    wait.add_argument("--interval", type=_positive_float, default=15.0, metavar="SECONDS", help="轮询间隔（默认 15 秒）")
    wait.add_argument("--timeout", type=_positive_float, dest="total_timeout", default=argparse.SUPPRESS,
                      metavar="SECONDS", help="总等待时间（默认 3600 秒），超时退出码 6")
    wait.set_defaults(handler=cmd_wait)

    chat = sub.add_parser("chat", parents=[common], help="和平台上的 Agent 对话（流式；排队、重试、断线续播都自动处理）",
                          description="给 Agent 发一条消息并等它回复完（正文写 stdout，工具调用等过程提示写 stderr）。"
                                      "默认接着这个 Agent 上次的会话；--new-session 开新会话。会话忙时排队、平台维护时稍后重试、"
                                      "断线后从断点续播。这里的 --timeout 是这一轮的总等待时间（默认 1800 秒）；"
                                      "单个请求的超时用全局 --timeout（写在 chat 前面）。超时后用 --attach 接着看，不会重发消息。")
    chat.add_argument("--agent-id", required=True, metavar="ID", help="Agent id（用能力发现与 call 查到的）")
    which = chat.add_mutually_exclusive_group()
    which.add_argument("--session-id", metavar="ID", help="指定会话（默认接着上次的会话）")
    which.add_argument("--new-session", action="store_true", help="开一个新会话")
    text = chat.add_mutually_exclusive_group()
    text.add_argument("--message", metavar="TEXT", help="要发的消息")
    text.add_argument("--message-stdin", action="store_true", help="从标准输入读消息（长消息推荐）")
    text.add_argument("--attach", action="store_true", help="不发消息，接着看会话里最近一轮的回复（超时或断线之后用）")
    chat.add_argument("--model-id", metavar="ID", help="这一轮临时换用的模型 id（可选；不在可用范围内时平台改用默认模型）")
    chat.add_argument("--timeout", type=_positive_float, dest="total_timeout", default=argparse.SUPPRESS,
                      metavar="SECONDS", help="这一轮的总等待时间（默认 1800 秒），超时退出码 6")
    chat.set_defaults(handler=cmd_chat)

    update = sub.add_parser("skill-update", parents=[common, http_timeout], help="检查并更新本接入包（先备份）")
    update.add_argument("--check", action="store_true", help="只检查，不更新")
    update.add_argument("--force", action="store_true", help="版本相同或本机更新时也重新安装平台提供的版本")
    update.set_defaults(handler=cmd_skill_update)
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    _install_redacting_streams()
    _localize_argparse()
    parser = build_parser()
    json_mode = "--json" in (argv if argv is not None else sys.argv[1:])
    ui = Ui(json_mode)
    try:
        args = parser.parse_args(argv)
        if not getattr(args, "command", None):
            parser.print_help()
            return EXIT_USAGE
        ctx = Context(args)
        return int(args.handler(ctx) or EXIT_OK)
    except CliError as err:
        ui.fail(err)
        return err.exit_code
    except KeyboardInterrupt:
        ui.note("已中断。")
        return EXIT_INTERRUPTED
    except Exception as exc:  # noqa: BLE001 —— 兜底：不打印调用栈（可能含敏感上下文），只给一句已脱敏的原因
        if os.environ.get("NEXUS_DEBUG"):
            import traceback
            traceback.print_exc()
        ui.fail(CliError(EXIT_PLATFORM, "内部错误：%s: %s" % (exc.__class__.__name__, exc), code="internal_error",
                         hint="可设置环境变量 NEXUS_DEBUG=1 查看详情（输出仍会脱敏）。"))
        return EXIT_PLATFORM


if __name__ == "__main__":
    sys.exit(main())
