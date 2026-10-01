"""Rule effectiveness (plan 2B.10, MI:34-35): for each HARD rule, same-pattern episodes per 100 human
prompts in the N=7 days before and after `rule_landed_at`, minimum 50 human prompts per side (G15).
Rules come from `acr/rules.json` (seeded from /workspace/frustration-arc/trend.md, "HARD rules landing
dates vs. the pattern afterwards") plus any house rule file that carries a "HARD (Alex YYYY-MM-DD" or
"HARD — Alex YYYY-MM-DD" header when a --rules-dir is given. Human prompts are counted only from
human-tagged turns (R2); bot and unknown turns are never in the denominator.
"""
import datetime as dt
import glob
import json
import os
import re

from .period import PT

N_DAYS = 7
MIN_PROMPTS = 50
HARD_HEADER = re.compile(r"^#+\s*(?P<name>.+?)\s*\(HARD\s*[—–-]*\s*Alex\s+(?P<date>\d{4}-\d{2}-\d{2})", re.M)
# Frustration Arc pattern names -> this plan's keys
PATTERN_MAP = {"invented_gates_asking": "P1_invented_gates", "broke_things": "P2_broke_things", "wrong_model_or_spend": "P3_wrong_model",
               "over_engineering": "P4_over_engineering", "ignored_instructions": "P5_not_asked", "fake_output": "P6_fake_output",
               "skipped_steps_false_done": "P7_false_done", "wrong_tool_account_contact": "P8_wrong_tool", "bad_outbound": "P9_bad_outbound",
               "memory_loss": "P10_memory_loss", "jargon_verbose_unclear": "P11_jargon", "unattributed": "P12_unclear"}


def seed_rules():
    with open(os.path.join(os.path.dirname(__file__), "rules.json")) as fh: return json.load(fh)["rules"]


def scan_rule_files(rules_dir):
    """Dated HARD headers in house rule files; pattern is left None unless rules.json names the same rule."""
    out = []
    for f in sorted(glob.glob(os.path.join(rules_dir, "**", "*.md"), recursive=True)):
        try:
            with open(f, errors="ignore") as fh: text = fh.read(200_000)
        except OSError: continue
        for m in HARD_HEADER.finditer(text):
            out.append(dict(rule_key=re.sub(r"\W+", "_", m.group("name").lower()).strip("_")[:60], name=m.group("name").strip(), landed_pt=m.group("date"), pattern=None, source=os.path.basename(f)))
    return out


def _day_ms(day):
    return int(dt.datetime.combine(dt.date.fromisoformat(day), dt.time(), tzinfo=PT).timestamp() * 1000)


def _side(episodes, msgs, pattern, a_ms, b_ms):
    eps = [e for e in episodes if e["pattern"] == pattern and a_ms <= _ep_ms(e) < b_ms]
    prompts = sum(1 for ms in msgs.values() for m in ms if m["author"] == "human" and a_ms <= m["ts_ms"] < b_ms)
    return dict(episodes=len(eps), human_prompts=prompts, per_100=round(100 * len(eps) / prompts, 1) if prompts >= MIN_PROMPTS else None), [e["episode_id"] for e in eps]


def _ep_ms(e):
    return int(dt.datetime.fromisoformat(e["ts_pt"]).timestamp() * 1000)


def effectiveness(episodes, msgs, s_ms, e_ms, rules_dir=None, n_days=N_DAYS):
    """Rows for rules that landed inside the window or within N days before it."""
    rows = []; seen = set()
    if s_ms is None or e_ms is None: return rows            # a single-session run has no window to score rules in
    all_rules = seed_rules() + (scan_rule_files(rules_dir) if rules_dir else [])
    for r in all_rules:
        pat = PATTERN_MAP.get(r.get("pattern"), r.get("pattern"))
        landed = _day_ms(r["landed_pt"])
        if not (s_ms - n_days * 86_400_000 <= landed < e_ms): continue
        key = (r["rule_key"], r["landed_pt"])
        if key in seen: continue
        seen.add(key)
        if not pat:
            rows.append(dict(rule_key=r["rule_key"], name=r.get("name"), landed_pt=r["landed_pt"], pattern=None, n_days=n_days, before=None, after=None, verdict="not_enough_data", note="rule not mapped to a pattern", episode_ids_after=[])); continue
        before, _ = _side(episodes, msgs, pat, landed - n_days * 86_400_000, landed)
        after, ids = _side(episodes, msgs, pat, landed, landed + n_days * 86_400_000)
        if before["per_100"] is None or after["per_100"] is None:
            verdict = "not_enough_data"
        elif after["per_100"] >= before["per_100"] and after["episodes"] >= 2: verdict = "not_stopped"
        else: verdict = "stopped"
        rows.append(dict(rule_key=r["rule_key"], name=r.get("name"), landed_pt=r["landed_pt"], pattern=pat, n_days=n_days, before=before, after=after, verdict=verdict,
                         card=(verdict == "not_stopped"), episode_ids_after=ids, source=r.get("source", "rules.json")))
    return rows
