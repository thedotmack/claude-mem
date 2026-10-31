# Shared by the Sprite service scripts. Sourced, not run. Reads settings from the kit; never prints a key.
# A Sprite's `bun` on PATH is a shim that runs the real one as a child, and OpenDuet's start.sh checks that the
# process listening on its port is the one it launched. The real binary goes first so that check passes.
[ -x /.sprite/languages/bun/bin/bun ] && export PATH=/.sprite/languages/bun/bin:$PATH
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/lib.sh"
