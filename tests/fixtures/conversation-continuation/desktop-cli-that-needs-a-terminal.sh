#!/bin/sh
# Stands in for `claude --desktop --resume <session uuid>` in tests, and opens nothing. Like Claude Code 2.1.325's
# --desktop handler, it refuses on stderr and exits 1 unless its stdout and stdin are a terminal, in that order. Then it
# says what Claude Code says once the app has the session, and exits 0. Two settings change that:
#   STAND_IN_DESKTOP_HAS_NO_SESSION: it refuses the session id as Claude Code 2.1.325 did one that matches no
#     conversation, with the same color and cursor codes it wrote to the terminal under TERM=dumb
#     (claude-desktop-refusal-through-script.json), and exits 1.
#   STAND_IN_DESKTOP_HANGS_WRITING_ITS_PID_TO: it writes its pid to that file and waits, as a hung open would. It waits
#     60 seconds, far longer than any test here runs (bun's per-test timeout is 5 seconds), so only a stop ends it first.
if [ "$#" -ne 3 ] || [ "$1" != "--desktop" ] || [ "$2" != "--resume" ]; then
  echo "unexpected arguments: $*" >&2
  exit 2
fi
if [ ! -t 1 ]; then
  echo "--desktop opens the Claude Desktop app and can't run non-interactively (\`--print\`, \`--sdk-url\`, \`--init-only\`, or redirected output)." >&2
  exit 1
fi
if [ ! -t 0 ]; then
  echo "--desktop doesn't take piped or redirected input yet. Run \`claude --desktop\` on its own, then type in the app." >&2
  exit 1
fi
if [ -n "$STAND_IN_DESKTOP_HAS_NO_SESSION" ]; then
  printf '\033[0m\033[31mNo session found with ID %s. Run `claude --resume` to pick a session, then /desktop inside it.\033[0m\n\033[?25h' "$3" >&2
  exit 1
fi
if [ -n "$STAND_IN_DESKTOP_HANGS_WRITING_ITS_PID_TO" ]; then
  echo "$$" > "$STAND_IN_DESKTOP_HANGS_WRITING_ITS_PID_TO"
  exec sleep 60
fi
echo "Opening session $3 in Claude Desktop"
