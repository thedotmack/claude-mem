# Native harness integrations

Memory provider selection and account sign-in follow the existing installer flow.

## Pi

```sh
npx claude-mem install --ide pi
```

Restart Pi. The installer places a self-contained extension at `~/.pi/agent/extensions/claude-mem/index.js`, with an ESM manifest and readable license notices. `PI_CODING_AGENT_DIR` overrides the agent directory. Installation and `pi status` confirm extension-file presence; they do not check the Pi version or verify automatic memory capture.

Pi 0.79.6 provides manual recall only. Automatic capture compatibility is source-reviewed for Pi 1.0.2 and 1.0.4; other or unknown versions need a compatibility check. Check your Pi version and update Pi yourself if needed using the [Pi capture compatibility and update guidance](./pi-native-capture.md#install-and-check-capture-compatibility). A compatible Pi host and Claude-Mem worker use Pi's genuine session ID, capture the prompt before tool results, and summarize once per turn. Worker failures leave Pi usable; excluded projects remain excluded.

Pi provides `mem_search`, `mem_timeline`, and `mem_get_observations`. Search for IDs, inspect a timeline, and fetch only the useful records. Context injection uses the worker's checkout resolver. Observations are labeled `pi`.

```sh
npx claude-mem pi status
npx claude-mem pi uninstall
```

The installed extension keeps the contributor's MIT text in `LICENSE.txt`, the complete project Apache license and notice in `CLAUDE-MEM-LICENSE.txt` and `CLAUDE-MEM-NOTICE.txt`, and TypeBox's MIT license and version provenance in `TYPEBOX-LICENSE.txt` and `TYPEBOX-PROVENANCE.json`. Install preflights these package inputs, replaces only its seven owned files, and restores the previous files if replacement fails. Uninstall preserves unrelated files.

The recall design and text extraction build on [husniadil/pi-mem](https://github.com/husniadil/pi-mem), by Husni Adil Makmur, under MIT. The original [Pi adapter PR #2532](https://github.com/thedotmack/claude-mem/pull/2532) was closed by its author because native Pi uses HTTP. This integration follows that HTTP design.

## DeepSeek Harness

Install DSH and its package manager (`pnpm`) first, then:

```sh
npx claude-mem install --ide dsh --dsh-profile web
```

`web` is the default profile for DSH 0.2; start it with `dsh web`. Choose another profile with `--dsh-profile`, including an existing `tui` profile on an older host. The installer uses DSH's own `plugin --profile <name> add --workspace-root` command to install the bundled `@claude-mem/dsh` package in that profile's pnpm workspace. Restart DSH and start or restart the Claude-Mem worker. The plugin awaits DSH's `agent/created` event to inject checkout context before the first turn. It offers `mem_search`, `mem_timeline`, `mem_get_observations`, `mem_save`, and `mem_context`.

Automatic capture belongs to the worker's existing DSH transcript watcher. The installer adds one managed watch under `~/.dsh/sessions` (`DSH_HOME` overrides the directory), using the configured `CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH`. New installations start at the end of existing transcripts, avoiding an unexpected historical import. Current and legacy tool results use the real session-header ID, which survives a watcher restart, and `turn/end` summarizes once per turn. Existing user-managed DSH watches remain authoritative and are preserved during uninstall. Plugin ingestion and plugin summarization are off, so live capture has one writer.

The plugin uses the worker's configured address and timeout. `DSH_MEM_BASE_URL` or the plugin's `baseUrl` configuration can point recall at another worker; a remote address does not auto-start a local worker. Remote recall does not change the local transcript watch.

This integration adapts [Bleed00/dsh-claude-mem](https://github.com/Bleed00/dsh-claude-mem), by Bleed00, under Apache-2.0. Its complete project Apache license, Bleed00 attribution, project notice, and all eight bundled dependency licenses ship with the local package passed to DSH.

## Diagnostics and limits

Use `npx claude-mem doctor` if the worker is unavailable. Pi and DSH honor persisted worker settings and environment overrides. A missing native bundle or failed DSH package-manager command is reported as an install failure. If the plugin installs but transcript setup is incomplete, the installer reports a warning with a retry command. Explicitly disabled transcript capture is preserved and reported.

Pi and DSH currently require `--runtime worker`; the installer rejects their combination with server runtime before copying files. Full `npx claude-mem uninstall` removes the managed extension, DSH plugin from recorded profiles, and managed watch while retaining unrelated host settings.

Source changes require `npm run build` before packing or installing from a checkout. Native bundles are produced by the release build and included in the npm package. The build preflights attribution before output writes, checks the exact supported TypeBox 1.1.24 package and full license, and bundles that same resolved entry. Update the dependency pin and full notice together for a later TypeBox version. Marketplace copies include the current root `LICENSE` and `NOTICE` pair.
