"""Save an owner-goals snapshot: what the owner asked for in their own prompts, sorted into focus areas, asks and rules.

Input is the goals JSON the map step writes:
  {
    "generated_at": "2026-10-18T23:40:00-07:00",
    "window_days": 31,
    "source_prompt_count": 823,
    "human_summary": "What the owner is trying to do this month, in a few sentences.",
    "focus_areas": [{"rank": 1, "title": "<area name>", "goal": "<one sentence: what the area is for>",
                     "matches": "<saved focus area id>" or null, "latest_at": "2026-10-18 22:11", "times_asked": 4,
                     "evidence": [{"at": "2026-10-18 22:11", "quote": "the owner's exact words"}]}],
    "asks":  [{"rank": 1, "title": "...", "focus_area": "<a focus_areas title>" or null, "latest_at": "...", "times_asked": 2, "evidence": [...]}],
    "rules": [{"when": "<situation, or empty for always>", "then": "<what to do>", "latest_at": "...", "times_asked": 3, "evidence": [...]}]
  }

Every evidence quote is checked against owner-prompts.md: it has to appear in a prompt headed with that
minute. Quotes may skip words with "..." between the pieces. Unverified quotes stop the save and are listed.
A quote dated before the first prompt in owner-prompts.md has aged out of the window (an updated snapshot
carries older quotes forward): it is dropped, and so is an item left with no quote. With no prompts in the file,
every quote has aged out. When every item ages out, the snapshot is saved empty, which clears the old goals.

Where each kind goes, all through the local worker:
  focus areas  "owner-goals" rows (task "Focus area: <title>", goal_kind focus-area), and, for an area that
               matches no saved one, a suggested area in My Focus (POST /api/work-view/focus/owner-goals, which
               writes only system suggestions under new ids; "matches" is the model's judgment, never a name match)
  asks         "owner-goals" rows (task "Ask: <title>", goal_kind ask), with focus_area and focus_area_id
  rules        suggestions in My Rules: the build story's preferences (<ledger dir>/story.json), source owner-goals,
               replacing the ones an earlier save wrote
The "owner-goals" list is written under the home folder's project key so there is one list per computer:
  list state:  human_summary, generated_at, window_days, source_prompt_count, map_path, status
  one task per item: status todo, goal_kind, rank, title, goal or focus_area, focus_area_id, latest_at,
                     times_asked, evidence ("YYYY-MM-DD HH:MM | quote" per line)
Items from the previous snapshot that are not in this one are marked dropped, so a re-run replaces it.

With --start and --end (the period the prompts cover), the list state also records period_start and period_end.
A period that ended before today is a past month: it is saved to "owner-goals/<start>" as history (the list and
its items are saved done, so they never count as open), and My Work lists it under the Goals month switcher.
A past month suggests no focus areas and no rules: those describe the owner now.

--print-focus-areas prints the saved focus areas (id, name, goal, status) for the map step to match against.

Usage: python3 save_goals.py --goals owner-goals.json --prompts owner-prompts.md [--map owner-map.md]
                             [--start YYYY-MM-DD --end YYYY-MM-DD] [--carried-before "YYYY-MM-DD HH:MM"]
                             [--ledger-dir <dir>] [--dry-run]
       python3 save_goals.py --print-focus-areas
"""
import argparse, datetime, json, os, re, sys, traceback, urllib.error, urllib.request

LIST_NAME = "owner-goals"
MAX_FIELDS_JSON_CHARS = 2000  # MAX_WORK_STATE_FIELDS_JSON_CHARS in WorkStateRoutes.ts
MAX_QUOTE_CHARS = 240
# The bounds POST /api/work-view/focus/owner-goals takes for an area: a nav label and one sentence.
MAX_AREA_NAME_CHARS = 80
MAX_AREA_GOAL_CHARS = 300
# validateStory's bound on one preference (request-groups.mjs), so a rule reads the same after a story rewrite.
MAX_RULE_CHARS = 200
# The bound My Work shows an item's title within (compactText(title, 240) in agent-view.mjs).
MAX_TITLE_CHARS = 240
# The route's bound on an area's evidence line (ownerGoalsFocusBody in WorkViewRoutes.ts).
MAX_AREA_EVIDENCE_CHARS = 300
# The longest focus area id the worker takes (focusAreaIdField in WorkViewRoutes.ts): every row is checked with an id
# this long before anything is written, so a row that fits then fits with the real id.
LONGEST_FOCUS_AREA_ID = "fa_" + "0" * 77
# Exit code for a failure after the first write: the refresh never re-asks the model then, since a second answer
# would suggest its new areas again. Every refusal before a write exits 1 and can be fixed and retried.
FAILED_AFTER_WRITING_EXIT = 3
KIND_LABELS = {"focus-area": "Focus area", "ask": "Ask"}
ITEM_KEYS = ("focus_areas", "asks", "rules")
RULE_SOURCE = "owner-goals"


def data_dir():
    return os.environ.get("CLAUDE_MEM_DATA_DIR") or os.path.expanduser("~/.claude-mem")


def worker_base_url():
    settings = {}
    try:
        with open(os.path.join(data_dir(), "settings.json")) as settings_file:
            settings = json.load(settings_file)
    except (OSError, ValueError):
        pass
    port = os.environ.get("CLAUDE_MEM_WORKER_PORT") or settings.get("CLAUDE_MEM_WORKER_PORT") or str(37700 + (os.getuid() if hasattr(os, "getuid") else 77) % 100)
    host = os.environ.get("CLAUDE_MEM_WORKER_HOST") or settings.get("CLAUDE_MEM_WORKER_HOST") or "127.0.0.1"
    host = "127.0.0.1" if host in ("0.0.0.0", "::") else host
    return f"http://{host}:{port}"


class NothingWritten(Exception):
    """The worker refused a request it validates in full before writing anything (a 400 from the focus route)."""


def worker_request(base_url, path, body=None, nothing_written_on=()):
    request = urllib.request.Request(base_url + path, method="POST" if body is not None else "GET",
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json"} if body is not None else {})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read().decode()
    except urllib.error.HTTPError as error:
        if error.code in nothing_written_on:
            raise NothingWritten(f"worker refused {path}: {error.code} {error.read().decode()}")
        sys.exit(f"worker refused {path}: {error.code} {error.read().decode()}")
    except urllib.error.URLError as error:
        sys.exit(f"claude-mem worker is not reachable at {base_url} ({error.reason}). Start it with: npx claude-mem start")


def comparable(text):
    # Quote marks inside a quote are often switched between ' and "; they compare equal.
    # Pasted JSON escapes them with a backslash.
    text = re.sub(r"\\?[\u2018\u2019\u201c\u201d\"']", "'", text)
    return re.sub(r"\s+", " ", text).strip().lower()


def prompts_by_minute(prompts_path):
    sections = {}
    current_minute = None
    for line in open(prompts_path, errors="ignore"):
        header = re.match(r"## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · ", line)
        if header:
            current_minute = header.group(1)
            sections.setdefault(current_minute, [])
        elif current_minute:
            sections[current_minute].append(line)
    return {minute: comparable("".join(lines)) for minute, lines in sections.items()}


def label(item):
    return item.get("title") or item.get("then")


def drop_aged_quotes(goals, prompts):
    """Remove quotes older than the prompts file's first minute, and items they leave without one. Returns those items' titles.
    With no prompts in the window, every quote is outside it."""
    first_minute = min(prompts, default=None)
    aged_out = []
    for kind_key in ITEM_KEYS:
        kept = []
        for item in goals.get(kind_key, []):
            quotes = item.get("evidence") or []
            item["evidence"] = [quote for quote in quotes if first_minute is not None and str(quote.get("at", ""))[:16] >= first_minute]
            if quotes and not item["evidence"]:
                aged_out.append(label(item))
            else:
                kept.append(item)
        goals[kind_key] = kept
    return aged_out


def drop_unverifiable_carried_quotes(goals, prompts, carried_before):
    """Quotes dated before carried_before came from goals saved earlier, already checked then. One that no longer
    matches (its words were inside a <private> block, which the export now strips) is dropped, not refused, so
    one old quote cannot stop every later refresh. Items left without a quote go too. Returns what was dropped."""
    dropped = []
    for kind_key in ITEM_KEYS:
        kept = []
        for item in goals.get(kind_key, []):
            quotes = item.get("evidence") or []
            item["evidence"] = [quote for quote in quotes
                                if str(quote.get("at", ""))[:16] >= carried_before or not unverified_quotes({"asks": [{"evidence": [quote]}]}, prompts)]
            dropped += [f'{label(item)}: {quote.get("at")}' for quote in quotes if quote not in item["evidence"]]
            if not quotes or item["evidence"]:
                kept.append(item)
        goals[kind_key] = kept
    return dropped


def unverified_quotes(goals, prompts):
    problems = []
    for kind_key in ITEM_KEYS:
        for item in goals.get(kind_key, []):
            for quote in item.get("evidence", []):
                at, text = str(quote.get("at", "")), str(quote.get("quote", ""))
                prompt = prompts.get(at[:16])
                pieces = [comparable(piece).strip(" .,;:!?\"'") for piece in re.split(r"\.\.\.|…", text)]
                pieces = [piece for piece in pieces if len(piece) >= 3]
                if prompt is None:
                    problems.append(f'{label(item)}: no owner prompt at {at!r}')
                elif not pieces or any(piece not in prompt for piece in pieces):
                    problems.append(f'{label(item)}: quote not in the {at} prompt: "{text}"')
    return problems


def shape_problems(goals):
    """What keeps this answer from being saved as focus areas, asks and rules: the three tests' output, nothing else."""
    old_keys = [key for key in ("priorities", "open_asks") if key in goals]
    if old_keys:
        return [f'{", ".join(old_keys)}: the old shape. Sort every item into "focus_areas", "asks" or "rules" with the three tests']
    problems = []
    for key in ITEM_KEYS:
        if not isinstance(goals.get(key, []), list):
            problems.append(f'"{key}" must be a list')
    if problems:
        return problems
    area_titles = [str(area.get("title") or "").strip() for area in goals.get("focus_areas", [])]
    for area in goals.get("focus_areas", []):
        title = str(area.get("title") or "").strip()
        if not title or len(title) > MAX_AREA_NAME_CHARS:
            problems.append(f'focus area {title!r}: a title of 1-{MAX_AREA_NAME_CHARS} characters')
        if not str(area.get("goal") or "").strip() or len(str(area.get("goal") or "").strip()) > MAX_AREA_GOAL_CHARS:
            problems.append(f'focus area {title!r}: a one-sentence "goal" of 1-{MAX_AREA_GOAL_CHARS} characters')
        if not isinstance(area.get("rank"), int) or isinstance(area.get("rank"), bool) or area["rank"] < 1:
            problems.append(f'focus area {title!r}: "rank" must be a whole number from 1')
        if "matches" not in area or not (area["matches"] is None or (isinstance(area["matches"], str) and area["matches"].strip())):
            problems.append(f'focus area {title!r}: "matches" must be the saved focus area id it already is, or null for a new area')
    for ask in goals.get("asks", []):
        if len(str(ask.get("title") or "").strip()) > MAX_TITLE_CHARS:
            problems.append(f'ask {ask.get("title")!r}: a title of at most {MAX_TITLE_CHARS} characters')
        if "focus_area" not in ask:
            problems.append(f'ask {ask.get("title")!r}: "focus_area" must name one of this answer\'s focus_areas titles, or be null')
        elif ask["focus_area"] is not None and ask["focus_area"] not in area_titles:
            problems.append(f'ask {ask.get("title")!r}: focus_area {ask["focus_area"]!r} is not a title in this answer\'s focus_areas')
    for rule in goals.get("rules", []):
        then = str(rule.get("then") or "").strip()
        if not then or len(then) > MAX_RULE_CHARS:
            problems.append(f'rule {then!r}: a "then" of 1-{MAX_RULE_CHARS} characters')
        if not isinstance(rule.get("when", ""), str):
            problems.append(f'rule {then!r}: "when" must be text (empty for always)')
    return problems


def evidence_lines(item):
    lines = []
    for quote in item.get("evidence", []):
        # Keep backslashes out of f-string expressions: Python 3.9-3.11 cannot parse them.
        text = re.sub(r"\s+", " ", str(quote["quote"])).strip()[:MAX_QUOTE_CHARS]
        lines.append(f'{str(quote["at"])[:16]} | {text}')
    return lines


def item_fields(kind, item, snapshot, status, focus_area_id):
    title = str(item["title"]).strip()
    evidence = evidence_lines(item)
    fields = {
        "task": f"{KIND_LABELS[kind]}: {title}", "status": status, "goal_kind": kind,
        "rank": item.get("rank"), "title": title,
        **({"goal": str(item["goal"]).strip()} if kind == "focus-area" else {"focus_area": item.get("focus_area")}),
        "focus_area_id": focus_area_id,
        "latest_at": item.get("latest_at"), "times_asked": item.get("times_asked"),
        "snapshot": snapshot, "evidence": "\n".join(evidence),
    }
    # One write holds at most 2,000 characters; the newest quotes come first, so trim from the end.
    while len(json.dumps(fields)) > MAX_FIELDS_JSON_CHARS and len(evidence) > 1:
        evidence.pop()
        fields["evidence"] = "\n".join(evidence)
    if len(json.dumps(fields)) > MAX_FIELDS_JSON_CHARS:
        sys.exit(f"item too large to save even with one quote: {title}")
    return fields


def mined_area(area):
    """One focus area as POST /api/work-view/focus/owner-goals takes it. Its quotes stay on the owner-goals item."""
    return {
        "name": str(area["title"]).strip(), "goal": str(area["goal"]).strip(), "rank": area.get("rank"),
        "matches": area["matches"].strip() if isinstance(area["matches"], str) else None,
        "evidence": f'From your prompts: asked {area.get("times_asked") or len(area.get("evidence", []))} times, latest {area.get("latest_at") or "not recorded"}.',
    }


def rule_preference(rule):
    """One rule as a build-story preference, the input My Rules turns into a suggested rule."""
    times = rule.get("times_asked")
    return {
        "preference": str(rule["then"]).strip(), "when": str(rule.get("when") or "").strip(), "kind": "directive",
        "supportCount": times if isinstance(times, int) and times > 0 else len(rule.get("evidence", [])),
        # Prompt headers are local minutes; the story keeps ISO times with the offset.
        "quotes": [{"quote": re.sub(r"\s+", " ", str(quote["quote"])).strip(),
                    "at": datetime.datetime.strptime(str(quote["at"])[:16], "%Y-%m-%d %H:%M").astimezone().isoformat()}
                   for quote in rule.get("evidence", [])],
        "source": RULE_SOURCE,
    }


def write_json_atomic(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp = f"{path}.tmp"
    with open(temp, "w") as handle:
        json.dump(value, handle, indent=2)
    os.replace(temp, path)


def save_rules(ledger_dir, preferences):
    """Replace the rules an earlier save put in story.json; the story's own preferences stay."""
    path = os.path.join(ledger_dir, "story.json")
    story = {}
    if os.path.exists(path):
        with open(path) as handle:
            story = json.load(handle)
    story["preferences"] = [preference for preference in story.get("preferences", []) if preference.get("source") != RULE_SOURCE] + preferences
    write_json_atomic(path, story)
    return path


def print_focus_areas(base_url):
    view = json.loads(worker_request(base_url, "/api/work-view"))
    if "focusAreas" not in view:
        sys.exit("this claude-mem worker predates My Focus; update claude-mem and restart the worker")
    print(json.dumps([{"focusAreaId": area["focusAreaId"], "name": area["name"], "goal": area["goal"], "status": area["status"],
                       "mergedInto": area["mergedInto"]} for area in view["focusAreas"]], indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--goals", help="owner-goals.json from the map step")
    parser.add_argument("--prompts", help="owner-prompts.md the map was built from")
    parser.add_argument("--map", help="owner-map.md, recorded on the list so the full map can be found")
    parser.add_argument("--start", type=datetime.date.fromisoformat, help="first day the prompts cover, YYYY-MM-DD")
    parser.add_argument("--end", type=datetime.date.fromisoformat, help="day after the last day the prompts cover, YYYY-MM-DD")
    parser.add_argument("--carried-before", help="local minute the saved goals were exported, YYYY-MM-DD HH:MM: an older quote that no longer matches is dropped instead of refused")
    parser.add_argument("--ledger-dir", help="My Work's folder holding story.json (default: <claude-mem data dir>/work-view)")
    parser.add_argument("--dry-run", action="store_true", help="validate and print the writes without saving")
    parser.add_argument("--print-focus-areas", action="store_true", help="print the saved focus areas to match against, then exit")
    args = parser.parse_args()
    base_url = worker_base_url()
    if args.print_focus_areas:
        print_focus_areas(base_url)
        return
    if not args.goals or not args.prompts:
        sys.exit("--goals and --prompts are required")
    if bool(args.start) != bool(args.end) or (args.start and args.end <= args.start):
        sys.exit("--start and --end go together, and --end must be after --start")
    history = bool(args.end and args.end < datetime.date.today())
    list_name = f"{LIST_NAME}/{args.start.isoformat()}" if history else LIST_NAME
    ledger_dir = args.ledger_dir or os.path.join(data_dir(), "work-view")

    goals = json.load(open(args.goals))
    problems = shape_problems(goals)
    if problems:
        sys.exit("the goals JSON is not in the saved shape:\n- " + "\n- ".join(problems))
    prompts = prompts_by_minute(args.prompts)
    aged_out = drop_aged_quotes(goals, prompts)
    dropped_carried = drop_unverifiable_carried_quotes(goals, prompts, args.carried_before) if args.carried_before else []
    areas, asks, rules = goals.get("focus_areas", []), goals.get("asks", []), goals.get("rules", [])
    # An ask whose area aged out of the window keeps its words but no longer names an area; it is reported.
    kept_titles = {str(area["title"]).strip() for area in areas}
    unlinked_asks = [ask.get("title") for ask in asks if ask.get("focus_area") is not None and ask["focus_area"] not in kept_titles]
    for ask in asks:
        if ask.get("title") in unlinked_asks:
            ask["focus_area"] = None
    missing = [f'{kind} {label(item)!r}' for kind, items in (("focus area", areas), ("ask", asks), ("rule", rules))
               for item in items if not label(item) or not item.get("evidence")]
    # An empty snapshot is valid only when the window emptied it (every quote aged out, or no prompts in it);
    # an answer that names nothing while there are prompts is refused.
    if (not areas and not asks and not rules and not aged_out and not dropped_carried and prompts) or missing:
        sys.exit("every focus area, ask and rule needs a title (a rule: its then) and at least one evidence quote: " + ", ".join(missing or ["no items"]))
    problems = unverified_quotes(goals, prompts)
    if problems:
        sys.exit("these quotes are not the owner's words at that time; fix them in the goals JSON:\n- " + "\n- ".join(problems))
    titles = [f'{KIND_LABELS["focus-area"]}: {str(area["title"]).strip()}' for area in areas] + [f'{KIND_LABELS["ask"]}: {str(ask["title"]).strip()}' for ask in asks]
    if len(set(titles)) != len(titles):
        sys.exit("two items share a title; give each focus area and ask its own title")

    snapshot = str(goals.get("generated_at") or "")
    state_fields = {
        "human_summary": str(goals.get("human_summary") or "")[:1500] or None, "generated_at": snapshot or None,
        "window_days": goals.get("window_days"), "source_prompt_count": goals.get("source_prompt_count"),
        "map_path": os.path.abspath(args.map) if args.map else None, "status": "done" if history else "open",
    }
    if args.start:
        state_fields.update(period_start=args.start.isoformat(), period_end=args.end.isoformat())
    # A past month suggests no areas and no rules: those describe the owner now.
    focus_request = {"areas": [mined_area(area) for area in areas]} if not history else None
    preferences = [rule_preference(rule) for rule in rules] if not history else []

    if focus_request is not None:
        long_evidence = [area["name"] for area in focus_request["areas"] if len(area["evidence"]) > MAX_AREA_EVIDENCE_CHARS]
        if long_evidence:
            sys.exit(f"focus areas whose latest_at or times_asked make the evidence line longer than {MAX_AREA_EVIDENCE_CHARS} characters: {long_evidence}")

    def writes_for(area_ids):
        id_by_title = {str(area["title"]).strip(): area_id for area, area_id in zip(areas, area_ids)}
        status = "done" if history else "todo"
        return [state_fields] + [item_fields("focus-area", area, snapshot, status, id_by_title.get(str(area["title"]).strip())) for area in areas] \
            + [item_fields("ask", ask, snapshot, status, id_by_title.get(ask.get("focus_area"))) for ask in asks]

    # Every row is built (and refused if it cannot fit) before anything is written.
    writes_for([LONGEST_FOCUS_AREA_ID] * len(areas))
    if args.dry_run:
        # The ids a save would give new areas are not known until the worker writes them.
        area_ids = [area["matches"] for area in focus_request["areas"]] if focus_request else [None] * len(areas)
        print(json.dumps({"list": list_name, "focus_areas": focus_request, "writes": writes_for(area_ids),
                          "rules": preferences, "unlinked_asks": unlinked_asks}, indent=2))
        return
    view = json.loads(worker_request(base_url, "/api/work-view"))
    if "goals" not in view or "focusAreas" not in view or (history and "goalHistory" not in view):
        sys.exit(f"this claude-mem worker predates {'Goals history' if history else 'My Focus'}; update claude-mem and restart the worker")
    previous = (next((month for month in view["goalHistory"] if month["listName"] == list_name), None) if history else view["goals"]) or {}
    try:
        story_path, stale_tasks = write_everything(base_url, list_name, previous, focus_request, writes_for, ledger_dir, preferences, history, len(areas))
    except NothingWritten as refusal:
        # The first write was refused whole (a match to an area that is not saved): fixable, and nothing to undo.
        sys.exit(str(refusal))
    except SystemExit as failure:
        if failure.code in (0, None):
            raise
        print(failure.code if isinstance(failure.code, str) else f"save_goals.py failed after it started writing ({failure.code})", file=sys.stderr)
        sys.exit(FAILED_AFTER_WRITING_EXIT)
    except Exception:
        traceback.print_exc()
        sys.exit(FAILED_AFTER_WRITING_EXIT)
    print(json.dumps({"saved_focus_areas": len(areas), "saved_asks": len(asks), "saved_rules": len(preferences),
                      "new_focus_areas": sum(1 for area in areas if area["matches"] is None) if not history else 0,
                      "dropped_previous_items": len(stale_tasks), "aged_out_items": aged_out, "dropped_carried_quotes": dropped_carried,
                      "unlinked_asks": unlinked_asks, "rules_file": story_path, "rules_not_saved_for_past_month": len(rules) if history else 0,
                      "view": f"{base_url}/#cards", "list": list_name, "history": history}))


def write_everything(base_url, list_name, previous, focus_request, writes_for, ledger_dir, preferences, history, area_count):
    """The writes, in order: My Focus areas, owner-goals rows, then rules. Everything was validated before this runs."""
    area_ids = [None] * area_count
    if focus_request is not None and focus_request["areas"]:
        area_ids = json.loads(worker_request(base_url, "/api/work-view/focus/owner-goals", focus_request, nothing_written_on=(400,)))["focusAreaIds"]
        if len(area_ids) != area_count:
            sys.exit(f"the worker answered {len(area_ids)} focus area ids for {area_count} areas")
    writes = writes_for(area_ids)
    new_tasks = {fields["task"] for fields in writes[1:]}
    stale_tasks = [item["task"] for item in previous.get("areas", []) + previous.get("asks", []) if item["task"] not in new_tasks]

    home = os.path.expanduser("~")
    for fields in writes + [{"task": task, "status": "dropped"} for task in stale_tasks]:
        reply = worker_request(base_url, "/api/work-state/entries", {"cwd": home, "list": list_name, "fields": fields})
        if not reply.startswith("Saved to"):
            sys.exit(f"work state did not save: {reply[:300]}")
    return (save_rules(ledger_dir, preferences) if not history else None), stale_tasks


if __name__ == "__main__":
    main()
