"""claude-mem transport for the Hermes memory provider.

Standard library only, so the plugin installs into any Hermes without pip.

Settings resolve the way every claude-mem integration resolves them: an
environment variable wins, then ``settings.json`` in the claude-mem data
directory (``CLAUDE_MEM_DATA_DIR``, default ``~/.claude-mem``), then claude-mem's own
default. With ``CLAUDE_MEM_RUNTIME=server`` and a server URL, API key and project
id, notes go to the hosted server's ``/v1`` API; otherwise to the local worker.

Nothing here raises to the caller. Every request has a timeout, and three
failures in a row open a breaker for 30 seconds, so a stopped worker costs a
Hermes turn nothing.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Optional

PLATFORM_SOURCE = "hermes"
_PREFIXES = ("CLAUDE_MEM_",)
MAX_TOOL_RESPONSE = 1000
WRITE_TIMEOUT_S = 5.0
READ_TIMEOUT_S = 3.0
BREAKER_FAILURES = 3
BREAKER_OPEN_S = 30.0
# Sections that never become memory: <private> text, memory Hermes was handed
# (<memory-context>), and agent-internal blocks. Matches the worker's own list.
_TAGS = ("private", "memory-context", "claude-mem-context", "system_instruction",
         "system-instruction", "persisted-output", "system-reminder")
_TAG = re.compile(r"<(/?)(%s)\b[^>]*>" % "|".join(re.escape(t) for t in _TAGS), re.IGNORECASE)


def _strip_text(text: str) -> str:
    """Removes each tagged section whole. A section ends only when every tag
    opened inside it is closed again, so nested and overlapping sections go
    together; one that is never closed runs to the end of the text."""
    out: List[str] = []
    position = 0
    open_tags: Dict[str, int] = {}
    for tag in _TAG.finditer(text):
        closing, name = tag.group(1), tag.group(2).lower()
        if not open_tags:
            if closing:
                continue
            out.append(text[position:tag.start()])
            open_tags = {name: 1}
            continue
        if closing:
            if open_tags.get(name):
                open_tags[name] -= 1
                if not open_tags[name]:
                    del open_tags[name]
        else:
            open_tags[name] = open_tags.get(name, 0) + 1
        if not open_tags:
            position = tag.end()
    if not open_tags:
        out.append(text[position:])
    return "".join(out)


def strip_tags(value: Any) -> Any:
    """The value with those sections removed from every string in it, at any
    depth; strings without one are returned unchanged."""
    if isinstance(value, str):
        return _strip_text(value) if _TAG.search(value) else value
    if isinstance(value, list):
        return [strip_tags(item) for item in value]
    if isinstance(value, dict):
        return {key: strip_tags(item) for key, item in value.items()}
    return value


def _names(key: str) -> List[str]:
    suffix = key[len("CLAUDE_MEM_"):] if key.startswith("CLAUDE_MEM_") else key
    return [prefix + suffix for prefix in _PREFIXES]


def data_dir(environ: Optional[Dict[str, str]] = None) -> str:
    env = os.environ if environ is None else environ
    for name in _names("CLAUDE_MEM_DATA_DIR"):
        if env.get(name):
            return os.path.expanduser(env[name])
    return os.path.join(os.path.expanduser("~"), ".claude-mem")


def load_settings(environ: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """settings.json as claude-mem reads it: keys under ``env`` when that block
    holds claude-mem keys, else at the root. Empty on any error."""
    path = os.path.join(data_dir(environ), "settings.json")
    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            doc = json.load(handle)
    except (OSError, ValueError):
        return {}
    if not isinstance(doc, dict):
        return {}
    nested = doc.get("env")
    if isinstance(nested, dict) and any(k.startswith(_PREFIXES) for k in nested):
        return nested
    return doc


def setting(settings: Dict[str, Any], key: str, default: str = "",
            environ: Optional[Dict[str, str]] = None) -> str:
    env = os.environ if environ is None else environ
    for name in _names(key):
        value = env.get(name)
        if value and value.strip():
            return value.strip()
    for name in _names(key):
        value = settings.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return default


def _glob_regex(pattern: str) -> "re.Pattern[str]":
    expanded = os.path.expanduser(pattern.replace("\\", "/")).replace("\\", "/")
    regex = re.sub(r"[.+^${}()|\[\]\\]", lambda m: "\\" + m.group(0), expanded)
    regex = regex.replace("**", "\0").replace("*", "[^/]*").replace("?", "[^/]").replace("\0", ".*")
    return re.compile("^" + regex + "$")


def is_project_excluded(cwd: str, patterns: str) -> bool:
    """CLAUDE_MEM_EXCLUDED_PROJECTS, matched as the worker matches it: comma-separated
    globs (*, **, ?, leading ~) against the full path and its last folder name."""
    if not cwd or not patterns or not patterns.strip():
        return False
    path = cwd.replace("\\", "/")
    name = path.rstrip("/").rsplit("/", 1)[-1]
    for pattern in (p.strip() for p in patterns.split(",")):
        if not pattern:
            continue
        try:
            regex = _glob_regex(pattern)
        except re.error:
            continue
        if regex.match(path) or regex.match(name):
            return True
    return False


_PROJECT_KEYS: Dict[str, str] = {}


def checkout_project(cwd: str) -> str:
    """The project key the Claude Code hooks give this checkout in their
    default (path) mode: the git root's folder name, or `<repo>/<worktree>` for
    a linked worktree; the folder name outside git. Only hosted mode needs it:
    the local worker resolves the key itself from the cwd."""
    if not cwd:
        return ""
    cached = _PROJECT_KEYS.get(cwd)
    if cached is not None:
        return cached
    key = os.path.basename(os.path.normpath(cwd))
    try:
        import subprocess

        found = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir",
             "--git-common-dir"],
            capture_output=True, text=True, timeout=2.0, check=False)
        lines = found.stdout.split("\n") if found.returncode == 0 else []
        if len(lines) >= 3 and lines[0]:
            top, git_dir, common = (os.path.normpath(line) for line in lines[:3])
            key = os.path.basename(top)
            if git_dir != common and os.path.basename(common) == ".git":
                parent = os.path.basename(os.path.dirname(common))
                key = parent if key == parent else parent + "/" + key
    except Exception:  # noqa: BLE001 - no git (or no answer) means the folder name
        pass
    _PROJECT_KEYS[cwd] = key
    return key


def default_worker_port() -> str:
    uid = os.getuid() if hasattr(os, "getuid") else 77
    return str(37700 + uid % 100)


class Config:
    """Where notes go: the local worker, or the hosted server."""

    def __init__(self, worker_base: str, server_url: str = "", api_key: str = "",
                 project_id: str = "", excluded_projects: str = "", skip_tools: str = "") -> None:
        self.worker_base = worker_base
        self.server_url = server_url.rstrip("/")
        self.api_key = api_key
        self.project_id = project_id
        self.excluded_projects = excluded_projects
        # The worker drops these at ingest; the hosted path has to drop them here.
        self.skip_tools = {t.strip().lower() for t in skip_tools.split(",") if t.strip()}

    @property
    def server(self) -> bool:
        return bool(self.server_url and self.api_key and self.project_id)

    @classmethod
    def resolve(cls, environ: Optional[Dict[str, str]] = None) -> "Config":
        settings = load_settings(environ)
        port = setting(settings, "CLAUDE_MEM_WORKER_PORT", default_worker_port(), environ)
        host = setting(settings, "CLAUDE_MEM_WORKER_HOST", "127.0.0.1", environ)
        if ":" in host and not host.startswith("["):
            host = "[" + host + "]"
        worker_base = "http://" + host + ":" + port
        excluded = setting(settings, "CLAUDE_MEM_EXCLUDED_PROJECTS", "", environ)
        runtime = setting(settings, "CLAUDE_MEM_RUNTIME", "worker", environ).lower()
        if runtime not in ("server", "server-beta"):
            return cls(worker_base, excluded_projects=excluded)

        def pick(key: str) -> str:
            return setting(settings, key, "", environ) or setting(
                settings, key.replace("CLAUDE_MEM_SERVER_", "CLAUDE_MEM_SERVER_BETA_"), "", environ)

        # Like the other integrations, a server selection missing any of its
        # three settings falls back to the worker.
        return cls(worker_base, pick("CLAUDE_MEM_SERVER_URL"), pick("CLAUDE_MEM_SERVER_API_KEY"),
                   pick("CLAUDE_MEM_SERVER_PROJECT_ID"), excluded,
                   setting(settings, "CLAUDE_MEM_SKIP_TOOLS", "", environ))


class Breaker:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._failures = 0
        self._open_until = 0.0
        self._lock = threading.Lock()

    def open(self) -> bool:
        with self._lock:
            return self._clock() < self._open_until

    def ok(self) -> None:
        with self._lock:
            self._failures = 0
            self._open_until = 0.0

    def fail(self) -> None:
        with self._lock:
            self._failures += 1
            if self._failures >= BREAKER_FAILURES:
                self._open_until = self._clock() + BREAKER_OPEN_S
                self._failures = 0


class RequestFailed(Exception):
    pass


class Transport:
    """One bounded HTTP request at a time; a failure counts toward the breaker."""

    def __init__(self, config: Config, breaker: Optional[Breaker] = None) -> None:
        self.config = config
        self.breaker = breaker or Breaker()

    def _send(self, method: str, url: str, body: Any, timeout: float,
              headers: Dict[str, str]) -> bytes:
        if self.breaker.open():
            raise RequestFailed("breaker open")
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(url, data=data, method=method)
        request.add_header("content-type", "application/json")
        for name, value in headers.items():
            request.add_header(name, value)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = response.read()
        except (urllib.error.URLError, OSError, ValueError) as error:
            self.breaker.fail()
            raise RequestFailed(str(error)) from error
        self.breaker.ok()
        return payload

    def worker(self, method: str, path: str, body: Any = None,
               timeout: float = WRITE_TIMEOUT_S) -> bytes:
        return self._send(method, self.config.worker_base + path, body, timeout, {})

    def server(self, method: str, path: str, body: Any = None,
               timeout: float = WRITE_TIMEOUT_S) -> bytes:
        return self._send(method, self.config.server_url + path, body, timeout,
                          {"authorization": "Bearer " + self.config.api_key})


def as_json(payload: bytes) -> Dict[str, Any]:
    try:
        value = json.loads(payload.decode("utf-8") or "null")
    except (UnicodeDecodeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def text_of(value: Any) -> str:
    """A tool result as text: strings stay, anything else is JSON."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(value)


def server_query(prompt: str, max_terms: int = 12) -> str:
    """The hosted server ANDs every word of a query, so a whole prompt would
    match almost nothing: keep its distinct longer words, joined with "or".
    Private blocks never leave the machine."""
    words = re.findall(r"\w{4,}", _strip_text(prompt).lower())
    distinct: List[str] = []
    for word in words:
        if word not in distinct:
            distinct.append(word)
    return " or ".join(distinct[:max_terms])


class Session:
    """What the sender knows about one Hermes session."""

    def __init__(self, session_id: str) -> None:
        self.id = session_id
        self.prompts_sent = 0
        self.last_prompt_recorded = False
        self.anchored = False
        self.excluded = False
        self.server_session_id = ""


class ClaudeMemClient:
    """Writes go through one background thread, in the order Hermes produced
    them: a prompt, then its tool calls, then the summary. Reads are direct
    and bounded by READ_TIMEOUT_S."""

    def __init__(self, config: Optional[Config] = None, transport: Optional[Transport] = None,
                 queue_size: int = 1000) -> None:
        import queue

        self.config = config or Config.resolve()
        self.transport = transport or Transport(self.config)
        self._queue: "queue.Queue[Optional[Callable[[], None]]]" = queue.Queue(maxsize=queue_size)
        self._queue_full = queue.Full
        self._sessions: Dict[str, Session] = {}
        self._thread = threading.Thread(target=self._run, name="claude-mem-sender", daemon=True)
        self._thread.start()

    # -- sender thread ------------------------------------------------------

    def _run(self) -> None:
        while True:
            job = self._queue.get()
            try:
                if job is None:
                    return
                job()
            except Exception:  # noqa: BLE001 - a failed write must never kill the sender
                pass
            finally:
                self._queue.task_done()

    def _enqueue(self, job: Callable[[], None]) -> None:
        try:
            self._queue.put_nowait(job)
        except self._queue_full:
            pass  # a worker that is that far behind loses the newest writes, never the turn

    def flush(self, timeout: float = 4.0) -> bool:
        """Wait up to ``timeout`` seconds for queued writes. True when drained."""
        deadline = time.monotonic() + timeout
        while self._queue.unfinished_tasks:
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.02)
        return True

    def close(self, timeout: float = 4.0) -> None:
        self.flush(timeout)
        try:
            self._queue.put_nowait(None)
        except self._queue_full:
            pass

    def _excluded(self, cwd: str) -> bool:
        # Checked here as well as by the worker, so nothing from an excluded
        # checkout leaves Hermes, whichever runtime is selected.
        return is_project_excluded(cwd, self.config.excluded_projects)

    def _session(self, session_id: str) -> Session:
        session = self._sessions.get(session_id)
        if session is None:
            session = self._sessions[session_id] = Session(session_id)
        return session

    # -- writes -------------------------------------------------------------

    def record_prompt(self, session_id: str, cwd: str, prompt: str) -> None:
        self._enqueue(lambda: self._record_prompt(self._session(session_id), cwd, prompt))

    def record_tool(self, session_id: str, cwd: str, tool_name: str, tool_input: Any,
                    tool_response: Any, tool_use_id: str = "") -> None:
        self._enqueue(lambda: self._record_tool(
            self._session(session_id), cwd, tool_name, tool_input, tool_response, tool_use_id))

    def finish_session(self, session_id: str, cwd: str, last_assistant_message: str) -> None:
        self._enqueue(lambda: self._finish(self._session(session_id), cwd, last_assistant_message))

    def save_note(self, session_id: str, cwd: str, text: str, title: str,
                  metadata: Dict[str, Any]) -> None:
        self._enqueue(lambda: self._save_note(self._session(session_id), cwd, text, title, metadata))

    def _record_prompt(self, session: Session, cwd: str, prompt: str) -> None:
        # Notes Hermes was handed come back inside the user message; they are
        # not part of what the user asked.
        if session.excluded or self._excluded(cwd):
            session.excluded = True
            return
        prompt = strip_tags(prompt).strip()
        session.prompts_sent += 1
        session.last_prompt_recorded = False
        if not prompt:
            # A wholly private prompt is not recorded, and neither are its tools.
            return
        try:
            if self.config.server:
                reply = as_json(self.transport.server("POST", "/v1/sessions/start", {
                    "projectId": self.config.project_id,
                    "externalSessionId": session.id,
                    "contentSessionId": session.id,
                    "platformSource": PLATFORM_SOURCE,
                    "metadata": {"prompt": prompt, "cwd": cwd, "project": checkout_project(cwd)},
                }))
                started = reply.get("session")
                if isinstance(started, dict) and isinstance(started.get("id"), str):
                    session.server_session_id = started["id"]
                # Starting a session is idempotent and keeps only the first
                # prompt, so every prompt is also its own event.
                self.transport.server("POST", "/v1/events?generate=false", {
                    "projectId": self.config.project_id,
                    "contentSessionId": session.id,
                    "platformSource": PLATFORM_SOURCE,
                    "sourceType": "hook",
                    "eventType": "user_prompt",
                    "occurredAtEpoch": int(time.time() * 1000),
                    "payload": {"prompt": prompt, "cwd": cwd, "platformSource": PLATFORM_SOURCE},
                })
            else:
                reply = as_json(self.transport.worker("POST", "/api/sessions/init", {
                    "contentSessionId": session.id,
                    "prompt": prompt,
                    "platformSource": PLATFORM_SOURCE,
                    "cwd": cwd,
                }))
                if reply.get("reason") == "project_excluded":
                    session.excluded = True
                    return
        except RequestFailed:
            return
        session.anchored = True
        session.last_prompt_recorded = True

    def _record_tool(self, session: Session, cwd: str, tool_name: str, tool_input: Any,
                     tool_response: Any, tool_use_id: str) -> None:
        # A tool call belongs to the prompt before it: when the worker did not
        # record that prompt, the call is dropped rather than filed without one.
        if session.excluded or self._excluded(cwd) or (session.prompts_sent and not session.last_prompt_recorded):
            return
        # Cut only after the tagged sections are gone: a cut through a section
        # would leave its opening tag without the closing one.
        response = strip_tags(text_of(tool_response))[:MAX_TOOL_RESPONSE]
        tool_input = strip_tags(tool_input)
        try:
            if self.config.server:
                if tool_name.lower() in self.config.skip_tools:
                    return
                payload: Dict[str, Any] = {
                    "tool_name": tool_name, "tool_input": tool_input, "tool_response": response,
                    "cwd": cwd, "platformSource": PLATFORM_SOURCE,
                }
                if tool_use_id:
                    payload["tool_use_id"] = tool_use_id
                self.transport.server("POST", "/v1/events", {
                    "projectId": self.config.project_id,
                    "contentSessionId": session.id,
                    "platformSource": PLATFORM_SOURCE,
                    "sourceType": "hook",
                    "eventType": "tool_use",
                    "occurredAtEpoch": int(time.time() * 1000),
                    "payload": payload,
                })
            else:
                body: Dict[str, Any] = {
                    "contentSessionId": session.id,
                    "tool_name": tool_name,
                    "tool_input": tool_input,
                    "tool_response": response,
                    "platformSource": PLATFORM_SOURCE,
                    "cwd": cwd,
                }
                if tool_use_id:
                    body["tool_use_id"] = tool_use_id
                self.transport.worker("POST", "/api/sessions/observations", body)
        except RequestFailed:
            pass

    def _finish(self, session: Session, cwd: str, last_assistant_message: str) -> None:
        self._sessions.pop(session.id, None)
        if not session.anchored or session.excluded or self._excluded(cwd):
            return
        # Same gate as _record_tool: when the last prompt was wholly private the
        # turn was never recorded, so its closing assistant message is dropped
        # too — session.anchored is historical and does not cover the last turn.
        # The session itself still ends: its earlier public turns were recorded.
        last_turn_private = bool(session.prompts_sent and not session.last_prompt_recorded)
        try:
            if self.config.server:
                reply = as_json(self.transport.server("POST", "/v1/sessions/start", {
                    "projectId": self.config.project_id,
                    "externalSessionId": session.id,
                    "contentSessionId": session.id,
                    "platformSource": PLATFORM_SOURCE,
                }))
                started = reply.get("session")
                server_id = started.get("id") if isinstance(started, dict) else None
                if not isinstance(server_id, str) or not server_id:
                    return
                if not last_turn_private:
                    self.transport.server("POST", "/v1/events", {
                        "projectId": self.config.project_id,
                        "serverSessionId": server_id,
                        "contentSessionId": session.id,
                        "platformSource": PLATFORM_SOURCE,
                        "sourceType": "hook",
                        "eventType": "assistant_message",
                        "occurredAtEpoch": int(time.time() * 1000),
                        "payload": {"last_assistant_message": strip_tags(last_assistant_message),
                                    "platformSource": PLATFORM_SOURCE},
                    })
                self.transport.server("POST", "/v1/sessions/" + urllib.parse.quote(server_id, safe="") + "/end", {})
            elif not last_turn_private:
                # The worker also skips summarize for a private last prompt;
                # not sending the message at all keeps it off the wire.
                self.transport.worker("POST", "/api/sessions/summarize", {
                    "contentSessionId": session.id,
                    "last_assistant_message": strip_tags(last_assistant_message),
                    "platformSource": PLATFORM_SOURCE,
                    "cwd": cwd,
                })
        except RequestFailed:
            pass

    def _save_note(self, session: Session, cwd: str, text: str, title: str,
                   metadata: Dict[str, Any]) -> None:
        text = strip_tags(text).strip()
        if session.excluded or self._excluded(cwd) or not text:
            return
        meta = dict(metadata)
        meta["platformSource"] = PLATFORM_SOURCE
        try:
            if self.config.server:
                self.transport.server("POST", "/v1/memories", {
                    "projectId": self.config.project_id,
                    "contentSessionId": session.id,
                    "platformSource": PLATFORM_SOURCE,
                    "content": text,
                    "metadata": dict(meta, project=checkout_project(cwd), **({"title": strip_tags(title)} if title else {})),
                })
            else:
                body: Dict[str, Any] = {"text": text, "cwd": cwd, "metadata": meta}
                if title:
                    body["title"] = strip_tags(title)
                self.transport.worker("POST", "/api/memory/save", body)
        except RequestFailed:
            pass

    # -- reads --------------------------------------------------------------

    def recent_context(self, cwd: str) -> str:
        """Memory for the start of a session: the project's recent work, from
        every agent (no platform filter)."""
        if self._excluded(cwd):
            return ""
        try:
            if self.config.server:
                reply = as_json(self.transport.server("POST", "/v1/context", {
                    "projectId": self.config.project_id, "limit": 10,
                    "folderProjects": [checkout_project(cwd)],
                }, timeout=READ_TIMEOUT_S))
                context = reply.get("context")
                return context if isinstance(context, str) else ""
            return self.transport.worker(
                "GET", "/api/context/inject?cwd=" + urllib.parse.quote(cwd, safe=""),
                timeout=READ_TIMEOUT_S).decode("utf-8", "replace")
        except RequestFailed:
            return ""

    def relevant_notes(self, cwd: str, query: str, limit: int = 5) -> str:
        """Notes that match this prompt, from every agent in this project."""
        query = strip_tags(query).strip()
        if len(query) < 20 or self._excluded(cwd):
            return ""
        try:
            if self.config.server:
                terms = server_query(query)
                if not terms:
                    return ""
                reply = as_json(self.transport.server("POST", "/v1/context", {
                    "projectId": self.config.project_id, "query": terms, "limit": limit,
                    "folderProjects": [checkout_project(cwd)],
                }, timeout=READ_TIMEOUT_S))
            else:
                reply = as_json(self.transport.worker("POST", "/api/context/semantic", {
                    "q": query, "cwd": cwd, "limit": limit,
                }, timeout=READ_TIMEOUT_S))
        except RequestFailed:
            return ""
        context = reply.get("context")
        return context if isinstance(context, str) else ""
