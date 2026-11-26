# Claude-Mem Messages for Mac

Choose **Messages on this Mac** to take notes on chats you pick, or **Photon line** to listen to groups that include your dedicated Photon number. Each chat has its own Claude-Mem project. Both sources start with new messages.

## Install and open the app

1. Install Claude-Mem and start its worker in Terminal.

   ```sh
   npx claude-mem install
   npx claude-mem start
   ```

2. Download and unzip the release, move **Claude-Mem Messages.app** to Applications, and open it. The universal app supports macOS 14 and later on Apple silicon and Intel Macs. [Download Claude-Mem Messages for macOS](https://github.com/thedotmack/claude-mem/releases/latest/download/Claude-Mem-Messages.zip)
3. The current release is ad-hoc signed. If macOS blocks first open, use **System Settings → Privacy & Security → Open Anyway** for the official download. [Apple's first-open instructions](https://support.apple.com/en-us/102445)
4. Choose the source at the top of the window. Switching sources stops the current listener before the other starts.

## Messages on this Mac

1. Click **Open Full Disk Access**. Turn on **Claude-Mem Messages** under **System Settings → Privacy & Security → Full Disk Access**. If needed, use the **+** button to select it in Applications.
2. Reopen the app if macOS asks. Once the worker and Messages are available, your chat list opens.

### Pick chats

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

## Photon line

1. Choose **Photon line**. An existing `claude-mem imessage setup` configuration appears automatically. To connect a project in the app, enter the project ID and secret from Photon project settings and click **Connect Project**. The app verifies the project has a dedicated line before saving credentials to the same private configuration the CLI uses.
2. Add the line to each group you want observed. The other members can see it. Photon observation uses the line's group memberships and honors the CLI's configured chat allowlist. Direct messages are excluded.
3. Click **Listen**. The status and Activity log show the listener and worker handoffs. Use **Stop** in the window or menu bar. Closing the window keeps the active listener running. Full Disk Access and a local Apple Messages history are required only for the Mac Messages source.

## Packaged observer

The app verifies its signed bundle and invokes the observer shipped for the Mac's processor. Its runtime and Photon client are inside the app. The separately installed Claude-Mem worker receives observations over its configured API. Start the worker from Terminal or your usual agent.

To build from the repository, use Xcode 15 or later and Bun 1.4.4.

```sh
npm install --ignore-scripts
npm ci --ignore-scripts --prefix integrations/imessage-mac/observer
cd integrations/imessage-mac
scripts/build-app.sh
open build
```

For maintainers publishing a version tag, the release workflow attaches the Mac ZIP
and verifies its public download before publishing to npm. If the tag has no GitHub
Release, the workflow creates one using the tagged changelog's **Unreleased** section.
You can keep or edit those notes on GitHub. Retries preserve the existing release
title, notes, and attached ZIP.

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
