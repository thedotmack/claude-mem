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

from . import costs, devices, evidence, labels, measure, mistakes, period, snapshot, wins
from . import prices as prices_mod
from .evidence import LOCAL

FINISHED = ("shipped", "completed")
HEADLINE_LABEL = "estimated at OpenRouter list prices from measured tokens"
# Phase 6 (plan 6.1-6.2; G4 settled: "unavailable", no seat count, never $0, never a guessed price)
GROK_BOT_UNAVAILABLE = dict(status="unavailable", reason="no documented API or export for Cursor Grok Bot seat usage",
                            checked_sources=["https://cursor.com/docs/grok-bot", "https://cursor.com/pricing", "https://docs.x.ai/developers/rest-api-reference/management/billing"],
                            note="Cursor exposes seat usage only on the plan screen; the xAI Management API covers xAI API keys only and the house has no xAI key for Grok Bot")
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
    """Draft money split (SKILL.md:88-109): abandoned work is wasted; 'Recovery after miss' spend is recovery.
    Once the Phase 2B behavior pass has run, its same-session union is the only waste figure (2B.9)."""
    if "behavior_counts" in li: return
    c = li["attributed_usd"]
    li["wasted_cost"] = round(c, 2) if li["status"] == "abandoned" else 0.0
    li["recovery_cost"] = round(c, 2) if ("Recovery after miss" in li["failure_signals"] and not li["wasted_cost"]) else 0.0
    li["productive_cost"] = round(c - li["wasted_cost"] - li["recovery_cost"], 2)


def build(usage, prices, db, scope, window_block, now=None, use_gh=True, gh=wins.gh_pr_view, remote=wins.git_remote, behavior=True, classify=None, rules_dir=None, glob_pattern=None, device_exports=(), precision=None, wins_repos=wins.WINS_REPOS, gh_list=wins.gh_merged_prs):
    now = now or period.now_pt(); pricer = costs.Pricer(prices)
    sess = evidence.load_sessions(db, scope)
    ev, dev_labels, counts, obs_unpriced = evidence.load_evidence(db, scope, sess, pricer.observer_input_rate)
    for m, tok in obs_unpriced.items(): pricer.unpriced[m]["observer"]["tokens"] += tok
    rows = usage["rows"]
    device_merge = devices.merge(rows, list(device_exports), sess, window_block) if device_exports else []   # Phase 5
    if scope.kind == "project":                     # keep only transcripts of sessions in the project (+ nothing else)
        keep = {v["content_session_id"] for v in sess.values()}; rows = [r for r in rows if r["session"] in keep]
    elif scope.kind == "session":                   # a period usage.json holds other sessions' rows too
        rows = [r for r in rows if r["session"] == scope.session]
    for r in rows: r["ts_ms"] = _ts_ms(r["ts"])
    rows_outside = 0
    if scope.S is not None:                         # a shared or wider collect: only rows inside the PT window are priced
        kept = [r for r in rows if scope.S <= r["ts_ms"] < scope.E]; rows_outside = len(rows) - len(kept); rows = kept
    by_session, by_model, _ = costs.price_rows(rows, pricer)
    matched, unmatched = evidence.join_transcripts(rows, sess)
    for r in rows: r["x1e6"] = costs.api_equiv_x1e6(r, pricer.rate(r["model"]))
    # ---- line items (one per session) ----
    items = []; evid = []; review = []; all_stamps = []; n = 0
    for n, (mid, s) in enumerate(sorted(sess.items(), key=lambda kv: kv[1]["started_at_epoch"]), 1):
        e = ev[mid]; cs = s["content_session_id"]; t = by_session.get(cs) or costs._zero(); trs = matched.get(mid, [])
        stamps = e["stamps"] + [r["ts_ms"] for r in trs] + [s["started_at_epoch"]] + ([s["completed_at_epoch"]] if s["completed_at_epoch"] else [])
        all_stamps += stamps; active = labels.active_minutes(stamps); has_tx = bool(t["calls"])
        draft = labels.classify(e, s); status = status_of(e, s); model = costs.dominant_model(t)
        devs = sorted({dev_labels.get(d, d) for d in e["devices"]} | {r.get("device") or LOCAL for r in trs})
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
                         + (("tokens measured from the transcript on this box" if all((r.get("device") or LOCAL) == LOCAL for r in trs) else "tokens measured from a device export: " + ", ".join(sorted({r["device"] for r in trs if r.get("device")}))) if has_tx else "no transcript on this box (remote device)")),
                  observer_tokens=e["obs_tok_dedup"], cost_x1e6=t["usd_x1e6"])
        items.append(li); review.append(labels.review_entry(li, draft))
        evid.append(dict(work_item_id=li["work_item_id"], memory_session_id=mid, content_session_id=cs, observation_ids=e["obs_ids"],
                         summary_ids=e["sum_ids"], titles=[x[:100] for x in e["text"][:20]], ship_titles=li["ship_titles"], ship_ids=e["ship_ids"],
                         observer_tokens=e["obs_tok_dedup"], observer_tokens_raw=e["obs_tok"], observer_est_usd=costs.usd(e["obs_cost_x1e6"]),
                         generated_by_model=sorted(m for m in e["models"] if m), devices=[evidence.device_hash(d) for d in sorted(e["devices"])]))
    # ---- transcripts that matched no claude-mem session become their own line items (outcome unknown -> in_progress) ----
    for cs, rs in sorted(unmatched.items(), key=lambda kv: min(r["ts"] for r in kv[1])):
        n += 1; t = by_session.get(cs) or costs._zero(); model = costs.dominant_model(t); rs = sorted(rs, key=lambda r: r["ts"])
        d0 = rs[0].get("dir") or ""; proj = (os.path.basename(rs[0]["cwd"]) if rs[0].get("cwd") else d0.strip("-").split("-")[-1] or "unknown")
        active = labels.active_minutes([r["ts_ms"] for r in rs]); all_stamps += [r["ts_ms"] for r in rs]
        draft = dict(category="Investigation", failure_signals=[], matched=dict(category_where="default"), head="", tail="")
        li = dict(work_item_id=f"WI-{n}", title=f"Transcript with no claude-mem session ({rs[0]['src']}, {d0 or proj})", scope=scope.kind, project=proj, worktree="",
                  session_ids=[f"nomem-{cs}"], content_session_id=cs, status="in_progress", category="Investigation", work_category="Investigation", failure_type="", failure_signals=[],
                  cost_measured="unavailable", cost_estimated=costs.usd(t["usd_x1e6"]), cost_extrapolated=None, risk_exposure="none", evidence_ids=[], summary_ids=[],
                  agent_tokens={f: t[f] for f in costs.TOKEN_FIELDS}, agent_calls=t["calls"], unpriced_calls=t["unpriced_calls"], model=model,
                  model_prices_usd_per_mtok=costs.price_block(pricer.rate(model)) if model else None, cost_basis="estimated_usage", label_source="keyword",
                  device=sorted({r.get("device") or LOCAL for r in rs}), recommended_action="", confidence="low", date_pt=evidence.day_pt(rs[0]["ts_ms"]), active_minutes=round(active, 1),
                  has_transcript=True, trivial=False, orphan=True, platform=rs[0]["src"], session_status="unknown", observations=0, summaries=0, ship_events=0, ship_titles=[],
                  notes=f"no claude-mem session for this transcript ({len(rs)} API calls); outcome unknown, counted in the totals", observer_tokens=0, cost_x1e6=t["usd_x1e6"])
        items.append(li); review.append(labels.review_entry(li, draft))
        evid.append(dict(work_item_id=li["work_item_id"], memory_session_id=None, content_session_id=cs, observation_ids=[], summary_ids=[], titles=[], ship_titles=[], ship_ids=[],
                         observer_tokens=0, observer_tokens_raw=0, observer_est_usd=0.0, generated_by_model=[], devices=li["device"]))
    extrapolated_usd, basis, ratio = costs.extrapolation(items)
    for li in items:
        if not li["has_transcript"]: li["cost_extrapolated"] = costs.usd(li["extrapolated_x1e6"]) if ratio is not None else None
        li["attributed_usd"] = li["cost_estimated"] if li["has_transcript"] else (li["cost_extrapolated"] or 0.0)
        # attributed_usd stays numeric for the sums; cost_status says when that 0.0 is "unknown", never a measured zero
        li["cost_status"] = "estimated" if li["has_transcript"] else "extrapolated" if ratio is not None else "unmeasured"
        waste_split(li)
    # ---- spend ----
    agent_x1e6 = sum(m["usd_x1e6"] for m in by_model.values())                       # matched + unmatched, all measured rows
    observer_x1e6 = sum(ev[mid]["obs_cost_x1e6"] for mid in sess)
    agent_usd = costs.usd(agent_x1e6)
    spend = dict(agent_estimated_usd=agent_usd, agent_estimated_label="ESTIMATED", agent_measured_usd=None, measured_status="unavailable",
                 extrapolated_unmeasured_usd=extrapolated_usd, extrapolated_label="EXTRAPOLATED (low confidence)", extrapolation_basis=basis,
                 observer_note_taker_est_usd=costs.usd(observer_x1e6), grok_bot_usage=GROK_BOT_UNAVAILABLE,
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
    sessions_by_cs = {li["content_session_id"]: dict(project=li["project"], memory_session_id=li["session_ids"][0],
                      has_transcript=li["has_transcript"], observer_tokens=li["observer_tokens"],
                      cwd=next((r["cwd"] for r in matched.get(li["session_ids"][0], []) if r.get("cwd")), None)) for li in items}
    rows_by_cs = collections.defaultdict(list)
    for r in rows: rows_by_cs[r["session"]].append(r)
    files = sorted({r["file"] for r in rows if r.get("file")})
    wins_block, wins_by_day = wins.build(files, scope.S, scope.E, ship_obs, sessions_by_cs, rows_by_cs, ratio, days, gh=gh, remote=remote, use_gh=use_gh, repos=tuple(wins_repos), gh_list=gh_list)
    if wins_block["cost_status"] == "session_linked":   # spend not tied to any win, only once at least one win cost exists (2.8)
        wins_block["unattributed_usd"] = round(max(spend["total_estimate_usd"] - wins_block["total_attributed_usd"], 0.0), 2)
    # ---- Phase 2B: behavior pass, mistakes line, mistakes timeline (one union set) ----
    behavior_block = None; mistakes_by_day = []
    if behavior:
        session_projects = {li["content_session_id"]: li["project"] for li in items}
        behavior_block, mspend, mistakes_by_day = mistakes.run(db, scope, window_block, pricer, session_projects, items, classify=classify, rules_dir=rules_dir, usage_rows=rows, glob_pattern=glob_pattern, precision=precision)
        spend.update(mspend)
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
    report = dict(window=dict(window_block, usage_rows_outside_window=rows_outside) if scope.S is not None else window_block, scope=scope.block(), generated_at_pt=now.strftime("%Y-%m-%d %H:%M PT"), spend=spend,
                  totals=dict(sessions=sum(1 for li in items if not li.get("orphan")), transcript_only_sessions=sum(1 for li in items if li.get("orphan")),
                              agent_hours=round(sum(li["active_minutes"] for li in items if not li.get("orphan")) / 60, 1), transcript_only_hours=round(sum(li["active_minutes"] for li in items if li.get("orphan")) / 60, 1),
                              wall_clock_hours=round(labels.active_minutes(all_stamps) / 60, 1), tokens=tok,
                              hours_method="sum of gaps <=15 min between consecutive events (prompts, observations, summaries, tool calls, transcript API calls); "
                                           "parallel sessions add up in agent_hours but not in wall_clock_hours"),
                  by_day=list(by_day.values()), by_model=by_model_list, by_device=by_device_list, line_items=items,
                  labels=dict(reviewed=0, total=len(items)), pricing=dict(source=prices.get("source"), fetched=prices.get("fetched"),
                  loaded_from=prices.get("loaded_from"), rule_1h=RULE_1H, models_listed=len(prices["models"])),
                  unmatched_transcripts=unmatched_block, unpriced_models=pricer.unpriced_list(), wins=wins_block, timeline=dict(wins_by_day=wins_by_day, mistakes_by_day=mistakes_by_day),
                  behavior=behavior_block,
                  observer=observer, devices=[dict(device=lbl, id_hash=evidence.device_hash(d)) for d, lbl in dev_labels.items()], device_exports=device_merge,
                  trivial_definition="no observations, no transcript on this box, and <1 active minute")
    aggregate(report)
    raw = (behavior_block or {}).pop("_raw", None)
    if raw is not None: report["_behavior_raw"] = raw           # written to behavior.json by write_outputs, never into report.json
    return report, evid, dict(generated_at_pt=report["generated_at_pt"], scope=scope.block(), items=review)


def aggregate(report):
    """Everything that follows from the line items' labels; re-run after review --apply."""
    items = report["line_items"]; real = [li for li in items if not li["trivial"] and not li.get("orphan")]   # claude-mem sessions; transcript-only sessions are counted apart
    for li in items: waste_split(li)
    finished = [li for li in real if li["status"] in FINISHED]
    byd = {d["day_pt"]: d for d in report["by_day"]}                     # per-day outcomes follow the same statuses (stale after review otherwise)
    for d in byd.values(): d["finished_outcomes"] = 0
    for li in finished:                                                  # the same set as the headline: never a transcript-only item
        if li["date_pt"] in byd: byd[li["date_pt"]]["finished_outcomes"] += 1
    total = sum(li["attributed_usd"] for li in items); wasted = sum(li["wasted_cost"] for li in items); rec = sum(li["recovery_cost"] for li in items)
    t = report["totals"]
    t.update(real_work_sessions=len(real), trivial_sessions=sum(1 for li in items if li["trivial"]),
             projects=len({(li["project"], li["worktree"]) for li in items if not li.get("orphan")}), repos=len({li["project"] for li in items if not li.get("orphan")}),
             transcript_only_projects=len({li["project"] for li in items if li.get("orphan")}),
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
    b = report.get("behavior")
    if b:                                            # 2B.5: at most 2 cards from the behavior pass, in this order
        ob = b["outbound"]
        if ob["incidents"]: att.append(dict(kind="bad_outbound", text=f"{ob['incidents']} send(s) reached {ob['recipients']} recipient(s) without your approval"))
        bad_rule = next((r for r in b["rule_effectiveness"] if r.get("card")), None)
        if bad_rule and len(att) < 2: att.append(dict(kind="rule_not_stopped", rule_key=bad_rule["rule_key"], text=f"Rule '{bad_rule['name']}' ({bad_rule['landed_pt']}) did not stop repeats: {bad_rule['before']['per_100']} -> {bad_rule['after']['per_100']} per 100 human prompts"))
        top = max((p for p in b["patterns"] if p["low_usd"]), key=lambda p: p["low_usd"], default=None)
        if top and len(att) < 2: att.append(dict(kind="pattern", pattern=top["key"], usd=top["low_usd"], text=f"Largest behavior cost: {top['name']} at ${top['low_usd']:.2f} ESTIMATED (heuristic, {top['count']} found)"))
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
    raw = report.pop("_behavior_raw", None)
    if raw is not None:
        with open(os.path.join(outdir, "behavior.json"), "w") as fh: json.dump(dict(window=report["window"], scope=report["scope"], **raw), fh, indent=1, default=str)
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
    exports = []
    for f in getattr(args, "device_usage", None) or []:
        try: exports.append(devices.load(f))
        except (OSError, ValueError) as ex: raise SystemExit(f"acr.py rollup --device-usage: {ex}")
    snap = snapshot.snapshot(args.out, live=getattr(args, "db", None)); db = snapshot.open_snapshot(snap)
    try:
        precision = None
        if getattr(args, "precision", None):
            with open(args.precision) as fh: precision = json.load(fh)
        cl = dict(enabled=True, cap_usd=getattr(args, "classify_budget", None) or mistakes.classify_mod.CAP_USD, model=getattr(args, "classify_model", None)) if getattr(args, "classify", False) else None
        report, evid, review = build(usage, prices, db, scope, window_block, use_gh=not getattr(args, "no_gh", False),
                                     behavior=not getattr(args, "no_behavior", False), classify=cl, rules_dir=getattr(args, "rules_dir", None), device_exports=exports, precision=precision, wins_repos=tuple(getattr(args, "wins_repo", None) or wins.WINS_REPOS))
    finally:
        db.close()
    mp = getattr(args, "measured", None) or os.path.join(args.out, "measured.json")
    measured = None
    if os.path.exists(mp):
        with open(mp) as fh: measured = json.load(fh)
    measure.apply(report, measured)                        # Phase 4: MEASURED only when the UTC bucket covers the PT window
    report["inputs"] = dict(usage=usage_path, prices=prices.get("loaded_from"), snapshot=snap, measured=mp if measured else None)
    write_outputs(args.out, report, evid, review)
    t, s = report["totals"], report["spend"]
    print(f"rollup: {scope.kind} sessions={t['sessions']} real_work={t['real_work_sessions']} projects={t['projects']} devices={t['devices']} "
          f"finished={t['finished_outcomes']} ship_events={t['ship_events']} agent_hours={t['agent_hours']} | agent_est=${s['agent_estimated_usd']} "
          f"extrapolated=${s['extrapolated_unmeasured_usd']} observer=${s['observer_note_taker_est_usd']} measured={s['measured_status']} | "
          f"wins={len(report['wins']['items'])} ({report['wins']['cost_status']}) unpriced={len(report['unpriced_models'])}"
          + (f" | mistakes=${s['mistakes_estimated_usd']} low ({s['mistakes_turns_n']} turns, {s['mistakes_episodes_n']} episodes, {s['mistakes_unmeasured_n']} unmeasured)" if 'mistakes_estimated_usd' in s else "")
          + f" -> {args.out}/report.json")


def run_review(args):
    rp = os.path.join(args.out, "report.json")
    with open(rp) as fh: report = json.load(fh)
    with open(args.apply) as fh: reviewed = json.load(fh)
    n = labels.apply_review(report["line_items"], reviewed, period.now_pt().strftime("%Y-%m-%d %H:%M PT"))
    aggregate(report); write_outputs(args.out, report)
    print(f"review: applied {n} labels; {report['labels']['reviewed']} of {report['labels']['total']} reviewed -> {rp}")
