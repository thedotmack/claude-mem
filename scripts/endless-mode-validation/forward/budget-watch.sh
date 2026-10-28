#!/usr/bin/env zsh
# OpenRouter profile only. Watches the key's total spend (GET https://openrouter.ai/api/v1/key, `data.usage`, USD)
# and, when it reaches EMV_BUDGET_USD, writes the turn every configuration stops after to logs/budget-stop-turn: the
# lowest turn any configuration has started. The slowest configuration finishes that turn; the others stop before
# their next turn. Every configuration then has the same turns 1..N (the tables compare those); the turns the faster
# ones ran past N are kept but beyond the common range. Not the highest turn: letting the slower configurations
# catch up would keep spending after the budget is reached. Only the spend is logged (logs/budget.log), never the key; the key goes to curl on stdin, never in a URL
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
      lowest=''
      for c in "$@"; do
        t=$(grep -o 'turn [0-9]* start' $EMV_RUN_DIR/stacks/$c/logs/session.log 2>/dev/null | tail -1 | awk '{print $2}')
        [[ -z $lowest ]] || (( ${t:-0} < lowest )) && lowest=${t:-0}
      done
      print -r -- $lowest > $marker.new && mv $marker.new $marker
      echo "$(date -u +%FT%TZ) BUDGET REACHED: usage $usage >= $budget; every configuration stops after turn $lowest" >> $L
    fi
  fi
  sleep 60
done
