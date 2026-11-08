#!/usr/bin/env zsh
# Fork audit: after a turn, ask a fork of the agent's session three questions (the project goal, what we are working on
# now, what is up next) and append the answer to $EMV_STACK/logs/audits.jsonl as one JSON line:
#   {turn, time, goal, now, next, ok, error, secs, tokens, cost_usd, cost_source}
# A failed audit is a line with ok:false and the error; the raw output stays in logs/audits/t<turn>.{out,err}.
#
# Usage: fork-audit.sh <config> <turn> [snapshot|ask]   (same env as agent-turn.sh; no phase = both, in the foreground)
#   snapshot  copy the session store into $EMV_STACK/audit-work/t<turn>/. Run it while the agent is stopped (session.sh
#             runs it right after the turn, before the next one starts).
#   ask       ask the copy, write the line, delete the copy. Touches nothing of the main session, so it can run in the
#             background while the next turn runs.
#
# The main session is never touched: everything runs on a copy of its session store in the work dir, with its own HOME
# and config dir there. SQLite stores are copied with SQLite's backup API from a read-only connection (WAL-safe; a
# read-only connection never checkpoints the original). Model requests go straight to OpenRouter, never this stack's
# tee, gateway or worker (those would count in the measured cost, and the worker could store memories from them), with
# no claude-mem plugin, hook or MCP server and nothing that can write to proj:
#   claude    native fork of the copied transcript (--resume <id> --fork-session), no tools
#   codex     native fork of the copied rollout (`codex exec fork <id>`), read-only sandbox
#   openclaw  no fork command: the copied state dir is resumed (same session id), every tool denied
#   hermes    no fork command, and a copy cannot be resumed: Hermes binds each session to its home's path (a copy is
#             refused with profile_mismatch, measured 2026-11-07) and freezes the launch config per session, base URL
#             (this stack's tee) and toolsets included, so even a rewritten copy would not be safe. Instead Hermes's own
#             loader (SessionDB.get_messages_as_conversation, read-only, on the copy) rebuilds the conversation exactly
#             as a resume would, and that plus the stored system prompt and the question goes to OpenRouter's chat
#             completions with no tools, pinned to the card's endpoint like the tee pins the main session.
# Claude Code, Codex and OpenClaw choose their own request body, so their forks are not pinned: OpenRouter may route
# them to another provider of the same model. cost_usd is OpenRouter's billed cost where it is reported (OpenClaw,
# Hermes), else the agent's token counts at the frozen card's prices (cost_source says which).
source ${0:A:h}/lib/env.sh || exit
config=${1:?usage: fork-audit.sh <config> <turn> [snapshot|ask]}; turn=${2:?usage: fork-audit.sh <config> <turn> [snapshot|ask]}; phase=${3:-both}
emv_use_stack $config || exit
W=$EMV_STACK/audit-work/t$turn; A=$EMV_STACK/logs/audits; mkdir -p $A
out=$A/t$turn.out; err=$A/t$turn.err
# One audit has one model answer to give and no tools. Reason for 300 s: forks measured 1-36 s (snapshot to answer) in
# the 2026-11-07 tests on 3-turn sessions; a 1M-token session's uncached prefill takes far longer, and a hung fork must
# not keep its copy and process for the rest of the run. A hit limit is an ok:false line (timeout's exit code 124).
limit=300

QUESTION='Harness audit, not a task: do not use any tool and do not change anything. From this conversation alone, answer in exactly three lines, one sentence each, and nothing else:
GOAL: <the goal of the project>
NOW: <what we are working on now>
NEXT: <what is up next>'

# copy_store <src dir> <dst dir> <only|except> <top-level names or globs...>: the files under src, keeping only the
# named top-level entries or leaving them out. SQLite files go through the backup API (their -wal/-shm are not copied:
# the backup carries the committed content).
copy_store() {
  python3 - "$@" <<'PY'
import fnmatch, os, shutil, sqlite3, stat, sys
src, dst, mode, patterns = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
named = lambda name: any(fnmatch.fnmatch(name, pattern) for pattern in patterns)
keep = (lambda name: named(name)) if mode == 'only' else (lambda name: not named(name))
for root, dirs, files in os.walk(src):
    rel = os.path.relpath(root, src)
    if rel == '.':
        dirs[:] = [d for d in dirs if keep(d)]; files = [f for f in files if keep(f)]
    os.makedirs(os.path.join(dst, rel), exist_ok=True)
    for name in files:
        s, d = os.path.join(root, name), os.path.join(dst, rel, name)
        if not stat.S_ISREG(os.stat(s).st_mode) or name.endswith(('-wal', '-shm', '-journal')): continue
        with open(s, 'rb') as f: is_sqlite = f.read(16) == b'SQLite format 3\x00'
        if is_sqlite:
            source = sqlite3.connect(f'file:{s}?mode=ro', uri=True); copy = sqlite3.connect(d)
            source.backup(copy); copy.close(); source.close()
        else:
            shutil.copy2(s, d)
PY
}

snapshot() {
  rm -rf $W; mkdir -p $W/home
  date +%s > $W/start
  [[ $EMV_MODEL_PROFILE == openrouter-deepseek-flash ]] || { print -r -- "fork audit runs on the openrouter-deepseek-flash profile only" > $W/snapshot.err; return 1; }
  local sidfile=$EMV_STACK/logs/session.sid
  [[ -s $sidfile ]] || { print -r -- "no session id in $sidfile (the turn failed before the agent started a session)" > $W/snapshot.err; return 1; }
  cp $sidfile $W/sid
  local sid=$(<$W/sid) store
  case $EMV_AGENT in
    claude)
      store=($CLAUDE_CONFIG_DIR/projects/*/$sid.jsonl(N))
      (( ${#store} == 1 )) || { print -r -- "expected one transcript $sid.jsonl under $CLAUDE_CONFIG_DIR/projects, found ${#store}" > $W/snapshot.err; return 1; }
      copy_store ${store[1]:h} $W/claude-config/projects/${store[1]:h:t} except ;;
    codex)
      # The rollout files only. Codex's SQLite state records each rollout's absolute path in the main CODEX_HOME, and
      # Codex refuses a path outside its home (measured 2026-11-07), so the fork indexes the copied rollouts itself.
      copy_store $CODEX_HOME $W/codex-home only sessions ;;
    hermes)
      # Only the session store: the rest of HERMES_HOME is tools, caches, plugins and the background gateway's runtime
      # state (its pid and lock files would point the fork at the main session's live gateway).
      [[ -f $HERMES_HOME/state.db ]] || { print -r -- "no $HERMES_HOME/state.db" > $W/snapshot.err; return 1; }
      copy_store $HERMES_HOME $W/hermes-home only state.db ;;
    openclaw)
      copy_store $OPENCLAW_STATE_DIR $W/openclaw-state except cache tmp plugin-skills extensions openclaw.json ;;
  esac || { print -r -- "copying the $EMV_AGENT session store failed" >> $W/snapshot.err; return 1; }
}

# The agent's command on the copy. Prints nothing; output goes to $out and $err.
ask_agent() {
  local sid=$(<$W/sid) base=$EMV_OPENROUTER_ANTHROPIC_BASE
  emv_read_openrouter_key 2> $err || return
  # Nothing of the stack's claude-mem or of the main agent's homes reaches the fork.
  local -a fork_env=(env -u OPENROUTER_API_KEY -u ANTHROPIC_BASE_URL -u CLAUDE_MEM_WORKER_PORT -u CLAUDE_MEM_WORKER_HOST
    -u CLAUDE_MEM_OPENROUTER_API_KEY -u CLAUDE_MEM_DATA_DIR HOME=$W/home XDG_CONFIG_HOME=$W/home/.config
    XDG_DATA_HOME=$W/home/.local/share XDG_CACHE_HOME=$W/home/.cache XDG_STATE_HOME=$W/home/.local/state)
  cd $EMV_STACK/proj
  case $EMV_AGENT in
    claude)
      # The stack's own settings minus everything that loads plugins or hooks, with the base URL at OpenRouter.
      jq --arg b $base '{env: ((.env // {}) + {ANTHROPIC_BASE_URL: $b}), claudeMdExcludes}' \
        $CLAUDE_CONFIG_DIR/settings.json > $W/claude-config/settings.json || return
      $fork_env CLAUDE_CONFIG_DIR=$W/claude-config ANTHROPIC_AUTH_TOKEN=$EMV_OPENROUTER_KEY ANTHROPIC_API_KEY='' \
        timeout $limit $EMV_CLAUDE_BIN -p "$QUESTION" --resume $sid --fork-session --tools '' --strict-mcp-config \
        --setting-sources user --model $(emv_claude_model) --output-format json < /dev/null > $out 2> $err ;;
    codex)
      cat > $W/codex-home/config.toml <<TOML
model = "$EMV_OPENROUTER_MODEL"
model_provider = "emv-openrouter"

[model_providers.emv-openrouter]
name = "emv-openrouter"
base_url = "$base/v1"
wire_api = "responses"

[model_providers.emv-openrouter.auth]
command = "sh"
args = ["-c", "printf %s \"\$EMV_UPSTREAM_KEY\""]

[features]
hooks = false
plugin_hooks = false

[projects."$EMV_STACK/proj"]
trust_level = "trusted"
TOML
      $fork_env CODEX_HOME=$W/codex-home EMV_UPSTREAM_KEY=$EMV_OPENROUTER_KEY \
        timeout $limit $EMV_CODEX_BIN exec --skip-git-repo-check -s read-only --json fork $sid "$QUESTION" \
        < /dev/null > $out 2> $err ;;
    hermes)
      # Hermes's venv runs its own loader; the request and its answer are plain JSON (see the header for why).
      $fork_env HERMES_HOME=$W/hermes-home EMV_UPSTREAM_KEY=$EMV_OPENROUTER_KEY \
        timeout $limit ${EMV_HERMES_BIN:h}/python -I - $W/hermes-home/state.db $sid ${EMV_HERMES_BIN:h:h:h} "$base/v1" \
        $EMV_OPENROUTER_MODEL $(emv_pin_provider) $limit "$QUESTION" > $out 2> $err <<'PY'
import json, os, sys, urllib.error, urllib.request
from pathlib import Path
db_path, sid, hermes_src, base, model, pin, limit, question = sys.argv[1:9]
sys.path.insert(0, hermes_src)
from hermes_state import SessionDB
db = SessionDB(Path(db_path), read_only=True)
session = db.get_session(sid)
if not session: sys.exit(f'session {sid} is not in the copied state.db')
# The live-replay load a resume does; only the chat-completions fields go out (the rest is Hermes's bookkeeping).
conversation = db.get_messages_as_conversation(sid, include_ancestors=True, repair_alternation=True)
def api(m):
    out = {k: m[k] for k in ('role', 'content', 'tool_call_id') if k in m}
    if m.get('tool_calls'): out['tool_calls'] = [{k: c[k] for k in ('id', 'type', 'function')} for c in m['tool_calls']]
    return out
messages = [{'role': 'system', 'content': session['system_prompt']}] + [api(m) for m in conversation] + [{'role': 'user', 'content': question}]
body = {'model': model, 'messages': messages, 'usage': {'include': True}, 'provider': {'order': [pin], 'allow_fallbacks': False}}
request = urllib.request.Request(base + '/chat/completions', data=json.dumps(body).encode(), headers={
    'Authorization': 'Bearer ' + os.environ['EMV_UPSTREAM_KEY'], 'Content-Type': 'application/json'})
try:
    answer = json.load(urllib.request.urlopen(request, timeout=int(limit)))
except urllib.error.HTTPError as e:
    sys.exit(f'OpenRouter HTTP {e.code}: {e.read().decode(errors="replace")}')
choice = (answer.get('choices') or [{}])[0]
json.dump(dict(reply=(choice.get('message') or {}).get('content'), finish_reason=choice.get('finish_reason'),
               usage=answer.get('usage'), provider=answer.get('provider'), model=answer.get('model'), error=answer.get('error')), sys.stdout)
PY
      ;;
    openclaw)
      local stack_config=$OPENCLAW_CONFIG_PATH
      # skipBootstrap: the fork must not write OpenClaw's workspace files into proj.
      jq --arg b "$base/v1" 'del(.plugins) | .models.providers["emv-openrouter"].baseUrl = $b | .tools = {deny: ["*"]}
        | .agents.defaults.skipBootstrap = true' $stack_config > $W/openclaw-state/openclaw.json || return
      $fork_env OPENCLAW_STATE_DIR=$W/openclaw-state OPENCLAW_CONFIG_PATH=$W/openclaw-state/openclaw.json \
        EMV_UPSTREAM_KEY=$EMV_OPENROUTER_KEY PATH=${EMV_OPENCLAW_NODE_DIR:+$EMV_OPENCLAW_NODE_DIR:}$PATH \
        timeout $limit $EMV_OPENCLAW_BIN agent --local --agent main --session-id $sid --timeout $limit --json -m "$QUESTION" \
        < /dev/null > $out 2> $err ;;
  esac
}

# write_line <rc> [error]: parse the agent's output and append the audit line.
write_line() {
  local start; [[ -f $W/start ]] && start=$(<$W/start) || start=$(date +%s)
  python3 - $EMV_AGENT $turn $1 "${2:-}" $start $out $err $EMV_CARD $limit $EMV_STACK/logs/audits.jsonl $W <<'PY'
import glob, json, os, re, sys, time
agent, turn, rc, error, start, out, err, card, limit, dest, work = sys.argv[1:12]
line = dict(turn=int(turn), time=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), goal=None, now=None, next=None,
            ok=False, error=error or None, secs=int(time.time()) - int(start), tokens=None, cost_usd=None, cost_source=None)
read = lambda p: open(p, errors='replace').read() if os.path.exists(p) else ''
reply, tokens, billed = None, None, None
raw = read(out)
try:
    if agent == 'claude':
        r = json.loads(raw); r = r[-1] if isinstance(r, list) else r
        reply = r.get('result')
        if r.get('is_error'): error = error or f"agent error: {reply}"
        # `usage` is this invocation's sum; `modelUsage` and `total_cost_usd` add up the whole resumed session
        # (measured 2026-11-07: turn 2's `usage` equals the turn 1 -> 2 growth of `modelUsage`).
        u = r.get('usage')
        if u: tokens = dict(input=u.get('input_tokens', 0), cache_read=u.get('cache_read_input_tokens', 0),
                            cache_write=u.get('cache_creation_input_tokens', 0), output=u.get('output_tokens', 0))
    elif agent == 'codex':
        for l in raw.splitlines():
            try: d = json.loads(l)
            except ValueError: continue
            it = d.get('item') or {}
            if d.get('type') == 'item.completed' and it.get('type') == 'agent_message': reply = it.get('text')
            if d.get('type') == 'turn.completed':
                # The thread's running total, which a fork starts from the parent's (measured 2026-11-07): the fork's
                # own usage is that minus the parent's last total_token_usage in the copied rollout.
                u = d.get('usage') or {}; parent = {}
                sid = open(os.path.join(work, 'sid')).read().strip()
                for rollout in glob.glob(os.path.join(work, 'codex-home', 'sessions', '**', f'rollout-*{sid}.jsonl'), recursive=True):
                    for l2 in open(rollout):
                        p = (json.loads(l2).get('payload') or {})
                        if p.get('type') == 'token_count' and p.get('info'): parent = p['info']['total_token_usage']
                own = {k: u.get(k, 0) - parent.get(k, 0) for k in ('input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens')}
                tokens = dict(input=own['input_tokens'] - own['cached_input_tokens'], cache_read=own['cached_input_tokens'],
                              cache_write=own['cache_write_input_tokens'], output=own['output_tokens'])
            if d.get('type') in ('error', 'turn.failed'): error = error or 'agent error: ' + json.dumps(d)
    elif agent == 'hermes':
        d = json.loads(raw)
        reply = d.get('reply')
        if d.get('error'): error = error or 'OpenRouter error: ' + json.dumps(d['error'])
        u = d.get('usage') or {}
        if u:
            cached = (u.get('prompt_tokens_details') or {}).get('cached_tokens') or 0
            tokens = dict(input=u.get('prompt_tokens', 0) - cached, cache_read=cached,
                          cache_write=(u.get('prompt_tokens_details') or {}).get('cache_write_tokens') or 0, output=u.get('completion_tokens', 0))
            if u.get('cost') is not None: billed = u['cost']
    elif agent == 'openclaw':
        d = json.loads(raw[raw.find('{'):])
        body = d.get('result') if isinstance(d.get('result'), dict) else d
        reply = '\n'.join(p.get('text') or '' for p in body.get('payloads') or []).strip()
        meta = body.get('meta') or {}
        if meta.get('error') or meta.get('aborted'): error = error or 'agent error: ' + json.dumps(meta.get('error') or 'aborted')
        u = (meta.get('agentMeta') or {}).get('usage') or {}
        if u:
            tokens = dict(input=u.get('input', 0), cache_read=u.get('cacheRead', 0), cache_write=u.get('cacheWrite', 0), output=u.get('output', 0))
            if (u.get('cost') or {}).get('totalOrigin') == 'provider-billed': billed = u['cost'].get('total')
except Exception as e:
    error = error or f'unreadable agent output ({type(e).__name__}: {e})'
if rc == '124': error = error or f'timed out after {limit} s'
elif rc != '0': error = error or f'agent exited {rc}'
if tokens:
    line['tokens'] = tokens
    if billed is not None: line['cost_usd'], line['cost_source'] = billed, 'openrouter-billed'
    else:
        p = json.load(open(card))
        line['cost_usd'] = round((tokens['input'] * p['input'] + tokens['cache_read'] * p['cache_read'] + tokens['cache_write'] * p['cache_write_5m'] + tokens['output'] * p['output']) / 1e6, 8)
        line['cost_source'] = 'card-estimate'
fields = {}
for l in (reply or '').splitlines():
    m = re.match(r'^[\s*_#>-]*(GOAL|NOW|NEXT)[*_]*\s*:[*_]*\s*(.+?)\s*$', l, re.I)
    if m and m.group(1).upper() not in fields: fields[m.group(1).upper()] = m.group(2)
line['goal'], line['now'], line['next'] = fields.get('GOAL'), fields.get('NOW'), fields.get('NEXT')
if not error and len(fields) < 3:
    error = 'reply is not the three GOAL/NOW/NEXT lines' if reply else 'no reply'
if error:
    line['error'] = error
    if reply: line['reply'] = reply
    stderr_tail = read(err).strip().splitlines()[-5:]
    if stderr_tail: line['stderr_tail'] = stderr_tail
else:
    line['ok'], line['error'] = True, None
with open(dest, 'a') as f: f.write(json.dumps(line) + '\n')
print(json.dumps(line))
PY
}

ask() {
  local rc
  if [[ ! -d $W ]]; then write_line skipped "no snapshot at $W (run the snapshot phase first)"; return; fi
  if [[ -s $W/snapshot.err ]]; then write_line skipped "snapshot failed: $(<$W/snapshot.err)"
  elif ! command -v timeout > /dev/null; then write_line skipped "timeout(1) not found (install coreutils)"
  else
    ask_agent; rc=$?
    write_line $rc
  fi
  rm -rf $W
}

case $phase in
  snapshot) snapshot ;;
  ask) ask ;;
  both) snapshot; ask ;;
  *) echo "usage: fork-audit.sh <config> <turn> [snapshot|ask]" >&2; exit 2 ;;
esac
exit 0
