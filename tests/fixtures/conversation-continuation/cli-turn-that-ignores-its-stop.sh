#!/bin/sh
# Stands in for an agent CLI running one headless turn that does not end when it is told to stop, run with the turn's
# arguments and message, which it ignores. It ignores SIGINT, the stop a turn is sent, and SIGTERM, the shutdown cascade's
# first signal, so only SIGKILL ends it. Its naps ignore both too (a signal ignored at exec stays ignored), as processes a
# CLI starts would. Once it ignores both, it writes its pid to the file STAND_IN_TURN_WRITES_ITS_PID_TO names.
trap '' INT TERM
echo "$$" > "$STAND_IN_TURN_WRITES_ITS_PID_TO"
while :; do sleep 1; done
