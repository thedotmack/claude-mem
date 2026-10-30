# The by-hand checks

These need a real Mac, a phone or a release, so `score.py` marks them "by hand". Do them once per build that got
far enough, outside the build sandbox, on a Mac account you're happy to test on.

- **S1, one command:** on a clean Mac account with claude-mem installed (`npx claude-mem install`), run the build's
  setup command from `imessage-agent.test.json` with no environment variables set. Pass if the first iMessage
  arrives with no hand edits and the only prompt you had to answer was Full Disk Access.
- **S4, survives a restart:** reboot. Without running anything, text the agent. Pass if it answers.
- **S5 and I1 to I4, for real:** repeat on the real line what `score.py` did on the fake one: the first text names a
  real open item; three quick texts get one answer; a text mid-reply changes it; kill the agent while it's sending
  (`pkill -9` on its process) and restart: the text arrives once; a text from another number gets nothing.
- **R3, done means checked:** read every "done" the agent texted during the run (`<out>/<build>/score/imsg/
  outbox.jsonl`) and check each has evidence behind it (a test run, a PR state, a package version).
- **C1, full chain from one text:** with `TEST_GH_REPO_PREFIX` set, text the agent a small change for the throwaway
  repo ("add a CHANGELOG line and release it"). Pass if make-plan, do, babysit, version-bump and childhood each run
  to their own end: a plan file, a clean PR, a tag and a GitHub release, the version on the local registry, and
  childhood's findings in work state.
- **C2, resumes mid-chain:** start another change, stop the agent right after babysit reports the PR clean, start a
  new session, and text "carry on". Pass if it finishes version-bump and childhood without being told where it was.
- **D2, the link opens on the phone:** ask for something bigger than a text ("send me the list of open work as a
  page"). Open the link on the phone over cellular, Wi-Fi off. Pass if the page opens.
- **D3, the link is locked:** open the same link on a device that isn't yours (or a private window with no tunnel
  login). Pass if it's refused.

To undo after the by-hand checks, run the build's undo command and check that `launchctl list` shows no agent.
