"""Wins and what each cost (plan Phase 2.8, G11/G12/G13).

A win is a merged PR or a published version (praise wins are a Phase 2B hook, see detect_praise).
Sources: successful `gh pr merge` / `npm publish` / `gh release create` / tag-push tool calls found by
streaming the window's transcripts, and ship observations (evidence.SHIP_RE, weekly_report.py:65,74-75)
that name a PR number or a published version. Deduped by key repo#number or package@version.
Optional read-only confirmation: `gh pr view <n> --repo <repo> --json mergedAt,url,title,commits`
(one call per candidate PR; never a write command). mergedAt must fall in the window.

Cost: "unmeasured" (every usd null) unless the PR's commits carry `Claude-Session: <bare id>`
trailers (R4, G13: a `Session:` line in a PR body is ignored; non-bare values rejected). Then each turn
of a linked session is assigned to the first linked win merged after it, so no turn counts twice.
There is no lineage fallback (G11). Titles come from the PR, the package, or the observation.
"""
import collections
import datetime as dt
import json
import re
import subprocess

from .labels import active_minutes
from .period import PT

KEYS = ("gh pr merge", "npm publish", "gh release create", "git push")
# a command is split into segments on ; & | and newlines (heredoc bodies dropped); the verb must start the segment
SEGMENT_SPLIT = re.compile(r"[;&|\n]")
MERGE_CMD = re.compile(r"^gh\s+pr\s+merge\b(?P<rest>.*)")
PUBLISH_CMD = re.compile(r"^npm\s+publish\b")
RELEASE_CMD = re.compile(r"^gh\s+release\s+create\s+(?P<tag>[\w.-]+)")
TAG_PUSH_CMD = re.compile(r"^git\s+push\b(?P<rest>.*)")
FAILED = re.compile(r"^\W{0,3}(error|fatal|failed|graphql:|npm err!|could not|permission denied|rejected|x pull request)", re.I | re.M)
PR_NUM = re.compile(r"/pull/(\d+)|(?<![\w.#-])(\d+)(?![\w.-])")
REPO_FLAG = re.compile(r"(?:--repo|-R)[ =](\S+)")
PR_IN_TITLE = re.compile(r"(?:\bPR|pull request)\s*#\s*(\d+)", re.I)
PUBLISH_TITLE = re.compile(r"\b(published|released|npm publish|tagged)\b", re.I)
PKG_VER = re.compile(r"(@?[\w][\w./-]*)@(\d+\.\d+\.\d+[\w.-]*)")
VERSION = re.compile(r"\bv?(\d+\.\d+\.\d+(?:[-.][\w.]+)?)\b")
REPO_URL = re.compile(r"github\.com[:/]([\w.-]+)/([\w.-]+?)(?:\.git)?(?:[/\s]|$)")
TRAILER = re.compile(r"^Claude-Session:[ \t]*(.*?)[ \t]*$", re.M)
BARE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
LINKED_LABEL = "ESTIMATED · session-linked"
ATTRIBUTION = "Claude-Session commit trailers (R4); each turn assigned to the first linked win merged after it"


# ---------- transcripts ----------
def classify_command(cmd):
    """The first merge/publish verb that starts a command segment (heredoc bodies and quoted prose never count)."""
    for seg in SEGMENT_SPLIT.split(cmd.split("<<")[0]):
        seg = seg.strip().lstrip("( ").strip()
        m = MERGE_CMD.match(seg)
        if m:
            rest = m.group("rest"); n = next((a or b for a, b in PR_NUM.findall(rest) if a or b), None)
            rf = REPO_FLAG.search(rest); ru = REPO_URL.search(rest)
            repo = rf.group(1) if rf else (f"{ru.group(1)}/{ru.group(2)}" if ru else None)
            return dict(kind="pr", number=int(n) if n else None, repo=repo, cmd=cmd[:200])
        if PUBLISH_CMD.match(seg): return dict(kind="publish", how="npm publish", cmd=cmd[:200])
        m = RELEASE_CMD.match(seg)
        if m: return dict(kind="publish", how="gh release create", tag=m.group("tag"), cmd=cmd[:200])
        m = TAG_PUSH_CMD.match(seg)
        if m:
            rest = m.group("rest"); v = VERSION.search(rest)
            if "--tags" in rest or v: return dict(kind="publish", how="git push tag", tag=v.group(0) if v else None, cmd=cmd[:200])
    return None


def _result_text(c, tur):
    parts = []
    if isinstance(tur, dict): parts += [str(tur.get("stdout") or ""), str(tur.get("stderr") or "")]
    cc = c.get("content")
    if isinstance(cc, str): parts.append(cc)
    elif isinstance(cc, list): parts += [str(x.get("text") or "") for x in cc if isinstance(x, dict)]
    return "\n".join(parts)


def _ts_ms(iso):
    try: return int(dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception: return None


def scan_transcripts(files, s_ms=None, e_ms=None):
    """Stream each transcript line by line; yield successful merge/publish tool calls inside the window."""
    for f in files:
        pending = {}
        try: fh = open(f, errors="ignore")
        except OSError: continue
        with fh:
            for line in fh:
                if not pending and not any(k in line for k in KEYS): continue
                if '"tool_use"' not in line and '"tool_result"' not in line: continue
                try: d = json.loads(line)
                except Exception: continue
                content = (d.get("message") or {}).get("content")
                if not isinstance(content, list): continue
                if d.get("type") == "assistant":
                    for c in content:
                        if isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") == "Bash":
                            cand = classify_command(str((c.get("input") or {}).get("command") or ""))
                            if cand:
                                cand.update(tool_use_id=c.get("id"), ts_ms=_ts_ms(d.get("timestamp") or ""), session=d.get("sessionId"),
                                            cwd=d.get("cwd"), file=f, source="transcript")
                                pending[c.get("id")] = cand
                elif d.get("type") == "user" and pending:
                    for c in content:
                        if isinstance(c, dict) and c.get("type") == "tool_result" and c.get("tool_use_id") in pending:
                            cand = pending.pop(c["tool_use_id"]); text = _result_text(c, d.get("toolUseResult"))
                            if c.get("is_error") or FAILED.search(text): continue
                            if cand["ts_ms"] is None or (s_ms is not None and not (s_ms <= cand["ts_ms"] < e_ms)): continue
                            cand["result"] = text[:2000]; yield cand


# ---------- helpers ----------
def parse_repo(url):
    m = REPO_URL.search(url or "")
    return f"{m.group(1)}/{m.group(2)}" if m else None


def git_remote(cwd):
    """Read-only: `git -C cwd remote get-url origin`; None when cwd is gone or not a repo."""
    try:
        r = subprocess.run(["git", "-C", cwd, "remote", "get-url", "origin"], capture_output=True, text=True, timeout=5)
        return parse_repo(r.stdout) if r.returncode == 0 else None
    except Exception: return None


def gh_pr_view(number, repo):
    """Read-only: gh pr view <n> --repo <repo> --json mergedAt,url,title,commits. Returns dict or None."""
    try:
        r = subprocess.run(["gh", "pr", "view", str(number), "--repo", repo, "--json", "mergedAt,url,title,commits"],
                           capture_output=True, text=True, timeout=25)
        return json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else None
    except Exception: return None


# ---- read-only merged-PR source (GitHub) ----
WINS_REPOS = ("thedotmack/claude-mem",)      # default repos for the merged-PR list; override with `rollup --wins-repo`
GH_SOURCE = "github_merged_prs"
GH_LIST_LIMIT = 200


def _gh_status(returncode, stderr):
    """Map a failed `gh` call to an honest status; never a number."""
    t = (stderr or "").lower()
    if "rate limit" in t or "api rate limit" in t or "secondary rate" in t: return "rate-limited"
    if "auth login" in t or "authentication" in t or "not logged in" in t or "http 401" in t or "bad credentials" in t: return "unauthenticated"
    return f"gh error (exit {returncode})"


def gh_merged_prs(repo, s_ms, e_ms, run=subprocess.run):
    """Read-only: gh pr list --repo <repo> --state merged --json number,title,mergedAt,url, searched by merge date
    (UTC days covering the PT window) and then filtered by mergedAt inside [s_ms, e_ms). Returns (rows, status)
    with status "ok" or a reason: "gh missing" | "unauthenticated" | "rate-limited" | "gh error (exit n)"."""
    a = dt.datetime.fromtimestamp(s_ms / 1000, dt.timezone.utc).date() - dt.timedelta(days=1)
    b = dt.datetime.fromtimestamp(e_ms / 1000, dt.timezone.utc).date() + dt.timedelta(days=1)
    cmd = ["gh", "pr", "list", "--repo", repo, "--state", "merged", "--limit", str(GH_LIST_LIMIT), "--json", "number,title,mergedAt,url",
           "--search", f"merged:{a.isoformat()}..{b.isoformat()}"]
    try:
        r = run(cmd, capture_output=True, text=True, timeout=40)
    except FileNotFoundError: return [], "gh missing"
    except (subprocess.TimeoutExpired, OSError) as ex: return [], f"gh error ({type(ex).__name__})"
    if r.returncode != 0: return [], _gh_status(r.returncode, r.stderr)
    try: rows = json.loads(r.stdout or "[]")
    except ValueError: return [], "gh error (unparseable output)"
    out = []
    for x in rows:
        if not x.get("mergedAt") or not x.get("number"): continue
        ms = _ts_ms(x["mergedAt"])
        if s_ms <= ms < e_ms: out.append(dict(number=int(x["number"]), title=x.get("title") or "", url=x.get("url"), ts_ms=ms))
    return out, "ok"


def gh_list_candidates(repos, s_ms, e_ms, lister=gh_merged_prs):
    """Candidates from the merged-PR list per repo plus a per-repo status for the report."""
    cands = []; status = {}
    for repo in repos:
        rows, st = lister(repo, s_ms, e_ms)
        status[repo] = dict(status=st, found=len(rows) if st == "ok" else None)
        for x in rows:
            cands.append(dict(kind="pr", source=GH_SOURCE, repo=repo, number=x["number"], title=x["title"], url=x["url"], ts_ms=x["ts_ms"],
                              project=repo.split("/")[-1], sessions=[], evidence_ids=[], gh_listed=True))
    return cands, status


def session_trailers(message):
    """Bare content_session_ids named by `Claude-Session:` trailers in one commit message (G13).
    Non-bare values (URLs, ids with spaces or parentheses, anything else) are rejected; `Session:`
    lines and PR bodies are never read."""
    out = []
    for v in TRAILER.findall(message or ""):
        if v and BARE_ID.match(v) and v not in out: out.append(v)
    return out


def detect_praise(*_args, **_kw):
    """Phase 2B hook (plan 2B.1 human-vs-bot tagger, 2B.4 sarcasm filter). Until those exist no user
    prompt is read for praise, so this returns [] and wins.praise_n is 0. Praise wins are never costed."""
    return []


def _pt_iso(ms):
    return dt.datetime.fromtimestamp(ms / 1000, PT).strftime("%Y-%m-%dT%H:%M%z")


# ---------- candidates -> wins ----------
def observation_candidates(ship_obs, project_repo):
    """ship_obs: dicts(id, title, ts_ms, project, memory_session_id, content_session_id)."""
    for o in ship_obs:
        t = o["title"] or ""; base = (o["project"] or "").split("/")[0]
        m = PR_IN_TITLE.search(t)
        if m:
            yield dict(kind="pr", number=int(m.group(1)), repo=project_repo(o["project"]), project=o["project"], ts_ms=o["ts_ms"],
                       title=t, evidence_ids=[o["id"]], sessions=[o["content_session_id"]], source="ship_observation"); continue
        if PUBLISH_TITLE.search(t):
            pv = PKG_VER.search(t); v = VERSION.search(t)
            if pv: key = f"{pv.group(1)}@{pv.group(2)}"
            elif v and base: key = f"{base}@{v.group(1)}"
            else: continue
            yield dict(kind="publish", key=key, project=o["project"], ts_ms=o["ts_ms"], title=t, evidence_ids=[o["id"]],
                       sessions=[o["content_session_id"]], source="ship_observation")


def _key(c, dropped):
    if c["kind"] == "pr":
        if not c.get("number"): dropped.append(dict(source=c["source"], reason="gh pr merge without a PR number", cmd=c.get("cmd"))); return None
        return f"{c.get('repo') or (c.get('project') or '?').split('/')[0]}#{c['number']}"
    if c.get("key"): return c["key"]
    text = c.get("result") or ""; pv = PKG_VER.search(text)
    if c.get("how") == "npm publish":
        if pv: return f"{pv.group(1)}@{pv.group(2)}"
        dropped.append(dict(source=c["source"], reason="npm publish result names no package@version", cmd=c.get("cmd"))); return None
    if c.get("tag"): return f"{c.get('repo') or c.get('project') or '?'}@{c['tag']}"
    dropped.append(dict(source=c["source"], reason="tag push without an identifiable tag", cmd=c.get("cmd"))); return None


def build(files, s_ms, e_ms, ship_obs, sessions_by_cs, rows_by_cs, ratio, days, gh=gh_pr_view, remote=git_remote, use_gh=True,
          repos=WINS_REPOS, gh_list=gh_merged_prs):
    """Returns (wins_block, wins_by_day). sessions_by_cs: cs -> dict(project, memory_session_id, has_transcript,
    observer_tokens, cwd); rows_by_cs: cs -> usage rows with ts_ms and x1e6 (None when unpriced)."""
    repo_cache = {}
    def project_repo(project):
        """Repo of a project from `git remote` of any transcript cwd in it; a worktree (`repo/wt`) falls back to its base project."""
        if project in repo_cache: return repo_cache[project]
        repo = None; base = (project or "").split("/")[0]
        for cs, s in sessions_by_cs.items():
            if (s.get("project") or "").split("/")[0] == base and s.get("cwd"):
                repo = remote(s["cwd"]) if remote else None
                if repo: break
        repo_cache[project] = repo; return repo
    cands = []; dropped = []; gh_unconfirmed = []
    for c in scan_transcripts(files, s_ms, e_ms):
        s = sessions_by_cs.get(c["session"]) or {}
        c["project"] = s.get("project") or c.get("cwd"); c["sessions"] = [c["session"]]; c["evidence_ids"] = []
        if c["kind"] == "pr" and not c.get("repo"): c["repo"] = (remote(c["cwd"]) if remote and c.get("cwd") else None) or project_repo(c["project"])
        cands.append(c)
    cands += list(observation_candidates(ship_obs, project_repo))
    gh_status = {}
    if use_gh and gh_list and s_ms is not None and e_ms is not None:
        gh_cands, gh_status = gh_list_candidates(repos, s_ms, e_ms, lister=gh_list); cands += gh_cands
    elif repos: gh_status = {r: dict(status="unavailable (gh disabled for this run)", found=None) for r in repos}
    merged = collections.OrderedDict()
    for c in cands:
        key = _key(c, dropped)
        if key is None: continue
        w = merged.get(key)
        if w is None:
            w = merged[key] = dict(win_id=None, kind=c["kind"], key=key, title=c.get("title") or key, url=None, ts_ms=c["ts_ms"],
                                   project=c.get("project"), repo=c.get("repo"), number=c.get("number"), evidence_ids=[], sessions=[],
                                   sources=[], confirmed=False, linked_sessions=[], gh_listed=False)
        for eid in c.get("evidence_ids", []):
            if eid not in w["evidence_ids"]: w["evidence_ids"].append(eid)
        for sid in c.get("sessions", []):
            if sid and sid not in w["sessions"]: w["sessions"].append(sid)
        if c["source"] not in w["sources"]: w["sources"].append(c["source"])
        if c.get("gh_listed"):                       # the registry's own merge time, title and url win over transcript guesses
            w["gh_listed"] = True; w["confirmed"] = True; w["ts_ms"] = c["ts_ms"]; w["url"] = w["url"] or c.get("url"); w["title"] = c.get("title") or w["title"]
        elif c["ts_ms"] and (w["ts_ms"] is None or c["ts_ms"] < w["ts_ms"]): w["ts_ms"] = c["ts_ms"]
    items = []
    for key, w in merged.items():
        if w["kind"] == "pr" and use_gh and gh and w.get("repo") and w.get("number") and not (w["gh_listed"] and w["sources"] == [GH_SOURCE]):   # listed-only wins need no second call
            info = gh(w["number"], w["repo"])
            if info is not None:
                if not info.get("mergedAt"): dropped.append(dict(key=key, reason="gh pr view: not merged")); continue
                w["ts_ms"] = _ts_ms(info["mergedAt"]); w["url"] = info.get("url"); w["title"] = info.get("title") or w["title"]
                w["confirmed"] = True; w["sources"].append("gh_confirm")
                for cm in info.get("commits") or []:
                    for sid in session_trailers("\n".join([cm.get("messageHeadline") or "", cm.get("messageBody") or ""])):
                        if sid not in w["linked_sessions"]: w["linked_sessions"].append(sid)
            else:   # gh failed or returned nothing: keep the win on its own evidence, but say so
                gh_unconfirmed.append(dict(key=key, reason="gh pr view returned nothing (gh error, no access, or PR not found); kept unconfirmed"))
        if w["ts_ms"] is None: dropped.append(dict(key=key, reason="no timestamp")); continue
        if s_ms is not None and not (s_ms <= w["ts_ms"] < e_ms): dropped.append(dict(key=key, reason="outside window", ts_pt=_pt_iso(w["ts_ms"]))); continue
        items.append(w)
    items.sort(key=lambda w: w["ts_ms"])
    for i, w in enumerate(items, 1): w["win_id"] = f"W-{i}"
    attribute(items, sessions_by_cs, rows_by_cs, ratio)
    praise = detect_praise()
    out = []
    for w in items:
        out.append(dict(win_id=w["win_id"], kind=w["kind"], key=w["key"], title=w["title"], url=w["url"], ts_pt=_pt_iso(w["ts_ms"]),
                        day_pt=dt.datetime.fromtimestamp(w["ts_ms"] / 1000, PT).date().isoformat(), project=w["project"],
                        evidence_ids=w["evidence_ids"], sessions=w["sessions"], sources=w["sources"], confirmed=w["confirmed"],
                        linked_sessions=w["linked_sessions"], usd=w["usd"], cost_status=w["cost_status"], cost_basis=w["cost_basis"],
                        cost_label=w["cost_label"], tokens=w["tokens"], sessions_n=w["sessions_n"], turns_n=w["turns_n"],
                        active_minutes=w["active_minutes"]))
    linked = any(w["cost_status"] == "session_linked" for w in items)
    total = round(sum(w["usd"] for w in items if w["usd"] is not None), 2) if linked else None
    block = dict(items=out, cost_status="session_linked" if linked else "unmeasured", attribution_method=ATTRIBUTION if linked else None,
                 unattributed_usd=None, total_attributed_usd=total, praise_n=len(praise), dropped=dropped, gh_unconfirmed=gh_unconfirmed,
                 sources=dict(transcripts="box transcripts (gh pr merge / npm publish / release / tag push)", ship_observations="claude-mem ship observations",
                              **{GH_SOURCE: dict(label="GitHub merged PRs (read-only gh pr list)", repos={r: v for r, v in gh_status.items()},
                                                 status=("ok" if gh_status and all(v["status"] == "ok" for v in gh_status.values()) else "unavailable" if gh_status else "off"),
                                                 found=sum(v["found"] or 0 for v in gh_status.values()) if gh_status else 0)}),
                 note="finished line items (shipped/completed) are outcomes, not wins (G12); praise detection is a Phase 2B hook")
    by_day = [dict(day_pt=d, count=sum(1 for w in out if w["day_pt"] == d),
                   usd=(round(sum(w["usd"] for w in out if w["day_pt"] == d and w["usd"] is not None), 2) if linked else None),
                   win_ids=[w["win_id"] for w in out if w["day_pt"] == d]) for d in days]
    return block, by_day


def attribute(items, sessions_by_cs, rows_by_cs, ratio):
    """Assign each turn of a linked session to the first linked win merged after it (no double counting).
    Replica sessions (no transcript on this box) add an extrapolated portion only when the win is linked
    and a ratio exists; the item is then labeled cost_basis extrapolated. Unlinked wins stay unmeasured."""
    by_session = collections.defaultdict(list)
    for w in items:
        w.update(usd=None, cost_status="unmeasured", cost_basis=None, cost_label="unmeasured (session not linked to PR)",
                 tokens=None, sessions_n=0, turns_n=0, active_minutes=None, _x1e6=0, _tok=collections.Counter(), _stamps=[])
        for sid in w["linked_sessions"]: by_session[sid].append(w)
    for sid, ws in by_session.items():
        ws.sort(key=lambda w: w["ts_ms"])
        for w in ws: w["sessions_n"] += 1
        for r in rows_by_cs.get(sid, []):
            tgt = next((w for w in ws if w["ts_ms"] >= r["ts_ms"]), None)
            if tgt is None: continue                                    # a turn after every linked win stays unattributed
            tgt["turns_n"] += 1; tgt["_stamps"].append(r["ts_ms"])
            if r.get("x1e6") is not None: tgt["_x1e6"] += r["x1e6"]
            for f in ("input", "output", "cache_write_5m", "cache_write_1h", "cache_read"): tgt["_tok"][f] += r[f]
        s = sessions_by_cs.get(sid) or {}
        if not s.get("has_transcript") and ratio is not None and s.get("observer_tokens"):
            ws[-1]["_x1e6"] += int(round(s["observer_tokens"] * ratio)); ws[-1]["cost_basis"] = "extrapolated"
    for w in items:
        if w["linked_sessions"]:
            w["usd"] = round(w["_x1e6"] / 1e6, 2); w["cost_status"] = "session_linked"
            w["cost_basis"] = w["cost_basis"] or "estimated_usage"
            w["cost_label"] = LINKED_LABEL + (" · EXTRAPOLATED (low confidence)" if w["cost_basis"] == "extrapolated" else "")
            w["tokens"] = dict(w["_tok"]); w["active_minutes"] = round(active_minutes(w["_stamps"]), 1)
        for k in ("_x1e6", "_tok", "_stamps"): w.pop(k, None)
