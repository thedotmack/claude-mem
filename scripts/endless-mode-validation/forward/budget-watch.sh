#!/usr/bin/env zsh
# OpenRouter profile only. Watches the key's total spend (GET https://openrouter.ai/api/v1/key, `data.usage`, USD)
# and, when it reaches EMV_BUDGET_USD, writes the turn every configuration stops after to logs/budget-stop-turn: the
# highest turn any configuration has started. Each session finishes that turn and stops there, so all stop at the
# same turn. Only the spend is logged (logs/budget.log), never the key; the key goes to curl on stdin, never in a URL
# or an argument. Usage: budget-watch.sh <stop file> <config>...
# Poll every 60 s. Reason: the key endpoint is the only account-level measure that includes the observers; a
# DeepSeek Flash turn costs cents, so a minute of lag overshoots the budget by cents, well inside the key's own limit.
source ${0:A:h}/lib/env.sh || exit
stop=$1; shift; L=$EMV_RUN_DIR/logs/budget.log; marker=$EMV_RUN_DIR/logs/budget-stop-turn
emv_read_openrouter_key || exit
budget=${EMV_BUDGET_USD:?EMV_BUDGET_USD unset}
while [[ ! -e $stop ]]; do
  usage=$(print -r -- "Authorization: Bearer $EMV_OPENROUTER_KEY" | curl -s -m 15 -H @- https://openrouter.ai/api/v1/key | jq -r '.data.usage // empty' 2>/dev/null)
  if [[ -z $usage ]]; then echo "$(date -u +%FT%TZ) usage unavailable" >> $L
  else
    echo "$(date -u +%FT%TZ) usage_usd=$usage budget_usd=$budget" >> $L
    if [[ ! -e $marker ]] && (( usage >= budget )); then
      highest=0
      for c in "$@"; do
        t=$(grep -o 'turn [0-9]* start' $EMV_RUN_DIR/stacks/$c/logs/session.log 2>/dev/null | tail -1 | awk '{print $2}')
        (( ${t:-0} > highest )) && highest=$t
      done
      print -r -- $highest > $marker
      echo "$(date -u +%FT%TZ) BUDGET REACHED: usage $usage >= $budget; every configuration stops after turn $highest" >> $L
    fi
  fi
  sleep 60
done
