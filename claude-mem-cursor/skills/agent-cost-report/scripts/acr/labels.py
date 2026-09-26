"""Keyword-drafted labels and the review step (plan Phase 2.3 rules, 2.4 review).

CAT_RULES / FAIL_RULES / classify() / active_minutes() copied from
/workspace/weekly-cost-workflow/weekly_report.py:109-133. The failure set is the closed list in
SKILL.md:80; Rework is a failure type only, never a category. Every drafted label starts as
label_source "keyword"; only review --apply may change it to llm | human.
"""
import collections
import re

CATEGORIES = ("Feature", "Bug fix", "Incident", "Maintenance", "Investigation", "Experiment")   # SKILL.md:76
FAILURE_TYPES = ("Looping", "Hedging", "Wrong turn", "Rework", "Regression", "Premature completion", "Unauthorized action",
                 "Suboptimal path", "Duplicate work", "Blocked work", "Missed requirement", "Unnecessary escalation",
                 "Context re-read", "Model thrash", "Fan-out waste", "Recovery after miss")                 # SKILL.md:80
STATUSES = ("shipped", "completed", "in_progress", "abandoned", "blocked")                                    # SKILL.md:143
LABEL_SOURCES = ("keyword", "llm", "human")

# copied from weekly_report.py:109-114
CAT_RULES = [("Incident", r"emergency|bleed|outage|incident|brake|hotfix|crash-?loop"),
             ("Experiment", r"a/b|\bab\b|gaia-ab|experiment|benchmark|trial run|compare .* vs"),
             ("Investigation", r"make-plan|plan only|planning only|fact-?check|review|monitor|learn the codebase|learn-code|research|investigat|spec\b|product spec|status\b|dig\b|audit"),
             ("Maintenance", r"release|version bump|cleanup|clean up|disk|upgrade|rename|name new code workspaces|migrat|refactor"),
             ("Bug fix", r"\bfix|bug|broken|regression|timeout"),
             ("Feature", r"\bbuild|implement|feature|new skill|wowerpoint|deck|create|execute plans?/")]
DEFAULT_CATEGORY = "Investigation"
# copied from weekly_report.py:115-118 (failure signals come from the human/orchestrator prompts only)
FAIL_RULES = [("Rework", r"\bsteer\b|reset from alex|re-?plan|fix these gaps|verifier found|discard both|too granular|rewrite .* at product altitude|redo"),
              ("Recovery after miss", r"usage[- ]limit|resume the|relaunch|quota|dead token|401\b"),
              ("Wrong turn", r"not a real|misread|flawed|wrong (approach|path)|abandon|too scoped")]
LOOP_PREFIX, LOOP_MIN = 80, 3                                                                    # weekly_report.py:126
assert all(c in CATEGORIES for c, _ in CAT_RULES) and all(f in FAILURE_TYPES for f, _ in FAIL_RULES)


def _first(rules, text):
    for name, rx in rules:
        m = re.search(rx, text)
        if m: return name, m.group(0)
    return None, None


def classify(e, s):
    """copied from weekly_report.py:119-127, returning the matched keywords too (for labels.review.json)."""
    head = " ".join([s.get("project") or "", s.get("user_prompt") or ""] + e["prompts"][:1]).lower()
    tail = " ".join(e["text"][:5]).lower()
    cat, kw = _first(CAT_RULES, head); where = "head"
    if cat is None: cat, kw = _first(CAT_RULES, tail); where = "tail"
    if cat is None: cat, kw, where = DEFAULT_CATEGORY, None, "default"
    ptxt = " ".join([s.get("user_prompt") or ""] + e["prompts"]).lower()
    fails = []; fkw = {}
    for f, rx in FAIL_RULES:
        m = re.search(rx, ptxt)
        if m: fails.append(f); fkw[f] = m.group(0)
    firsts = [x[:LOOP_PREFIX] for x in e["prompts"] if x]
    if len(firsts) >= LOOP_MIN and max(collections.Counter(firsts).values()) >= LOOP_MIN:
        fails.append("Looping"); fkw["Looping"] = f"same {LOOP_PREFIX}-char prompt prefix x{LOOP_MIN}+"
    return dict(category=cat, failure_signals=fails, matched=dict(category_keyword=kw, category_where=where, failure_keywords=fkw),
                head=head[:300], tail=tail[:300])


def active_minutes(stamps, gap_min=15):
    """copied from weekly_report.py:128-133 (stamps: epoch ms)."""
    st = sorted(set(stamps)); tot = 0
    for a, b in zip(st, st[1:]):
        d = (b - a) / 60000
        if d <= gap_min: tot += d
    return tot


def review_entry(item, draft):
    """One labels.review.json entry per line item (plan 2.4)."""
    return dict(work_item_id=item["work_item_id"], session_ids=item["session_ids"], title=item["title"],
                draft_category=draft["category"], draft_failure_signals=draft["failure_signals"], matched=draft["matched"],
                head=draft["head"], tail=draft["tail"], label_source="keyword",
                category=None, failure_type=None, failure_signals=None, reviewed_by=None, note=None)


class ReviewError(ValueError):
    pass


def apply_review(line_items, reviewed, reviewed_at_pt):
    """Merge confirmed labels into line items. An entry counts as reviewed when it names a category
    (and optionally failure_type / failure_signals) and a reviewed_by; label_source becomes
    'human' for reviewed_by 'Alex' (case-insensitive) or an explicit entry label_source, else 'llm'.
    Unreviewed entries are left as keyword drafts. failure_signals / failure_type left null keep the draft's
    signals; pass failure_signals: [] to clear them. Returns the number applied."""
    entries = reviewed.get("items", reviewed) if isinstance(reviewed, dict) else reviewed
    default_by = reviewed.get("reviewed_by") if isinstance(reviewed, dict) else None   # file-level default
    by_id = {li["work_item_id"]: li for li in line_items}; n = 0
    for en in entries:
        en = dict(en); en.setdefault("reviewed_by", default_by)
        li = by_id.get(en.get("work_item_id"))
        if li is None or not en.get("category") or not en.get("reviewed_by"): continue
        if en["category"] not in CATEGORIES: raise ReviewError(f"{en['work_item_id']}: unknown category {en['category']!r}")
        fails = en.get("failure_signals")
        if fails is None and en.get("failure_type"): fails = [en["failure_type"]]
        if fails is None: fails = list(li["failure_signals"])          # neither field set: the draft's signals stand (an explicit [] clears them)
        for f in fails:
            if f not in FAILURE_TYPES: raise ReviewError(f"{en['work_item_id']}: unknown failure type {f!r} (SKILL.md:80 is the set)")
        src = en.get("label_source")
        if src in (None, "keyword"): src = "human" if str(en["reviewed_by"]).strip().lower() == "alex" else "llm"
        if src not in ("llm", "human"): raise ReviewError(f"{en['work_item_id']}: label_source must be llm or human, got {src!r}")
        if en.get("status") is not None:
            if en["status"] not in STATUSES: raise ReviewError(f"{en['work_item_id']}: unknown status {en['status']!r}")
            li["status"] = en["status"]
        li["category"] = li["work_category"] = en["category"]; li["failure_signals"] = list(fails)
        li["failure_type"] = fails[0] if fails else ""; li["label_source"] = src
        li["reviewed_by"] = en["reviewed_by"]; li["reviewed_at_pt"] = reviewed_at_pt
        if en.get("note"): li["notes"] = en["note"]
        if en.get("title"): li["title"] = str(en["title"])[:120].replace("\n", " ")
        n += 1
    return n
