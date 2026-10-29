#!/usr/bin/env bash
# Run REPS sessions per arm side by side (each in its own stack), then extract usage. Results: <out>/results.sqlite.
# Usage: run_all.sh <out dir> <reps> [extra run_session.py args...]
# EMV_ARMS picks the arms [plain endless]; EMV_ARM_SUFFIX names a variant (e.g. -obs55 with EMV_OBSERVER_MODEL set).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=$1 reps=$2; shift 2
bench=${EMV_BENCH:?set EMV_BENCH to polyglot-benchmark/python/exercises/practice}
mkdir -p "$out"
pids=()
for r in $(seq 1 "$reps"); do
  for arm in ${EMV_ARMS:-plain endless}; do
    if [[ $arm == plain ]]; then base=39100; else base=39200; fi
    base=$((base + 10 * (r - 1)))
    dir=$out/$arm-r$r
    "$here/stack.sh" start $arm "$dir" $base > "$out/$arm-r$r.stack.log" 2>&1
    python3 "$here/run_session.py" --arm $arm --arm-dir "$dir" --bench "$bench" --db "$out/results.sqlite" \
      --run-id $arm${EMV_ARM_SUFFIX:-}-r$r --arm-label $arm${EMV_ARM_SUFFIX:-} "$@" > "$out/$arm-r$r.log" 2>&1 &
    pids+=($!)
  done
done
fail=0; for p in "${pids[@]}"; do wait $p || fail=1; done
sleep 60  # let the observers finish what the last turns sent them, so their cost is counted
for r in $(seq 1 "$reps"); do
  for arm in ${EMV_ARMS:-plain endless}; do
    python3 "$here/extract.py" --db "$out/results.sqlite" --run-id $arm${EMV_ARM_SUFFIX:-}-r$r --arm-dir "$out/$arm-r$r"
    "$here/stack.sh" stop $arm "$out/$arm-r$r"
  done
done
exit $fail
