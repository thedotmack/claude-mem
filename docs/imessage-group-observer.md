# iMessage group chat observer

Add a Photon iMessage line to any group chat and Claude-Mem keeps notes on it:
what the group decided, planned, asked for and shared, and who said what.
Each group chat gets its own Claude-Mem project, so you can search one chat's
memory or pull it into an agent's context like any other project.

The observer only reads. It never sends a message, reacts, or changes a group.

## Set it up

1. Get an iMessage line from Photon (the
   [`@photon-ai/advanced-imessage`](https://github.com/photon-hq/advanced-imessage-ts)
   SDK). Photon gives you the line's server address and token.
2. Run setup and paste them when asked:

   ```bash
   npx claude-mem imessage setup
   ```

   This saves them to `~/.claude-mem/imessage-observer/config.json` (readable
   only by you) and installs the Photon SDK into that folder. You can also pass
   `--address` and `--token`, or set `PHOTON_IMESSAGE_ADDRESS` and
   `PHOTON_IMESSAGE_TOKEN`.
3. Add the Photon line's number or Apple ID to the group chats you want
   remembered. Everyone in the chat can see that it was added.
4. Start observing:

   ```bash
   npx claude-mem imessage observe
   ```

   Leave it running. `npx claude-mem imessage chats` lists the chats it has
   seen and the project each one is saved under.

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

  A phone number without a name is written as "Phone ending 0001", so a full
  number is never stored by accident. Messages from your own account are
  labelled `Me`; set `"meLabel"` in `config.json` to change that.
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
- If the Photon connection drops, the observer reconnects to the live stream.
  Messages sent while it was disconnected are not fetched afterwards.
- On shutdown (Ctrl+C) the windows that are still open are sent once.

The only file the observer writes is `chats.json`, the list of chats and
their project names. Message text is never written to disk by the observer.

## Privacy

- Everything a window holds goes through the worker's normal privacy rules.
  Text inside `<private>…</private>` is removed before memory is written.
- A Claude-Mem project exclusion or a private prompt stops the chat's
  conversation before any message is sent.
- Group members can see the Photon line in the member list. Tell the group it
  keeps notes.
