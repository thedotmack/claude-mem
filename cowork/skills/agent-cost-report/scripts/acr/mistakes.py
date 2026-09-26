"""Phase 2B assembly (plan 2B.2, 2B.5, 2B.9): run the behavior pass, price the same-session union
of wasted turns once (the low figure = the headline), keep the upper bound in Details only, and hand
`behavior`, `spend.mistakes_*`, `timeline.mistakes_by_day` and per-line-item fields to the report.

One source of truth: the ribbon's waste sliver, line-item `wasted_cost` and the mistakes line all read
the union set built here. There is no second waste calculation anywhere else.
"""
import collections
import datetime as dt
import hashlib

from . import behavior, costs, patterns, prices, rules
from . import classify as classify_mod
from .period import PT

UPPER_LABEL = "upper bound, likely 5–10× too high (Frustration Arc)"
MISTAKES_BASIS = "same-session wasted turns, each turn once"
TILE_MAX = 4


def classify_pass(flags, sessions, pricer, opts):
    """2B.4: only candidates the heuristics could not settle (P1 asks with no boost). A 'yes' confirms
    the flag with label_source classifier; 'no' drops it. Spend is reported separately, never added."""
    cands = []; by_id = {}
    for i, f in enumerate(flags):
        if f["pattern"] == "P1_invented_gates" and f.get("unconfirmed"):
            S = sessions.get(f["session"]); users = [u for u in (S["users"] if S else []) if u["text"] and not u["results"]]
            before = next((u["text"] for u in reversed(users) if u["ts_ms"] < (f["ts_ms"] or 0)), "")
            after = next((u["text"] for u in users if u["ts_ms"] > (f["ts_ms"] or 0)), "")
            cid = f"c{i}"; by_id[cid] = f; cands.append(dict(id=cid, kind="P1_invented_gates", text=f["excerpt"], before=before, after=after))
    model = opts.get("model") or classify_mod.DEFAULT_MODEL
    try:
        labels, summary = classify_mod.run(cands, pricer.rate(model), model=model, cap_usd=opts.get("cap_usd") or classify_mod.CAP_USD, call=opts.get("call") or classify_mod._call)
    except classify_mod.ClassifierError as ex:
        return dict(ran=False, model=model, spend_usd=None, cap_usd=opts.get("cap_usd") or classify_mod.CAP_USD, sampled_n=0, error=str(ex))
    for cid, lab in labels.items():
        f = by_id[cid]; f["label_source"] = "classifier"; f["classifier"] = lab
        if lab["label"] == "yes": f.pop("unconfirmed", None); f["basis"] += "; classifier: invented gate"
    return summary


def _day_list(s_ms, e_ms):
    d = dt.datetime.fromtimestamp(s_ms / 1000, PT).date(); end = dt.datetime.fromtimestamp(e_ms / 1000, PT).date()
    out = []
    while d < end: out.append(d.isoformat()); d += dt.timedelta(days=1)
    return out


def default_model(sessions, pricer):
    """P3 comparison basis: the most-used priced Claude model in the window, else the plan's fallback."""
    c = collections.Counter()
    for S in sessions.values():
        for T in S["turns"].values():
            if T["model"] and T["usage"]:
                m = prices.norm(T["model"])
                if m.startswith("anthropic/claude") and pricer.usable(m): c[m] += 1
    return c.most_common(1)[0][0] if c else patterns.P3_FALLBACK_DEFAULT


def mistake_id(session, first_key):
    return "MK-" + hashlib.sha1(f"{session}|{first_key}".encode()).hexdigest()[:10]


def add_usage_turns(sessions, usage_rows, src="codex"):
    """Codex rows (usage.json) have a model id and tokens but no readable text on the box; they join as
    text-less turns so P3 (wrong model) and the union see every logged model (R3)."""
    for i, r in enumerate(usage_rows):
        if r.get("src") != src: continue
        S = sessions.setdefault(r["session"], behavior.new_session()); S.setdefault("tag", "unknown")
        key = (f"{src}:{r['session']}", i)
        S["turns"][key] = dict(key=key, ts_ms=int(behavior.transcripts.ts(r["ts"]).timestamp() * 1000), model=r["model"], text="", tool_uses=[],
                               usage={f: r[f] for f in behavior.FIELDS}, sidechain=False, file=r.get("file"), uuid=None)


UNTAGGED = "unavailable (prompts not tagged human vs bot)"


ALTERNATES = ("P4_over_engineering", "P5_not_asked", "P8_wrong_tool", "P10_memory_loss")   # 2B.5 swap order when a tile fails the 70% gate
PRECISION_GATE = 0.70


def precision_gate(pats, precision):
    """Phase 8.5 / 2B.5: a tile pattern whose spot-check precision is under 70% moves to Details as low
    confidence; the next pattern by ranking takes its place only if it passes."""
    if not precision: return
    freed = 0
    for p in pats:
        pr = precision.get(p["key"])
        if pr is None: continue
        p["precision"] = pr
        if p["placement"] == "tile" and pr < PRECISION_GATE: p["placement"] = "details"; p["confidence"] = "low"; p["gate"] = f"spot-check precision {pr:.0%} < 70%: moved to Details"; freed += 1
    for key in ALTERNATES:
        if freed <= 0: break
        p = next((x for x in pats if x["key"] == key), None)
        if p and precision.get(key) is not None and precision[key] >= PRECISION_GATE: p["placement"] = "tile"; p["gate"] = f"promoted: precision {precision[key]:.0%}"; freed -= 1


def run(db, scope, window_block, pricer, session_projects, items, classify=None, rules_dir=None, now_ms=None, usage_rows=(),
        glob_pattern=None, tagger=True, precision=None):
    """session_projects: {content_session_id: project}. items: Phase 2 line items (mutated: behavior_counts,
    wasted_cost, recovery_cost, productive_cost, failure_signals). tagger=False models the R2 gate: no count
    that reads user messages runs, and those counts render UNTAGGED."""
    s_ms, e_ms = scope.S, scope.E
    sessions, scan_stats = behavior.scan(s_ms, e_ms, session=scope.session if scope.kind == "session" else None, **({"pattern": glob_pattern} if glob_pattern else {}))
    if scope.kind == "project":                       # only the project's sessions (transcripts of other projects are out of scope)
        sessions = {sid: S for sid, S in sessions.items() if sid in session_projects}
    for S in sessions.values(): behavior.tag_user_turns(S)
    add_usage_turns(sessions, usage_rows)
    behavior.price_turns(sessions, pricer)
    if tagger:
        prompt_rows = behavior.load_prompt_rows(db, scope)
        if scope.kind == "project": prompt_rows = [r for r in prompt_rows if r["session"] in session_projects]
        msgs, author_tags = behavior.human_messages(sessions, prompt_rows)
    else:                                             # R2 gate: bot/unknown turns never count; nothing reads user messages
        prompt_rows = []; msgs = {}; author_tags = UNTAGGED
        for S in sessions.values():
            for u in S["users"]: u["author"] = "unknown" if u.get("author") != "tool" else "tool"
    tagger_ran = tagger
    dm = default_model(sessions, pricer)

    # ---- detectors ----
    flags = []; denials = []; stats = collections.Counter()
    for sid, S in sessions.items():
        f, d, st = patterns.run_session(S, sid, msgs, dm, pricer); flags += f; denials += d
        for k, v in st.items(): stats[k] += v
    turn_by_key = {T["key"]: T for S in sessions.values() for T in S["turns"].values()}
    classifier_block = classify_pass(flags, sessions, pricer, classify) if classify and classify.get("enabled") else None
    flagged = collections.defaultdict(set)     # pattern -> keys
    for f in flags:
        if f.get("unconfirmed"): continue
        if f["key"] is not None: flagged[f["pattern"]].add(f["key"])
        for k in f.get("extra_keys", []) + f.get("wasted_extra", []): flagged[f["pattern"]].add(k)
    # hedges are text only unless they caused a follow-up (2B.3 S2); P11 reading time is minutes, not dollars
    flagged["S2_hedging"] = {f["key"] for f in flags if f["pattern"] == "S2_hedging" and f.get("priced")}
    flagged["P11_jargon"] = set()
    flagged["P9_bad_outbound"] = set()          # incidents × recipients, never dollars
    redo_keys = collections.defaultdict(set)    # pattern -> redo keys (high only)
    for f in flags:
        for k in f.get("recovery_keys", []): redo_keys["S1_tool_errors"].add(k)

    # ---- episodes (need human-tagged messages) ----
    episodes = []; ep_flag_keys = set(); ep_redo_keys = set(); project_fallback = set()
    for ep in behavior.find_episodes(msgs, phrase_hit=patterns.human_phrase_patterns):
        S = sessions.get(ep["session"])
        wasted, redo, last_agent = behavior.episode_windows(ep, S, msgs)
        wkeys = {T["key"] for T in wasted}
        pat = next((p for p in patterns.TILE_ORDER + tuple(k for k, *_ in patterns.PATTERNS) if flagged.get(p) and flagged[p] & wkeys), None)
        if pat is None:                                   # human phrases over every message of the episode; ties break in P1..P12 order
            hp = collections.Counter(p for m in ep["messages"] for p in patterns.human_phrase_patterns(m["text"]))
            order = [k for k, *_ in patterns.PATTERNS]
            pat = min(hp, key=lambda k: (-hp[k], order.index(k))) if hp else "P12_unclear"
        measured = S is not None and bool(S["turns"])
        if measured:
            ep_flag_keys |= wkeys; ep_redo_keys |= {T["key"] for T in redo}
            flagged[pat] |= wkeys
        else:
            proj = session_projects.get(ep["session"])
            if proj:
                for sid2, S2 in sessions.items():
                    if session_projects.get(sid2) == proj:
                        for T in S2["turns"].values():
                            if ep["first_ts"] - behavior.WASTED_CAP_MS <= T["ts_ms"] < ep["first_ts"]: project_fallback.add(T["key"])
        model = None
        if S:
            mc = collections.Counter(prices.norm(T["model"]) for T in S["turns"].values() if T["model"])
            model = mc.most_common(1)[0][0] if mc else None
        low = behavior.turn_cost(wasted) if measured else None
        high = (low + behavior.turn_cost(redo)) if measured else None
        episodes.append(dict(episode_id=ep["episode_id"], session=ep["session"], ts_pt=behavior.pt_iso(ep["first_ts"]), day_pt=behavior.day_pt(ep["first_ts"]),
                             pattern=pat, messages_n=len(ep["messages"]), low_usd=costs.usd(low) if measured else None, high_usd=costs.usd(high) if measured else None,
                             cost_status="measured_tokens" if measured else "unmeasured", alex_minutes=behavior.alex_minutes(ep, last_agent),
                             model=model, model_status="observed" if model else "assumed", source=ep["messages"][0]["source"],
                             device=ep["messages"][0].get("device", "local"), excerpt=behavior.scrub(ep["messages"][0]["text"]), wasted_keys=[list(k) for k in wkeys]))

    # ---- failure-signal spans (2B.9) ----
    span_keys = collections.defaultdict(set)
    for sid, S in sessions.items():
        for ft, keys in behavior.failure_spans(S, msgs).items(): span_keys[ft] |= keys
    for f in flags:
        if f["pattern"] == "S1_tool_errors" and f.get("loop"): span_keys["Looping"].add(f["key"])

    # ---- the union (low) and the upper bound (high) ----
    union = set().union(*flagged.values()) | ep_flag_keys | set().union(*span_keys.values()) if (flagged or span_keys) else set(ep_flag_keys)
    union = {k for k in union if k in turn_by_key}
    redo_all = (ep_redo_keys | set().union(*redo_keys.values()) if redo_keys else ep_redo_keys) - union
    high_set = union | redo_all | (project_fallback - union)
    low_x1e6 = sum(turn_by_key[k]["x1e6"] or 0 for k in union)
    high_x1e6 = sum(turn_by_key[k]["x1e6"] or 0 for k in high_set)
    unmeasured_n = sum(1 for e in episodes if e["cost_status"] == "unmeasured")

    # ---- per pattern ----
    by_ep = collections.Counter(e["pattern"] for e in episodes)
    ex_by_pat = collections.defaultdict(list)
    for f in flags:
        if not f.get("unconfirmed") and len(ex_by_pat[f["pattern"]]) < 10:
            ex_by_pat[f["pattern"]].append(dict(content_session_id=f["session"], ts_pt=behavior.pt_iso(f["ts_ms"]) if f["ts_ms"] else None, excerpt=f["excerpt"], basis=f["basis"], label_source=f["label_source"]))
    pats = []
    for key, name, mi, ft, place in patterns.PATTERNS:
        keys = flagged.get(key, set()); fl = [f for f in flags if f["pattern"] == key and not f.get("unconfirmed")]
        count = len(fl) + by_ep.get(key, 0) if key not in ("P12_unclear",) else by_ep.get(key, 0)
        low = None if key == "P9_bad_outbound" else costs.usd(sum(turn_by_key[k]["x1e6"] or 0 for k in keys if k in turn_by_key))
        hk = keys | {k for k in redo_all if key == "S1_tool_errors"} | set().union(*[set(map(tuple, e["wasted_keys"])) for e in episodes if e["pattern"] == key] or [set()])
        high = None if key == "P9_bad_outbound" else costs.usd(sum(turn_by_key[k]["x1e6"] or 0 for k in hk if k in turn_by_key))
        p = dict(key=key, name=name, source_ref=f"metrics-ideas.md:{mi}" if mi else "plan 2B.3 supporting metric", failure_type=ft, placement=place if key in patterns.TILE_ORDER else "details",
                 count=count, count_basis="heuristic", low_usd=low, high_usd=high, high_label=UPPER_LABEL, unmeasured_n=sum(1 for e in episodes if e["pattern"] == key and e["cost_status"] == "unmeasured"),
                 alex_minutes=round(sum(e["alex_minutes"] for e in episodes if e["pattern"] == key) + sum(f.get("alex_minutes", 0) for f in fl), 1),
                 agent_minutes=None, waiting_minutes=round(sum(f.get("waiting_minutes") or 0 for f in fl), 1) if key == "P1_invented_gates" else None,
                 confidence="high" if key in ("P3_wrong_model", "S1_tool_errors", "P9_bad_outbound") else "medium", overlaps=True, examples=ex_by_pat.get(key, []),
                 detection="H" if key != "P12_unclear" else "base detector; M attributes when it can")
        if key == "P3_wrong_model":
            p["delta_usd"] = costs.usd(sum(max(f.get("delta_x1e6") or 0, 0) for f in fl)); p["default_model"] = dm; p["model_not_logged"] = stats["model_not_logged"]
        if key == "P1_invented_gates":
            p["unconfirmed_n"] = sum(1 for f in flags if f["pattern"] == key and f.get("unconfirmed")); p["never_answered_n"] = sum(1 for f in fl if f.get("never_answered"))
        if key == "P9_bad_outbound":
            p["incidents"] = len(fl); p["recipients"] = sum(f.get("recipients") or 0 for f in fl); p["cost_note"] = "incidents × recipients, never dollars"
        if key == "S1_tool_errors": p["error_chains"] = stats["error_chains"]; p["loops"] = stats["loops"]; p["recovered_usd"] = costs.usd(sum(turn_by_key[k]["x1e6"] or 0 for k in redo_keys["S1_tool_errors"] if k in turn_by_key))
        if key == "S2_hedging": p["availability_unknown_n"] = stats["hedge_availability_unknown"]; p["cost_note"] = "text only, not priced" if not keys else "follow-up round trip priced as recovery"
        if key == "P11_jargon": p["cost_note"] = "Alex-minutes = words ÷ 200; dollars only for a clarification round trip"
        pats.append(p)
    precision_gate(pats, precision)
    tiles = [p for p in pats if p["placement"] == "tile"]
    assert len(tiles) <= 5 and len({("tile2" if p["key"] in patterns.MERGED_TILE else p["key"]) for p in tiles}) <= TILE_MAX

    # ---- per session / line item (one union set) ----
    per_session = collections.defaultdict(lambda: dict(low=0, redo=0, counts=collections.Counter(), failures=set()))
    for k in union:
        T = turn_by_key[k]; sid = next(s for s, S in sessions.items() if k in S["turns"]); per_session[sid]["low"] += T["x1e6"] or 0
    for k in redo_all:
        T = turn_by_key[k]; sid = next(s for s, S in sessions.items() if k in S["turns"]); per_session[sid]["redo"] += T["x1e6"] or 0
    for f in flags:
        if f.get("unconfirmed"): continue
        per_session[f["session"]]["counts"][f["pattern"]] += 1
        ft = f.get("failure_type") or dict((k, t) for k, _, _, t, _ in patterns.PATTERNS).get(f["pattern"])
        if ft: per_session[f["session"]]["failures"].add(ft)
    for e in episodes: per_session[e["session"]]["counts"][e["pattern"]] += 1
    def _reconciled(field, total_x1e6):
        """Round per item, then give the cent remainder to the largest item so the items sum to the total exactly (8.6)."""
        vals = {li["content_session_id"]: (per_session[li["content_session_id"]][field] if li["content_session_id"] in per_session else 0) for li in items}
        rounded = {k: costs.usd(v) for k, v in vals.items()}; diff = round(costs.usd(total_x1e6) - sum(rounded.values()), 2)
        if diff and vals:
            k = max(vals, key=vals.get); rounded[k] = round(rounded[k] + diff, 2)
        return rounded
    in_items = {li["content_session_id"] for li in items}
    low_in_items = sum(v["low"] for k, v in per_session.items() if k in in_items); redo_in_items = sum(v["redo"] for k, v in per_session.items() if k in in_items)
    wasted_by = _reconciled("low", low_in_items); redo_by = _reconciled("redo", redo_in_items)
    for li in items:
        ps = per_session.get(li["content_session_id"])
        li["behavior_counts"] = dict(ps["counts"]) if ps else {}
        li["wasted_cost"] = wasted_by.get(li["content_session_id"], 0.0)
        li["recovery_cost"] = redo_by.get(li["content_session_id"], 0.0)
        li["productive_cost"] = round(max(li["attributed_usd"] - li["wasted_cost"], 0.0), 2)
        if ps and ps["failures"]:
            li["failure_signals"] = sorted(set(li["failure_signals"]) | ps["failures"]); li["failure_type"] = li["failure_type"] or li["failure_signals"][0]

    # ---- timeline: mistakes by day (2B.9) ----
    days = _day_list(s_ms, e_ms) if scope.kind != "session" else sorted({behavior.day_pt(T["ts_ms"]) for T in turn_by_key.values()} | {e["day_pt"] for e in episodes})
    by_day = {d: dict(day_pt=d, usd=0, high_usd=0, unmeasured_n=0, alex_minutes=0.0, turns_n=0, by_pattern=collections.Counter(), outbound_incidents=0, top_examples=[]) for d in days}
    key_pats = collections.defaultdict(set)
    for p, ks in flagged.items():
        for k in ks: key_pats[k].add(p)
    for k in union:
        T = turn_by_key[k]; d = by_day.get(behavior.day_pt(T["ts_ms"]))
        if d is None: continue
        d["usd"] += T["x1e6"] or 0; d["turns_n"] += 1
        for p in key_pats.get(k, ()): d["by_pattern"][p] += T["x1e6"] or 0
    for k in high_set:
        T = turn_by_key[k]; d = by_day.get(behavior.day_pt(T["ts_ms"]))
        if d is not None: d["high_usd"] += T["x1e6"] or 0
    for e in episodes:
        d = by_day.get(e["day_pt"])
        if d is None: continue
        d["alex_minutes"] += e["alex_minutes"]
        if e["cost_status"] == "unmeasured": d["unmeasured_n"] += 1
        if len(d["top_examples"]) < 3: d["top_examples"].append(dict(mistake_id=mistake_id(e["session"], e["episode_id"]), episode_id=e["episode_id"], pattern=e["pattern"], content_session_id=e["session"], ts_pt=e["ts_pt"]))
    for f in flags:
        if f["pattern"] == "P9_bad_outbound" and f["ts_ms"] and behavior.day_pt(f["ts_ms"]) in by_day: by_day[behavior.day_pt(f["ts_ms"])]["outbound_incidents"] += 1
    for d in by_day.values():
        d["usd"] = costs.usd(d["usd"]); d["high_usd"] = costs.usd(d["high_usd"]); d["alex_minutes"] = round(d["alex_minutes"], 1)
        d["by_pattern"] = {p: costs.usd(v) for p, v in d["by_pattern"].items()}
    # stable mistake ids for flagged-turn clusters (consecutive flagged turns in one session)
    clusters = []
    for sid, S in sessions.items():
        run = []
        for T in behavior.ordered_turns(S):
            if T["key"] in union: run.append(T)
            elif run: clusters.append((sid, run)); run = []
        if run: clusters.append((sid, run))
    mistake_ids = [dict(mistake_id=mistake_id(sid, r[0]["key"]), content_session_id=sid, ts_pt=behavior.pt_iso(r[0]["ts_ms"]), turns_n=len(r),
                        usd=costs.usd(sum(T["x1e6"] or 0 for T in r)), patterns=sorted(set().union(*[key_pats.get(T["key"], set()) for T in r]))) for sid, r in clusters]

    # ---- rule effectiveness (2B.10) ----
    rule_rows = rules.effectiveness(episodes, msgs, s_ms, e_ms, rules_dir=rules_dir)

    outbound = dict(incidents=sum(1 for f in flags if f["pattern"] == "P9_bad_outbound"), recipients=sum(f.get("recipients") or 0 for f in flags if f["pattern"] == "P9_bad_outbound"), alex_minutes=None)
    alex_known = [e["alex_minutes"] for e in episodes if e["alex_minutes"] is not None]
    unmatched_x1e6 = sum(turn_by_key[k]["x1e6"] or 0 for k in union if next(s for s, S in sessions.items() if k in S["turns"]) not in session_projects)
    spend = dict(mistakes_estimated_usd=costs.usd(low_x1e6), mistakes_label="ESTIMATED", mistakes_basis=MISTAKES_BASIS, mistakes_turns_n=len(union),
                 mistakes_unmatched_usd=costs.usd(unmatched_x1e6),   # waste inside transcripts that matched no claude-mem session (no line item)
                 mistakes_episodes_n=len(episodes), mistakes_unmeasured_n=unmeasured_n, mistakes_alex_minutes=round(sum(alex_known), 1), mistakes_alex_minutes_known_n=len(alex_known),
                 mistakes_high_usd=costs.usd(high_x1e6), mistakes_high_label=UPPER_LABEL)
    block = dict(patterns=pats, outbound=outbound, episodes=[{k: v for k, v in e.items() if k != "wasted_keys"} for e in episodes],
                 union_low_usd=costs.usd(low_x1e6), union_high_usd=costs.usd(high_x1e6), union_turns_n=len(union), high_turns_n=len(high_set),
                 author_tags=author_tags, tagger_ran=tagger_ran, session_tags=collections.Counter(S.get("tag", "unknown") for S in sessions.values()),
                 human_message_counts=("computed from human-tagged turns" if tagger else UNTAGGED),
                 episodes_status=("measured" if tagger else UNTAGGED),
                 rule_effectiveness=rule_rows, coverage=dict(box="measured", mac="unavailable (no Phase 5 export)", grok_bot="unavailable"),
                 classifier=classifier_block or dict(ran=False, model=None, spend_usd=None, cap_usd=classify_mod.CAP_USD, sampled_n=0, note="off by default (G8); enable with --classify"),
                 permission_denials=dict(count=len(denials), examples=denials[:10], note="blocked by a rule; not priced as agent waste"),
                 label_sources=collections.Counter(f["label_source"] for f in flags if not f.get("unconfirmed")),
                 unconfirmed=dict(P1_candidates=[dict(content_session_id=f["session"], ts_pt=behavior.pt_iso(f["ts_ms"]), excerpt=f["excerpt"]) for f in flags if f.get("unconfirmed")][:50]),
                 default_model=dm, scan=scan_stats, mistake_clusters=mistake_ids, prompt_rows_n=len(prompt_rows),
                 not_in_mistakes_line="session-level keyword failure signals with no turn span stay in Details (2B.9)")
    # raw material for behavior.json (Phase 8.5 spot-check); scrubbed excerpts only, no turn keys
    raw = dict(flags=[dict(pattern=f["pattern"], session=f["session"], ts_pt=behavior.pt_iso(f["ts_ms"]) if f.get("ts_ms") else None, excerpt=f["excerpt"], basis=f["basis"],
                           label_source=f["label_source"], unconfirmed=bool(f.get("unconfirmed"))) for f in flags],
               user_turns=[dict(session=sid, ts_pt=behavior.pt_iso(m["ts_ms"]), author=m["author"], source=m["source"], excerpt=behavior.scrub(m["text"])) for sid, ms in msgs.items() for m in ms],
               episodes=block["episodes"],
               sessions=[dict(session=sid, tag=S.get("tag", "unknown"), turns=len(S["turns"]), tool_errors=sum(1 for u in S["users"] for r in u["results"] if r["is_error"]),
                              last_text=behavior.scrub(next((behavior.user_facing(T["text"]) for T in reversed(behavior.ordered_turns(S)) if T["text"].strip()), ""))) for sid, S in sessions.items()])
    block["_raw"] = raw
    return block, spend, list(by_day.values())
