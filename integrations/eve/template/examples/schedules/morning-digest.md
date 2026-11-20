---
cron: "0 14 * * *"
---

Write my morning digest of my most recent work across all my projects: what
shipped, what is still open, and any decision I made.

Start from the claude-mem context you were given this turn: it is my newest
memory, refreshed for every turn. For more, call claude-mem__timeline with the
oldest ID in that context as anchorId and depthBefore 20 to see the rows before
it. Search cannot filter by date and memory rows may not show one, so do not
use claude-mem__search for this and do not claim a row is from a given day.

Keep it under 15 short lines, newest first, one point per line. Save it with
claude-mem__remember, titled "Morning digest" and today's date, so I can ask
for it later from any agent.
