# Claude-Mem Messages (Mac app)

Claude-Mem Messages is a small Mac app that lists your iMessage chats and group
chats, lets you tick the ones to observe, and lets you say what to watch for in
each one. New messages in the chats you tick become Claude-Mem notes, one
Claude-Mem project per chat, on your own Mac.

- It reads the Messages app's own database on your Mac (`~/Library/Messages/chat.db`).
  No Photon line, no phone number to add to a chat, nothing for the group to see.
- It only reads. It never sends a message, reacts, or changes a chat.
- Only new messages are read, from when it starts listening. Older history is
  not imported.

It is the same observer as the [group chat observer](imessage-group-observer.md),
with a different source: your Mac's Messages database instead of a Photon line.

## Set it up

### 1. Install Claude-Mem

If you don't have it yet, in Terminal:

```bash
npx claude-mem install
```

The app runs the `claude-mem` command and finds it on your normal Terminal
PATH (Homebrew, nvm, Bun and the usual folders). If it can't, paste the full
path to `claude-mem` into the setup screen.

### 2. Get the app

Either download it or build it.

- **Download:** every pull request and `main` build of this folder runs the
  "iMessage Mac app" check, which attaches `Claude-Mem-Messages.zip`. Open the
  check's run on GitHub, download the zip under Artifacts, and unzip it.
- **Build it yourself** (needs Xcode 15 or later, or the Swift 5.9 toolchain):

  ```bash
  cd integrations/imessage-mac
  scripts/build-app.sh
  open build
  ```

Move **Claude-Mem Messages.app** to Applications. The app is not notarized by
Apple yet, so the first time, right-click it and pick **Open**, then **Open**
again.

### 3. Allow Full Disk Access

macOS keeps Messages private. The app needs Full Disk Access to read it, and
macOS has no pop-up for this: you turn it on yourself. The app's setup screen
walks you through it:

1. Click **Open Full Disk Access**. System Settings opens at Privacy & Security >
   Full Disk Access.
2. Turn on **Claude-Mem Messages**. If it isn't listed, click **+** and pick it
   in Applications.
3. If macOS asks, quit and reopen the app. The step turns green.

The app runs `claude-mem` as its own child process, so the app's permission
covers the command too. You don't need to give Terminal or Node Full Disk Access.

If you rebuild the app yourself, macOS treats the new build as a different app.
Turn Full Disk Access off and on again for it.

### 4. Connect to Claude-Mem

The setup screen checks that your Claude-Mem worker is running and offers a
**Start Claude-Mem** button if it isn't. It also starts the worker when it
starts listening.

### 5. Pick chats

Your chats appear on the left, newest first. Use the filter for **Group chats**
or **Observing**, or search by name or person.

- **Tick a chat** to observe it. Untick it to stop. The listener picks up the
  change on its own, without a restart.
- **Observe for:** select a chat and write what matters in it, like "plans,
  dates and who's bringing what" or "money: who paid, who owes". Claude-Mem
  gives that the most attention when it writes notes on that chat. Chats
  without their own use the **Observe for, in every chat** text on the
  overview.
- **Use Names from Contacts** puts people's names in the notes instead of
  "Phone ending 1234". macOS asks once for Contacts access. Names are saved
  on your Mac in `~/.claude-mem/imessage-observer/contacts.json`.

Click **Listen** in the toolbar (it starts by itself once you tick a chat).
Closing the window keeps it listening from the menu bar; **Quit** there stops
it. **Open at login** is on the overview.

## How messages become memory

The same as the [group chat observer](imessage-group-observer.md#how-messages-become-memory):

- Messages are collected while people are talking and sent to Claude-Mem when
  the chat goes quiet for 10 minutes, reaches 50 messages, or is an hour old.
- Four hours of silence ends a conversation, which is then summarized.
- Each chat gets its own Claude-Mem project, named from the chat:
  `imessage-tahoe-trip-3fa94c1d`. The chat's page in the app shows it.
- Your own messages are labelled "Me".
- Edits and unsends change the window that is still open. Tapbacks appear as
  reactions. Photos and files appear as `[photo]` or `[file: menu.pdf]`;
  their contents are not read.
- One-to-one chats can be observed too: tick them like any other.

If Claude-Mem is down, a window is skipped and logged, not saved for later
(Claude-Mem's [live observer contract](architecture/observer-lifecycle.md)).

## Without the app

Everything the app does is a `claude-mem` command, so it also works from
Terminal (which then needs Full Disk Access itself):

```bash
npx claude-mem imessage mac check                  # can it read Messages? is Claude-Mem up?
npx claude-mem imessage mac chats --groups         # list group chats and their ids
npx claude-mem imessage mac pick '<chat id>' --on --focus 'plans and money'
npx claude-mem imessage mac pick --default-focus 'decisions and promises'
npx claude-mem imessage mac observe                # listen until Ctrl-C
npx claude-mem imessage mac observe --dry-run      # print what would be sent
```

Your picks are saved in `~/.claude-mem/imessage-observer/mac.json`, readable
only by you.

## What's where

- `integrations/imessage-mac/`: the SwiftUI app. `MessagesObserverKit` holds the
  parts that are tested without a window (reading the command's output, finding
  `claude-mem`, the Full Disk Access check).
- `src/integrations/imessage-observer/chatdb-source.ts`: reads and watches
  `chat.db` (and its `-wal` file), read-only, starting at the newest message.
- `src/integrations/imessage-observer/attributed-body.ts`: reads message text
  that newer macOS versions store only in `attributedBody`.
- `src/npx-cli/commands/imessage-mac.ts`: the `claude-mem imessage mac` commands.
