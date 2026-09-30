import datetime as dt
import json
import os
import shutil
import tempfile
import unittest

import _paths
from acr import wins
from acr.period import PT

S = int(dt.datetime(2026, 9, 18, tzinfo=PT).timestamp() * 1000)
E = int(dt.datetime(2026, 9, 21, tzinfo=PT).timestamp() * 1000)
H = 3600 * 1000
DAYS = ["2026-09-18", "2026-09-19", "2026-09-20"]


def iso(ms):
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).isoformat().replace("+00:00", "Z")


def usage_row(cs, ms, x1e6, out=100):
    return dict(session=cs, ts_ms=ms, x1e6=x1e6, input=1000, output=out, cache_write_5m=0, cache_write_1h=0, cache_read=0)


def tool_lines(session, ms, cmd, result="", is_error=False, tid="toolu_1"):
    a = dict(type="assistant", timestamp=iso(ms), sessionId=session, cwd="/w/p", message=dict(role="assistant", content=[dict(type="tool_use", id=tid, name="Bash", input=dict(command=cmd))]))
    u = dict(type="user", timestamp=iso(ms + 1000), sessionId=session, message=dict(role="user", content=[dict(type="tool_result", tool_use_id=tid, content=result, is_error=is_error)]),
             toolUseResult=dict(stdout=result, stderr=""))
    return [json.dumps(a), json.dumps(u)]


def fake_gh(table):
    calls = []
    def gh(number, repo):
        calls.append((number, repo)); return table.get(f"{repo}#{number}")
    gh.calls = calls; return gh


class Commands(unittest.TestCase):
    def test_classify(self):
        c = wins.classify_command("gh pr merge 12 --repo o/r --squash")
        self.assertEqual((c["kind"], c["number"], c["repo"]), ("pr", 12, "o/r"))
        c = wins.classify_command("cd /x && gh pr merge https://github.com/o/r/pull/7 --merge")
        self.assertEqual((c["number"], c["repo"]), (7, "o/r"))
        self.assertEqual(wins.classify_command("gh pr merge --auto")["number"], None)
        self.assertEqual(wins.classify_command("npm publish --access public")["how"], "npm publish")
        self.assertEqual(wins.classify_command("gh release create v1.2.3 --notes x")["tag"], "v1.2.3")
        self.assertEqual(wins.classify_command("git push origin v1.2.3")["tag"], "v1.2.3")
        self.assertEqual(wins.classify_command("git push --tags")["tag"], None)
        self.assertIsNone(wins.classify_command("git push origin main"))
        self.assertIsNone(wins.classify_command("grep -l 'gh pr merge' *.jsonl | head"))                 # quoted prose
        self.assertIsNone(wins.classify_command("cat > f.py <<'PY'\nnpm publish\ngh pr merge 1\nPY"))    # heredoc body
        self.assertIsNone(wins.classify_command("echo done"))

    def test_trailers(self):
        msg = "feat: x\n\nbody\n\nClaude-Session: 0e3f6cc9-3feb-4e4a-b20e-cc3704ef868d\nCo-Authored-By: x"
        self.assertEqual(wins.session_trailers(msg), ["0e3f6cc9-3feb-4e4a-b20e-cc3704ef868d"])
        self.assertEqual(wins.session_trailers("Session: 0e3f6cc9-3feb-4e4a-b20e-cc3704ef868d"), [])                      # G13: Session: ignored
        self.assertEqual(wins.session_trailers("Claude-Session: https://x/0e3f6cc9"), [])                                  # non-bare rejected
        self.assertEqual(wins.session_trailers("Claude-Session: abc def"), []); self.assertEqual(wins.session_trailers("Claude-Session: (abc)"), [])
        self.assertEqual(wins.session_trailers("Claude-Session: a\nClaude-Session: a\nClaude-Session: b"), ["a", "b"])

    def test_no_fallback_estimate_anywhere(self):
        for f in ("wins.py", "rollup.py", "costs.py"):
            with open(os.path.join(_paths.SCRIPTS, "acr", f)) as fh: src = fh.read()
            self.assertNotIn("fallback_estimate", src, f); self.assertNotIn("lineage", src.lower().replace("no lineage fallback", ""), f)

    def test_praise_stub(self):
        self.assertEqual(wins.detect_praise(), []); self.assertEqual(wins.detect_praise(prompts=["boom love it"]), [])


class Transcripts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="acr-wins-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, name, lines):
        p = os.path.join(self.tmp, name)
        with open(p, "w") as fh: fh.write("\n".join(lines) + "\n")
        return p

    def test_scan_success_error_and_window(self):
        f = self.write("a.jsonl", tool_lines("cs1", S + 2 * H, "gh pr merge 5 --repo o/r", "", tid="t1")
                       + tool_lines("cs1", S + 3 * H, "gh pr merge 6 --repo o/r", "GraphQL: Pull request not mergeable", is_error=False, tid="t2")
                       + tool_lines("cs1", S + 4 * H, "gh pr merge 7 --repo o/r", "", is_error=True, tid="t3")
                       + tool_lines("cs1", E + H, "gh pr merge 8 --repo o/r", "", tid="t4")
                       + tool_lines("cs1", S + 5 * H, "npm publish", "npm notice Publishing to https://registry.npmjs.org/\n+ claude-mem@13.25.3", tid="t5")
                       + ['{"type":"assistant","message":{"usage":{}}}', "not json"])
        got = list(wins.scan_transcripts([f], S, E))
        self.assertEqual([(c["kind"], c.get("number")) for c in got], [("pr", 5), ("publish", None)])
        self.assertIn("claude-mem@13.25.3", got[1]["result"])


class Build(Transcripts):
    def sessions(self):
        return {"cs1": dict(project="claude-mem", memory_session_id="m1", has_transcript=True, observer_tokens=100, cwd="/w/p"),
                "cs2": dict(project="claude-mem", memory_session_id="m2", has_transcript=False, observer_tokens=1000, cwd=None)}

    def ship(self, n=4125, ms=S + 6 * H):
        return [dict(id=9, title=f"PR #{n} merged to main: x", ts_ms=ms, project="claude-mem", memory_session_id="m1", content_session_id="cs1")]

    def build(self, files=(), ship_obs=(), rows=None, gh=None, ratio=None, remote=lambda cwd: "o/r", gh_list=None, repos=("o/r",)):
        return wins.build(list(files), S, E, list(ship_obs), self.sessions(), rows or {}, ratio, DAYS, gh=gh or fake_gh({}), remote=remote,
                          use_gh=(gh is not None or gh_list is not None), repos=repos, gh_list=gh_list)

    def test_no_link_means_every_usd_null(self):
        f = self.write("a.jsonl", tool_lines("cs1", S + 2 * H, "gh pr merge 5 --repo o/r"))
        block, by_day = self.build([f], self.ship(), rows={"cs1": [usage_row("cs1", S + H, 1_000_000)]})
        self.assertEqual(len(block["items"]), 2); self.assertEqual(block["cost_status"], "unmeasured")
        self.assertTrue(all(i["usd"] is None and i["cost_status"] == "unmeasured" for i in block["items"]))
        self.assertIsNone(block["attribution_method"]); self.assertIsNone(block["total_attributed_usd"]); self.assertIsNone(block["unattributed_usd"])
        self.assertEqual(block["praise_n"], 0); self.assertEqual([d["day_pt"] for d in by_day], DAYS)
        self.assertEqual([d["count"] for d in by_day], [2, 0, 0]); self.assertTrue(all(d["usd"] is None for d in by_day))
        by_key = {i["key"]: i for i in block["items"]}
        self.assertEqual(by_key["o/r#4125"]["title"], "PR #4125 merged to main: x")                # observation title, never hand-written
        self.assertEqual(by_key["o/r#5"]["title"], "o/r#5")                                        # no title source yet: the key itself

    def test_pr_in_transcript_and_observation_counts_once(self):
        f = self.write("a.jsonl", tool_lines("cs1", S + 2 * H, "gh pr merge 4125 --repo o/r"))
        block, _ = self.build([f], self.ship(4125))
        self.assertEqual(len(block["items"]), 1); self.assertEqual(block["items"][0]["key"], "o/r#4125")
        self.assertEqual(set(block["items"][0]["sources"]), {"transcript", "ship_observation"}); self.assertEqual(block["items"][0]["evidence_ids"], [9])

    def test_observation_repo_from_remote_of_project_cwd(self):
        block, _ = self.build([], self.ship(1), remote=lambda cwd: "thedotmack/claude-mem" if cwd == "/w/p" else None)
        self.assertEqual(block["items"][0]["key"], "thedotmack/claude-mem#1")
        block, _ = self.build([], self.ship(1), remote=lambda cwd: None)
        self.assertEqual(block["items"][0]["key"], "claude-mem#1")

    def test_gh_confirmation_window_and_not_merged(self):
        merged_in = iso(S + 7 * H); merged_out = iso(E + 5 * H)
        gh = fake_gh({"o/r#1": dict(mergedAt=merged_in, url="u1", title="T1", commits=[]), "o/r#2": dict(mergedAt=merged_out, url="u2", title="T2", commits=[]),
                      "o/r#3": dict(mergedAt=None, url="u3", title="T3", commits=[])})
        obs = self.ship(1) + self.ship(2) + self.ship(3)
        block, _ = self.build([], obs, gh=gh)
        self.assertEqual([i["key"] for i in block["items"]], ["o/r#1"]); self.assertTrue(block["items"][0]["confirmed"])
        self.assertEqual((block["items"][0]["title"], block["items"][0]["url"]), ("T1", "u1"))
        self.assertEqual(sorted(d["reason"] for d in block["dropped"]), ["gh pr view: not merged", "outside window"])
        self.assertEqual(len(gh.calls), 3)

    def test_trailer_links_and_shared_turn_assigned_once(self):
        c = lambda sid: [dict(messageHeadline="x", messageBody=f"body\n\nClaude-Session: {sid}")]
        gh = fake_gh({"o/r#1": dict(mergedAt=iso(S + 5 * H), url="u", title="first", commits=c("cs1")),
                      "o/r#2": dict(mergedAt=iso(S + 9 * H), url="u", title="second", commits=c("cs1") + [dict(messageHeadline="y", messageBody="Session: cs2")])})
        rows = {"cs1": [usage_row("cs1", S + H, 1_000_000), usage_row("cs1", S + 2 * H, 2_000_000), usage_row("cs1", S + 7 * H, 4_000_000), usage_row("cs1", S + 20 * H, 8_000_000)]}
        block, by_day = self.build([], self.ship(1) + self.ship(2), rows=rows, gh=gh)
        w1, w2 = block["items"]
        self.assertEqual((w1["usd"], w2["usd"]), (3.0, 4.0))                                # each turn once; the turn after both wins is unattributed
        self.assertEqual((w1["turns_n"], w2["turns_n"], w1["sessions_n"]), (2, 1, 1))
        self.assertEqual(block["cost_status"], "session_linked"); self.assertEqual(block["total_attributed_usd"], 7.0)
        self.assertEqual(w1["cost_label"], "ESTIMATED · session-linked"); self.assertEqual(w1["cost_basis"], "estimated_usage")
        self.assertEqual(w2["linked_sessions"], ["cs1"])                                    # the `Session: cs2` line was ignored (G13)
        self.assertEqual(w1["tokens"]["input"], 2000); self.assertEqual(by_day[0]["usd"], 7.0)

    def test_replica_session_win_is_extrapolated_only_with_link(self):
        gh = fake_gh({"o/r#1": dict(mergedAt=iso(S + 5 * H), url="u", title="t", commits=[dict(messageHeadline="x", messageBody="Claude-Session: cs2")])})
        block, _ = self.build([], self.ship(1), gh=gh, ratio=2.0)                            # 2 micro-dollars per observer token
        w = block["items"][0]
        self.assertEqual((w["cost_status"], w["cost_basis"], w["usd"]), ("session_linked", "extrapolated", 0.0))
        self.assertIn("EXTRAPOLATED (low confidence)", w["cost_label"])
        block, _ = self.build([], self.ship(1), gh=gh, ratio=2.0)
        self.assertEqual(block["items"][0]["usd"], round(1000 * 2.0 / 1e6, 2))
        gh2 = fake_gh({"o/r#1": dict(mergedAt=iso(S + 5 * H), url="u", title="t", commits=[])})
        block, _ = self.build([], self.ship(1), gh=gh2, ratio=2.0)
        self.assertEqual((block["items"][0]["cost_status"], block["items"][0]["usd"], block["items"][0]["cost_basis"]), ("unmeasured", None, None))

    def test_finished_work_is_not_a_win(self):
        block, by_day = self.build([], [])                       # completed sessions exist in sessions(), but no merge/publish evidence
        self.assertEqual(block["items"], []); self.assertEqual([d["count"] for d in by_day], [0, 0, 0])

    # ---- read-only GitHub merged-PR source ----
    def test_gh_list_adds_wins_dedupes_and_labels_source(self):
        f = self.write("a.jsonl", tool_lines("cs1", S + 2 * H, "gh pr merge 4125 --repo o/r"))
        lister = lambda repo, s, e: ([dict(number=4125, title="from github", url="https://github.com/o/r/pull/4125", ts_ms=S + 3 * H),
                                      dict(number=4200, title="only on github", url="https://github.com/o/r/pull/4200", ts_ms=S + 30 * H)], "ok")
        block, by_day = self.build([f], self.ship(4125), gh_list=lister)
        keys = {i["key"]: i for i in block["items"]}
        self.assertEqual(sorted(keys), ["o/r#4125", "o/r#4200"])                                   # 4125 counted once across three sources
        self.assertEqual(set(keys["o/r#4125"]["sources"]), {"transcript", "ship_observation", wins.GH_SOURCE}); self.assertTrue(keys["o/r#4125"]["confirmed"])
        self.assertEqual((keys["o/r#4200"]["sources"], keys["o/r#4200"]["title"], keys["o/r#4200"]["usd"], keys["o/r#4200"]["cost_status"]), ([wins.GH_SOURCE], "only on github", None, "unmeasured"))
        src = block["sources"][wins.GH_SOURCE]; self.assertEqual((src["status"], src["found"], src["repos"]["o/r"]["status"]), ("ok", 2, "ok"))
        self.assertEqual([d["count"] for d in by_day], [1, 1, 0])

    def test_gh_list_unavailable_never_zero_and_report_completes(self):
        f = self.write("a.jsonl", tool_lines("cs1", S + 2 * H, "gh pr merge 4125 --repo o/r"))
        for reason in ("gh missing", "unauthenticated", "rate-limited"):
            block, _ = self.build([f], gh_list=lambda repo, s, e, r=reason: ([], r))
            src = block["sources"][wins.GH_SOURCE]
            self.assertEqual((src["status"], src["repos"]["o/r"]["status"], src["repos"]["o/r"]["found"]), ("unavailable", reason, None), reason)
            self.assertEqual(len(block["items"]), 1)                                                # the other sources still ship
        block, _ = self.build([f], gh=fake_gh({}), gh_list=None)
        self.assertEqual(block["sources"][wins.GH_SOURCE]["repos"]["o/r"]["status"], "unavailable (gh disabled for this run)")

    def test_gh_merged_prs_window_edges_and_failures(self):
        rows = [dict(number=1, title="a", url="u1", mergedAt=iso(S)), dict(number=2, title="b", url="u2", mergedAt=iso(E)), dict(number=3, title="c", url="u3", mergedAt=iso(E - 1000)), dict(number=4, title="no merge", url="u4", mergedAt=None)]
        ok = lambda cmd, **k: type("R", (), dict(returncode=0, stdout=json.dumps(rows), stderr=""))()
        out, st = wins.gh_merged_prs("o/r", S, E, run=ok)
        self.assertEqual((st, [x["number"] for x in out]), ("ok", [1, 3]))                        # start inclusive, end exclusive, unmerged dropped
        def missing(cmd, **k): raise FileNotFoundError("gh")
        self.assertEqual(wins.gh_merged_prs("o/r", S, E, run=missing), ([], "gh missing"))
        auth = lambda cmd, **k: type("R", (), dict(returncode=4, stdout="", stderr="To get started with GitHub CLI, please run:  gh auth login"))()
        self.assertEqual(wins.gh_merged_prs("o/r", S, E, run=auth)[1], "unauthenticated")
        rl = lambda cmd, **k: type("R", (), dict(returncode=1, stdout="", stderr="GraphQL: API rate limit exceeded for user"))()
        self.assertEqual(wins.gh_merged_prs("o/r", S, E, run=rl)[1], "rate-limited")
        junk = lambda cmd, **k: type("R", (), dict(returncode=0, stdout="not json", stderr=""))()
        self.assertEqual(wins.gh_merged_prs("o/r", S, E, run=junk)[1], "gh error (unparseable output)")
        seen = []
        def spy(cmd, **k): seen.append(cmd); return ok(cmd)
        wins.gh_merged_prs("o/r", S, E, run=spy)
        self.assertEqual(seen[0][:6], ["gh", "pr", "list", "--repo", "o/r", "--state"]); self.assertEqual(seen[0][1:3], ["pr", "list"]); self.assertNotIn("merge", seen[0][2])   # read-only: list, never merge

    def test_publish_from_transcript_and_observation_dedup(self):
        f = self.write("a.jsonl", tool_lines("cs1", S + 2 * H, "npm publish", "npm notice Publishing to https://registry.npmjs.org/\n+ claude-mem@13.25.3"))
        obs = [dict(id=3, title="claude-mem 13.25.3 published to npm", ts_ms=S + 3 * H, project="claude-mem/wt", memory_session_id="m1", content_session_id="cs1")]
        block, _ = self.build([f], obs)
        self.assertEqual([i["key"] for i in block["items"]], ["claude-mem@13.25.3"]); self.assertEqual(block["items"][0]["kind"], "publish")


if __name__ == "__main__":
    unittest.main()
