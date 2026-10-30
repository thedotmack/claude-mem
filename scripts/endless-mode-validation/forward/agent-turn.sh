#!/usr/bin/env zsh
# One agent turn in the current stack (call with EMV_CONFIG set, from session.sh).
# Usage: agent-turn.sh <label> <prompt> <first|resume>
# Prints one "rc=… secs=… error=… sid=…" line, then the first 300 characters of the reply.
#
# Claude Code: print mode, no plugins (capture is the gateway's). The credential goes into the agent's environment
# only. Under the anthropic profile the claude.ai token is read again before every turn, and a turn that fails
# (non-zero exit or is_error, e.g. the token was rotated mid-turn) is resumed once in the same session with the same
# prompt after reading the token again; the failed attempt is kept as <label>.attempt1.json and a "turn-retry:" line
# is printed.
source ${0:A:h}/lib/env.sh || exit
source $EMV_FORWARD_DIR/lib/claude-token.sh
emv_use_stack ${EMV_CONFIG:?} || exit
label=$1; prompt=$2; mode=$3; T=$EMV_STACK/logs/turns; mkdir -p $T
sidfile=$EMV_STACK/logs/session.sid
cd $EMV_STACK/proj
start=$(date +%s)

if [[ $EMV_AGENT == codex ]]; then
  if [[ $mode == resume ]]; then set -- exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --json resume --last "$prompt"
  else set -- exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --json "$prompt"; fi
  $EMV_CODEX_BIN "$@" < /dev/null > $T/$label.jsonl 2> $T/$label.err; rc=$?
  python3 - $T/$label.jsonl $rc $(( $(date +%s) - start )) $sidfile <<'PY'
import json, sys
thread = None; last = None; errs = []; usage = None
for l in open(sys.argv[1]):
    try: d = json.loads(l)
    except Exception: continue
    t = d.get('type'); it = d.get('item') or {}
    if t == 'thread.started': thread = d.get('thread_id')
    if t == 'item.completed' and it.get('type') == 'agent_message': last = it.get('text')
    if t == 'turn.completed': usage = d.get('usage')
    if t in ('error', 'turn.failed'): errs.append(json.dumps(d)[:300])
if thread: open(sys.argv[4], 'w').write(thread)
print('rc=%s secs=%s error=%s sid=%s usage=%s' % (sys.argv[2], sys.argv[3], bool(errs) or sys.argv[2] != '0', thread, json.dumps(usage)))
print((last or '').replace('\n', ' ')[:300])
PY
  exit 0
fi

credentials() {
  if [[ $EMV_MODEL_PROFILE == openrouter-deepseek-flash ]]; then
    emv_read_openrouter_key || exit; export ANTHROPIC_AUTH_TOKEN=$EMV_OPENROUTER_KEY ANTHROPIC_API_KEY=''
  else
    emv_read_claude_token || exit; [[ -n $EMV_CLAUDE_TOKEN ]] && export CLAUDE_CODE_OAUTH_TOKEN=$EMV_CLAUDE_TOKEN
  fi
}
run_claude() {
  $EMV_CLAUDE_BIN -p "$prompt" "$@" --model $(emv_claude_model) --dangerously-skip-permissions --output-format json \
    < /dev/null > $T/$label.json 2> $T/$label.err
}
failed_session() {  # the session id of a failed attempt, '' when it succeeded, 'unparsable' when the output is not JSON
  python3 - $T/$label.json $1 <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1])); r = d[-1] if isinstance(d, list) else d
    print(r.get('session_id') if (sys.argv[2] != '0' or r.get('is_error')) else '')
except Exception:
    print('unparsable' if sys.argv[2] != '0' else '')
PY
}
credentials
resume=(); [[ $mode == resume ]] && resume=(--resume $(<$sidfile))
run_claude $resume; rc=$?
failed=$(failed_session $rc)
if [[ -n $failed ]]; then
  [[ $failed == unparsable ]] && failed=${resume[2]:-}
  mv $T/$label.json $T/$label.attempt1.json; mv $T/$label.err $T/$label.attempt1.err
  credentials
  echo "turn-retry: $(date +%T) first attempt failed (rc=$rc); resuming session ${failed:-new} with the same prompt"
  [[ -n $failed ]] && resume=(--resume $failed)
  run_claude $resume; rc=$?
fi
python3 - $T/$label.json $rc $(( $(date +%s) - start )) $sidfile <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1])); r = d[-1] if isinstance(d, list) else d
    if r.get('session_id'): open(sys.argv[4], 'w').write(r['session_id'])
    print('rc=%s secs=%s error=%s turns=%s sid=%s cost=%s' % (sys.argv[2], sys.argv[3], r.get('is_error'), r.get('num_turns'), r.get('session_id'), r.get('total_cost_usd')))
    print((r.get('result') or '').replace('\n', ' ')[:300])
except Exception as e:
    print('rc=%s secs=%s error=True unparsable output: %s' % (sys.argv[2], sys.argv[3], e))
PY
tail -3 $T/$label.err
