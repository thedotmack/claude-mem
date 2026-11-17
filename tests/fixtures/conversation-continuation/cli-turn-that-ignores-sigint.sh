#!/bin/sh
# Stands in for an agent CLI running one headless turn that does not end on the stop a turn is sent, SIGINT, run with the
# turn's arguments and message, which it ignores. The shutdown cascade's SIGTERM ends it. Its naps ignore SIGINT too (a
# signal ignored at exec stays ignored). Once it ignores SIGINT, it writes its pid to the file
# STAND_IN_TURN_WRITES_ITS_PID_TO names.
trap '' INT
echo "$$" > "$STAND_IN_TURN_WRITES_ITS_PID_TO"
while :; do sleep 1; done
