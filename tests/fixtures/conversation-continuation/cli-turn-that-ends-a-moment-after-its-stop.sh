#!/bin/sh
# Stands in for an agent CLI running one headless turn, run with the turn's arguments and message, which it ignores. It
# ends its turn a moment after it is told to stop, as a CLI that writes out its turn before it exits does: SIGINT or
# SIGTERM ends it, exit 130, six 50 ms naps later (a signal that cuts a nap short ends that nap only). Nothing else ends
# it. Once it can hear a stop, it writes its pid to the file STAND_IN_TURN_WRITES_ITS_PID_TO names.
stop_heard=''
trap 'stop_heard=yes' INT TERM
echo "$$" > "$STAND_IN_TURN_WRITES_ITS_PID_TO"
naps_left=6
while [ "$naps_left" -gt 0 ]; do
  sleep 0.05
  if [ -n "$stop_heard" ]; then naps_left=$((naps_left - 1)); fi
done
exit 130
