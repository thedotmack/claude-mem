#!/usr/bin/env zsh
# Turns first..last of the scripted session (EMV_PROMPTS, one prompt per line) in one stack.
# Usage: session.sh <config> <first> <last>
#
# Between turns it waits for this stack's observer queue to drain, so every configuration gets the same pacing.
# Cap 240 s. Reason: our observer calls measured 20-90 s each; a hit cap is logged on the "turn N done" line, never
# hidden. The cap only paces the run: a 240 s pause is far inside Claude Code's 1-hour cache TTL.
# EMV_HEADER_EDIT_TURN=N appends a rule to the sandbox MY-RULES.md just before turn N (needs EMV_MY_RULES), to test
# a durable-header edit mid-session; before/after copies go to logs/.
source ${0:A:h}/lib/env.sh || exit
emv_use_stack $1 || exit
first=$2; last=$3; log=$EMV_STACK/logs/session.log
prompts=("${(@f)$(<$EMV_PROMPTS)}")
(( last <= ${#prompts} )) || { echo "only ${#prompts} prompts in $EMV_PROMPTS" >&2; exit 2; }
[[ $first == 1 ]] && $EMV_FORWARD_DIR/seed-project.sh $EMV_STACK/proj
for i in {$first..$last}; do
  free_gb=$(emv_free_gb)
  if (( free_gb < EMV_MIN_FREE_GB )); then echo "$(date -u +%FT%TZ) STOP: ${free_gb} GB free before turn $i" | tee -a $log; exit 3; fi
  if [[ -n $EMV_HEADER_EDIT_TURN && $i == $EMV_HEADER_EDIT_TURN ]]; then
    rules=$CLAUDE_MEM_DATA_DIR/MY-RULES.md
    [[ -f $rules ]] || { echo "EMV_HEADER_EDIT_TURN needs EMV_MY_RULES" >&2; exit 2; }
    cp $rules $EMV_STACK/logs/MY-RULES.before-turn$i.md
    print -r -- "- When you run the tests, print the number of tests that ran." >> $rules
    cp $rules $EMV_STACK/logs/MY-RULES.after-turn$i.md
    echo "$(date -u +%FT%TZ) header edited before turn $i" | tee -a $log
  fi
  echo "$(date -u +%FT%TZ) turn $i start" | tee -a $log
  mode=$([[ $i == 1 ]] && echo first || echo resume)
  out=$(zsh $EMV_FORWARD_DIR/agent-turn.sh $1-t$i "${prompts[$i]}" $mode)
  echo "$out" | tee -a $log
  # For the judges: the project the moment the turn's agent exited, every EMV_SNAPSHOT_EVERY turns and at the end.
  if (( i % ${EMV_SNAPSHOT_EVERY:-10} == 0 || i == last )); then
    mkdir -p $EMV_STACK/snapshots; tar -czf $EMV_STACK/snapshots/turn-$(printf %03d $i).tar.gz -C $EMV_STACK proj
  fi
  sleep 10; waited=10; st=''
  while [[ $1 != none ]] && (( waited < 240 )); do
    st=$(curl -s -m3 http://127.0.0.1:$EMV_WORKER_PORT/api/processing-status)
    [[ $st == *'"isProcessing":false'* && $st == *'"queueDepth":0'* ]] && break
    sleep 5; (( waited += 5 ))
  done
  echo "$(date -u +%FT%TZ) turn $i done; observer wait ${waited}s; status $st" | tee -a $log
done
