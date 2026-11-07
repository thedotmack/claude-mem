"""Phase 2B pattern detectors (plan 2B.3): Frustration Arc's final list P1–P12 plus the supporting
metrics S1 (tool errors and retries) and S2 (hedging, Alex's definition per G10). Every detector is a
heuristic (count_basis "heuristic") until the optional classifier (2B.4) or a human review confirms it.
Source refs cite /workspace/frustration-arc/metrics-ideas.md (MI:<line>). Failure types map onto the
16 in SKILL.md:80 or stay empty; no new types.

A detector returns flags: dict(pattern, key, session, ts_ms, excerpt, basis, **extra). `key` is the
assistant turn key so the flag is priced by the same usage row Phase 1 counted. Human-phrase
detectors fire on human-tagged messages and flag the episode's wasted window (2B.1 pattern assignment).
"""
import collections
import hashlib
import re

from . import behavior, costs, prices

FAILURE_TYPES = ("Looping", "Hedging", "Wrong turn", "Rework", "Regression", "Premature completion", "Unauthorized action",
                 "Suboptimal path", "Duplicate work", "Blocked work", "Missed requirement", "Unnecessary escalation",
                 "Context re-read", "Model thrash", "Fan-out waste", "Recovery after miss")   # SKILL.md:80

# key, name, MI line, failure type, placement, summary tile order
PATTERNS = [
    ("P1_invented_gates", "Invented human gates / asking instead of doing", 16, "Unnecessary escalation", "tile"),
    ("P2_broke_things", "Broke working things", 17, "Regression", "tile"),
    ("P3_wrong_model", "Wrong or expensive model", 18, "Model thrash", "tile"),
    ("P4_over_engineering", "Over-engineering / overthinking", 19, "Suboptimal path", "details"),
    ("P5_not_asked", "Did something not asked", 20, "Missed requirement", "details"),
    ("P6_fake_output", "Fake or invented output", 21, "Premature completion", "tile"),
    ("P7_false_done", "Skipped steps / false done", 22, "Premature completion", "tile"),
    ("P8_wrong_tool", "Wrong tool, account, or contact", 23, "Suboptimal path", "details"),
    ("P9_bad_outbound", "Bad outbound", 24, "Unauthorized action", "details"),
    ("P10_memory_loss", "Memory or rule loss", 25, "", "details"),
    ("P11_jargon", "Jargon / walls of text", 26, "", "details"),
    ("P12_unclear", "Unclear cause", 27, "", "details"),
    ("S1_tool_errors", "Tool errors and retries", None, "Recovery after miss", "details"),
    ("S2_hedging", "Hedging", None, "Hedging", "details"),
]
TILE_ORDER = ("P1_invented_gates", "P6_fake_output", "P7_false_done", "P2_broke_things", "P3_wrong_model")   # 2B.3 summary strip
MERGED_TILE = ("P6_fake_output", "P7_false_done")   # tile 2: made it up, or said done when it wasn't
NAMES = {k: n for k, n, *_ in PATTERNS}
assert all(ft in FAILURE_TYPES or ft == "" for _, _, _, ft, _ in PATTERNS)

# ---- P1 (MI:16) plus the old M2 rules ----
P1_AGENT = re.compile(r"Blocked on Alex|needs your sign-off|initials|please click|open this link and|when you get a chance|human gate", re.I)
P1_ASK = re.compile(r"(?i)would you like me to|do you want me to|want me to|should I\b|shall I\b|let me know if|can you (paste|provide|send|share|click|confirm|approve|log ?in)|"
                    r"please (paste|provide|click|approve|confirm|run)|I need you to|waiting (for|on) (you|your)|blocked on (you|Alex)|needs? Alex|human gate")
P1_ANNOYED = re.compile(r"(?i)already|I told you|just do it|stop asking|why do I have to|no .{0,20}human gate|fuck|wtf")
P1_HUMAN = re.compile(r"who (made|makes) up|no one said|you're allowed|just do it|(arbitrary|fake|invented|made.up) gate|human gates?\b", re.I)
P1_ANSWER_SHAPE = re.compile(r"sk-[\w-]{6,}|ghp_\w+|https?://\S+|/[\w.-]+/[\w./-]+|\bpassword\b|\bapproved?\b|\byes\b|\bgo ahead\b", re.I)
# real gates on the house allow-list (HUMAN-GATES-PLAIN-ENGLISH.md, Alex 2026-09-23): never flagged
P1_REAL_GATE = re.compile(r"cold (allow|start)|payment method|wet[- ]ink|signature|2FA|two[- ]factor", re.I)
# ---- P2 (MI:17) ----
P2_HUMAN = re.compile(r"\b(broke|broken|crash\w*|regress\w*|was working)\b", re.I)
P2_REVERT = re.compile(r"^\s*git\s+revert\b|\bgh pr create\b.*\brevert\b", re.I | re.M)
# ---- P3 (MI:18), defaults settled by G16 (plan defaults): Claude for claude-mem work, deepseek flash for cheap evals ----
# Claude for claude-mem work and deepseek flash for cheap evals (MI:18); Codex gpt-6-astra for bug-fix make-plans is a house
# HARD rule of 2026-09-10 (frustration-arc/trend.md), so it is on the default list too.
P3_ALLOWED = re.compile(r"^anthropic/claude|^claude|deepseek.*flash|^openai/gpt-6-astra", re.I)
P3_FALLBACK_DEFAULT = "anthropic/claude-sonnet-5"
P3_HUMAN = re.compile(r"\b(gemini|gpt-5|why are you using|credits|spent)\b", re.I)
# ---- P4 (MI:19) ----
P4_HUMAN = re.compile(r"\b(happy path|overthink\w*|guards?|harden\w*|simple)\b", re.I)
P4_FILE = re.compile(r"(guard|harden|fallback|validator)[\w-]*\.(py|ts|js|sh|md)$", re.I)
P4_PLAN_LINES = 600
# ---- P5 (MI:20) plus the old M6 phrases ----
P5_HUMAN = re.compile(r"i did not ask|i didn't tell you|nobody said|I SAID|wrong (side|end|repo)|receiving end|sending end|why is there .{0,40}(in|from) that repo|not what I (asked|want)|feels? dumb", re.I)
# ---- P6 (MI:21) ----
P6_CLAIMED_SKILL = re.compile(r"(?:\bran|\brunning|\bexecuted|\bcompleted|\binvoked|\bused)\s+(?:the\s+)?`?(/[a-z][\w:-]+)`?|`?(/[a-z][\w:-]+)`?\s+(?:ran|has run|completed|finished|is done)", re.I)
P6_PLACEHOLDER = re.compile(r"\$0\.00\b|\blorem\b|\bTBD\b", re.I)   # MI:21 list; bare `123` is too noisy in prose and is left to the classifier
# ---- P7 (MI:22) plus the old M3 rule ----
P7_CLAIM = re.compile(r"(?i)\b(done|fixed|works now|deployed|shipped|merged|all tests pass(ed)?|verified|100%|confirmed)\b")
P7_NEGATED = re.compile(r"(?i)\b(not|isn't|isn t|aren't|wasn't|never|once|will be|until|before|if|when|unless|after)\s+(?:\w+\s+){0,2}(done|fixed|works now|deployed|shipped|merged|verified|confirmed)\b|\b(done|fixed|deployed|shipped|merged|verified)\b\s*\?")
P7_PROOF_CMD = re.compile(r"pytest|unittest|vitest|jest|bun test|npm (run )?test|go test|cargo test|curl\b|gh pr (view|checks|merge)|git push|wrangler deploy|vercel|deploy", re.I)
P7_PROOF_OUT = re.compile(r"\bpassed\b|\bOK\b|\b(200|201|204)\b|MERGED|mergedAt|Deployed|https?://|\bmain -> main\b|->\s+\w+/\w+", re.I)
P7_PROD_CLAIM = re.compile(r"deployed|in production|live now|fixed in prod", re.I)
P7_MERGE_ONLY = re.compile(r"gh pr merge", re.I)
# ---- P8 (MI:23): deny list from the HARD rules (trend.md 2026-09-04..23) ----
P8_DENY_TOOL = re.compile(r"zapier|computer[_-]?use|mcp__.*computer", re.I)
P8_DENY_INPUT = re.compile(r"zapier\.com|\bas Alex\b|from:\s*\"?alex@|hello@thedotmack|aj@(?!aicollective\.com)[\w.-]+", re.I)
# ---- P9 (MI:24): sends without approval, recipient count above 10 (G16), Alex's identity ----
P9_SEND_TOOL = re.compile(r"(gmail|resend|mail|slack|telegram|sms|twilio|sendgrid|postmark).*?(send|reply|forward|broadcast)|(send|reply|forward).*?(email|broadcast)", re.I)
P9_NOT_OUTBOUND = re.compile(r"^(SendMessage|PushNotification|SendFeedback)$")   # inter-agent / harness tools, not outbound
P9_APPROVAL = re.compile(r"\b(send it|go ahead|approved?|yes,? send|ship it|do it|fire away)\b", re.I)
P9_RECIPIENT_CAP = 10
P9_ALEX_IDENTITY = re.compile(r"alex@|thedotmack@gmail|\"from\":\s*\"[^\"]*alex", re.I)
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
# ---- P10 (MI:25) ----
P10_HUMAN = re.compile(r"I told you|100 times|8,?000 times|what's the rule|like i said", re.I)
# ---- P11 (MI:26) ----
P11_MAX_WORDS = 150   # G16, settled
P11_JARGON = ("drain", "projection", "projected_seq", "head_seq", "poll-mode", "lag", "kill-switch", "BYOK", "face-wall", "chatty",
              "Durable Object", "idempotent", "backfill", "TOCTOU")   # HUMAN-GATES-PLAIN-ENGLISH.md cheat sheet + Alex's example
P11_GLOSS = re.compile(r"\(|—|\bmeans\b|\bi\.e\.|\bthat is\b", re.I)
P11_HUMAN = re.compile(r"\b(jargon|9000 things|single answer|plain english)\b", re.I)
P11_PATH = re.compile(r"(?<![\w/])/(?:workspace|home|tmp|Users)/[\w./-]+")
# ---- S1 ----
# plan 2B.3 S1 list; bare 3-digit numbers only count next to an HTTP/status/code word, else grep output and token counts match
S1_ERROR_TEXT = re.compile(r"(?i)^\W{0,3}(error|fatal)\b|traceback \(most recent|exit code [1-9]|command not found|no such file or directory|ENOENT|EACCES|timed out|"
                           r"(HTTP|status|code|error)\W{0,4}(429|5\d\d)\b|\brate.?limit(ed|s)?\b")
S1_DENIAL = re.compile(r"Permission to use .* has been denied|denied by (a )?(hook|rule|permission)|blocked by (a )?(hook|rule|permission)", re.I)
S1_RETRY_WINDOW = 5
S1_SIMILARITY = 0.8
S1_LOOP_N = 3
# ---- S2 (G10: Alex's definition) ----
S2_LEXICON = re.compile(r"\b(might|may|could potentially|possibly|perhaps|it seems|it appears|appears to|probably|likely|I think|I believe|not sure|can't be sure|cannot be sure|"
                        r"no way to (know|tell)|hard to say|should work|should be (fine|fixed|good|working)|in theory|hopefully|if you want|would you like|depending on)\b", re.I)
S2_STATUS = re.compile(r"should be (fixed|deployed|working)|probably (works|fixed|deployed)|I think it'?s (done|fixed)", re.I)
S2_TARGET = re.compile(r"(/[\w.-]+/[\w./-]+|`[^`]{2,80}`|#\d{2,6}|https?://\S+|\btest_\w+|\b\d+(\.\d+)?%?)")
S2_ALLOW = re.compile(r"\b(estimated?|low confidence|unavailable|measured spend unavailable|unmeasured|extrapolated|heuristic)\b", re.I)
S2_FOLLOWUP = re.compile(r"(?i)is it|yes or no|did you|confirm|what do you mean|straight answer")
MASK_RE = re.compile(r"/tmp/\S+|\d+")


def flag(pattern, T, session, excerpt, basis, **extra):
    return dict(pattern=pattern, key=T["key"] if T else None, session=session, ts_ms=T["ts_ms"] if T else extra.pop("ts_ms", None),
                excerpt=behavior.scrub(excerpt), basis=basis, label_source="heuristic", **extra)


def _norm_input(s):
    return " ".join(MASK_RE.sub("#", s or "").split())


def _similar(a, b):
    """Normalized input similarity: Jaccard over tokens after whitespace collapse and number/temp-path masking."""
    ta, tb = set(re.findall(r"\w+", _norm_input(a))), set(re.findall(r"\w+", _norm_input(b)))
    return len(ta & tb) / len(ta | tb) if (ta or tb) else 1.0


def user_facing_turns(S):
    """Each assistant turn's user-facing text (the last text before the next user prompt is what Alex reads)."""
    turns = behavior.ordered_turns(S)
    prompts = sorted(u["ts_ms"] for u in S["users"] if u["text"] and not u["results"])
    out = []
    for i, T in enumerate(turns):
        txt = behavior.user_facing(T["text"])
        nxt_turn = turns[i + 1]["ts_ms"] if i + 1 < len(turns) else None
        nxt_prompt = next((p for p in prompts if p > T["ts_ms"]), None)
        final = txt and (nxt_turn is None or (nxt_prompt is not None and nxt_prompt < nxt_turn))
        out.append((T, txt, bool(final), nxt_prompt))
    return out


def _events(S):
    """Interleaved (ts, kind, obj) with kind in {turn, user}."""
    ev = [(T["ts_ms"], "turn", T) for T in S["turns"].values()] + [(u["ts_ms"], "user", u) for u in S["users"]]
    return sorted(ev, key=lambda e: e[0])


def _results_by_id(S):
    out = {}
    for u in S["users"]:
        for r in u["results"]: out[r["tool_use_id"]] = (u["ts_ms"], r)
    return out


# ---------------- detectors on agent turns ----------------
def detect_p1(S, sid, msgs):
    flags = []; uf = user_facing_turns(S); turns = behavior.ordered_turns(S)
    users = [u for u in S["users"] if u["text"] and not u["results"]]
    for T, txt, final, nxt_prompt in uf:
        if not txt or not final: continue          # only what Alex reads: the last text before the next prompt or session end
        tail = txt[-600:]
        hard = bool(P1_AGENT.search(tail)); cand = hard or tail.rstrip().endswith("?") or bool(P1_ASK.search(tail))
        if not cand or P1_REAL_GATE.search(tail): continue
        earlier = " ".join(u["text"] for u in users if u["ts_ms"] < T["ts_ms"])
        boosts = []
        if P1_ANSWER_SHAPE.search(earlier): boosts.append("already answered")
        if S["entrypoint"] in behavior.HEADLESS and T is turns[-1]: boosts.append("nobody can answer (headless session ends on the ask)")
        nxt = next((u for u in users if u["ts_ms"] > T["ts_ms"]), None)
        if nxt and P1_ANNOYED.search(nxt["text"]): boosts.append("annoyed reply")
        if not (hard or boosts):
            flags.append(flag("P1_invented_gates", T, sid, tail[-160:], "candidate, no boost", unconfirmed=True)); continue
        asked = "Alex" if S.get("tag") == "alex_direct" else "agent"
        wait_min = round((nxt["ts_ms"] - T["ts_ms"]) / 60_000, 1) if nxt else None
        # cost: the asking turn plus up to 2 turns after the reply that rebuild state
        after = [x for x in turns if nxt and x["ts_ms"] > nxt["ts_ms"]][:2] if nxt else []
        if S["entrypoint"] in behavior.HEADLESS and T is turns[-1]:
            last_ok = max([ts for ts, r in _results_by_id(S).values() if not r["is_error"]] or [0])
            after = [x for x in turns if x["ts_ms"] > last_ok and x is not T]
        f = flag("P1_invented_gates", T, sid, tail[-160:], "agent text: " + ("gate phrase" if hard else "ask + " + ", ".join(boosts)),
                 asked=asked, waiting_minutes=wait_min, never_answered=nxt is None, extra_keys=[x["key"] for x in after])
        flags.append(f)
    return flags


def detect_p3(S, sid, default_model, pricer):
    flags = []; not_logged = 0
    for T in S["turns"].values():
        if not T["usage"]: continue
        if not T["model"]: not_logged += 1; continue
        m = prices.norm(T["model"])
        if m == "<synthetic>" or P3_ALLOWED.search(m): continue
        rt_def = pricer.rate(default_model)
        base = costs.api_equiv_x1e6(T["usage"], rt_def) if rt_def else None
        delta = (T["x1e6"] - base) if (T["x1e6"] is not None and base is not None) else None
        flags.append(flag("P3_wrong_model", T, sid, f"model {m} (default {default_model})", "message.model differs from the house default (exact)",
                          model=m, default_model=default_model, delta_x1e6=delta))
    return flags, not_logged


def detect_p4(S, sid):
    flags = []
    for T in S["turns"].values():
        for tu in T["tool_uses"]:
            if tu["name"] not in ("Write", "Edit", "MultiEdit"): continue
            path = str(tu["input"].get("file_path") or "")
            content = str(tu["input"].get("content") or "")
            if P4_FILE.search(path): flags.append(flag("P4_over_engineering", T, sid, f"new file {path}", "new guard/harden/fallback/validator file"))
            elif "/plans/" in path and content.count("\n") > P4_PLAN_LINES:
                flags.append(flag("P4_over_engineering", T, sid, f"plan {path}: {content.count(chr(10))} lines", f"plan length over {P4_PLAN_LINES} lines"))
    return flags


def detect_p6(S, sid):
    flags = []; skills = set()
    for T in S["turns"].values():
        for tu in T["tool_uses"]:
            if tu["name"] == "Skill": skills.add("/" + str(tu["input"].get("skill") or "").lstrip("/"))
    for T, txt, final, _ in user_facing_turns(S):
        if not txt or not final: continue
        for m in P6_CLAIMED_SKILL.finditer(txt):
            name = (m.group(1) or m.group(2) or "").rstrip(".,:;")
            if name and name not in skills and not any(s.endswith(name.lstrip("/")) for s in skills):
                flags.append(flag("P6_fake_output", T, sid, m.group(0), f"claimed {name} ran, no Skill tool call", trust_flag=True)); break
        if final and P6_PLACEHOLDER.search(txt):
            flags.append(flag("P6_fake_output", T, sid, P6_PLACEHOLDER.search(txt).group(0), "placeholder value in the final text", trust_flag=True))
    return flags


def detect_p7(S, sid):
    flags = []; ev = _events(S); results = _results_by_id(S); finals = {T["key"] for T, t, f, _ in user_facing_turns(S) if f and t}
    last_user = None; proof_since = None; last_edit = None; merge_only = False
    for ts, kind, obj in ev:
        if kind == "user":
            if obj["text"] and not obj["results"]: last_user = ts; proof_since = None; last_edit = None; merge_only = False
            continue
        T = obj
        for tu in T["tool_uses"]:
            if tu["name"] in ("Write", "Edit", "MultiEdit"): last_edit = ts; proof_since = None; merge_only = False
            res = results.get(tu["id"]); cmd = tu["input_s"]
            if res and not res[1]["is_error"] and (P7_PROOF_CMD.search(cmd) or tu["name"] == "Skill") and (P7_PROOF_OUT.search(res[1]["content"]) or "test" in cmd.lower()):
                if P7_MERGE_ONLY.search(cmd) and not re.search(r"deploy|wrangler|vercel", cmd, re.I): merge_only = True
                else: proof_since = ts; merge_only = False
        if T["key"] not in finals: continue
        txt = behavior.user_facing(T["text"])
        m = P7_CLAIM.search(txt or "")
        if not m: continue
        sent = txt[max(0, m.start() - 80): m.end() + 40]
        if P7_NEGATED.search(sent): continue
        if proof_since is not None and (last_edit is None or proof_since > last_edit): continue
        special = bool(P7_PROD_CLAIM.search(txt)) and merge_only
        flags.append(flag("P7_false_done", T, sid, sent, "merged, not deployed" if special else "claim with no proof since the last edit", claim=m.group(0)))
    return flags


def detect_p8(S, sid):
    flags = []
    for T in S["turns"].values():
        for tu in T["tool_uses"]:
            if P8_DENY_TOOL.search(tu["name"]) or P8_DENY_INPUT.search(tu["input_s"]):
                outside = bool(re.search(r"send|email|deploy|publish|post", tu["name"] + tu["input_s"], re.I))
                flags.append(flag("P8_wrong_tool", T, sid, f"{tu['name']} {tu['input_s'][:100]}", "tool/account/contact on the deny list",
                                  failure_type="Unauthorized action" if outside else "Suboptimal path"))
    return flags


def detect_p9(S, sid):
    flags = []; users = [u for u in S["users"] if u["text"] and not u["results"]]
    for T in S["turns"].values():
        for tu in T["tool_uses"]:
            if P9_NOT_OUTBOUND.match(tu["name"]) or not P9_SEND_TOOL.search(tu["name"]): continue
            prev = [u for u in users if u["ts_ms"] < T["ts_ms"]]
            approved = bool(prev) and prev[-1].get("author") == "human" and bool(P9_APPROVAL.search(prev[-1]["text"]))
            emails = set(EMAIL_RE.findall(tu["input_s"]))
            n = len(emails) or (0 if "broadcast" not in tu["name"].lower() else None)
            identity = bool(P9_ALEX_IDENTITY.search(tu["input_s"]))
            if approved and (n is not None and n <= P9_RECIPIENT_CAP) and not identity: continue
            why = [w for w, c in (("no human approval in the preceding turn", not approved), ("recipient count above 10", n is None or n > P9_RECIPIENT_CAP), ("sent as Alex", identity)) if c]
            flags.append(flag("P9_bad_outbound", T, sid, f"{tu['name']} to {n if n is not None else 'unknown'} recipients", "; ".join(why), recipients=n))
    return flags


def detect_p11(S, sid):
    flags = []
    for T, txt, final, _ in user_facing_turns(S):
        if not final or not txt: continue
        w = words(txt); paths = len(P11_PATH.findall(txt)); links = txt.count("http")
        terms = []
        for term in P11_JARGON:
            for m in re.finditer(r"(?i)(?<![\w-])" + re.escape(term) + r"(?![\w-])", txt):
                sent = txt[max(0, txt.rfind(".", 0, m.start()) + 1): txt.find(".", m.end()) if txt.find(".", m.end()) > 0 else len(txt)]
                if not P11_GLOSS.search(sent): terms.append(term); break
        reasons = []
        if w > P11_MAX_WORDS: reasons.append(f"{w} words in the last message")
        if terms: reasons.append("unexplained: " + ", ".join(terms))
        if paths >= 3 and not links: reasons.append(f"{paths} file paths, no links")
        if reasons: flags.append(flag("P11_jargon", T, sid, txt[:160], "; ".join(reasons), alex_minutes=round(w / 200, 1), words=w))
    return flags


def words(text):
    return behavior.words(text)


def detect_s1(S, sid):
    """Errors (is_error or text match), permission denials (separate, unpriced), retries (same tool,
    similarity ≥0.8 within 5 turns) and loops (same name+normalized input ≥3 times)."""
    flags = []; denials = []; results = _results_by_id(S); turns = behavior.ordered_turns(S)
    calls = []   # (turn index, tool_use, error?)
    for i, T in enumerate(turns):
        for tu in T["tool_uses"]:
            res = results.get(tu["id"]); err = None
            if res:
                c = res[1]["content"] or ""
                if S1_DENIAL.search(c): denials.append(dict(session=sid, ts_ms=T["ts_ms"], tool=tu["name"], excerpt=behavior.scrub(c))); calls.append((i, tu, "denied")); continue
                if res[1]["is_error"]: err = "is_error"
                elif S1_ERROR_TEXT.search(c[:2048]): err = "text"
            calls.append((i, tu, err))
    chains = 0; loops = 0; counter = collections.Counter((tu["name"], hashlib.sha1(_norm_input(tu["input_s"]).encode()).hexdigest()) for _, tu, _ in calls)
    loop_keys = {k for k, n in counter.items() if n >= S1_LOOP_N}
    for j, (i, tu, err) in enumerate(calls):
        if err in (None, "denied"): continue
        T = turns[i]; retries = []
        for i2, tu2, err2 in calls[j + 1:]:
            if i2 - i > S1_RETRY_WINDOW: break
            if tu2["name"] == tu["name"] and _similar(tu["input_s"], tu2["input_s"]) >= S1_SIMILARITY:
                retries.append((turns[i2]["key"], err2))
                if err2 is None: break
        chains += 1
        recovered = bool(retries) and retries[-1][1] is None
        flags.append(flag("S1_tool_errors", T, sid, f"{tu['name']}: {tu['input_s'][:80]}", f"tool error ({err}), {len(retries)} retries, " + ("recovered" if recovered else "never succeeded"),
                          confidence="high" if err == "is_error" else "medium", failure_type="Recovery after miss",
                          recovery_keys=[k for k, e in retries] if recovered else [], wasted_extra=[] if recovered else [k for k, e in retries]))
    for k in loop_keys:
        seen = [(i, tu) for i, tu, _ in calls if (tu["name"], hashlib.sha1(_norm_input(tu["input_s"]).encode()).hexdigest()) == k]
        for i, tu in seen[1:]:
            flags.append(flag("S1_tool_errors", turns[i], sid, f"{tu['name']}: {tu['input_s'][:80]}", f"same call {len(seen)} times (loop)", failure_type="Looping", loop=True)); loops += 1
    return flags, denials, dict(error_chains=chains, loops=len(loop_keys))


def detect_s2(S, sid):
    flags = []; unknown = 0; results = _results_by_id(S); users = [u for u in S["users"] if u["text"] and not u["results"]]
    seen_targets = ""
    ev = _events(S)
    for ts, kind, obj in ev:
        if kind == "user":
            for r in obj["results"]: seen_targets += (r["content"] or "")[:1500] + "\n"
            continue
        T = obj; txt = behavior.user_facing(T["text"])
        if not txt: continue
        for sent in re.split(r"(?<=[.!?])\s+|\n+", txt):
            if not S2_LEXICON.search(sent) or S2_ALLOW.search(sent): continue
            tgt = S2_TARGET.search(sent)
            if not (S2_STATUS.search(sent) or tgt): continue
            target = (tgt.group(0).strip("`") if tgt else "")
            available = bool(target) and len(target) > 2 and target in seen_targets
            if not available: unknown += 1; continue
            nxt = next((u for u in users if u["ts_ms"] > T["ts_ms"]), None)
            caused = bool(nxt and S2_FOLLOWUP.search(nxt["text"]))
            flags.append(flag("S2_hedging", T, sid, sent, "hedge on a claim whose answer was already in a tool result (G10)", failure_type="Hedging",
                              caused_followup=caused, priced=caused)); break
    return flags, unknown


# ---------------- human-phrase detectors (fire on human-tagged messages) ----------------
P6_HUMAN = re.compile(r"did you actually|made (that|it) up|\bfake\b|\bvibe\w*\b|where did .{0,30}number", re.I)
P7_HUMAN = re.compile(r"is it (100% )?fixed|did you (actually )?(fix|deploy|run|push|test)|can you confirm|is it (actually )?(done|deployed|merged)", re.I)
HUMAN_PHRASES = (("P6_fake_output", P6_HUMAN), ("P7_false_done", P7_HUMAN), ("P1_invented_gates", P1_HUMAN), ("P2_broke_things", P2_HUMAN),
                 ("P3_wrong_model", P3_HUMAN), ("P5_not_asked", P5_HUMAN), ("P10_memory_loss", P10_HUMAN), ("P11_jargon", P11_HUMAN),
                 ("P4_over_engineering", P4_HUMAN))


def human_phrase_patterns(text):
    return [k for k, rx in HUMAN_PHRASES if rx.search(text or "")]


def detect_reverts(S, sid):
    flags = []
    for T in S["turns"].values():
        for tu in T["tool_uses"]:
            if tu["name"] == "Bash" and P2_REVERT.search(str(tu["input"].get("command") or "")):
                flags.append(flag("P2_broke_things", T, sid, tu["input_s"][:120], "git revert in the session (objective)"))
    return flags


def run_session(S, sid, msgs, default_model, pricer):
    """All agent-turn detectors for one session. Returns (flags, denials, stats)."""
    flags = []; stats = {}
    flags += detect_p1(S, sid, msgs)
    f3, not_logged = detect_p3(S, sid, default_model, pricer); flags += f3; stats["model_not_logged"] = not_logged
    flags += detect_p4(S, sid) + detect_p6(S, sid) + detect_p7(S, sid) + detect_p8(S, sid) + detect_p9(S, sid) + detect_p11(S, sid) + detect_reverts(S, sid)
    f1, denials, s1 = detect_s1(S, sid); flags += f1; stats.update(s1)
    f2, unknown = detect_s2(S, sid); flags += f2; stats["hedge_availability_unknown"] = unknown
    return flags, denials, stats
