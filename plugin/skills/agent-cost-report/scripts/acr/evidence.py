"""Sessions, devices, per-session evidence and the transcript join (plan Phase 2.1).

Copied from /workspace/weekly-cost-workflow/weekly_report.py:44-86 (sessions, devices, evidence),
:137 (join key) and :151-156 (unmatched transcripts). Not copied on purpose: :54-56 (seat names and
device UUIDs) and :158-168 (gateway log parsing). Devices are labeled local / remote-1 / remote-2 in
first-seen order; UUIDs only ever leave this module as short hashes.
Queries select named columns with a window or id filter; nothing loads a whole table.
"""
import collections
import datetime as dt
import hashlib
import re

from .period import PT

# copied from weekly_report.py:65
SHIP_RE = re.compile(r"\b(merged|published|released|shipped|npm publish|tagged v?\d|publish complete|committed)\b", re.I)
SHIP_TYPES = ("feature", "bugfix", "change")   # weekly_report.py:74
COMPLETED_MIN_LEN = 20                         # weekly_report.py:79
LOCAL = "local"                                # origin_device_id NULL = this device (SessionStore.ts:574-579)
PROMPT_CHARS = 1000                            # prompt text is only used for keyword rules and the 80-char loop check

SESSION_COLS = ("id", "content_session_id", "memory_session_id", "project", "platform_source", "user_prompt",
                "started_at_epoch", "completed_at_epoch", "status", "custom_title", "observed_model", "observed_billing")


class Scope:
    """kind = period | session | project. S/E are epoch ms (None for a session run)."""
    def __init__(self, kind, S=None, E=None, session=None, project=None):
        self.kind, self.S, self.E, self.session, self.project = kind, S, E, session, project

    def block(self):
        return dict(kind=self.kind, session=self.session, project=self.project)


def pt(ms):
    return dt.datetime.fromtimestamp(ms / 1000, PT)


def day_pt(ms):
    return pt(ms).date().isoformat()


def device_hash(device_id):
    """Short hash for Details; the UUID itself is never written to any output."""
    return LOCAL if device_id == LOCAL else hashlib.sha1(device_id.encode()).hexdigest()[:8]


def session_key(r):
    """copied from weekly_report.py:45: memory_session_id or nomem-<id>."""
    return r["memory_session_id"] or f"nomem-{r['id']}"


def load_sessions(db, scope):
    """copied from weekly_report.py:45-47 (period), extended with the --session / --project scopes."""
    cols = ", ".join(SESSION_COLS)
    if scope.kind == "session":
        sql, args = f"select {cols} from sdk_sessions where content_session_id=?", (scope.session,)
    elif scope.kind == "project":   # a project and its worktrees (`<repo>/<worktree>`, src/utils/project-name.ts:100-125)
        sql, args = (f"select {cols} from sdk_sessions where started_at_epoch>=? and started_at_epoch<? and (project=? or project like ?)",
                     (scope.S, scope.E, scope.project, scope.project + "/%"))
    else:
        sql, args = f"select {cols} from sdk_sessions where started_at_epoch>=? and started_at_epoch<?", (scope.S, scope.E)
    sess = {}
    for r in db.execute(sql, args):
        d = dict(r); sess[session_key(d)] = d
    return sess


def _rows(db, table, cols, scope, id_col, ids):
    """Window-bounded (period/project) or id-bounded (session) rows of one table, streamed."""
    c = ", ".join(cols)
    if scope.kind == "session":
        for i in ids:
            yield from db.execute(f"select {c} from {table} where {id_col}=?", (i,))
    else:
        yield from db.execute(f"select {c} from {table} where created_at_epoch>=? and created_at_epoch<?", (scope.S, scope.E))


def new_evidence():
    # shape copied from weekly_report.py:63-64, plus ids / completed text / ship (id, title) pairs
    return dict(obs=0, types=collections.Counter(), obs_tok=0, obs_tok_dedup=0, obs_cost_x1e6=0, models=set(), sums=0,
                completed_sums=0, completed_text=None, prompts=[], stamps=[], ship_titles=[], ship_ids=[], text=[],
                obs_ids=[], sum_ids=[], devices=set())


def load_evidence(db, scope, sess, observer_rate):
    """Per-session evidence (weekly_report.py:59-86) and the device registry (:48-53).

    observer_rate(model) -> input USD/MTok or None; the observer cost is accumulated in integer
    micro-dollars, deduped on (memory_session_id, created_at_epoch, discovery_tokens) (:70-73).
    Returns (ev, devices, counts) where devices = {device_id: label} in first-seen order."""
    bycs = {v["content_session_id"]: k for k, v in sess.items()}                     # :47
    mids = list(sess) if scope.kind == "session" else None
    csids = [v["content_session_id"] for v in sess.values()] if scope.kind == "session" else None
    ev = collections.defaultdict(new_evidence)
    first_seen = {}                                                                   # device_id -> first epoch
    seen_reply = set(); observer_unpriced = collections.Counter(); counts = collections.Counter()

    def in_scope(m):
        return scope.kind != "project" or m in sess                                  # project runs: other projects' rows never enter the metadata

    def dev(m, device_id, t):
        d = device_id or LOCAL
        if d not in first_seen or t < first_seen[d]: first_seen[d] = t
        if m is not None: ev[m]["devices"].add(d)

    # observer (note-taker) cost only: discovery_tokens are the observer model's own tokens, deduped below, never agent cost
    for o in _rows(db, "observations", ("id", "memory_session_id", "project", "type", "title", "discovery_tokens",   # observer tokens
                                        "created_at_epoch", "generated_by_model", "origin_device_id"), scope, "memory_session_id", mids or ()):
        m = o["memory_session_id"]
        if not in_scope(m): continue
        counts["observations"] += 1; e = ev[m]
        e["obs"] += 1; e["types"][o["type"]] += 1; e["obs_ids"].append(o["id"])
        e["obs_tok"] += o["discovery_tokens"] or 0; e["models"].add(o["generated_by_model"]); e["stamps"].append(o["created_at_epoch"])   # observer tokens
        key = (m, o["created_at_epoch"], o["discovery_tokens"])                       # :70 observer dedup key
        if key not in seen_reply:
            seen_reply.add(key); tok = o["discovery_tokens"] or 0; e["obs_tok_dedup"] += tok
            r = observer_rate(o["generated_by_model"])                                 # :72-73, priced at the input rate only
            if r is None: observer_unpriced[o["generated_by_model"]] += tok
            else: e["obs_cost_x1e6"] += int(round(tok * r))
        if o["type"] in SHIP_TYPES and SHIP_RE.search(o["title"] or ""):              # :74-75
            e["ship_titles"].append(o["title"]); e["ship_ids"].append(o["id"])
        e["text"].append(o["title"] or "")
        dev(m, o["origin_device_id"], o["created_at_epoch"])
    # observer tokens on summaries (note-taker), same dedup rule
    for s_ in _rows(db, "session_summaries", ("id", "memory_session_id", "request", "completed", "discovery_tokens",   # observer tokens
                                             "created_at_epoch", "origin_device_id"), scope, "memory_session_id", mids or ()):
        m = s_["memory_session_id"]
        if not in_scope(m): continue
        counts["summaries"] += 1; e = ev[m]
        e["sums"] += 1; e["sum_ids"].append(s_["id"]); e["stamps"].append(s_["created_at_epoch"])
        if s_["completed"] and len(s_["completed"]) > COMPLETED_MIN_LEN:                # :79
            e["completed_sums"] += 1
            if e["completed_text"] is None: e["completed_text"] = s_["completed"]
        e["text"].append((s_["request"] or "") + " " + (s_["completed"] or ""))
        dev(m, s_["origin_device_id"], s_["created_at_epoch"])
    for p in _rows(db, "user_prompts", ("content_session_id", f"substr(prompt_text,1,{PROMPT_CHARS}) as prompt_text",
                                        "created_at_epoch", "origin_device_id"), scope, "content_session_id", csids or ()):
        m = bycs.get(p["content_session_id"])
        if not in_scope(m): continue
        counts["prompts"] += 1
        if m: ev[m]["prompts"].append(p["prompt_text"]); ev[m]["stamps"].append(p["created_at_epoch"])
        dev(m, p["origin_device_id"], p["created_at_epoch"])
    for t in _rows(db, "tool_uses", ("content_session_id", "created_at_epoch"), scope, "content_session_id", csids or ()):
        m = bycs.get(t["content_session_id"])
        if not in_scope(m): continue
        counts["tool_uses"] += 1
        if m: ev[m]["stamps"].append(t["created_at_epoch"])
    # device labels: local first, then remote-N in first-seen order (never the UUID)
    labels = {LOCAL: LOCAL}; n = 0
    for d, _ in sorted(first_seen.items(), key=lambda kv: kv[1]):
        if d != LOCAL: n += 1; labels[d] = f"remote-{n}"
    return ev, labels, counts, observer_unpriced


def join_transcripts(rows, sess):
    """Group usage rows by transcript session and split matched / unmatched.
    Join key: usage.session == sdk_sessions.content_session_id (weekly_report.py:137; plan Phase 0 C)."""
    bycs = {v["content_session_id"]: k for k, v in sess.items()}
    by_session = collections.defaultdict(list)
    for r in rows: by_session[r["session"]].append(r)
    matched = {bycs[cs]: rs for cs, rs in by_session.items() if cs in bycs}
    unmatched = {cs: rs for cs, rs in by_session.items() if cs not in bycs}           # :151-156
    return matched, unmatched
