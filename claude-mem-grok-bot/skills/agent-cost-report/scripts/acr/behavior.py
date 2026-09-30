"""Phase 2B shared machinery (plan 2B.1, 2B.2, 2B.9): a second streaming pass over the same
transcript files and window as the Phase 1 collector, building ordered turns per session, tagging
every user turn human | bot | unknown (prerequisite R2, plan 0.5), finding frustration episodes,
and pricing wasted turns with the Phase 1 rate() table in integer micro-dollars.

Sources: box Claude Code transcripts (agent turns plus tagged user turns) and claude-mem
`user_prompts` rows (local and replica, tagged). Grok Bot chats stay "unavailable" (R1).
Field names were verified on box transcripts 2026-09-25 (plan 2B.7): assistant lines carry
`message.content[] {type: text|tool_use {id, name, input}}`, user lines carry
`{type: tool_result {tool_use_id, is_error, content}}` or text; `entrypoint` is cli | sdk-cli | sdk-ts.
"""
import collections
import datetime as dt
import glob
import hashlib
import json
import os
import re

from . import costs, prices, transcripts
from .period import PT

# ---- constants (plan 2B.1) ----
GAP_MIN = 45                 # episode grouping gap (MI:8)
WASTED_CAP_MS = 6 * 3600_000 # wasted window cap (MI:9)
REDO_MS = 60 * 60_000        # redo window after the episode's last message (MI:9)
ALEX_WAIT_CAP_MIN = 60       # Alex-minutes wait cap (MI:10)
EXCERPT_CHARS = 160
TEXT_KEEP = 6000             # chars of assistant text kept per turn (bounded memory)
RESULT_KEEP = 2048           # first 2 KB of a tool result (S1 rule)
INPUT_KEEP = 1500
HEADLESS = ("sdk-cli", "sdk-ts")

# Frustration Arc markers (MI:7) plus the agent markers in plan 2B.1 and the relay/automation
# prefixes seen in claude-mem user_prompts on this box (2026-09-26 probe).
BOT_MARKERS = re.compile(
    r"^\s*(STEER from Alex|HOUSE LOCK|\[SAND_HIDDEN_PROMPT\]|<system-reminder>|<timestamp>|<cross-session-message|<command-|<local-command|"
    r"\[Request interrupted|MAKE-PLAN\b|make-plan ONLY|# make-plan|Branch: [\w/.-]+ \(this worktree|"
    r"\[Cross-session idle notice\]|\[Group chat:|\[Artifact comment|Agent sweep|AJ email check|Quiet overnight|"
    r"You name new code workspaces|You are\b|/do\b|/make-plan\b|/loop\b|/claude-mem:|/ccs-|/[a-z][\w-]*:[a-z][\w-]*\b|"
    r"(STEER|RESET|CORRECTION) from Alex|Resuming after|\[SYSTEM NOTIFICATION|<task-notification>|<pasted_content)"
    r"|^.{0,200}\bAlex (asked|said|wants|greened|approved)\b"            # third-person relays of Alex are agent-written
    r"|^(?=.{400,})[^\n]{0,300}\bYou are (a|an|the|in|one|running|working)\b", re.I | re.S)   # long briefs that address the agent
CORRECTION = re.compile(r"^\s*(STEER|RESET|CORRECTION) from Alex|\bSTEER\b.{0,10}\bfrom Alex\b|^\s*(RESET|CORRECTION):", re.I)
PROFANITY = re.compile(r"\b(fuck\w*|shit\w*|wtf|goddamn)\b", re.I)
FRUSTRATION_PHRASE = re.compile(r"\b(i told you|i said|why did you|who (said|made|told)|stop|never|again)\b", re.I)
SECRET_RE = re.compile(r"(sk-or-[\w-]+|sk-[\w-]{8,}|Bearer\s+\S+|ghp_\w+|gho_\w+|xox[abp]-[\w-]+|AKIA\w{12,}|[A-Za-z0-9+/=_-]{32,})")
# key=value / key: value credentials of any length (password=hunter2, token: abc, api_key="x"); the key stays, the value goes
KV_SECRET_RE = re.compile(r"\b(pass(?:word|wd|phrase|code)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth|credentials?)\b(\s*[:=]\s*)[\"']?[^\s\"',;]+[\"']?", re.I)
FENCE_RE = re.compile(r"```.*?```", re.S)
QUOTE_RE = re.compile(r"^\s*>.*$", re.M)
MISS_RE = re.compile(r"usage limit|rate.?limit|\b429\b|\b401\b|dead token|token (has )?expired|unauthori[sz]ed|quota", re.I)

FIELDS = ("input", "output", "cache_write_5m", "cache_write_1h", "cache_read")


def scrub(text, n=EXCERPT_CHARS):
    """Excerpts: at most 160 chars after the secret scrubber (plan 2B.1)."""
    t = KV_SECRET_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}[redacted]", (text or "").replace("\n", " ").strip())
    t = SECRET_RE.sub("[redacted]", t)
    return t[:n]


def user_facing(text):
    """'User-facing text' = assistant text with code fences, block quotes and tool inputs removed."""
    return QUOTE_RE.sub("", FENCE_RE.sub("", text or "")).strip()


def words(text):
    return len(re.findall(r"[A-Za-z0-9'’]+", text or ""))


def is_frustrated(text):
    """Heuristic frustration detector (MI:6, ~51% precision): profanity, ≥40% caps over ≥12 letters,
    !!! or ???, or a phrase like 'i told you'."""
    if not text: return False
    if PROFANITY.search(text) or "!!!" in text or "???" in text or FRUSTRATION_PHRASE.search(text): return True
    letters = [c for c in text if c.isalpha()]
    return len(letters) >= 12 and sum(c.isupper() for c in letters) / len(letters) >= 0.4


def _ts_ms(iso):
    t = transcripts.ts(iso)
    return int(t.timestamp() * 1000)


def _usage_row(u):
    """copied from transcripts.py:66-75 (the same 5m/1h split as Phase 1)."""
    cc = u.get("cache_creation") or {}
    cw = u.get("cache_creation_input_tokens", 0) or 0
    cw1 = cc.get("ephemeral_1h_input_tokens", 0) or 0
    cw5 = cc.get("ephemeral_5m_input_tokens")
    return dict(input=u.get("input_tokens", 0) or 0, output=u.get("output_tokens", 0) or 0,
                cache_write_5m=cw5 if cw5 is not None else cw - cw1, cache_write_1h=cw1,
                cache_read=u.get("cache_read_input_tokens", 0) or 0)


def _blocks(content):
    if isinstance(content, str): return [dict(type="text", text=content)]
    return [b for b in (content or []) if isinstance(b, dict)]


def _result_text(content):
    if isinstance(content, str): return content
    out = []
    for b in content or []:
        if isinstance(b, dict) and b.get("type") == "text": out.append(b.get("text") or "")
        elif isinstance(b, str): out.append(b)
    return "\n".join(out)


def new_session():
    return dict(entrypoint=None, turns={}, users=[], files=set(), sidechain_prompts=0)


def scan(s_ms, e_ms, session=None, pattern=transcripts.CLAUDE_GLOB):
    """Stream the window's Claude Code transcripts (same glob and mtime prefilter as Phase 1).
    Returns {sessionId: {entrypoint, turns: {key: turn}, users: [user event], files}}.
    A turn = one assistant API reply keyed (message.id, requestId) with its text, tool_uses and usage."""
    s_dt = dt.datetime.fromtimestamp(s_ms / 1000, PT) if s_ms is not None else None
    files = [f for f in glob.glob(os.path.expanduser(pattern), recursive=True)
             if s_dt is None or dt.datetime.fromtimestamp(os.path.getmtime(f), PT) >= s_dt]
    sessions = collections.defaultdict(new_session)
    for f in files:
        with open(f, errors="ignore") as fh:
            for line in fh:
                if '"timestamp"' not in line or ('"assistant"' not in line and '"user"' not in line): continue
                if session is not None and session not in line: continue
                try: d = json.loads(line)
                except Exception: continue
                typ = d.get("type")
                if typ not in ("assistant", "user") or not d.get("timestamp"): continue
                sid = d.get("sessionId") or d.get("session_id")
                if session is not None and sid != session: continue
                try: t_ms = _ts_ms(d["timestamp"])
                except Exception: continue
                if s_ms is not None and not (s_ms <= t_ms < e_ms): continue
                S = sessions[sid]; S["files"].add(f)
                if d.get("entrypoint") and not S["entrypoint"]: S["entrypoint"] = d["entrypoint"]
                m = d.get("message") or {}
                if typ == "assistant":
                    key = (m.get("id"), d.get("requestId"))
                    T = S["turns"].get(key)
                    if T is None:
                        u = m.get("usage") or {}
                        row = _usage_row(u) if u else None
                        T = S["turns"][key] = dict(key=key, ts_ms=t_ms, model=m.get("model"), text="", tool_uses=[], usage=row,
                                                   sidechain=bool(d.get("isSidechain")), file=f, uuid=d.get("uuid"))
                    elif T["usage"] is None and m.get("usage"): T["usage"] = _usage_row(m["usage"])
                    for b in _blocks(m.get("content")):
                        if b.get("type") == "text" and len(T["text"]) < TEXT_KEEP: T["text"] += (b.get("text") or "")[:TEXT_KEEP]
                        elif b.get("type") == "tool_use":
                            inp = b.get("input"); inp_s = inp if isinstance(inp, str) else json.dumps(inp, sort_keys=True)
                            T["tool_uses"].append(dict(id=b.get("id"), name=b.get("name") or "", input=inp if isinstance(inp, dict) else {}, input_s=inp_s[:INPUT_KEEP]))
                else:
                    blocks = _blocks(m.get("content")); results = []; texts = []
                    for b in blocks:
                        if b.get("type") == "tool_result":
                            results.append(dict(tool_use_id=b.get("tool_use_id"), is_error=bool(b.get("is_error")), content=_result_text(b.get("content"))[:RESULT_KEEP]))
                        elif b.get("type") == "text": texts.append(b.get("text") or "")
                    text = "\n".join(texts).strip()
                    if not results and not text: continue
                    if d.get("isMeta") and not results: continue                  # harness meta lines are not prompts
                    S["users"].append(dict(ts_ms=t_ms, text=text[:TEXT_KEEP], results=results, sidechain=bool(d.get("isSidechain")),
                                          uuid=d.get("uuid"), turn_origin=d.get("turnOrigin")))
    return dict(sessions), dict(files_seen=len(files))


# ---- human-or-bot tagging (R2) ----
def session_tag(S):
    """alex_direct (interactive cli, no agent-prompt markers) | agent_relayed | unknown (plan 2B.1)."""
    prompts = [u for u in S["users"] if u["text"] and not u["sidechain"] and not u["results"]]
    if S["entrypoint"] in HEADLESS: return "agent_relayed"
    marked = [bool(BOT_MARKERS.search(u["text"])) for u in prompts]
    if marked and (marked[0] or all(marked)): return "agent_relayed"        # launched by an agent, or nothing but relays
    if S["entrypoint"] == "cli" and prompts: return "alex_direct"           # a marker later on tags that prompt alone (tag_user_turns)
    return "unknown"


def tag_user_turns(S):
    tag = session_tag(S); S["tag"] = tag
    for u in S["users"]:
        if u["results"] and not u["text"]: u["author"] = "tool"; continue
        if u["sidechain"] or tag == "agent_relayed" or BOT_MARKERS.search(u["text"]) or u.get("turn_origin") in ("task_notification", "sdk", "scheduled", "peer"):
            u["author"] = "bot"
        elif tag == "alex_direct": u["author"] = "human"
        else: u["author"] = "unknown"
    return tag


def tag_prompt_row(text):
    """A claude-mem user_prompts row is human only when it passes the marker filter."""
    return "bot" if BOT_MARKERS.search(text or "") else "human"


# ---- pricing turns ----
def price_turns(sessions, pricer):
    for S in sessions.values():
        for T in S["turns"].values():
            rt = pricer.rate(T["model"]) if T["model"] else None
            T["x1e6"] = costs.api_equiv_x1e6(T["usage"], rt) if (T["usage"] and rt) else None
            T["model_status"] = "observed" if T["model"] else "assumed"


def ordered_turns(S):
    return sorted(S["turns"].values(), key=lambda T: T["ts_ms"])


def turn_cost(turns):
    """Sum of priced turns in micro-dollars; unpriced turns add nothing but are counted."""
    return sum(T["x1e6"] or 0 for T in turns)


# ---- human messages: transcripts first, claude-mem user_prompts only for sessions without a box transcript ----
def load_prompt_rows(db, scope):
    cols = "content_session_id, prompt_text, created_at_epoch, coalesce(origin_device_id,'local')"
    if scope.kind == "session":
        q = f"SELECT {cols} FROM user_prompts WHERE content_session_id = ?"; args = (scope.session,)
    else:
        q = f"SELECT {cols} FROM user_prompts WHERE created_at_epoch >= ? AND created_at_epoch < ?"; args = (scope.S, scope.E)
    return [dict(session=r[0], text=r[1] or "", ts_ms=r[2], device=r[3]) for r in db.execute(q, args)]


def human_messages(sessions, prompt_rows):
    """Per content_session_id: [{ts_ms, text, author, source}] ordered. Sessions with a box transcript
    use its tagged user turns; other sessions (Mac replica, remote) use the tagged user_prompts rows."""
    msgs = collections.defaultdict(list); tags = collections.Counter()
    for sid, S in sessions.items():
        for u in S["users"]:
            if u["author"] == "tool": continue
            tags[u["author"]] += 1
            msgs[sid].append(dict(ts_ms=u["ts_ms"], text=u["text"], author=u["author"], source="transcript"))
    for r in prompt_rows:
        if r["session"] in sessions: continue
        a = tag_prompt_row(r["text"]); tags[a] += 1
        msgs[r["session"]].append(dict(ts_ms=r["ts_ms"], text=r["text"], author=a, source="user_prompts", device=r["device"]))
    for v in msgs.values(): v.sort(key=lambda m: m["ts_ms"])
    return msgs, dict(human=tags["human"], bot=tags["bot"], unknown=tags["unknown"])


# ---- episodes (plan 2B.1, 2B.2) ----
def episode_id(session, first_ts):
    return "EP-" + hashlib.sha1(f"{session}|{first_ts}".encode()).hexdigest()[:10]


def find_episodes(msgs, phrase_hit=None):
    """Frustrated human-tagged messages in one session with gaps ≤45 min form one episode. A human message
    that matches a pattern's own human phrase (2B.3) is a candidate too; the pattern detector is its confirmation."""
    eps = []
    for sid, ms in msgs.items():
        cur = None
        for m in ms:
            if m["author"] != "human" or not (is_frustrated(m["text"]) or (phrase_hit and phrase_hit(m["text"]))): continue
            if cur and m["ts_ms"] - cur["messages"][-1]["ts_ms"] <= GAP_MIN * 60_000: cur["messages"].append(m)
            else:
                cur = dict(session=sid, messages=[m]); eps.append(cur)
    for e in eps:
        e["episode_id"] = episode_id(e["session"], e["messages"][0]["ts_ms"])
        e["first_ts"] = e["messages"][0]["ts_ms"]; e["last_ts"] = e["messages"][-1]["ts_ms"]
    return eps


def episode_windows(ep, S, all_msgs):
    """wasted = turns from the previous human prompt to the first frustrated message (cap 6h);
    redo = turns in the 60 min after the last message. Same session only (MI:9)."""
    if S is None: return [], [], None
    prev = [m["ts_ms"] for m in all_msgs.get(ep["session"], []) if m["ts_ms"] < ep["first_ts"] and m["author"] in ("human", "bot", "unknown")]
    start = max(prev) if prev else ep["first_ts"] - WASTED_CAP_MS
    start = max(start, ep["first_ts"] - WASTED_CAP_MS)
    turns = ordered_turns(S)
    wasted = [T for T in turns if start <= T["ts_ms"] < ep["first_ts"]]
    redo = [T for T in turns if ep["last_ts"] < T["ts_ms"] <= ep["last_ts"] + REDO_MS]
    before = [T["ts_ms"] for T in turns if T["ts_ms"] < ep["first_ts"]]
    last_agent = max(before) if before else None
    return wasted, redo, last_agent


def alex_minutes(ep, last_agent_ts):
    """time since the last agent output before the complaint (cap 60) + episode span + 1 min per message (MI:10)."""
    wait = min(ALEX_WAIT_CAP_MIN, (ep["first_ts"] - last_agent_ts) / 60_000) if last_agent_ts else 0
    span = (ep["last_ts"] - ep["first_ts"]) / 60_000
    return round(wait + span + len(ep["messages"]), 1)


def pt_iso(ms):
    return dt.datetime.fromtimestamp(ms / 1000, PT).isoformat(timespec="minutes")


def day_pt(ms):
    return dt.datetime.fromtimestamp(ms / 1000, PT).strftime("%Y-%m-%d")


# ---- failure-signal turn spans (plan 2B.9) ----
def failure_spans(S, msgs):
    """Rework / Wrong turn = turns from the user message before the corrected work up to the
    steer/reset/correction message; Recovery after miss = turns from the miss to the first successful
    tool result after it; Looping is handled by S1. Returns {failure_type: set(keys)}."""
    turns = ordered_turns(S); out = collections.defaultdict(set)
    users = [u for u in S["users"] if u["text"] and not u["results"]]
    for i, u in enumerate(users):
        if CORRECTION.search(u["text"]):
            prev = users[i - 1]["ts_ms"] if i else (u["ts_ms"] - WASTED_CAP_MS)
            for T in turns:
                if prev <= T["ts_ms"] < u["ts_ms"]: out["Rework"].add(T["key"])
    miss_at = None
    for u in S["users"]:
        for r in u["results"]:
            if miss_at is None and (r["is_error"] and MISS_RE.search(r["content"] or "")): miss_at = u["ts_ms"]
            elif miss_at is not None and not r["is_error"]:
                for T in turns:
                    if miss_at <= T["ts_ms"] <= u["ts_ms"]: out["Recovery after miss"].add(T["key"])
                miss_at = None
    return out
