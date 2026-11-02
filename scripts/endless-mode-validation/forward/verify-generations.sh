#!/usr/bin/env zsh
# End of a Codex run: confirm the provider of every answer the tee could not confirm while it ran (see tee-proxy.ts).
# Exits 1 when any answer came from another provider (writes OFF-PIN) or stays unproven. Usage: verify-generations.sh <tee dir>
source ${0:A:h}/lib/env.sh || exit
tee_dir=$1; todo=$tee_dir/generations-to-verify.tsv; done_file=$tee_dir/generation-lookups.tsv
[[ -f $todo ]] || exit 0
emv_read_openrouter_key || exit
slug=$(emv_pin_provider) || exit
expected=${${slug%%/*}//[^a-zA-Z0-9]/}
# Waits between sweeps, in seconds. Reason: on 2026-11-02 records missing after 126 s were present within 5 minutes.
waits=(${=EMV_GENERATION_SWEEP_WAITS:-60 60 60 60 60})
remaining=1 bad=0
for wait_seconds in $waits; do
  remaining=0
  while IFS=$'\t' read -r n id; do
    grep -q -F -- "$id" $done_file 2>/dev/null && continue
    # The key goes to curl on stdin, never in an argument.
    provider=$(print -r -- "Authorization: Bearer $EMV_OPENROUTER_KEY" | curl -s -m 20 -H @- "$EMV_OPENROUTER_ANTHROPIC_BASE/v1/generation?id=$id" | jq -r '.data.provider_name // empty' 2>/dev/null)
    if [[ -z $provider ]]; then (( remaining++ )); continue; fi
    print -r -- "$n	$id	$provider" >> $done_file
    if [[ ${${provider:l}//[^a-z0-9]/} != ${expected:l} ]]; then
      print -r -- "$n	served by provider $provider, pinned endpoint is $slug" > $tee_dir/OFF-PIN
      echo "OFF-PIN: request $n: served by provider $provider, pinned endpoint is $slug" >&2; bad=1
    fi
  done < $todo
  (( remaining == 0 )) && break
  sleep $wait_seconds
done
(( remaining == 0 )) || { echo "$tee_dir: $remaining generation(s) unverified after ${#waits} sweeps: their provider is unproven" >&2; bad=1; }
echo "$tee_dir: $(wc -l < $done_file 2>/dev/null | tr -d ' ') of $(wc -l < $todo | tr -d ' ') answers confirmed on the pinned provider's name"
exit $bad
