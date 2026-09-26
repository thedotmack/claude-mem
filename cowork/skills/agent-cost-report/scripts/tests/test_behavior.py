"""Phase 2B tests (plan 2B.8): tiny hand-made transcript lines with the field names verified in 2B.7."""
import json
import os
import shutil
import tempfile
import unittest

import _paths  # noqa: F401
import _db
from acr import behavior, classify, costs, evidence, mistakes, patterns, period, prices, rules

PRICES = json.load(open(os.path.join(_paths.FIXTURES, "prices_sample.json")))
W = period.resolve_window("2026-09-18", "2026-09-26")
S_MS, E_MS = W.start_epoch_ms, W.end_epoch_ms
BASE = S_MS + 2 * 86_400_000 + 10 * 3600_000     # Sep 20 10:00 PT


def iso(ms):
    import datetime as dt
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


USAGE = dict(input_tokens=1000, output_tokens=100, cache_creation_input_tokens=0, cache_read_input_tokens=0,
             cache_creation=dict(ephemeral_5m_input_tokens=0, ephemeral_1h_input_tokens=0))


class Tx:
    """Builds one session's jsonl lines."""
    def __init__(self, sid="s1", entrypoint="cli"):
        self.sid, self.entry, self.lines, self.n = sid, entrypoint, [], 0

    def _line(self, typ, ms, message, **kw):
        self.n += 1
        d = dict(type=typ, timestamp=iso(ms), sessionId=self.sid, cwd="/w/p", entrypoint=self.entry, isSidechain=False, uuid=f"u{self.n}", message=message, **kw)
        self.lines.append(json.dumps(d)); return d

    def user(self, ms, text, **kw):
        return self._line("user", ms, dict(role="user", content=text), **kw)

    def assistant(self, ms, text=None, tools=(), model="claude-fable-5-1", usage=USAGE, mid=None):
        content = ([dict(type="text", text=text)] if text else []) + [dict(type="tool_use", id=t[0], name=t[1], input=t[2]) for t in tools]
        return self._line("assistant", ms, dict(id=mid or f"m{self.n + 1}", model=model, usage=usage, content=content), requestId=f"r{self.n + 1}")

    def result(self, ms, tool_use_id, content, is_error=False):
        return self._line("user", ms, dict(role="user", content=[dict(type="tool_result", tool_use_id=tool_use_id, is_error=is_error, content=content)]))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(); self.pat = os.path.join(self.tmp, "projects", "**", "*.jsonl")
        os.makedirs(os.path.join(self.tmp, "projects", "-w-p"))
        self.dbp = os.path.join(self.tmp, "snap.db"); self.db = _db.make_db(self.dbp)
        self.pricer = costs.Pricer(PRICES)

    def tearDown(self):
        self.db.close(); shutil.rmtree(self.tmp)

    def write(self, *txs):
        for t in txs:
            with open(os.path.join(self.tmp, "projects", "-w-p", f"{t.sid}.jsonl"), "w") as fh: fh.write("\n".join(t.lines) + "\n")

    def scan(self):
        sessions, _ = behavior.scan(S_MS, E_MS, pattern=self.pat)
        for S in sessions.values(): behavior.tag_user_turns(S)
        behavior.price_turns(sessions, self.pricer)
        return sessions

    def run_all(self, items=None, projects=None, tagger=True, classify=None):
        scope = evidence.Scope("period", S=S_MS, E=E_MS)
        items = items if items is not None else []
        return mistakes.run(self.db, scope, W.block(), self.pricer, projects or {}, items, glob_pattern=self.pat, tagger=tagger, classify=classify)

    def item(self, cs, usd=10.0):
        return dict(content_session_id=cs, attributed_usd=usd, failure_signals=[], failure_type="", status="completed", trivial=False)


class Tagger(Base):
    def test_every_frustration_arc_marker_tags_bot(self):
        for marker in ("STEER from Alex: stop", "HOUSE LOCK: x", "[SAND_HIDDEN_PROMPT] hi", "<system-reminder>x", "You are a planner", "/do plan.md", "/make-plan x", "<command-message>do</command-message>"):
            self.assertEqual(behavior.tag_prompt_row(marker), "bot", marker)
        self.assertEqual(behavior.tag_prompt_row("why is this broken again"), "human")

    def test_headless_and_relayed_sessions_are_bot(self):
        a = Tx("a", "sdk-cli"); a.user(BASE, "fix the bug"); a.assistant(BASE + 1000, "ok")
        b = Tx("b", "cli"); b.user(BASE, "You are one lane of a plan"); b.user(BASE + 5000, "fuck this"); b.assistant(BASE + 6000, "ok")
        c = Tx("c", "cli"); c.user(BASE, "please fix the build"); c.assistant(BASE + 1000, "ok")
        self.write(a, b, c); s = self.scan()
        self.assertEqual([s["a"]["tag"], s["b"]["tag"], s["c"]["tag"]], ["agent_relayed", "agent_relayed", "alex_direct"])
        self.assertEqual({u["author"] for u in s["b"]["users"]}, {"bot"})
        self.assertEqual(s["c"]["users"][0]["author"], "human")

    def test_one_marker_mid_session_does_not_hide_alex(self):
        a = Tx("a", "cli"); a.user(BASE, "fix the build"); a.user(BASE + 5000, "<command-name>/clear</command-name>"); a.user(BASE + 9000, "why is this fucking broken again"); a.assistant(BASE + 10000, "ok")
        self.write(a); s = self.scan()
        self.assertEqual(s["a"]["tag"], "alex_direct"); self.assertEqual([u["author"] for u in s["a"]["users"]], ["human", "bot", "human"])
        block, spend, _ = self.run_all(items=[self.item("a")])
        self.assertEqual(spend["mistakes_episodes_n"], 1)
        b = Tx("b", "cli"); b.user(BASE, "<system-reminder>x"); b.user(BASE + 5000, "[Cross-session idle notice] y"); b.assistant(BASE + 6000, "ok")
        self.write(b); s = self.scan(); self.assertEqual(s["b"]["tag"], "agent_relayed")      # nothing but relays

    def test_scrub_redacts_key_value_credentials(self):
        t = behavior.scrub("log in with password=hunter2 then Token: abc123 and api_key=\"q9\" ok", 300)
        self.assertNotIn("hunter2", t); self.assertNotIn("abc123", t); self.assertNotIn("q9", t)
        self.assertEqual(t, "log in with password=[redacted] then Token: [redacted] and api_key=[redacted] ok")
        self.assertEqual(behavior.scrub("the token limit was hit", 100), "the token limit was hit")

    def test_tagger_off_renders_unavailable(self):
        a = Tx("a"); a.user(BASE, "this is fucking broken"); a.assistant(BASE + 1000, "ok")
        self.write(a); block, spend, _ = self.run_all(tagger=False)
        self.assertEqual(block["author_tags"], mistakes.UNTAGGED); self.assertEqual(block["episodes"], []); self.assertFalse(block["tagger_ran"])
        self.assertEqual(block["human_message_counts"], mistakes.UNTAGGED)


class Episodes(Base):
    def test_bot_tagged_anger_never_starts_an_episode(self):
        a = Tx("a", "sdk-cli"); a.user(BASE, "what the fuck is this"); a.assistant(BASE + 1000, "ok")
        self.write(a); block, spend, _ = self.run_all()
        self.assertEqual(block["episodes"], []); self.assertEqual(spend["mistakes_episodes_n"], 0)

    def test_gap_45_minutes_groups(self):
        msgs = {"s": [dict(ts_ms=BASE, text="fuck", author="human", source="t"), dict(ts_ms=BASE + 40 * 60_000, text="fuck", author="human", source="t")]}
        self.assertEqual(len(behavior.find_episodes(msgs)), 1)
        msgs["s"][1]["ts_ms"] = BASE + 50 * 60_000
        self.assertEqual(len(behavior.find_episodes(msgs)), 2)

    def test_wasted_window_caps_at_6_hours_and_stays_in_session(self):
        a = Tx("a"); a.user(BASE - 8 * 3600_000, "do the thing")
        for i in range(8): a.assistant(BASE - (7 - i) * 3600_000, "working", tools=[(f"t{i}", "Bash", dict(command="ls"))])
        a.user(BASE, "why did you break it again")
        b = Tx("b"); b.user(BASE - 3600_000, "x"); b.assistant(BASE - 1800_000, "y")
        self.write(a, b); block, spend, _ = self.run_all(items=[self.item("a"), self.item("b")])
        ep = block["episodes"][0]
        self.assertEqual(ep["cost_status"], "measured_tokens")
        s = self.scan(); wasted, redo, _ = behavior.episode_windows(dict(session="a", first_ts=BASE, last_ts=BASE, messages=[{}]), s["a"], {"a": [dict(ts_ms=BASE - 8 * 3600_000, author="human")]})
        self.assertEqual(len(wasted), 6)                                    # 6 turns inside the 6-hour cap, 2 outside
        self.assertTrue(all(T["key"] in s["a"]["turns"] for T in wasted))   # never crosses into session b
        self.assertGreaterEqual(block["union_high_usd"], block["union_low_usd"])

    def test_unmeasured_episode_has_null_dollars(self):
        _db.add_prompt(self.db, "mac1", 1, "what the fuck is a codebase map", BASE, device="dev-uuid"); self.db.commit()
        block, spend, _ = self.run_all(projects={"mac1": "p"})
        ep = block["episodes"][0]
        self.assertEqual((ep["cost_status"], ep["low_usd"], ep["high_usd"]), ("unmeasured", None, None))
        self.assertEqual(spend["mistakes_unmeasured_n"], 1)


    def test_measured_episode_records_observed_model_and_day_example_carries_episode_id(self):
        a = Tx("a"); a.user(BASE - 3600_000, "do the thing"); a.assistant(BASE - 1800_000, "working", tools=[("t1", "Bash", dict(command="ls"))]); a.user(BASE, "why did you break it again")
        self.write(a); block, _, by_day = self.run_all(items=[self.item("a")])
        ep = block["episodes"][0]
        self.assertEqual((ep["model_status"], ep["model"]), ("observed", prices.norm("claude-fable-5-1")))
        ex = next(d for d in by_day if d["day_pt"] == ep["day_pt"])["top_examples"][0]
        self.assertEqual(ex["episode_id"], ep["episode_id"]); self.assertTrue(ex["mistake_id"].startswith("MK-"))


class Detectors(Base):
    def test_model_tile_prices_difference_and_assumed_not_counted(self):
        a = Tx("a"); a.user(BASE, "x"); a.assistant(BASE + 1000, "y", model="gpt-5-codex"); a.assistant(BASE + 2000, "z", model=None)
        self.write(a); block, spend, _ = self.run_all(items=[self.item("a")])
        p3 = next(p for p in block["patterns"] if p["key"] == "P3_wrong_model")
        self.assertEqual(p3["count"], 1); self.assertEqual(p3["model_not_logged"], 1)
        self.assertEqual(p3["delta_usd"], 0.0)                                   # gpt-5-codex is unpriced in the fixture: no delta, never a guess
        pr = costs.Pricer(dict(models={"anthropic/claude-fable-5.1": PRICES["models"]["anthropic/claude-fable-5.1"], "openai/gpt-5-codex": dict(input=20.0, output=100.0, cache_read=2.0, cache_write=25.0, cache_write_1h=40.0)}))
        s = self.scan(); behavior.price_turns(s, pr); f, _ = patterns.detect_p3(s["a"], "a", "anthropic/claude-fable-5.1", pr)
        row = behavior._usage_row(USAGE)
        self.assertEqual(f[0]["delta_x1e6"], costs.api_equiv_x1e6(row, pr.rate("gpt-5-codex")) - costs.api_equiv_x1e6(row, pr.rate("anthropic/claude-fable-5.1")))

    def test_send_without_approval_is_incident_times_recipients_no_dollars(self):
        a = Tx("a"); a.user(BASE, "draft the email"); a.assistant(BASE + 1000, "sending", tools=[("t1", "mcp__claude_ai_Gmail__send_message", dict(to=["a@x.com", "b@x.com"], body="hi"))])
        self.write(a); block, spend, _ = self.run_all(items=[self.item("a")])
        self.assertEqual(block["outbound"], dict(incidents=1, recipients=2, alex_minutes=None))
        p9 = next(p for p in block["patterns"] if p["key"] == "P9_bad_outbound"); self.assertIsNone(p9["low_usd"])
        self.assertEqual(spend["mistakes_estimated_usd"], 0.0)

    def test_fixed_with_passing_pytest_not_flagged_without_is(self):
        a = Tx("a"); a.user(BASE, "fix it"); a.assistant(BASE + 1000, None, tools=[("t1", "Edit", dict(file_path="/w/p/x.py"))]); a.result(BASE + 2000, "t1", "ok")
        a.assistant(BASE + 3000, None, tools=[("t2", "Bash", dict(command="pytest -q"))]); a.result(BASE + 4000, "t2", "3 passed in 0.1s")
        a.assistant(BASE + 5000, "Fixed, all tests pass."); a.user(BASE + 6000, "thanks")
        b = Tx("b"); b.user(BASE, "fix it"); b.assistant(BASE + 1000, None, tools=[("t1", "Edit", dict(file_path="/w/p/x.py"))]); b.result(BASE + 2000, "t1", "ok")
        b.assistant(BASE + 3000, "Fixed, all tests pass."); b.user(BASE + 6000, "thanks")
        self.write(a, b); s = self.scan()
        self.assertEqual(patterns.detect_p7(s["a"], "a"), [])
        self.assertEqual(len(patterns.detect_p7(s["b"], "b")), 1)

    def test_claimed_skill_without_skill_call_is_p6(self):
        a = Tx("a"); a.user(BASE, "prime"); a.assistant(BASE + 1000, "I ran /learn-codebase and built the codebase map."); a.user(BASE + 2000, "ok")
        self.write(a); s = self.scan()
        f = patterns.detect_p6(s["a"], "a"); self.assertEqual(len(f), 1); self.assertTrue(f[0]["trust_flag"])

    def test_s1_error_then_similar_retry_that_succeeds(self):
        a = Tx("a"); a.user(BASE, "run"); a.assistant(BASE + 1000, None, tools=[("t1", "Bash", dict(command="npm test"))]); a.result(BASE + 2000, "t1", "Error: x", is_error=True)
        a.assistant(BASE + 3000, None, tools=[("t2", "Bash", dict(command="npm test "))]); a.result(BASE + 4000, "t2", "passed")
        self.write(a); s = self.scan(); f, denials, st = patterns.detect_s1(s["a"], "a")
        self.assertEqual((len(f), st["error_chains"], len(f[0]["recovery_keys"]), f[0]["wasted_extra"]), (1, 1, 1, []))
        block, spend, _ = self.run_all(items=[self.item("a")])
        self.assertLess(block["union_low_usd"], block["union_high_usd"])   # the retry is redo (high only)

    def test_permission_denial_not_priced(self):
        a = Tx("a"); a.user(BASE, "run"); a.assistant(BASE + 1000, None, tools=[("t1", "Bash", dict(command="curl x"))])
        a.result(BASE + 2000, "t1", "Permission to use Bash with command curl x has been denied.", is_error=True)
        self.write(a); block, spend, _ = self.run_all(items=[self.item("a")])
        self.assertEqual(block["permission_denials"]["count"], 1); self.assertEqual(spend["mistakes_estimated_usd"], 0.0)

    def test_report_labels_are_not_hedges(self):
        a = Tx("a"); a.user(BASE, "x"); a.assistant(BASE + 1000, "Spend is $12.00 ESTIMATED at list prices, low confidence; measured spend unavailable."); a.user(BASE + 2000, "ok")
        self.write(a); s = self.scan(); f, unknown = patterns.detect_s2(s["a"], "a")
        self.assertEqual((f, unknown), ([], 0))

    def test_hedge_with_answer_available_counts(self):
        a = Tx("a"); a.user(BASE, "x"); a.assistant(BASE + 1000, None, tools=[("t1", "Bash", dict(command="cat /w/p/x.py"))]); a.result(BASE + 2000, "t1", "/w/p/x.py: def f(): return 1")
        a.assistant(BASE + 3000, "It should be fixed in /w/p/x.py, I think."); a.user(BASE + 4000, "is it?")
        self.write(a); s = self.scan(); f, _ = patterns.detect_s2(s["a"], "a")
        self.assertEqual(len(f), 1); self.assertTrue(f[0]["caused_followup"])

    def test_union_never_exceeds_agent_cost_and_line_items_share_it(self):
        a = Tx("a"); a.user(BASE, "x")
        for i in range(3): a.assistant(BASE + 1000 * (i + 1), "Done and verified." if i == 2 else None, tools=[(f"t{i}", "Bash", dict(command="ls"))] if i < 2 else ())
        a.user(BASE + 9000, "why did you say done, it's broken again")
        self.write(a); it = self.item("a", usd=99.0); block, spend, by_day = self.run_all(items=[it])
        total = costs.usd(sum(T["x1e6"] for S in self.scan().values() for T in S["turns"].values()))
        self.assertLessEqual(block["union_low_usd"], total); self.assertEqual(it["wasted_cost"], spend["mistakes_estimated_usd"])
        self.assertEqual(round(sum(d["usd"] for d in by_day), 2), spend["mistakes_estimated_usd"]); self.assertEqual(len(by_day), 8)

    def test_secret_leaves_no_trace(self):
        a = Tx("a"); a.user(BASE, "here is sk-or-abcdefghijklmnop1234 use it"); a.assistant(BASE + 1000, "Blocked on Alex: paste the key sk-or-abcdefghijklmnop1234"); a.user(BASE + 2000, "I already gave you the fucking key")
        self.write(a); block, spend, _ = self.run_all(items=[self.item("a")])
        self.assertNotIn("sk-or-abc", json.dumps(block, default=str))
        p1 = next(p for p in block["patterns"] if p["key"] == "P1_invented_gates"); self.assertGreaterEqual(p1["count"], 1)


class Classifier(unittest.TestCase):
    def test_stops_at_cap(self):
        rate = dict(input_usd_per_mtok=1000.0, output_usd_per_mtok=5000.0)   # absurd price so 3 calls cross the cap
        calls = []
        def fake(model, prompt, key): calls.append(prompt); return dict(label="yes", pattern="P1", reason="r"), 1000, 100
        cands = [dict(id=str(i), kind="P1_invented_gates", text="x") for i in range(50)]
        labels, summary = classify.run(cands, rate, cap_usd=2.0, key="k", call=fake)
        self.assertLessEqual(summary["spend_usd"], 2.0 + 1.6); self.assertLess(len(labels), 50); self.assertTrue(summary["sampled_n"] > 0)
        with self.assertRaises(classify.ClassifierError): classify.run(cands, rate, key="", call=fake)

    def test_cap_is_a_hard_limit_not_rounded_to_cents(self):
        rate = dict(input_usd_per_mtok=1.0, output_usd_per_mtok=10.0)      # a call of 1000 in / 100 out costs $0.002; the estimate is $0.0022
        def fake(model, prompt, key): return dict(label="yes", pattern="P1", reason="r"), 1000, 100
        cands = [dict(id=str(i), kind="P1_invented_gates", text="x") for i in range(20)]
        labels, summary = classify.run(cands, rate, cap_usd=0.005, key="k", call=fake)
        self.assertEqual(len(labels), 2); self.assertTrue(summary["stopped_at_cap"]); self.assertLessEqual(summary["spend_usd"], 0.005)


class Rules(unittest.TestCase):
    def _msgs(self, n_before, n_after, landed, author="human"):
        return {"s": [dict(ts_ms=landed - 3 * 86_400_000 + i * 60_000, author=author, text="x") for i in range(n_before)]
                     + [dict(ts_ms=landed + 3 * 86_400_000 + i * 60_000, author=author, text="x") for i in range(n_after)]}

    def _eps(self, n_before, n_after, landed, pat):
        import datetime as dt
        mk = lambda ms: dt.datetime.fromtimestamp(ms / 1000, period.PT).isoformat(timespec="minutes")
        return [dict(pattern=pat, ts_pt=mk(landed - 2 * 86_400_000 + i * 3600_000), episode_id=f"b{i}") for i in range(n_before)] + \
               [dict(pattern=pat, ts_pt=mk(landed + 2 * 86_400_000 + i * 3600_000), episode_id=f"a{i}") for i in range(n_after)]

    def test_not_stopped_and_not_enough_data(self):
        landed = rules._day_ms("2026-09-10"); s = landed - 5 * 86_400_000; e = landed + 8 * 86_400_000
        rows = rules.effectiveness(self._eps(3, 8, landed, "P1_invented_gates"), self._msgs(211, 211, landed), s, e)
        r = next(x for x in rows if x["rule_key"] == "no_invented_gates")
        self.assertEqual((r["verdict"], r["card"], r["before"]["per_100"], r["after"]["per_100"], len(r["episode_ids_after"])), ("not_stopped", True, 1.4, 3.8, 8))
        rows = rules.effectiveness(self._eps(3, 8, landed, "P1_invented_gates"), self._msgs(18, 18, landed), s, e)
        r = next(x for x in rows if x["rule_key"] == "no_invented_gates"); self.assertEqual((r["verdict"], r["card"]), ("not_enough_data", False))

    def test_bot_prompts_not_in_denominator(self):
        landed = rules._day_ms("2026-09-10"); s = landed - 5 * 86_400_000; e = landed + 8 * 86_400_000
        rows = rules.effectiveness(self._eps(3, 8, landed, "P1_invented_gates"), self._msgs(211, 211, landed, author="bot"), s, e)
        r = next(x for x in rows if x["rule_key"] == "no_invented_gates"); self.assertEqual((r["before"]["human_prompts"], r["verdict"]), (0, "not_enough_data"))


if __name__ == "__main__":
    unittest.main()
