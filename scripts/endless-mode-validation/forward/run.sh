#!/usr/bin/env zsh
# A forward run: the same scripted session, N turns, in each configuration side by side, each in its own isolated
# stack; then stats, tables and the judges' artifacts.
#
# Usage: scripts/endless-mode-validation/forward/run.sh <turns> [configs...]   (configs default: none off timeline observation)
# Env: see lib/env.sh (EMV_RUN_NAME, EMV_AGENT, EMV_MODEL_PROFILE, EMV_CLAUDE_BIN, ...). Also:
#   EMV_FIRST_TURN  continue an existing run (same EMV_RUN_NAME) from this turn [1]
#   EMV_PRICES      prices file for the tables [by profile: prices/anthropic-claude-opus-5-5.json, prices/openai-gpt-6.1-sol.json,
#                   or OpenRouter's live list for openrouter-deepseek-flash]
# Output: $EMV_RUN_DIR/results/{<config>.json, tables.md, real-configs-before.txt, real-configs-after.txt}
#         $EMV_RUN_DIR/artifacts/<config>/{turns.jsonl, snapshots/}  (for the blind judges; contains the agent's replies)
source ${0:A:h}/lib/env.sh || exit
turns=${1:?usage: run.sh <turns> [configs...]}; shift
configs=("$@"); (( ${#configs} )) || configs=($EMV_ALL_CONFIGS)
first=${EMV_FIRST_TURN:-1}
R=$EMV_RUN_DIR/results; mkdir -p $R $EMV_RUN_DIR/logs
L=$EMV_RUN_DIR/logs/run.log
say() { echo "$(date -u +%FT%TZ) $*" | tee -a $L; }

# Preflight: fail before anything starts.
for tool in python3 jq git curl lsof shasum tar; do command -v $tool >/dev/null || { echo "missing: $tool" >&2; exit 2; }; done
[[ -x $EMV_BUN ]] || { echo "bun not found (set EMV_BUN)" >&2; exit 2; }
if [[ $EMV_AGENT == codex ]]; then [[ -x $EMV_CODEX_BIN ]] || { echo "codex not found (set EMV_CODEX_BIN)" >&2; exit 2; }
else [[ -x $EMV_CLAUDE_BIN ]] || { echo "claude not found (set EMV_CLAUDE_BIN)" >&2; exit 2; }; fi
if [[ $EMV_AGENT == claude ]] && head -c 2 $EMV_CLAUDE_BIN | grep -q '#!'; then
  echo "warning: $EMV_CLAUDE_BIN is a script; if it rewrites HOME or CLAUDE_CONFIG_DIR the isolation fails. Set EMV_CLAUDE_BIN to the real binary." >&2
fi
emv_check_profile || exit
[[ ! -d $EMV_RUN_DIR/stacks || $first != 1 ]] || { echo "$EMV_RUN_DIR already has stacks; pick a new EMV_RUN_NAME, or set EMV_FIRST_TURN to continue" >&2; exit 2; }
(( $(emv_free_gb) >= EMV_MIN_FREE_GB )) || { echo "under $EMV_MIN_FREE_GB GB free" >&2; exit 3; }

say "run $EMV_RUN_NAME: turns $first-$turns, configs ${configs[*]}, agent $EMV_AGENT, profile $EMV_MODEL_PROFILE, model $([[ $EMV_AGENT == codex ]] && echo $EMV_CODEX_MODEL || emv_claude_model), commit $(git -C $EMV_REPO_ROOT rev-parse --short HEAD)"
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
[[ $EMV_MODEL_PROFILE == anthropic && $EMV_AGENT == claude && -z $EMV_CLAUDE_OAUTH_TOKEN && $EMV_HOST_AUTH != 1 ]] && zsh $EMV_FORWARD_DIR/token-watch.sh $stop $configs &

say "sessions start"
session_pids=()
for c in $configs; do zsh $EMV_FORWARD_DIR/session.sh $c $first $turns > $EMV_RUN_DIR/stacks/$c/logs/session-$first-$turns.out 2>&1 & session_pids+=($!); done
failed=0; for p in $session_pids; do wait $p || (( failed++ )); done
say "sessions done ($failed failed)"
touch $stop; wait $extractor
cleanup
zsh $EMV_FORWARD_DIR/lib/real-configs.sh snapshot $R/real-configs-after-$first.txt
zsh $EMV_FORWARD_DIR/lib/real-configs.sh compare $R/real-configs-before-$first.txt $R/real-configs-after-$first.txt 2>&1 | tee -a $L
configs_ok=${pipestatus[1]}

# Prices, stats, tables.
if [[ -n $EMV_PRICES ]]; then prices=$EMV_PRICES
elif [[ $EMV_MODEL_PROFILE == openrouter-deepseek-flash ]]; then
  prices=$R/prices-openrouter.json; python3 $EMV_FORWARD_DIR/../fetch-openrouter-prices.py "$EMV_OPENROUTER_MODEL" $prices | tee -a $L || exit 1
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
