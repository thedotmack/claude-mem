"""Session rollup -> report.json, line-items.csv, evidence.json, labels.review.json (plan Phase 2).

Inputs: <out>/usage.json (collect), <out>/prices.json (prices), a fresh read-only snapshot at
<out>/snapshot.db. Everything derived from the observer's discovery_tokens stays in the separate
observer block / spend.observer_note_taker_est_usd; it never feeds agent_estimated_usd, headline_usd,
by_category or by_day. agent_measured_usd is null with measured_status "unavailable" (never $0).
"""
import collections
import csv
import datetime as dt
import json
import os

from . import costs, evidence, labels, period, snapshot, wins
from . import prices as prices_mod
from .evidence import LOCAL

FINISHED = ("shipped", "completed")
HEADLINE_LABEL = "estimated at OpenRouter list prices from measured tokens"
RULE_1H = "explicit input_cache_write_1h when listed, else 2 x input (weekly_report.py:95)"
CSV_COLUMNS = ("work_item_id", "title", "scope", "project", "worktree", "session_ids", "content_session_id", "status", "category",
               "failure_type", "failure_signals", "cost_measured", "cost_estimated", "cost_extrapolated", "attributed_usd", "wasted_cost",
               "recovery_cost", "productive_cost", "risk_exposure", "evidence_ids", "summary_ids", "agent_tokens", "model",
               "model_prices_usd_per_mtok", "cost_basis", "label_source", "device", "recommended_action", "confidence", "date_pt",
               "active_minutes", "has_transcript", "trivial", "notes")


def _days(s_ms, e_ms):
    d, end = evidence.pt(s_ms).date(), evidence.pt(e_ms).date(); out = []
    while d < end: out.append(d.isoformat()); d += dt.timedelta(days=1)
    return out


def _ts_ms(iso):
    return int(dt.datetime.fromisoformat(iso).timestamp() * 1000)


def status_of(e, s):
    if e["ship_titles"]: return "shipped"
    if e["completed_sums"]: return "completed"
    return "abandoned" if s["status"] in ("completed", "failed") else "in_progress"


def waste_split(li):
    """Draft money split (SKILL.md:88-109): abandoned work is wasted; 'Recovery after miss' spend is recovery."""
    c = li["attributed_usd"]
    li["wasted_cost"] = round(c, 2) if li["status"] == "abandoned" else 0.0
    li["recovery_cost"] = round(c, 2) if ("Recovery after miss" in li["failure_signals"] and not li["wasted_cost"]) else 0.0
    li["productive_cost"] = round(c - li["wasted_cost"] - li["recovery_cost"], 2)


def build(usage, prices, db, scope, window_block, now=None, use_gh=True, gh=wins.gh_pr_view, remote=wins.git_remote):
    now = now or period.now_pt(); pricer = costs.Pricer(prices)
    sess = evidence.load_sessions(db, scope)
    ev, dev_labels, counts, obs_unpriced = evidence.load_evidence(db, scope, sess, pricer.observer_input_rate)
    for m, tok in obs_unpriced.items(): pricer.unpriced[m]["observer"]["tokens"] += tok
    rows = usage["rows"]
    if scope.kind == "project":                     # keep only transcripts of sessions in the project (+ nothing else)
        keep = {v["content_session_id"] for v in sess.values()}; rows = [r for r in rows if r["session"] in keep]
    elif scope.kind == "session":                   # a period usage.json holds other sessions' rows too
        rows = [r for r in rows if r["session"] == scope.session]
    by_session, by_model, _ = costs.price_rows(rows, pricer)
    matched, unmatched = evidence.join_transcripts(rows, sess)
    for r in rows: r["ts_ms"] = _ts_ms(r["ts"]); r["x1e6"] = costs.api_equiv_x1e6(r, pricer.rate(r["model"]))
    # ---- line items (one per session) ----
    items = []; evid = []; review = []; all_stamps = []
    for n, (mid, s) in enumerate(sorted(sess.items(), key=lambda kv: kv[1]["started_at_epoch"]), 1):
        e = ev[mid]; cs = s["content_session_id"]; t = by_session.get(cs) or costs._zero(); trs = matched.get(mid, [])
        stamps = e["stamps"] + [r["ts_ms"] for r in trs] + [s["started_at_epoch"]] + ([s["completed_at_epoch"]] if s["completed_at_epoch"] else [])
        all_stamps += stamps; active = labels.active_minutes(stamps); has_tx = bool(t["calls"])
        draft = labels.classify(e, s); status = status_of(e, s); model = costs.dominant_model(t)
        devs = sorted({dev_labels.get(d, d) for d in e["devices"]} | ({LOCAL} if has_tx else set()))
        title = (s["custom_title"] or (s["user_prompt"] or (e["prompts"][0] if e["prompts"] else "") or (e["text"][0] if e["text"] else "")))[:120].replace("\n", " ")
        proj = s["project"] or ""
        li = dict(work_item_id=f"WI-{n}", title=title, scope=scope.kind, project=proj.split("/")[0], worktree=proj.split("/", 1)[1] if "/" in proj else "",
                  session_ids=[mid], content_session_id=cs, status=status, category=draft["category"], work_category=draft["category"],
                  failure_type=draft["failure_signals"][0] if draft["failure_signals"] else "", failure_signals=draft["failure_signals"],
                  cost_measured="unavailable", cost_estimated=costs.usd(t["usd_x1e6"]) if has_tx else None, cost_extrapolated=None,
                  risk_exposure="none", evidence_ids=e["obs_ids"], summary_ids=e["sum_ids"],
                  agent_tokens={f: t[f] for f in costs.TOKEN_FIELDS}, agent_calls=t["calls"], unpriced_calls=t["unpriced_calls"],
                  model=model, model_prices_usd_per_mtok=costs.price_block(pricer.rate(model)) if model else None,
                  cost_basis="estimated_usage" if has_tx else "extrapolated", label_source="keyword", device=devs,
                  recommended_action="", confidence=("high" if has_tx and status in FINISHED and not t["unpriced_calls"] else "medium" if has_tx else "low"),
                  date_pt=evidence.day_pt(s["started_at_epoch"]), active_minutes=round(active, 1), has_transcript=has_tx,
                  trivial=(e["obs"] == 0 and not has_tx and active < 1), platform=s["platform_source"], session_status=s["status"],
                  observations=e["obs"], summaries=e["sums"], ship_events=len(set(e["ship_titles"])), ship_titles=sorted(set(e["ship_titles"])),
                  notes=(f"{status.replace('_', ' ')}; {e['obs']} observations, {e['sums']} summaries, {len(e['prompts'])} prompts; "
                         + ("tokens measured from the transcript on this box" if has_tx else "no transcript on this box (remote device)")),
                  observer_tokens=e["obs_tok_dedup"], cost_x1e6=t["usd_x1e6"])
        items.append(li); review.append(labels.review_entry(li, draft))
        evid.append(dict(work_item_id=li["work_item_id"], memory_session_id=mid, content_session_id=cs, observation_ids=e["obs_ids"],
                         summary_ids=e["sum_ids"], titles=[x[:100] for x in e["text"][:20]], ship_titles=li["ship_titles"], ship_ids=e["ship_ids"],
                         observer_tokens=e["obs_tok_dedup"], observer_tokens_raw=e["obs_tok"], observer_est_usd=costs.usd(e["obs_cost_x1e6"]),
                         generated_by_model=sorted(m for m in e["models"] if m), devices=[evidence.device_hash(d) for d in sorted(e["devices"])]))
    extrapolated_usd, basis, ratio = costs.extrapolation(items)
    for li in items:
        if not li["has_transcript"]: li["cost_extrapolated"] = costs.usd(li["extrapolated_x1e6"]) if ratio is not None else None
        li["attributed_usd"] = li["cost_estimated"] if li["has_transcript"] else (li["cost_extrapolated"] or 0.0)
        waste_split(li)
    # ---- spend ----
    agent_x1e6 = sum(m["usd_x1e6"] for m in by_model.values())                       # matched + unmatched, all measured rows
    observer_x1e6 = sum(ev[mid]["obs_cost_x1e6"] for mid in sess)
    agent_usd = costs.usd(agent_x1e6)
    spend = dict(agent_estimated_usd=agent_usd, agent_estimated_label="ESTIMATED", agent_measured_usd=None, measured_status="unavailable",
                 extrapolated_unmeasured_usd=extrapolated_usd, extrapolated_label="EXTRAPOLATED (low confidence)", extrapolation_basis=basis,
                 observer_note_taker_est_usd=costs.usd(observer_x1e6), grok_bot_usage=dict(status="unavailable"),
                 headline_usd=agent_usd, headline_label=HEADLINE_LABEL, total_estimate_usd=round(agent_usd + (extrapolated_usd or 0), 2))
    # ---- days ----
    if scope.kind == "session":
        ds = [evidence.day_pt(x) for x in all_stamps] or [li["date_pt"] for li in items]
        days = _days(period.epoch_ms(period.parse_day(min(ds))), period.epoch_ms(period.parse_day(max(ds)) + dt.timedelta(days=1))) if ds else []
    else:
        days = _days(scope.S, scope.E)
    by_day = {d: dict(day_pt=d, sessions_started=0, agent_calls=0, tokens=0, agent_estimated_usd=0, extrapolated_usd=0, ship_events=0,
                      finished_outcomes=0, events=0) for d in days}
    for r in rows:
        d = by_day.get(r["ts"][:10])
        if d is None: continue
        d["agent_calls"] += 1; d["tokens"] += sum(r[f] for f in costs.TOKEN_FIELDS); d["agent_estimated_usd"] += r["x1e6"] or 0
    for li in items:
        d = by_day.get(li["date_pt"])
        if d is None: continue
        d["sessions_started"] += 1; d["ship_events"] += li["ship_events"]; d["extrapolated_usd"] += li.get("extrapolated_x1e6", 0)
        if li["status"] in FINISHED and not li["trivial"]: d["finished_outcomes"] += 1
    for x in all_stamps:
        d = by_day.get(evidence.day_pt(x))
        if d is not None: d["events"] += 1
    for d in by_day.values():
        d["agent_estimated_usd"] = costs.usd(d["agent_estimated_usd"]); d["extrapolated_usd"] = costs.usd(d["extrapolated_usd"])
        d["no_agent_work"] = not (d["sessions_started"] or d["agent_calls"] or d["events"])
    # ---- wins (2.8) ----
    ship_obs = []
    for mid, s in sess.items():
        e = ev[mid]
        for oid, t_ in zip(e["ship_ids"], e["ship_titles"]):
            ship_obs.append(dict(id=oid, title=t_, ts_ms=None, project=s["project"], memory_session_id=mid, content_session_id=s["content_session_id"]))
    if ship_obs:
        ids = [o["id"] for o in ship_obs]; stamp = {}
        for i in range(0, len(ids), 200):
            chunk = ids[i:i + 200]
            for r in db.execute(f"select id, created_at_epoch from observations where id in ({','.join('?' * len(chunk))})", chunk): stamp[r[0]] = r[1]
        for o in ship_obs: o["ts_ms"] = stamp.get(o["id"])
    sessions_by_cs = {li["content_session_id"]: dict(project=sess[li["session_ids"][0]]["project"], memory_session_id=li["session_ids"][0],
                      has_transcript=li["has_transcript"], observer_tokens=li["observer_tokens"],
                      cwd=next((r["cwd"] for r in matched.get(li["session_ids"][0], []) if r.get("cwd")), None)) for li in items}
    rows_by_cs = collections.defaultdict(list)
    for r in rows: rows_by_cs[r["session"]].append(r)
    files = sorted({r["file"] for r in rows if r.get("file")})
    wins_block, wins_by_day = wins.build(files, scope.S, scope.E, ship_obs, sessions_by_cs, rows_by_cs, ratio, days, gh=gh, remote=remote, use_gh=use_gh)
    if wins_block["cost_status"] == "session_linked":   # spend not tied to any win, only once at least one win cost exists (2.8)
        wins_block["unattributed_usd"] = round(max(spend["total_estimate_usd"] - wins_block["total_attributed_usd"], 0.0), 2)
    # ---- the rest ----
    um = [dict(session=cs, dir=rs[0]["dir"], src=rs[0]["src"], calls=len(rs), tokens=sum(sum(r[f] for f in costs.TOKEN_FIELDS) for r in rs),
               usd=costs.usd(sum(r["x1e6"] or 0 for r in rs)), first_ts=min(r["ts"] for r in rs)) for cs, rs in unmatched.items()]
    um.sort(key=lambda x: -x["usd"])
    unmatched_block = dict(count=len(um), usd=round(sum(x["usd"] for x in um), 2), tokens=sum(x["tokens"] for x in um),
                           by_dir=dict(collections.Counter(x["dir"] for x in um)), sessions=um,
                           note="transcripts on this box that matched no sdk_sessions row (work claude-mem never saw); counted in the totals above")
    tok = {f: sum(r[f] for r in rows) for f in costs.TOKEN_FIELDS}; tok["total"] = sum(tok.values()); tok["api_calls"] = len(rows)
    by_model_list = []
    for (src, m), c in sorted(by_model.items(), key=lambda kv: -kv[1]["usd_x1e6"]):
        rt = pricer.rate(m)
        by_model_list.append(dict(source=src, model=m, calls=c["calls"], **{f: c[f] for f in costs.TOKEN_FIELDS}, agent_estimated_usd=costs.usd(c["usd_x1e6"]),
                                  unpriced_calls=c["unpriced_calls"], priced=pricer.usable(m), prices_usd_per_mtok=costs.price_block(rt)))
    by_device = collections.defaultdict(lambda: dict(sessions=0, agent_estimated_usd=0, extrapolated_usd=0))
    for li in items:
        for d in li["device"]:
            b = by_device[d]; b["sessions"] += 1; b["agent_estimated_usd"] += li["cost_x1e6"] if len(li["device"]) == 1 or d == LOCAL else 0
            b["extrapolated_usd"] += li.get("extrapolated_x1e6", 0) if d != LOCAL else 0
    hashes = {lbl: evidence.device_hash(d) for d, lbl in dev_labels.items()}
    by_device_list = [dict(device=d, id_hash=hashes.get(d, d), sessions=b["sessions"], agent_estimated_usd=costs.usd(b["agent_estimated_usd"]),
                           extrapolated_usd=costs.usd(b["extrapolated_usd"])) for d, b in sorted(by_device.items())]
    observer = dict(tokens_dedup=sum(li["observer_tokens"] for li in items), est_usd=spend["observer_note_taker_est_usd"],
                    models=sorted({m for x in evid for m in x["generated_by_model"]}),
                    unpriced_tokens=dict(obs_unpriced), basis="ESTIMATED: observer model's own tokens (deduped per reply) x its input list price; "
                    "kept separate from the agent figures above", rows_in_scope=dict(counts))
    report = dict(window=window_block, scope=scope.block(), generated_at_pt=now.strftime("%Y-%m-%d %H:%M PT"), spend=spend,
                  totals=dict(sessions=len(items), agent_hours=round(sum(li["active_minutes"] for li in items) / 60, 1),
                              wall_clock_hours=round(labels.active_minutes(all_stamps) / 60, 1), tokens=tok,
                              hours_method="sum of gaps <=15 min between consecutive events (prompts, observations, summaries, tool calls, transcript API calls); "
                                           "parallel sessions add up in agent_hours but not in wall_clock_hours"),
                  by_day=list(by_day.values()), by_model=by_model_list, by_device=by_device_list, line_items=items,
                  labels=dict(reviewed=0, total=len(items)), pricing=dict(source=prices.get("source"), fetched=prices.get("fetched"),
                  loaded_from=prices.get("loaded_from"), rule_1h=RULE_1H, models_listed=len(prices["models"])),
                  unmatched_transcripts=unmatched_block, unpriced_models=pricer.unpriced_list(), wins=wins_block, timeline=dict(wins_by_day=wins_by_day),
                  observer=observer, devices=[dict(device=lbl, id_hash=evidence.device_hash(d)) for d, lbl in dev_labels.items()],
                  trivial_definition="no observations, no transcript on this box, and <1 active minute")
    aggregate(report)
    return report, evid, dict(generated_at_pt=report["generated_at_pt"], scope=scope.block(), items=review)


def aggregate(report):
    """Everything that follows from the line items' labels; re-run after review --apply."""
    items = report["line_items"]; real = [li for li in items if not li["trivial"]]
    for li in items: waste_split(li)
    finished = [li for li in real if li["status"] in FINISHED]
    total = sum(li["attributed_usd"] for li in items); wasted = sum(li["wasted_cost"] for li in items); rec = sum(li["recovery_cost"] for li in items)
    t = report["totals"]
    t.update(real_work_sessions=len(real), trivial_sessions=len(items) - len(real),
             projects=len({(li["project"], li["worktree"]) for li in items}), repos=len({li["project"] for li in items}),
             devices=len({d for li in items for d in li["device"]}), finished_outcomes=len(finished),
             ship_events=len({x for li in items for x in li["ship_titles"]}),
             cost_per_completed_outcome=round(sum(li["attributed_usd"] for li in finished) / len(finished), 2) if finished else None,
             waste_rate=round(wasted / total, 4) if total else None, recovery_share=round(rec / total, 4) if total else None,
             wasted_usd=round(wasted, 2), recovery_usd=round(rec, 2))
    cats = collections.defaultdict(lambda: dict(sessions=0, finished=0, agent_x1e6=0, extrapolated_x1e6=0, wasted_usd=0.0, recovery_usd=0.0, active_minutes=0.0))
    for li in real:                                 # micro-dollars in, one conversion to dollars per category
        c = cats[li["category"]]; c["sessions"] += 1; c["finished"] += li["status"] in FINISHED
        c["agent_x1e6"] += li["cost_x1e6"]; c["extrapolated_x1e6"] += li.get("extrapolated_x1e6", 0)
        c["wasted_usd"] += li["wasted_cost"]; c["recovery_usd"] += li["recovery_cost"]; c["active_minutes"] += li["active_minutes"]
    report["by_category"] = [dict(category=k, sessions=c["sessions"], finished=c["finished"], agent_estimated_usd=costs.usd(c["agent_x1e6"]),
                                  extrapolated_usd=costs.usd(c["extrapolated_x1e6"]), wasted_usd=round(c["wasted_usd"], 2),
                                  recovery_usd=round(c["recovery_usd"], 2), active_minutes=round(c["active_minutes"], 1))
                             for k, c in sorted(cats.items(), key=lambda kv: -(kv[1]["agent_x1e6"] + kv[1]["extrapolated_x1e6"]))]
    fe = collections.defaultdict(lambda: dict(sessions=0, attributed_usd=0.0, wasted_usd=0.0, recovery_usd=0.0, work_item_ids=[]))
    for li in real:
        for f in li["failure_signals"]:
            x = fe[f]; x["sessions"] += 1; x["attributed_usd"] += li["attributed_usd"]; x["wasted_usd"] += li["wasted_cost"]
            x["recovery_usd"] += li["recovery_cost"]; x["work_item_ids"].append(li["work_item_id"])
    report["failure_economics"] = [dict(failure_type=k, sessions=v["sessions"], attributed_usd=round(v["attributed_usd"], 2), wasted_usd=round(v["wasted_usd"], 2),
                                        recovery_usd=round(v["recovery_usd"], 2), work_item_ids=v["work_item_ids"]) for k, v in sorted(fe.items(), key=lambda kv: -kv[1]["attributed_usd"])]
    att = []
    w = max((li for li in real if li["wasted_cost"]), key=lambda li: li["wasted_cost"], default=None)
    if w: att.append(dict(kind="waste", work_item_id=w["work_item_id"], usd=w["wasted_cost"], text=f"Biggest waste: {w['work_item_id']} ({w['status']}, {w['category']}) at ${w['wasted_cost']:.2f} ESTIMATED"))
    u = max((li for li in real if li["status"] == "in_progress"), key=lambda li: li["attributed_usd"], default=None)
    if u: att.append(dict(kind="unfinished", work_item_id=u["work_item_id"], usd=u["attributed_usd"], text=f"Biggest unfinished item: {u['work_item_id']} ({u['category']}) at ${u['attributed_usd']:.2f} ESTIMATED, still in progress"))
    unp = sorted({x["model"] for x in report["unpriced_models"] if x["tokens"]})
    if unp: att.append(dict(kind="unpriced", text="Unpriced model(s): " + ", ".join(unp) + " (tokens counted, no dollars)"))
    report["attention"] = att[:3]
    report["labels"] = dict(reviewed=sum(1 for li in items if li["label_source"] != "keyword"), total=len(items))
    report["trivial_sessions"] = [dict(work_item_id=li["work_item_id"], session_ids=li["session_ids"], title=li["title"]) for li in items if li["trivial"]]


def write_outputs(outdir, report, evid=None, review=None):
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, "report.json"), "w") as fh: json.dump(report, fh, indent=1, default=str)
    with open(os.path.join(outdir, "line-items.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=CSV_COLUMNS, extrasaction="ignore"); w.writeheader()
        for li in report["line_items"]:
            w.writerow({k: (";".join(map(str, v)) if isinstance(v, list) else json.dumps(v) if isinstance(v, dict) else v) for k, v in li.items()})
    if evid is not None:
        with open(os.path.join(outdir, "evidence.json"), "w") as fh: json.dump(evid, fh, indent=1)
    if review is not None:
        with open(os.path.join(outdir, "labels.review.json"), "w") as fh: json.dump(review, fh, indent=1)


def resolve_scope(args, usage):
    """--session | --project [--start/--end] | --start/--end. Returns (scope, window_block)."""
    if args.session:   # a session run has no period bounds; a shared period usage.json only contributes that session's rows
        return evidence.Scope("session", session=args.session), (usage["window"] if usage["window"].get("session") else period.session_block(args.session))
    w = period.resolve_window(args.start, args.end)
    kind = "project" if args.project else "period"
    return evidence.Scope(kind, S=w.start_epoch_ms, E=w.end_epoch_ms, project=args.project), w.block()


def input_path(outdir, name):
    """<out>/<name>, else the parent directory's copy, so `--session` / `--project` runs under a period's --out
    can share its collect + prices run (plan 2.6). Returns the <out> path when neither exists (for the error)."""
    p = os.path.join(outdir, name)
    if os.path.exists(p): return p
    q = os.path.join(os.path.dirname(os.path.abspath(outdir)), name)
    return q if os.path.exists(q) else p


def run_rollup(args):
    usage_path = input_path(args.out, "usage.json")
    if not os.path.exists(usage_path): raise SystemExit(f"acr.py rollup: {usage_path} not found; run `acr.py collect` first")
    with open(usage_path) as fh: usage = json.load(fh)
    prices = prices_mod.load(args.prices or input_path(args.out, "prices.json"))
    scope, window_block = resolve_scope(args, usage)
    if scope.kind == "session" and usage["window"].get("session") not in (None, args.session):
        raise SystemExit("acr.py rollup: usage.json was collected for a different --session")
    snap = snapshot.snapshot(args.out, live=getattr(args, "db", None)); db = snapshot.open_snapshot(snap)
    try:
        report, evid, review = build(usage, prices, db, scope, window_block, use_gh=not getattr(args, "no_gh", False))
    finally:
        db.close()
    report["inputs"] = dict(usage=usage_path, prices=prices.get("loaded_from"), snapshot=snap)
    write_outputs(args.out, report, evid, review)
    t, s = report["totals"], report["spend"]
    print(f"rollup: {scope.kind} sessions={t['sessions']} real_work={t['real_work_sessions']} projects={t['projects']} devices={t['devices']} "
          f"finished={t['finished_outcomes']} ship_events={t['ship_events']} agent_hours={t['agent_hours']} | agent_est=${s['agent_estimated_usd']} "
          f"extrapolated=${s['extrapolated_unmeasured_usd']} observer=${s['observer_note_taker_est_usd']} measured={s['measured_status']} | "
          f"wins={len(report['wins']['items'])} ({report['wins']['cost_status']}) unpriced={len(report['unpriced_models'])} -> {args.out}/report.json")


def run_review(args):
    rp = os.path.join(args.out, "report.json")
    with open(rp) as fh: report = json.load(fh)
    with open(args.apply) as fh: reviewed = json.load(fh)
    n = labels.apply_review(report["line_items"], reviewed, period.now_pt().strftime("%Y-%m-%d %H:%M PT"))
    aggregate(report); write_outputs(args.out, report)
    print(f"review: applied {n} labels; {report['labels']['reviewed']} of {report['labels']['total']} reviewed -> {rp}")
