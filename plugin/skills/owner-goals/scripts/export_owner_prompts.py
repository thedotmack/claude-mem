"""Export the prompts the owner typed personally in the last N days, minus prompts an agent wrote first.

Step 1, owner-typed prompts, from the transcripts' own labels:
  Claude Code ($CLAUDE_CONFIG_DIR or ~/.claude, projects/*/*.jsonl): user messages with origin.kind == "human", entrypoint cli or
    claude-desktop, not sidechain, not meta. Agent-launched runs (claude -p, SDK, subagents, observers) never
    carry origin "human".
  Codex (~/.codex/sessions): user messages from interactive sessions only. codex_exec runs and spawned
    subagents (whose source is an object) are agent-launched and skipped.

Step 2, provenance: a prompt counts as agent-written when its opening text appears earlier in agent-authored
text (Claude Code assistant text and tool inputs, including subagent transcripts; Codex assistant messages and
function-call arguments), or when it opens with a role assignment ("You are the/a/...", "Task: ", "Branch: ")
and runs over 400 characters. Prompts that open in lowercase are kept. Long pasted material is trimmed.

Writes into --out:
  owner-prompts.md                    the owner's prompts, oldest first, headed "## YYYY-MM-DD HH:MM · tool · project"
  excluded-agent-written-prompts.md   what step 2 removed, for audit
  new-owner-prompts.md                with --since: only the prompts from that minute on, for updating a snapshot

Usage: python3 export_owner_prompts.py --out <dir> [--days 31 | --start YYYY-MM-DD --end YYYY-MM-DD] [--since "YYYY-MM-DD HH:MM"]
  --start/--end read a past period instead: from local midnight on --start up to local midnight on --end.
  --since names the previous snapshot's local generated_at minute.
"""
import argparse, calendar, glob, json, os, re, subprocess, sys, time

CODEX_INJECTED_PREFIXES = ("# AGENTS.md", "<environment_context", "<user_instructions", "<permissions", "<INSTRUCTIONS", "<turn_aborted")
MINIMUM_CHECKABLE_LENGTH = 160
FINGERPRINT_LENGTH = 120
MAXIMUM_KEPT_PROMPT_CHARACTERS = 3000
ROLE_ASSIGNMENT_OPENING = re.compile(r"(You are (the|a|an|one|on|in) |Task: |Branch: )")


# The tags claude-mem strips before anything is stored (src/utils/tag-stripping.ts TAG_NAMES). Text the owner
# marked <private> never reaches the prompts file, the refresh model or the saved goals.
MEMORY_TAG_NAMES = {"private", "claude-mem-context", "system_instruction", "system-instruction", "persisted-output", "system-reminder"}
OPEN_TAG_NAME = re.compile(r"<([A-Za-z_][A-Za-z0-9_-]*)")
CLOSE_TAG = re.compile(r"</([A-Za-z_][A-Za-z0-9_-]*)\s*>")


def strip_memory_tags(text):
    """Remove every balanced memory-tag block, the same pairing as stripBalancedMemoryTags in tag-stripping.ts:
    a close pairs with the earliest still-open tag of its name, a close inside an opener's own span is attribute
    text, and an unclosed tag in prose is left alone."""
    if "<" not in text:
        return text
    opens, removed, i = {}, [], 0
    while i < len(text):
        if text[i] != "<":
            i += 1
            continue
        close = CLOSE_TAG.match(text, i)
        if close:
            pending = opens.get(close.group(1))
            if pending and i >= pending[0][1]:
                start, _ = pending.pop(0)
                removed.append((start, close.end()))
            i = close.end()
            continue
        opener = OPEN_TAG_NAME.match(text, i)
        if opener and opener.group(1) in MEMORY_TAG_NAMES:
            greater = text.find(">", opener.end())
            opens.setdefault(opener.group(1), []).append((i, len(text) if greater < 0 else greater))
            i = opener.end()
            continue
        i += 1
    kept, cursor = [], 0
    for start, end in sorted(removed):
        if start > cursor:
            kept.append(text[cursor:start])
        cursor = max(cursor, end)
    kept.append(text[cursor:])
    return "".join(kept).strip()


def iso_to_epoch(timestamp):
    """Transcript timestamps are UTC ("...Z"); timegm reads them as UTC, with no local daylight-saving shift."""
    return calendar.timegm(time.strptime(timestamp[:19], "%Y-%m-%dT%H:%M:%S"))


# Claude Code keeps transcripts under CLAUDE_CONFIG_DIR when it is set, like claude-mem's own paths.ts.
CLAUDE_PROJECTS = os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"), "projects")


def text_of(content, text_types):
    if isinstance(content, str):
        return content
    return "\n".join(c.get("text", "") for c in content or [] if isinstance(c, dict) and c.get("type") in text_types)


def normalize(text):
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def recent_files(pattern, cutoff_seconds):
    return [path for path in glob.glob(os.path.expanduser(pattern)) if os.path.getmtime(path) >= cutoff_seconds]


def read_owner_typed_prompts(cutoff_seconds):
    """(epoch, tool, project, session, text) for every prompt the transcripts label as typed by a person."""
    prompts, seen_keys = [], set()
    for transcript_path in recent_files(os.path.join(CLAUDE_PROJECTS, "*", "*.jsonl"), cutoff_seconds):
        project_folder = os.path.basename(os.path.dirname(transcript_path))
        for line in open(transcript_path, errors="ignore"):
            if '"type":"user"' not in line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            text = strip_memory_tags(text_of(record.get("message", {}).get("content"), {"text"}).strip())
            is_owner_typed = ((record.get("origin") or {}).get("kind") == "human"
                              and record.get("entrypoint") in ("cli", "claude-desktop")
                              and not record.get("isSidechain") and not record.get("isMeta"))
            timestamp = record.get("timestamp", "")
            if not text or not is_owner_typed or not timestamp or iso_to_epoch(timestamp) < cutoff_seconds:
                continue
            dedupe_key = record.get("uuid") or (timestamp, text[:200])
            if dedupe_key in seen_keys:
                continue
            seen_keys.add(dedupe_key)
            prompts.append((iso_to_epoch(timestamp), "claude", project_folder, record.get("sessionId", "")[:8], text))

    for session_path in recent_files("~/.codex/sessions/*/*/*/*.jsonl", cutoff_seconds):
        with open(session_path, errors="ignore") as session_file:
            try:
                meta = json.loads(session_file.readline()).get("payload", {})
            except ValueError:
                continue
            is_interactive_session = (isinstance(meta.get("source"), str) and meta.get("originator") != "codex_exec"
                                      and meta.get("source") != "exec")
            if not is_interactive_session:
                continue
            project_folder = os.path.basename(meta.get("cwd") or "?")
            for line in session_file:
                if '"role":"user"' not in line.replace(" ", ""):
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                payload = record.get("payload") or {}
                if record.get("type") != "response_item" or payload.get("role") != "user":
                    continue
                text = strip_memory_tags(text_of(payload.get("content"), {"input_text"}).strip())
                timestamp = record.get("timestamp", "")
                if not text or text.startswith(CODEX_INJECTED_PREFIXES) or not timestamp or iso_to_epoch(timestamp) < cutoff_seconds:
                    continue
                dedupe_key = (meta.get("id"), timestamp, text[:200])
                if dedupe_key in seen_keys:
                    continue
                seen_keys.add(dedupe_key)
                prompts.append((iso_to_epoch(timestamp), "codex", project_folder, str(meta.get("id", ""))[:8], text))
    return sorted(prompts)


def read_agent_authored_text(cutoff_seconds):
    """(epoch, normalized text) for everything an agent wrote: assistant text, tool inputs, Codex function calls."""
    chunks = []
    claude_paths = (recent_files(os.path.join(CLAUDE_PROJECTS, "*", "*.jsonl"), cutoff_seconds)
                    + recent_files(os.path.join(CLAUDE_PROJECTS, "*", "*", "subagents", "*.jsonl"), cutoff_seconds))
    for path in claude_paths:
        for line in open(path, errors="ignore"):
            if '"type":"assistant"' not in line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            pieces = []
            for block in record.get("message", {}).get("content") or []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text":
                    pieces.append(block.get("text", ""))
                elif block.get("type") == "tool_use":
                    pieces.append(json.dumps(block.get("input", {}), ensure_ascii=False).replace("\\n", "\n").replace('\\"', '"'))
            if pieces and record.get("timestamp"):
                chunks.append((iso_to_epoch(record["timestamp"]), normalize(" ".join(pieces))))
    for path in recent_files("~/.codex/sessions/*/*/*/*.jsonl", cutoff_seconds):
        for line in open(path, errors="ignore"):
            try:
                record = json.loads(line)
            except ValueError:
                continue
            payload = record.get("payload") or {}
            if record.get("type") != "response_item" or not record.get("timestamp"):
                continue
            if payload.get("type") == "message" and payload.get("role") == "assistant":
                text = " ".join(c.get("text", "") for c in payload.get("content") or [] if isinstance(c, dict))
            elif payload.get("type") in ("function_call", "custom_tool_call"):
                text = str(payload.get("arguments") or payload.get("input") or "").replace("\\n", "\n").replace('\\"', '"')
            else:
                continue
            chunks.append((iso_to_epoch(record["timestamp"]), normalize(text)))
    return chunks


def is_agent_written(prompt_epoch, prompt_text, agent_chunks):
    normalized_prompt = normalize(prompt_text)
    # Agents do not open a prompt in lowercase; the owner usually does, so those are kept.
    if len(normalized_prompt) >= MINIMUM_CHECKABLE_LENGTH and not prompt_text[:1].islower():
        # Only the opening counts: the owner often types a line and then pastes an agent's report below it.
        fingerprint = normalized_prompt[:FINGERPRINT_LENGTH]
        if any(epoch < prompt_epoch and fingerprint in chunk for epoch, chunk in agent_chunks):
            return True
    # Launchers that hand a prompt over through a file leave no copy in any transcript; those prompts open by
    # assigning the agent a role.
    return ROLE_ASSIGNMENT_OPENING.match(prompt_text) is not None and len(prompt_text) > 400


def keep_out_of_git(out_dir):
    """Add the output folder to the checkout's local exclude file when git would otherwise track it."""
    try:
        if subprocess.run(["git", "-C", out_dir, "rev-parse", "--is-inside-work-tree"], capture_output=True).returncode != 0:
            return
        if subprocess.run(["git", "-C", out_dir, "check-ignore", "-q", "."], capture_output=True).returncode == 0:
            return
        top = subprocess.run(["git", "-C", out_dir, "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True).stdout.strip()
        exclude = subprocess.run(["git", "-C", out_dir, "rev-parse", "--git-path", "info/exclude"], capture_output=True, text=True, check=True).stdout.strip()
        exclude = exclude if os.path.isabs(exclude) else os.path.join(out_dir, exclude)
        relative = os.path.relpath(os.path.realpath(out_dir), os.path.realpath(top)).split(os.sep)[0]
        os.makedirs(os.path.dirname(exclude), exist_ok=True)
        with open(exclude, "a") as exclude_file:
            exclude_file.write(f"\n/{relative}/\n")
        print(f"added /{relative}/ to {exclude} so the map stays out of git")
    except (OSError, subprocess.CalledProcessError) as error:
        print(f"could not check git ignore status for {out_dir}: {error}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True, help="folder for owner-prompts.md (created if missing)")
    parser.add_argument("--days", type=int, default=31, help="how many days back to read (default 31)")
    parser.add_argument("--start", help="read from this day instead, YYYY-MM-DD (with --end)")
    parser.add_argument("--end", help="read up to, not including, this day, YYYY-MM-DD (with --start)")
    parser.add_argument("--since", help="also write new-owner-prompts.md with the prompts from this local minute on, YYYY-MM-DD HH:MM")
    args = parser.parse_args()
    if args.since and not re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}", args.since):
        sys.exit("--since takes a local minute, YYYY-MM-DD HH:MM")
    if bool(args.start) != bool(args.end):
        sys.exit("--start and --end go together")

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    keep_out_of_git(out_dir)
    cutoff_seconds = time.time() - args.days * 86400
    end_seconds = float("inf")
    if args.start:
        cutoff_seconds, end_seconds = (time.mktime(time.strptime(day, "%Y-%m-%d")) for day in (args.start, args.end))
        if end_seconds <= cutoff_seconds:
            sys.exit("--end must be after --start")
    window = f"{args.start} to {args.end}" if args.start else f"last {args.days} days"

    owner_typed = [prompt for prompt in read_owner_typed_prompts(cutoff_seconds) if prompt[0] < end_seconds]
    # Agent text written a little before the window can still be the source of a prompt inside it.
    agent_chunks = read_agent_authored_text(cutoff_seconds - 9 * 86400)

    owner_written, agent_written, new_since = [], [], []
    for epoch, tool, project, session, text in owner_typed:
        minute = time.strftime('%Y-%m-%d %H:%M', time.localtime(epoch))
        header = f"## {minute} · {tool} · {project}\nsession `{session}`\n\n"
        if is_agent_written(epoch, text, agent_chunks):
            agent_written.append(header + text + "\n")
            continue
        if len(text) > MAXIMUM_KEPT_PROMPT_CHARACTERS:
            trimmed = len(text) - MAXIMUM_KEPT_PROMPT_CHARACTERS
            text = text[:MAXIMUM_KEPT_PROMPT_CHARACTERS] + f"\n\n[... {trimmed} more characters, mostly pasted material, trimmed]"
        owner_written.append(header + text + "\n")
        if args.since and minute >= args.since:
            new_since.append(owner_written[-1])

    def write(filename, title, sections):
        with open(os.path.join(out_dir, filename), "w") as markdown_file:
            markdown_file.write(f"# {title}\n\n{len(sections)} prompts, oldest first.\n\n" + "\n---\n\n".join(sections))

    write("owner-prompts.md", f"Owner prompts (typed by the owner, not written by an agent), {window}", owner_written)
    write("excluded-agent-written-prompts.md", "Excluded: prompts an agent wrote first (audit file)", agent_written)
    summary = {"out": out_dir, "window": window, "owner_prompts": len(owner_written), "excluded_agent_written": len(agent_written)}
    if args.since:
        write("new-owner-prompts.md", f"Owner prompts since {args.since}", new_since)
        summary["new_prompts"] = len(new_since)
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
