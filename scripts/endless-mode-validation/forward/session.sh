#!/usr/bin/env zsh
# Turns first..last of the scripted session (EMV_PROMPTS, one prompt per line) in one stack.
# Usage: session.sh <config> <first> <last>
#
# The next turn starts as soon as the last one ends, in every configuration: nothing waits for claude-mem's observer
# queue (a user does not), and its state at the turn end is logged on the "turn N done" line.
# EMV_HEADER_EDIT_TURN=N appends a rule to the sandbox MY-RULES.md just before turn N (needs EMV_MY_RULES), to test
# a durable-header edit mid-session; before/after copies go to logs/.
source ${0:A:h}/lib/env.sh || exit
emv_use_stack $1 || exit
first=$2; last=$3; log=$EMV_STACK/logs/session.log
prompts=("${(@f)$(<$EMV_PROMPTS)}")
# EMV_FIRST_PROMPT_FILE=<file>: turn 1 sends this file's whole text (an app spec, several lines) instead of line 1.
[[ -n $EMV_FIRST_PROMPT_FILE ]] && prompts[1]=$(<$EMV_FIRST_PROMPT_FILE)
(( last <= ${#prompts} )) || { echo "only ${#prompts} prompts in $EMV_PROMPTS" >&2; exit 2; }
[[ $first == 1 ]] && $EMV_FORWARD_DIR/seed-project.sh $EMV_STACK/proj
# A response from outside the pin (tee-proxy.ts wrote OFF-PIN) ends the run: its numbers would not be comparable.
off_pin_stop() {
  local marker
  for marker in $EMV_STACK/tee-*/OFF-PIN(N); do
    echo "$(date -u +%FT%TZ) STOP: off-pin response before turn $1: $(<$marker)" | tee -a $log; exit 5
  done
}
for i in {$first..$last}; do
  off_pin_stop $i
  if [[ -n $EMV_HEADER_EDIT_TURN && $i == $EMV_HEADER_EDIT_TURN ]]; then
    rules=$CLAUDE_MEM_DATA_DIR/MY-RULES.md
    [[ -f $rules ]] || { echo "EMV_HEADER_EDIT_TURN needs EMV_MY_RULES" >&2; exit 2; }
    cp $rules $EMV_STACK/logs/MY-RULES.before-turn$i.md
    print -r -- "- When you run the tests, print the number of tests that ran." >> $rules
    cp $rules $EMV_STACK/logs/MY-RULES.after-turn$i.md
    echo "$(date -u +%FT%TZ) header edited before turn $i" | tee -a $log
  fi
  budget_marker=$EMV_RUN_DIR/logs/budget-stop-turn
  if [[ -f $budget_marker ]] && (( i > $(<$budget_marker) )); then
    echo "$(date -u +%FT%TZ) STOP: budget reached; stopping after turn $(<$budget_marker) like every configuration" | tee -a $log; exit 0
  fi
  echo "$(date -u +%FT%TZ) turn $i start" | tee -a $log
  mode=$([[ $i == 1 ]] && echo first || echo resume)
  out=$(zsh $EMV_FORWARD_DIR/agent-turn.sh $1-t$i "${prompts[$i]}" $mode)
  echo "$out" | tee -a $log
  # For the judges: the project the moment the turn's agent exited, every EMV_SNAPSHOT_EVERY turns and at the end.
  if (( i % ${EMV_SNAPSHOT_EVERY:-10} == 0 || i == last )); then
    mkdir -p $EMV_STACK/snapshots; tar -czf $EMV_STACK/snapshots/turn-$(printf %03d $i).tar.gz -C $EMV_STACK proj
  fi
  st=''; [[ $1 != none ]] && st=$(curl -s -m3 http://127.0.0.1:$EMV_WORKER_PORT/api/processing-status)
  echo "$(date -u +%FT%TZ) turn $i done; observer status $st" | tee -a $log
  # Fork audit (fork-audit.sh): the session store is copied now, while the agent is stopped, and the copy is asked in
  # the background, so the next turn neither waits for it nor shares a file with it. Answers: logs/audits.jsonl.
  zsh $EMV_FORWARD_DIR/fork-audit.sh $1 $i snapshot >> $EMV_STACK/logs/fork-audit.log 2>&1
  zsh $EMV_FORWARD_DIR/fork-audit.sh $1 $i ask >> $EMV_STACK/logs/fork-audit.log 2>&1 &
  off_pin_stop $((i + 1))
done
wait  # the last turns' background fork audits
