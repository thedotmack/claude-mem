"""Phase 8.5: `behavior-sample` writes a Markdown spot-check sheet from <run>/behavior.json and report.json:
N random human-tagged and N bot-tagged user turns (R2 check), N flagged turns or episodes per summary-tile
pattern, and 10 random unflagged sessions. Each line cites the session and time so a reviewer can mark it
true / false / unsure. Precision per pattern goes back into `rollup --precision <json>` (tile gate, 70%).
"""
import collections
import json
import os
import random

from . import patterns

TILE_GROUPS = [("P1_invented_gates", ["P1_invented_gates"]), ("P6+P7 made it up / false done", ["P6_fake_output", "P7_false_done"]),
               ("P2_broke_things", ["P2_broke_things"]), ("P3_wrong_model", ["P3_wrong_model"])]


def write(report_path, out_path, per_metric=20, seed=7):
    with open(report_path) as fh: d = json.load(fh)
    bp = os.path.join(os.path.dirname(os.path.abspath(report_path)), "behavior.json")
    with open(bp) as fh: b = json.load(fh)
    rnd = random.Random(seed); L = [f"# Behavior spot-check · {d['window'].get('start_pt')} → {d['window'].get('end_exclusive_pt')} · seed {seed}", "",
                                    "Mark each line `true`, `false` or `unsure` in the first column. Excerpts are scrubbed and cut to 160 chars.", ""]
    turns = b.get("user_turns", [])
    for author in ("human", "bot"):
        pool = [t for t in turns if t["author"] == author]; pick = rnd.sample(pool, min(per_metric, len(pool)))
        L += [f"## User turns tagged {author} ({len(pick)} of {len(pool)})", "", "| verdict | session | time | source | excerpt |", "|---|---|---|---|---|"]
        L += [f"| | `{t['session'][:12]}` | {t['ts_pt']} | {t['source']} | {t['excerpt'].replace('|', '/')} |" for t in pick]
        L.append("")
    flags = [f for f in b.get("flags", []) if not f.get("unconfirmed")]; eps = b.get("episodes", [])
    for name, keys in TILE_GROUPS:
        pool = [dict(kind="turn", **f) for f in flags if f["pattern"] in keys] + [dict(kind="episode", **e) for e in eps if e["pattern"] in keys]
        pick = rnd.sample(pool, min(per_metric, len(pool)))
        L += [f"## {name} ({len(pick)} of {len(pool)} flagged)", "", "| verdict | kind | session | time | basis | excerpt |", "|---|---|---|---|---|---|"]
        for x in pick:
            sid = x.get("session") or ""; ts = x.get("ts_pt") or ""
            L.append(f"| | {x['kind']} | `{sid[:12]}` | {ts} | {(x.get('basis') or x.get('cost_status') or '').replace('|', '/')} | {(x.get('excerpt') or '').replace('|', '/')} |")
        L.append("")
    flagged_sessions = {f["session"] for f in flags} | {e["session"] for e in eps}
    unflagged = [s for s in b.get("sessions", []) if s["session"] not in flagged_sessions]
    pick = rnd.sample(unflagged, min(10, len(unflagged)))
    L += [f"## Unflagged sessions ({len(pick)} of {len(unflagged)}) — look for obvious misses", "", "| missed? | session | tag | turns | tool errors | last message excerpt |", "|---|---|---|---|---|---|"]
    L += [f"| | `{s['session'][:12]}` | {s['tag']} | {s['turns']} | {s['tool_errors']} | {(s.get('last_text') or '').replace('|', '/')} |" for s in pick]
    L += ["", "## Precision (fill in)", "", "| pattern | true | false | unsure | precision |", "|---|---|---|---|---|"] + [f"| {name} | | | | |" for name, _ in TILE_GROUPS] + [""]
    with open(out_path, "w") as fh: fh.write("\n".join(L))
    return out_path, dict(human=sum(1 for t in turns if t["author"] == "human"), bot=sum(1 for t in turns if t["author"] == "bot"), flags=len(flags), episodes=len(eps), unflagged=len(unflagged))
