#!/usr/bin/env bash
# Run REPS sessions per arm side by side (each in its own stack), then extract usage. Results: <out>/results.sqlite.
# Usage: run_all.sh <out dir> <reps> [extra run_session.py args...]
# EMV_ARMS picks the arms [plain endless; also claudemem]; EMV_ARM_SUFFIX names a variant (e.g. -obs55 with EMV_OBSERVER_MODEL set).
# Every session and stack is stopped on exit, on an error and on an interrupt.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=$1 reps=$2; shift 2
bench=${EMV_BENCH:?set EMV_BENCH to polyglot-benchmark/python/exercises/practice}
arms=(${EMV_ARMS:-plain endless})
mkdir -p "$out"; out=$(cd "$out" && pwd)

for r in $(seq 1 "$reps"); do
  for arm in "${arms[@]}"; do
    [[ -e $out/$arm-r$r ]] && { echo "$out/$arm-r$r exists; use a new output dir" >&2; exit 2; }
  done
done

started=() pids=()
cleanup() {
  local d p
  # Sessions first (each with its claude process), so none keeps spending once its stack is gone.
  for p in ${pids[@]+"${pids[@]}"}; do pkill -TERM -P "$p" 2>/dev/null || true; kill -TERM "$p" 2>/dev/null || true; done
  for d in ${started[@]+"${started[@]}"}; do "$here/stack.sh" stop "${d%%:*}" "${d#*:}" || true; done
}
trap cleanup EXIT
trap 'exit 130' INT TERM

for r in $(seq 1 "$reps"); do
  for arm in "${arms[@]}"; do
    case $arm in plain) base=39100 ;; endless) base=39200 ;; *) base=39300 ;; esac
    base=$((base + 10 * (r - 1)))
    dir=$out/$arm-r$r
    started+=("$arm:$dir")
    "$here/stack.sh" start $arm "$dir" $base > "$out/$arm-r$r.stack.log" 2>&1
    python3 "$here/run_session.py" --arm $arm --arm-dir "$dir" --bench "$bench" --db "$out/results.sqlite" \
      --run-id $arm${EMV_ARM_SUFFIX:-}-r$r --arm-label $arm${EMV_ARM_SUFFIX:-} "$@" > "$out/$arm-r$r.log" 2>&1 &
    pids+=($!)
  done
done
fail=0; for p in "${pids[@]}"; do wait $p || fail=1; done

for r in $(seq 1 "$reps"); do
  for arm in "${arms[@]}"; do
    # The observer may still be writing up the last turns: wait for it, so its cost is counted whole.
    if [[ $arm != plain ]]; then python3 "$here/wait_observer.py" "$out/$arm-r$r" || fail=1; fi
    python3 "$here/extract.py" --db "$out/results.sqlite" --run-id $arm${EMV_ARM_SUFFIX:-}-r$r --arm-dir "$out/$arm-r$r" || fail=1
  done
done
exit $fail
