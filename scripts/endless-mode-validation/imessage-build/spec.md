# Photon iMessage Claude Code Endless Mode Agent with Persistent Personality

## Purpose

This spec is the yardstick for one test: DeepSeek builds the same app three times, each across several sessions, and every build is scored against the checks at the end of this doc.

- The three builds: plain Claude Code · Claude-Mem without the Wire Gateway · Claude-Mem with Endless Mode

- Why several sessions: the work is split into milestones that each fit one session, so a build only does well if it remembers what earlier sessions decided and left open

- What gets scored: the app itself (does it work for a user) and how the build got there (did later sessions pick up where earlier ones stopped)

- Two layers, don't mix them up: the builder is DeepSeek in one of the three setups; the product is an agent that itself runs Claude Code with Claude-Mem and Endless Mode

## What the user gets

A Claude-Mem user goes from "I have Claude-Mem" to "I'm texting my agent from my phone and it knows my work" with no effort beyond one command and the permission prompts macOS forces.

- Zero-effort onboarding: setup finds the user's existing Claude-Mem install and memory, so the first iMessage conversation already knows their projects, open work and rules

- On-the-go access: from iMessage the user can ask about their work, get answers drawn from their own Claude-Mem data, and hand the agent work to do

- Local first: everything runs on the user's Mac; when the phone needs to open something richer than a text (for example a page of their data), it reaches the Mac through a tunnel

- A feature of open-source Claude-Mem: each user brings their own model access, an API key or a subscription, set up their own way

- Where this goes next (not in this spec): a cloud version for paid users, so access doesn't depend on the Mac being awake. Builds should not close that door, but nothing here is scored on it

## 1-click / 1-command setup

One command (or one click that runs it) takes a Mac with Claude-Mem installed to a working iMessage agent, and re-running it is safe.

What that one step must do, in order:

- Check the basics: macOS, Claude Code present, Claude-Mem installed and its worker running (Claude-Mem's own install is npx claude-mem install)

- Connect iMessage through Photon's iMessage service, on whichever Apple ID the user chooses (see the iMessage section)

- Walk the user through the one thing a command can't do on its own: macOS Full Disk Access for the process that reads Messages. Open the right System Settings pane, then confirm it actually worked before moving on

- Turn on what the agent needs in Claude-Mem: work state (on by default) and Endless Mode for the agent's route (off by default, so setup must switch it on)

- Ask the user which tunnel to use, offering Tailscale first when it's installed, and set it up

- Load the agent's personality (see Persistent personality)

- Start the agent as a background service that comes back after a restart

- Send the user a first iMessage that proves it works and shows it already knows them (names a real open item from their Claude-Mem work state)
Rules for the setup:

- No hand edits: the user never opens or edits a config file by hand

- Safe to repeat: running it twice changes nothing and starts no second copy

- Clean undo: one command removes it and puts back anything it changed

- Plain failures: if a step fails, the user is told which step and the one thing to do about it

## The Role agent: the conductor

The Role agent is the one the user texts. It talks, decides and hands out work; it never does the work itself, every piece goes to a subagent.
What a message goes through:

- A text arrives from the user over iMessage

- The Role agent reads it with the user's memory, rules and open work in view

- It answers directly only when the answer is talk or recall ("what was I doing on X?"), drawn from Claude-Mem

- Anything that is work goes to a subagent, sorted by size:

- easier work → a subagent using Claude-Mem work state (next section)

- complex work → a subagent running the claude-mem skills (the section after)

- It texts back a short receipt right away, then the result when the subagent finishes
What the Role agent must always do:

- Never does work itself: no file edits, builds or commands of its own; only routing, checking and replying

- Sorts every request as easy or complex and can say why when asked

- Keeps track of everything it handed out in Claude-Mem work state, so a restart or a new session sees what's still running

- Checks before it reports: a subagent's "done" is confirmed against evidence (tests passed, PR state, release published) before the user is told

- Runs subagents side by side when they don't depend on each other, and tells the user what's still going when asked

## Easier work: subagents with default work state

Easier work uses Claude-Mem's work state exactly as it ships, with nothing custom on top.
What "default work state" means (as it exists in claude-mem today):

- Two tools: work_state_write adds an entry to a named list; work_state_read shows what's open

- To-do items carry a task name and a status: todo, doing, done or dropped

- It carries across sessions on its own: whatever is still open is shown at the start of every new session

- It's on by default (setting CLAUDE_MEM_WORK_STATE_ENABLED)
What counts as easier work: one clear outcome that one subagent can finish without a plan, for example "what changed in the repo today", "fix this typo", "remind me what's open on X", "draft a reply".
What the subagent must do:

- Write the task to work state when it starts, mark it doing, then done or dropped with a one-line result

- Leave nothing behind as "doing" when it stops; anything unfinished stays open with a note on where it stopped

- Hand its result back to the Role agent, which texts the user

## Complex work: the claude-mem skills

Complex work runs through five skills from the claude-mem repo (plugin/skills), in this order, each run to its end.

| Skill | What it does | Done when |
|---|---|---|
| make-plan | Writes a phased plan: a user-visible goal at the top, a docs-discovery phase first, and a check for every phase | A plan file exists and every phase says how it serves the goal |
| do | Carries out the plan phase by phase, with fresh subagents to build, verify, check for bad patterns, review and commit | Every phase is verified and committed; nothing committed before its check passed |
| babysit | Watches the pull request until it's clean: checks, review comments, review threads | Checks pass, no open review threads, no actionable comments left |
| version-bump | Bumps the version everywhere it lives, builds, tags, makes the GitHub release; the tag triggers the npm publish | Exact version and latest tag live on npm, working tree clean and pushed |
| childhood | Stays with the release after it ships: checks the published package, the installed plugin and late CI or issue reports through an observation window | Observation window passed with no open regression, or gaps reported plainly |

What counts as complex work: more than one step, code that ships, or anything that ends in a PR or a release.
What the Role agent must do around them:

- Start the right skill for where the work is (a bug already in a PR starts at babysit, not make-plan)

- Record each skill's progress in work state, so a new session can resume mid-chain (childhood already writes its findings with work_state_write)

- Text the user at the milestones that matter: plan ready, PR clean, release out, observation window closed

- Keep the skills' own limits: published versions and tags are never moved or rewritten; childhood watching a release doesn't by itself allow another release or a rollback

## Persistent personality and Endless Mode

The agent stays the same character, with the same knowledge of the user, across days, restarts and very long conversations.
Personality:

- Written down once, in one place, loaded every time the agent starts. Claude-Mem already has a place for standing instructions: My Rules (~/.claude-mem/MY-RULES.md), which the Wire Gateway sends as a fixed header on every request

- Holds steady: same name, tone and habits on day one and day thirty, and after a restart

- Remembers the user, not just the chat: facts and preferences come from Claude-Mem memory, so a fresh conversation still knows them

- Changeable by the user from iMessage ("be shorter with me"), and the change sticks from then on
Endless Mode (on the claude-mem feat/wire-gateway branch, which the builds use as it stands and add their commits to):

- What it does: instead of resending every past tool call and result, the conversation is folded into one growing timeline of Claude-Mem observations, one line each. The agent's own copy is untouched; only what the model is sent shrinks

- Why it matters here: a texting agent is one conversation that never ends, so without folding it would hit its context limit and lose its thread

- It's off by default: setup turns it on for the agent's route (claude-mem wire routes endless <route> on)

- What to check: the model's input stays bounded over a long conversation while answers keep using older details correctly

## iMessage through Photon

The local version uses Photon's local iMessage provider, which runs on the user's Mac and needs no Photon account or keys.
What Photon offers ([docs](https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing.md)):

| Option | Runs where | Needs | Can do |
|---|---|---|---|
| Local provider (@spectrum-ts/imessage-local) | The user's Mac, reading the Messages database | macOS, the Mac's Messages account | Text, attachments, contacts. No tapbacks, threaded replies, edits, unsend or read receipts |
| Cloud provider (@spectrum-ts/imessage) | Photon's servers | A Photon project ID and secret | The full feature set |
| [imessage-kit](https://photon.codes/docs/opensource/imessage-kit.md) (open source) | The user's Mac | Full Disk Access for the process | Watch for messages and reply |

The agent texts from whichever Apple ID the user chooses to connect, through Photon's iMessage service as it is today; setup asks which one. The cloud provider's managed lines belong with the paid cloud version later.
How the agent should behave in iMessage (from Photon's own [inbound](https://photon.codes/docs/best-practices/inbound-pipeline.md) and [recovery](https://photon.codes/docs/best-practices/recovery-and-state.md) guides):

- Waits for the user to finish: several quick texts in a row become one request (Photon's example waits 5 seconds after the last one)

- Changes course when interrupted: a new text mid-reply cancels the reply in progress and folds both into the next one

- Never double-sends: each outgoing text has a stable ID, so a crash and retry doesn't send it twice

- Remembers per person: memory belongs to the person texting, history to the chat

- Keeps texts short: long results become a short summary, with a link to the full thing when it helps

- Answers only its owner: texts from anyone else are ignored

## Data access: local first, with a tunnel

The user's data never leaves their Mac in this version; the phone reaches it through iMessage for answers and through a tunnel for anything richer.

- Answers in the text: most questions are answered right in iMessage from the local Claude-Mem memory and work state

- Links through the tunnel: when the answer is bigger than a text (a list of open work, an observation, a plan), the agent sends a link that opens on the phone through a tunnel to the Mac

- The user picks the tunnel: setup asks which one to use and recommends Tailscale when the user has it, as the most secure choice

- The tunnel is locked: only the user can open it. Claude-Mem's own docs say the worker should be reachable only over a trusted network or an authenticated tunnel, never straight from the internet

- Honest when the Mac is off: if the Mac is asleep or offline, nothing pretends to work; once it's back, queued texts get answered
Next, not in this spec: a cloud version for paid users, where Photon's cloud provider and Claude-Mem's cloud sync take over when the Mac isn't reachable.

## Milestones, one per session

The build runs as six sessions, each starting fresh with the same one-line prompt ("continue building the spec"), so anything a session needs from earlier ones has to come from memory, not from the prompt.

- Plan → run make-plan on this spec; the plan file is the session's output

- iMessage loop → the agent receives and answers texts on the Mac through Photon's local provider: waits out bursts, never double-sends, answers only its owner

- Conductor and easy work → the Role agent routes every request; easy work runs on subagents that track themselves in work state

- Complex work → the make-plan, do, babysit, version-bump, childhood chain runs from a text, on a throwaway test repo and package

- Personality and Endless Mode → the personality loads every start and survives a restart; Endless Mode keeps a long conversation bounded

- One command and the tunnel → setup, undo and the locked tunnel work end to end on a clean Mac
How memory gets tested across sessions:

- Planted facts: session 1's prompt also gives three small decisions (for example the agent's name and the debounce wait). Later sessions must use them without being told again

- A left-open item: session 3 is stopped mid-task on purpose; session 4 must notice and finish it before starting its own work

- A changed mind: session 2 reverses one planted decision; sessions 3 to 6 must follow the new one, not the old

- Same prompts, same order, all three builds, so differences come from the setup, not the instructions

## Scorecard

Each build gets one point per check passed; a check passes only on the evidence named, never on the build saying so.

| # | Area | Check | Pass when |
|---|---|---|---|
| S1 | Setup | One command on a clean Mac with Claude-Mem gives a working agent | First iMessage arrives with no hand edits; only the Full Disk Access prompt needed |
| S2 | Setup | Running setup twice is safe | Second run changes nothing; one agent process, not two |
| S3 | Setup | Undo puts everything back | After undo, no service, no route, settings as before |
| S4 | Setup | Survives a restart | After reboot, the agent answers a text without anyone running anything |
| S5 | Onboarding | First text shows it knows the user | It names a real open item from the user's work state |
| I1 | iMessage | A burst of quick texts gets one answer | 3 texts within 5 seconds get one reply that covers all three |
| I2 | iMessage | Interrupting changes the answer | A new text mid-reply is reflected in the reply that goes out |
| I3 | iMessage | No double-sends | Kill the agent mid-send and restart; the text arrives once |
| I4 | iMessage | Owner only | A text from another number gets no reply and starts no work |
| R1 | Conductor | The Role agent does no work itself | Its log shows no file edits or commands of its own; all through subagents |
| R2 | Conductor | Easy vs complex sorted right | 5 easy and 5 complex sample requests go down the right path, 9 of 10 or better |
| R3 | Conductor | Done means checked | Every "done" texted has evidence behind it (test run, PR state, npm version) |
| E1 | Easy work | Work state used as shipped | Each easy task shows todo, doing, done in work_state_read |
| E2 | Easy work | Nothing left hanging | No item stuck at doing after its subagent stopped |
| C1 | Complex work | Full chain from one text | make-plan, do, babysit, version-bump, childhood all run to their own end on the test repo |
| C2 | Complex work | Resumes mid-chain | Stop it after babysit; a new session finishes version-bump and childhood without being told where it was |
| P1 | Personality | Same character after restart | Blind read of replies before and after a restart: same name, tone, habits |
| P2 | Personality | User can change it by text | "Be shorter" by text sticks for the next 10 replies and after a restart |
| P3 | Endless Mode | Long conversation stays bounded | Over 200 texts, the largest request the model is sent stops growing with the conversation |
| P4 | Endless Mode | Still remembers early details | A fact from text 5 is answered right at text 200 |
| D1 | Data access | Answers come from the user's own data | 5 recall questions answered right from Claude-Mem |
| D2 | Data access | Tunnel link opens on the phone | A link from the agent opens the page on cellular, not Wi-Fi |
| D3 | Data access | Tunnel is locked | The same link opened by someone else is refused |
| M1 | Across sessions | Planted facts used | All 3 planted facts used in later sessions without restating |
| M2 | Across sessions | Left-open item picked up | Session 4 finishes session 3's stopped task first |
| M3 | Across sessions | Changed mind followed | The reversed decision is used from session 3 on, the old one never |

Also record for each build, not scored pass or fail: total cost (including Claude-Mem's note-taker), time, and how many sessions it needed.

## Notes for the test

Three things to know before the builds run.

- Test releases: C1 and C2 publish a package, so the test needs a throwaway repo and npm package. version-bump also posts each release to X; that step should be skipped in the test

- Not verified: Photon's page for the local provider doesn't mention Full Disk Access (their imessage-kit page says it's required); the cloud provider's install command isn't on that page

- Starting from scratch: nothing iMessage- or Photon-related exists in the claude-mem repo today, so all three builds start from zero on that part

Sources read: claude-mem repo main (skills, work state) and feat/wire-gateway (Endless Mode, Wire Gateway docs), and Photon's docs linked above.

## Appendix: test rules (this test run only)

These rules are the same for all three builds. They exist so the builds can run and be scored safely; they are not part of the product.

- Don't touch the real Messages app. This build machine blocks reading the Messages database, running osascript and sending AppleEvents. Build and test the iMessage parts against the fake provider below; the real Photon provider is wired in for a user's own setup.
- Fake provider, for tests and scoring: when `IMSG_PROVIDER=fake`, the agent reads incoming texts from `$IMSG_FAKE_DIR/inbox.jsonl` (one JSON object per line, `{"id", "from", "chat", "text", "ts"}`, appended to over time) and writes each text it sends as one line of `$IMSG_FAKE_DIR/outbox.jsonl` (`{"id", "to", "chat", "text", "ts"}`). The owner's handle is in `IMSG_OWNER`.
- Model access in tests: the agent's model traffic uses `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` from its environment (with Endless Mode on, that base URL is the Wire Gateway route's upstream). Claude-Mem's data dir is `CLAUDE_MEM_DATA_DIR`.
- Test releases (the complex-work milestone): use the throwaway GitHub repo in `TEST_GH_REPO` when it is set, and publish test packages only to the npm registry in `TEST_NPM_REGISTRY`, never to npmjs.org. Never push to or release thedotmack/claude-mem. Skip any step that posts to X or other social media.
- This repo's `origin` is a local copy; pushing there is expected.
- Unattended setup, for tests: when `IMSG_SETUP_APPLE_ID` and `IMSG_SETUP_TUNNEL` are set, setup takes those as the user's answers instead of asking; `IMSG_SETUP_TUNNEL=test` means set up no real tunnel. With `IMSG_PROVIDER=fake` it skips the Messages and Full Disk Access steps. This machine also blocks `launchctl` and tunnel tools (tailscale, cloudflared, ngrok); the agent's background service is checked on a real Mac.
- Keep `imessage-agent.test.json` at the repo root up to date: `{"setup": "<the one setup command>", "undo": "<the undo command>", "run_fake": "<command that runs the agent in the foreground on the fake provider>", "complete": <true once every milestone is done>}`.
