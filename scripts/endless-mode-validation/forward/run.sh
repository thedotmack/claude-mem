#!/usr/bin/env zsh
# A forward run: the same scripted session, N turns, in each configuration side by side, each in its own isolated
# stack; then stats, tables and the judges' artifacts.
#
# Usage: scripts/endless-mode-validation/forward/run.sh <turns> [configs...]   (configs default: none off timeline observation; also: release)
# Env: see lib/env.sh (EMV_RUN_NAME, EMV_PROMPTS [prompts200.txt; prompts500.txt for 500 turns], EMV_AGENT, EMV_MODEL_PROFILE, EMV_CLAUDE_BIN, ...). Also:
#   EMV_FIRST_TURN  continue an existing run (same EMV_RUN_NAME) from this turn [1]; `auto`: each configuration from the turn after
#                   its own last finished one (a budget stop leaves them at different turns). A continued run clears the old budget stop.
#   EMV_BUDGET_USD  openrouter-deepseek-flash only: stop every configuration after the slowest one's current turn once the key's total
#                   OpenRouter spend reaches this many USD (budget-watch.sh) [unset: no stop]
#   EMV_KEEP_INSTALLS  set to keep each stack's installs after a clean finish, to continue the run to more turns later.
#                   [unset: a run that finishes with no failure and no budget stop removes them (lib/prune-installs.sh);
#                   a failed or budget-stopped run always keeps them, so it can be continued]
#   EMV_PRICES      prices file for the tables [by profile: prices/anthropic-claude-opus-5-5.json, prices/openai-gpt-6.1-sol.json,
#                   or the frozen card EMV_CARD for openrouter-deepseek-flash]
# Output: $EMV_RUN_DIR/results/{<config>.json, tables.md, real-configs-before.txt, real-configs-after.txt}
#         $EMV_RUN_DIR/artifacts/<config>/{turns.jsonl, snapshots/}  (for the blind judges; contains the agent's replies)
source ${0:A:h}/lib/env.sh || exit
turns=${1:?usage: run.sh <turns> [configs...]}; shift
configs=("$@"); (( ${#configs} )) || configs=($EMV_DEFAULT_CONFIGS)
first=${EMV_FIRST_TURN:-1}
R=$EMV_RUN_DIR/results; mkdir -p $R $EMV_RUN_DIR/logs
L=$EMV_RUN_DIR/logs/run.log
say() { echo "$(date -u +%FT%TZ) $*" | tee -a $L; }

# Preflight: fail before anything starts.
for tool in python3 jq git curl lsof shasum tar; do command -v $tool >/dev/null || { echo "missing: $tool" >&2; exit 2; }; done
[[ -x $EMV_BUN ]] || { echo "bun not found (set EMV_BUN)" >&2; exit 2; }
if [[ $EMV_AGENT == codex ]]; then [[ -x $EMV_CODEX_BIN ]] || { echo "codex not found (set EMV_CODEX_BIN)" >&2; exit 2; }
elif [[ $EMV_AGENT == hermes ]]; then [[ -x $EMV_HERMES_BIN ]] || { echo "hermes not found (set EMV_HERMES_BIN)" >&2; exit 2; }
elif [[ $EMV_AGENT == openclaw ]]; then [[ -x $EMV_OPENCLAW_BIN ]] || { echo "openclaw not found (set EMV_OPENCLAW_BIN)" >&2; exit 2; }
else [[ -x $EMV_CLAUDE_BIN ]] || { echo "claude not found (set EMV_CLAUDE_BIN)" >&2; exit 2; }; fi
if [[ $EMV_AGENT == claude ]] && head -c 2 $EMV_CLAUDE_BIN | grep -q '#!'; then
  echo "warning: $EMV_CLAUDE_BIN is a script; if it rewrites HOME or CLAUDE_CONFIG_DIR the isolation fails. Set EMV_CLAUDE_BIN to the real binary." >&2
fi
emv_check_profile || exit
python3 $EMV_FORWARD_DIR/check-prompts.py $EMV_PROMPTS >&2 || { echo "$EMV_PROMPTS refers to turns by number; reword those prompts by content" >&2; exit 2; }
[[ $first == auto ]] && rm -f $EMV_RUN_DIR/logs/budget-stop-turn
[[ $first == 1 || ! -e $EMV_RUN_DIR/logs/installs-pruned ]] || { echo "$EMV_RUN_DIR finished and its installs were removed, so it cannot be continued; start a new run (EMV_KEEP_INSTALLS keeps them)" >&2; exit 2; }
[[ ! -d $EMV_RUN_DIR/stacks || $first != 1 ]] || { echo "$EMV_RUN_DIR already has stacks; pick a new EMV_RUN_NAME, or set EMV_FIRST_TURN to continue" >&2; exit 2; }

say "run $EMV_RUN_NAME: turns $first-$turns, configs ${configs[*]}, agent $EMV_AGENT, profile $EMV_MODEL_PROFILE, model $([[ $EMV_AGENT == codex && $EMV_MODEL_PROFILE != openrouter-deepseek-flash ]] && echo $EMV_CODEX_MODEL || emv_claude_model), pin $([[ $EMV_MODEL_PROFILE == openrouter-deepseek-flash ]] && emv_pin_provider || echo none), commit $(git -C $EMV_REPO_ROOT rev-parse --short HEAD)"
zsh $EMV_FORWARD_DIR/lib/real-configs.sh snapshot $R/real-configs-before-$first.txt

stop=$EMV_RUN_DIR/logs/stop-$first; rm -f $stop
cleanup() {
  touch $stop
  for c in $configs; do zsh $EMV_FORWARD_DIR/stop-stack.sh $c >> $L 2>&1; done
}
trap 'say interrupted; cleanup; exit 130' INT TERM

for c in $configs; do
  if [[ $first == 1 ]]; then
    zsh $EMV_FORWARD_DIR/setup-stack.sh $c 2>&1 | tee -a $L
    (( ${pipestatus[1]} == 0 )) || exit 1
  fi
  zsh $EMV_FORWARD_DIR/start-stack.sh $c 2>&1 | tee -a $L
  (( ${pipestatus[1]} == 0 )) || { cleanup; exit 1; }
done
tee_dirs=(); for c in $configs; do tee_dirs+=($EMV_RUN_DIR/stacks/$c/tee-anthropic $EMV_RUN_DIR/stacks/$c/tee-codex); done
zsh $EMV_FORWARD_DIR/netwatch.sh $EMV_RUN_DIR/logs/netwatch.log $stop &
python3 $EMV_FORWARD_DIR/extract.py $stop $tee_dirs 2>> $EMV_RUN_DIR/logs/extract.err &
extractor=$!
[[ $EMV_MODEL_PROFILE == anthropic && $EMV_AGENT == claude && -z $EMV_CLAUDE_OAUTH_TOKEN ]] && zsh $EMV_FORWARD_DIR/token-watch.sh $stop $configs &
[[ $EMV_MODEL_PROFILE == openrouter-deepseek-flash && -n $EMV_BUDGET_USD ]] && zsh $EMV_FORWARD_DIR/budget-watch.sh $stop $configs &

say "sessions start"
session_pids=()
for c in $configs; do
  from=$first
  if [[ $first == auto ]]; then
    last_done=$(grep -o 'turn [0-9]* done' $EMV_RUN_DIR/stacks/$c/logs/session.log | tail -1 | awk '{print $2}')
    from=$(( ${last_done:?no finished turn in $c to continue from} + 1 ))
  fi
  say "$c: turns $from-$turns"
  zsh $EMV_FORWARD_DIR/session.sh $c $from $turns > $EMV_RUN_DIR/stacks/$c/logs/session-$from-$turns.out 2>&1 & session_pids+=($!)
  # Staggered starts. Reason: pinning removes provider fallback, so sessions that fire their first requests together on
  # one endpoint are the likeliest source of 429s. 20 s spreads three configurations across about one rate-limit minute.
  sleep ${EMV_STACK_STAGGER_SECONDS:-20}
done
failed=0; for p in $session_pids; do wait $p || (( failed++ )); done
say "sessions done ($failed failed)"
touch $stop; wait $extractor
cleanup
# Codex's answers name no provider: settle any the tee could not confirm during the run.
if [[ $EMV_AGENT == codex && $EMV_MODEL_PROFILE == openrouter-deepseek-flash ]]; then
  for c in $configs; do zsh $EMV_FORWARD_DIR/verify-generations.sh $EMV_RUN_DIR/stacks/$c/tee-codex 2>&1 | tee -a $L; (( ${pipestatus[1]} == 0 )) || (( failed++ )); done
fi
zsh $EMV_FORWARD_DIR/lib/real-configs.sh snapshot $R/real-configs-after-$first.txt
zsh $EMV_FORWARD_DIR/lib/real-configs.sh compare $R/real-configs-before-$first.txt $R/real-configs-after-$first.txt 2>&1 | tee -a $L
configs_ok=${pipestatus[1]}

# Prices, stats, tables.
if [[ -n $EMV_PRICES ]]; then prices=$EMV_PRICES
elif [[ $EMV_MODEL_PROFILE == openrouter-deepseek-flash ]]; then prices=$EMV_CARD
elif [[ $EMV_AGENT == codex ]]; then prices=$EMV_FORWARD_DIR/../prices/openai-gpt-6.1-sol.json
else prices=$EMV_FORWARD_DIR/../prices/anthropic-claude-opus-5-5.json
  [[ $EMV_CLAUDE_MODEL == claude-opus-5-5 ]] || echo "warning: prices are for claude-opus-5-5; set EMV_PRICES for $EMV_CLAUDE_MODEL" | tee -a $L
fi
for c in $configs; do
  python3 $EMV_FORWARD_DIR/stats.py $EMV_RUN_DIR/stacks/$c $prices $EMV_RUN_DIR/logs/netwatch.log > $R/$c.json || { say "stats failed for $c"; exit 1; }
  # The judges' artifacts: each turn's prompt and final reply, and the project snapshots.
  A=$EMV_RUN_DIR/artifacts/$c; mkdir -p $A; rm -rf $A/snapshots; cp -R $EMV_RUN_DIR/stacks/$c/snapshots $A/ 2>/dev/null
  python3 - $EMV_RUN_DIR/stacks/$c/logs/turns $c $EMV_PROMPTS $turns > $A/turns.jsonl <<'PY'
import json, os, sys
d, c, prompts, n = sys.argv[1], sys.argv[2], open(sys.argv[3]).read().splitlines(), int(sys.argv[4])
for i in range(1, n + 1):
    reply = None
    for ext in ('json', 'jsonl'):
        p = os.path.join(d, f'{c}-t{i}.{ext}')
        if not os.path.exists(p): continue
        if ext == 'json':
            try: x = json.load(open(p)); reply = (x[-1] if isinstance(x, list) else x).get('result')
            except Exception: pass
        else:
            for l in open(p):
                try: e = json.loads(l)
                except Exception: continue
                it = e.get('item') or {}
                if e.get('type') == 'item.completed' and it.get('type') == 'agent_message': reply = it.get('text')
    print(json.dumps(dict(config=c, turn=i, prompt=prompts[i - 1], reply=reply)))
PY
done
python3 $EMV_FORWARD_DIR/tables.py $R > $R/tables.md && cat $R/tables.md
# A configuration with no measured request, or request bodies the extractor could not read, is a broken run.
bad=$(python3 - $R $configs <<'PY'
import json, os, sys
for c in sys.argv[2:]:
    r = json.load(open(os.path.join(sys.argv[1], f'{c}.json')))
    if r['requests'] == 0 or r['unextracted_bodies']: print(f"{c}: {r['requests']} requests measured, {r['unextracted_bodies']} unreadable request bodies")
PY
)
[[ -z $bad ]] || { say "MEASUREMENT INCOMPLETE: $bad (see logs/extract.err)"; failed=$((failed + 1)); }
say "results in $R (tables.md, <config>.json); judges' artifacts in $EMV_RUN_DIR/artifacts"
(( failed == 0 && configs_ok == 0 )) || { say "FAILED: $failed session(s) failed, real-config check exit $configs_ok"; exit 1; }
# Finished cleanly: the installs (1 to 7 GB a run) go, the results stay. A budget stop is meant to be continued.
if [[ -z $EMV_KEEP_INSTALLS && ! -e $EMV_RUN_DIR/logs/budget-stop-turn ]]; then
  stacks=(); for c in $configs; do stacks+=($EMV_RUN_DIR/stacks/$c); done
  zsh $EMV_FORWARD_DIR/lib/prune-installs.sh $stacks 2>&1 | tee -a $L
  (( ${pipestatus[1]} == 0 )) || { say "FAILED: could not remove the installs"; exit 1; }
  touch $EMV_RUN_DIR/logs/installs-pruned
fi
