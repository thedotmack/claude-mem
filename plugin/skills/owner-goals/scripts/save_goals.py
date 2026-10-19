"""Save an owner-goals snapshot to claude-mem work state, where My Work shows it as Goals.

Input is the goals JSON the map step writes:
  {
    "generated_at": "2026-10-18T23:40:00-07:00",
    "window_days": 31,
    "source_prompt_count": 823,
    "human_summary": "What the owner is trying to do this month, in a few sentences.",
    "priorities": [{"rank": 1, "title": "...", "product": "...", "latest_at": "2026-10-18 22:11",
                    "times_asked": 4, "evidence": [{"at": "2026-10-18 22:11", "quote": "the owner's exact words"}]}],
    "open_asks":  [same shape as priorities]
  }

Every evidence quote is checked against owner-prompts.md: it has to appear in a prompt headed with that
minute. Quotes may skip words with "..." between the pieces. Unverified quotes stop the save and are listed.

Storage is the "owner-goals" work-state list, written through the local worker (the same endpoint as the
work_state_write tool) under the home folder's project key so there is one list per computer:
  list state:  human_summary, generated_at, window_days, source_prompt_count, map_path, status
  one task per item: task "<Priority|Open ask>: <title>", status todo, goal_kind, rank, title, product,
                     latest_at, times_asked, evidence ("YYYY-MM-DD HH:MM | quote" per line)
Items from the previous snapshot that are not in this one are marked dropped, so a re-run replaces it.

Usage: python3 save_goals.py --goals owner-goals.json --prompts owner-prompts.md [--map owner-map.md] [--dry-run]
"""
import argparse, json, os, re, sys, urllib.error, urllib.request

LIST_NAME = "owner-goals"
MAX_FIELDS_JSON_CHARS = 2000  # MAX_WORK_STATE_FIELDS_JSON_CHARS in WorkStateRoutes.ts
MAX_QUOTE_CHARS = 240
KIND_LABELS = {"priority": "Priority", "open-ask": "Open ask"}


def worker_base_url():
    data_dir = os.environ.get("CLAUDE_MEM_DATA_DIR") or os.path.expanduser("~/.claude-mem")
    settings = {}
    try:
        with open(os.path.join(data_dir, "settings.json")) as settings_file:
            settings = json.load(settings_file)
    except (OSError, ValueError):
        pass
    port = os.environ.get("CLAUDE_MEM_WORKER_PORT") or settings.get("CLAUDE_MEM_WORKER_PORT") or str(37700 + (os.getuid() if hasattr(os, "getuid") else 77) % 100)
    host = os.environ.get("CLAUDE_MEM_WORKER_HOST") or settings.get("CLAUDE_MEM_WORKER_HOST") or "127.0.0.1"
    host = "127.0.0.1" if host in ("0.0.0.0", "::") else host
    return f"http://{host}:{port}"


def worker_request(base_url, path, body=None):
    request = urllib.request.Request(base_url + path, method="POST" if body is not None else "GET",
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json"} if body is not None else {})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read().decode()
    except urllib.error.HTTPError as error:
        sys.exit(f"worker refused {path}: {error.code} {error.read().decode()[:500]}")
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


def unverified_quotes(goals, prompts):
    problems = []
    for kind_key in ("priorities", "open_asks"):
        for item in goals.get(kind_key, []):
            for quote in item.get("evidence", []):
                at, text = str(quote.get("at", "")), str(quote.get("quote", ""))
                prompt = prompts.get(at[:16])
                pieces = [comparable(piece).strip(" .,;:!?\"'") for piece in re.split(r"\.\.\.|…", text)]
                pieces = [piece for piece in pieces if len(piece) >= 3]
                if prompt is None:
                    problems.append(f'{item.get("title")}: no owner prompt at {at!r}')
                elif not pieces or any(piece not in prompt for piece in pieces):
                    problems.append(f'{item.get("title")}: quote not in the {at} prompt: "{text}"')
    return problems


def item_fields(kind, item, snapshot):
    title = str(item["title"]).strip()
    evidence = [f'{str(q["at"])[:16]} | {re.sub(r"\s+", " ", str(q["quote"])).strip()[:MAX_QUOTE_CHARS]}' for q in item.get("evidence", [])]
    fields = {
        "task": f"{KIND_LABELS[kind]}: {title}", "status": "todo", "goal_kind": kind,
        "rank": item.get("rank"), "title": title, "product": item.get("product"),
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


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--goals", required=True, help="owner-goals.json from the map step")
    parser.add_argument("--prompts", required=True, help="owner-prompts.md the map was built from")
    parser.add_argument("--map", help="owner-map.md, recorded on the list so the full map can be found")
    parser.add_argument("--dry-run", action="store_true", help="validate and print the writes without saving")
    args = parser.parse_args()

    goals = json.load(open(args.goals))
    items = [("priority", item) for item in goals.get("priorities", [])] + [("open-ask", item) for item in goals.get("open_asks", [])]
    missing = [f'{kind} {item.get("title")!r}' for kind, item in items if not item.get("title") or not item.get("evidence")]
    if not items or missing:
        sys.exit("every priority and open ask needs a title and at least one evidence quote: " + ", ".join(missing or ["no items"]))
    problems = unverified_quotes(goals, prompts_by_minute(args.prompts))
    if problems:
        sys.exit("these quotes are not the owner's words at that time; fix them in the goals JSON:\n- " + "\n- ".join(problems))

    snapshot = str(goals.get("generated_at") or "")
    state_fields = {
        "human_summary": str(goals.get("human_summary") or "")[:1500] or None, "generated_at": snapshot or None,
        "window_days": goals.get("window_days"), "source_prompt_count": goals.get("source_prompt_count"),
        "map_path": os.path.abspath(args.map) if args.map else None, "status": "open",
    }
    writes = [state_fields] + [item_fields(kind, item, snapshot) for kind, item in items]
    new_tasks = {fields["task"] for fields in writes[1:]}
    if len(new_tasks) != len(writes) - 1:
        sys.exit("two items share a title; give each priority and open ask its own title")

    base_url = worker_base_url()
    if args.dry_run:
        print(json.dumps(writes, indent=2))
        return
    view = json.loads(worker_request(base_url, "/api/work-view"))
    if "goals" not in view:
        sys.exit("this claude-mem worker predates Goals; update claude-mem and restart the worker")
    previous = view["goals"] or {}
    stale_tasks = [item["task"] for item in previous.get("priorities", []) + previous.get("openAsks", []) if item["task"] not in new_tasks]

    home = os.path.expanduser("~")
    for fields in writes + [{"task": task, "status": "dropped"} for task in stale_tasks]:
        reply = worker_request(base_url, "/api/work-state/entries", {"cwd": home, "list": LIST_NAME, "fields": fields})
        if not reply.startswith("Saved to"):
            sys.exit(f"work state did not save: {reply[:300]}")
    print(json.dumps({"saved_items": len(writes) - 1, "dropped_previous_items": len(stale_tasks),
                      "view": f"{base_url}/#cards", "list": LIST_NAME}))


if __name__ == "__main__":
    main()
