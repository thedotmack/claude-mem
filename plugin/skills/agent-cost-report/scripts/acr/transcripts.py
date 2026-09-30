"""Measured token usage from Claude Code transcripts (plan Phase 1.4).

Claude Code reader copied verbatim from /workspace/weekly-cost-workflow/parse_transcripts.py:7-38
and the Codex reader from :39-57, then extended (plan 1.4) with `cwd`, `cache_write_5m`
(read directly from cache_creation.ephemeral_5m_input_tokens when present, else
cache_write - cache_write_1h as weekly_report.py:94) and `device = "local"`.

Every transcript is streamed line by line; no file is ever read whole.
"""
import datetime as dt
import glob
import json
import os
import platform

from .period import PT, session_block

# copied from parse_transcripts.py:16 and :40 (glob patterns)
CLAUDE_GLOB = os.path.join("~", ".claude", "projects", "**", "*.jsonl")
CODEX_GLOB = os.path.join("~", ".codex", "sessions", "**", "*.jsonl")
DEVICE = "local"  # the collector only ever sees the machine it runs on


def host_label():
    """platform.node(); never a device UUID from settings."""
    return platform.node()


# copied from parse_transcripts.py:13-14
def ts(x):
    return dt.datetime.fromisoformat(x.replace("Z", "+00:00"))


def _project_dir(f, pattern):
    """Project dir = path segment after `/.claude/projects/` (parse_transcripts.py:20).
    For a non-default glob root (tests) the first segment relative to the root is the same thing."""
    if "/.claude/projects/" in f:
        return f.split("/.claude/projects/")[1].split("/")[0]  # copied from parse_transcripts.py:20
    root = os.path.expanduser(pattern).split("**")[0]
    return os.path.relpath(f, root).split(os.sep)[0]


def collect_claude(s, e, session=None, pattern=CLAUDE_GLOB):
    """Claude Code assistant lines in [s, e) deduped on (message.id, requestId).

    s/e: aware datetimes (end exclusive), or None when `session` is given (no period filter,
    plan 1.2). Returns (rows, stats)."""
    seen = set(); rows = []; dropped = 0
    # copied from parse_transcripts.py:16-17 (mtime prefilter); skipped when there is no window
    files = [f for f in glob.glob(os.path.expanduser(pattern), recursive=True)
             if s is None or dt.datetime.fromtimestamp(os.path.getmtime(f), PT) >= s]
    for f in files:
        proj = _project_dir(f, pattern)
        with open(f, errors="ignore") as fh:
            # copied from parse_transcripts.py:21-38, with the extensions marked (+)
            for line in fh:
                if '"usage"' not in line: continue
                if session is not None and session not in line: continue  # (+) cheap --session prefilter
                try: d = json.loads(line)
                except Exception: continue
                m = d.get("message") or {}
                u = m.get("usage")
                if d.get("type") != "assistant" or not u or not d.get("timestamp"): continue
                sid = d.get("sessionId") or d.get("session_id")
                if session is not None and sid != session: continue  # (+) --session filter
                t = ts(d["timestamp"])
                if s is not None and not (s <= t < e): continue
                key = (m.get("id"), d.get("requestId"))
                if key in seen: dropped += 1; continue
                seen.add(key)
                cc = u.get("cache_creation") or {}
                cache_write = u.get("cache_creation_input_tokens", 0) or 0
                cache_write_1h = cc.get("ephemeral_1h_input_tokens", 0) or 0
                cw5 = cc.get("ephemeral_5m_input_tokens")  # (+) direct when present
                cache_write_5m = cw5 if cw5 is not None else cache_write - cache_write_1h  # (+) fallback, weekly_report.py:94
                rows.append(dict(src="claude-code", file=f, dir=proj, cwd=d.get("cwd"), session=sid,
                    sidechain=bool(d.get("isSidechain")), model=m.get("model"), ts=t.astimezone(PT).isoformat(),
                    input=u.get("input_tokens", 0) or 0, output=u.get("output_tokens", 0) or 0,
                    cache_write=cache_write, cache_write_1h=cache_write_1h, cache_write_5m=cache_write_5m,
                    cache_read=u.get("cache_read_input_tokens", 0) or 0,
                    cost_usd_reported=d.get("costUSD"), device=DEVICE))
    return rows, dict(files_seen=len(files), dedup_dropped=dropped)


def collect_codex(s, e, session=None, pattern=CODEX_GLOB):
    """Codex: token_count events carry a cumulative total_token_usage per session file (parse_transcripts.py:39-57
    took the last one). Each event becomes one row holding the growth since the previous event, so usage before
    the window is subtracted and every day is charged its own tokens; a session that starts before the window
    contributes only its in-window growth."""
    rows = []; files_seen = 0
    for f in glob.glob(os.path.expanduser(pattern), recursive=True):
        if s is not None and dt.datetime.fromtimestamp(os.path.getmtime(f), PT) < s: continue
        if session is not None and os.path.basename(f) != session: continue  # (+) --session filter
        files_seen += 1
        prev = dict(input_tokens=0, cached_input_tokens=0, output_tokens=0); model = None
        with open(f, errors="ignore") as fh:
            for line in fh:
                try: d = json.loads(line)
                except Exception: continue
                p = d.get("payload") or {}
                if d.get("type") == "turn_context": model = p.get("model", model)
                if p.get("type") == "token_count" and p.get("info"):
                    t = ts(d["timestamp"]); u = p["info"].get("total_token_usage") or {}
                    cur = {k: int(u.get(k, 0) or 0) for k in prev}
                    delta = {k: max(cur[k] - prev[k], 0) for k in prev}; prev = cur       # cumulative counter: growth since the last event
                    if not any(delta.values()) or (s is not None and not (s <= t < e)): continue
                    rows.append(dict(src="codex", file=f, dir="codex", cwd=None, session=os.path.basename(f), sidechain=False, model=model,
                        ts=t.astimezone(PT).isoformat(), input=max(delta["input_tokens"] - delta["cached_input_tokens"], 0),
                        output=delta["output_tokens"], cache_write=0, cache_write_1h=0, cache_write_5m=0, cache_read=delta["cached_input_tokens"],
                        cost_usd_reported=None, device=DEVICE))
    return rows, dict(files_seen=files_seen)


def collect(window=None, session=None, claude_glob=CLAUDE_GLOB, codex_glob=CODEX_GLOB, window_block=None):
    """Run both readers. `window` is a period.Window, or None with `session` set.
    Returns the usage.json document: {window, collector, rows}."""
    if window is None and session is None:
        raise ValueError("collect needs a window or a session id")
    s, e = (window.start, window.end) if window is not None else (None, None)
    claude_rows, cstats = collect_claude(s, e, session=session, pattern=claude_glob)
    codex_rows, xstats = collect_codex(s, e, session=session, pattern=codex_glob)
    rows = claude_rows + codex_rows
    if window_block is None:
        window_block = window.block() if window is not None else session_block(session)
    wblock = window_block
    collector = dict(host_label=host_label(), glob=[claude_glob, codex_glob],
                     files_seen=cstats["files_seen"] + xstats["files_seen"],
                     files_seen_by_src={"claude-code": cstats["files_seen"], "codex": xstats["files_seen"]},
                     rows=len(rows), dedup_dropped=cstats["dedup_dropped"], window=wblock)
    return dict(window=wblock, collector=collector, rows=rows)
