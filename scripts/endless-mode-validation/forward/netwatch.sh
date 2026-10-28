#!/usr/bin/env zsh
# Outage marker: probes the providers every 20 s and logs the HTTP status (000 = no connection) until <stop file>
# exists. Usage: netwatch.sh <log file> <stop file>
# A turn with a failed probe inside it is flagged in the stats (`netwatch_failures`); 20 s is fine enough to place a
# failure inside one turn (our turns took 30 s to several minutes) without adding load.
while [[ ! -e $2 ]]; do
  a=$(curl -s -o /dev/null -m 8 -w '%{http_code}' https://api.anthropic.com/ 2>/dev/null); a=${a:-000}
  c=$(curl -s -o /dev/null -m 8 -w '%{http_code}' https://chatgpt.com/ 2>/dev/null); c=${c:-000}
  o=$(curl -s -o /dev/null -m 8 -w '%{http_code}' https://openrouter.ai/api/v1/models 2>/dev/null); o=${o:-000}
  echo "$(date -u +%FT%TZ) anthropic=$a chatgpt=$c openrouter=$o" >> $1
  sleep 20
done
