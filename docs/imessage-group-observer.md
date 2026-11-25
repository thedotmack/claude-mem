# iMessage group chat observer

Add a Photon iMessage line to any group chat and Claude-Mem keeps notes on it:
what the group decided, planned, asked for and shared, and who said what.
Each group chat gets its own Claude-Mem project, so you can search one chat's
memory or pull it into an agent's context like any other project.

The observer only reads. It never sends a message, reacts, or changes a group.

## Set it up

### 1. Get a Photon account and a dedicated line

The observer listens through an iMessage line from [Photon](https://photon.codes/docs).

- **Sign up** at [app.photon.codes](https://app.photon.codes) and create a project.
  Photon asks for a phone number that can receive iMessage, to bind your account.
- **Get a dedicated line.** Group chats need a dedicated iMessage line, which is
  part of Photon's Business plan. The free and Pro plans route through a shared
  pool of numbers, and Photon's docs say shared lines don't support group
  chats. (Photon listed a dedicated line at $250 a month in November 2026;
  check their plans page for today's price.)
- Once the line is ready, your project's Settings page shows a project id and
  secret. You don't need to copy them: setup can sign in for you.

### 2. Run setup

```bash
npx claude-mem imessage setup
```

Pick **Sign in to Photon in your browser** (the default). Setup runs Photon's
own command-line tool (`npx @photon-ai/cli@legacy login`), which prints a link
and a code and opens your browser. Approve the sign-in there. Setup then:

- lists your Photon projects and asks which one has your line, if you have more than one
- reads that project's existing secret (it never rotates it, so other apps on the project keep working)
- checks the project with Photon and prints the line's phone number
- installs the Photon SDK into `~/.claude-mem/imessage-observer/`

Everything is saved to `~/.claude-mem/imessage-observer/config.json`, readable
only by you.

Other ways to connect, for scripts or servers:

- `--project-id` and `--project-secret` (or `PHOTON_PROJECT_ID` and
  `PHOTON_PROJECT_SECRET`) skip the browser sign-in.
- `--address` and `--token` (or `PHOTON_IMESSAGE_ADDRESS` and
  `PHOTON_IMESSAGE_TOKEN`) connect straight to one line's server, if Photon
  gave you a server address and token instead of a project.

If setup says your project uses a shared line, the project is on a plan
without a dedicated line, and the observer would hear nothing from group chats.

### 3. Add the line to your group chats

Add the line's phone number to each group chat you want remembered, like adding
a person. Everyone in the chat can see it in the member list, so tell the group
it keeps notes.

### 4. Start observing

```bash
npx claude-mem imessage observe
```

Leave it running. `npx claude-mem imessage chats` lists the chats it has seen
and the project each one is saved under. Photon's tokens last a short time and
the observer renews them on its own.

## Try it without a line

A made-up Saturday of two group chats ships with the tests:

```bash
npx claude-mem imessage observe --replay tests/fixtures/imessage/group-chats.jsonl --dry-run
```

`--dry-run` prints what would be sent to the worker. Drop it to send the
replay to your real worker.

## How messages become memory

- **Conversation windows.** Messages are collected while people are talking.
  A window is handed to the worker when the chat has been quiet for 10
  minutes, when it reaches 50 messages, or when it is an hour old.
- **Conversations.** Four hours of silence ends a conversation. Its windows
  share one Claude-Mem session, which is summarized when it ends.
- **One project per chat.** The project is named from the group's name when
  the observer first sees it, plus a short id: `imessage-weekend-crew-3fa94c1d`.
  Renaming the group keeps the same project.
- **Who said what.** Each line of a window reads `[time] Name: message`.
  Names come from `~/.claude-mem/imessage-observer/contacts.json`:

  ```json
  { "+15551230001": "Jordan", "sam@example.com": "Sam" }
  ```

  Add your own number too, so your messages carry your name. A phone number
  without a name is written as "Phone ending 0001", so a full number is never
  stored by accident.
- **Edits, unsends and tapbacks** change the window that is still open. A
  change to a message that was already handed over is not sent again.
- **Photos and files** appear as `[photo]` or `[file: menu.pdf]`. Their
  contents are not read.
- **Direct chats are ignored.** Pass `--include-direct` to observe one-to-one
  chats too, or `--chat <guid>` (repeatable) to observe only certain chats.
  Both can also be set in `config.json` as `includeDirect` and `onlyChats`.

## What happens when something is down

The observer follows Claude-Mem's
[live observer contract](architecture/observer-lifecycle.md):

- If the worker cannot take a window, that window is skipped and logged. It
  is not saved for later and never sent again.
- If the worker falls behind, at most 20 windows wait for it. More than that,
  or a window that has waited over 10 minutes, is skipped and logged too.
- If the Photon connection drops, the observer reconnects to the live stream.
  Messages sent while it was disconnected are not fetched afterwards.
- On shutdown (Ctrl+C) the windows that are still open are sent once.

The only file the observer writes is `chats.json`, the list of chats and
their project names. Message text is never written to disk by the observer.

## Privacy

- Everything a window holds goes through the worker's normal privacy rules.
  Text inside `<private>…</private>` is removed before memory is written.
- To keep a chat out of memory, add its project name (or a pattern such as
  `imessage-family-*`) to `CLAUDE_MEM_EXCLUDED_PROJECTS` in Claude-Mem's
  settings. The observer checks it itself and sends nothing from that chat.
- A memory tag one member opens in one message and closes in another is
  turned into plain text, so it can't hide other people's messages.
- Group members can see the Photon line in the member list. Tell the group it
  keeps notes.
