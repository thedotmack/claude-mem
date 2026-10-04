# Native harness integrations

Memory provider selection and account sign-in follow the existing installer flow.

## Pi

```sh
npx claude-mem install --ide pi
```

Restart Pi. The installer places a self-contained extension at `~/.pi/agent/extensions/claude-mem/index.js`, with an ESM manifest and the contributor's license. `PI_CODING_AGENT_DIR` overrides the agent directory. The extension uses Pi's session manager ID and current working directory, posts each prompt before tool results, and summarizes once per turn. It never manufactures a session at startup. Worker failures leave Pi usable; excluded projects remain excluded.

Pi provides `mem_search`, `mem_timeline`, and `mem_get_observations`. Search for IDs, inspect a timeline, and fetch only the useful records. Context injection uses the worker's checkout resolver. Observations are labeled `pi`.

```sh
npx claude-mem pi status
npx claude-mem pi uninstall
```

The recall design and text extraction build on [husniadil/pi-mem](https://github.com/husniadil/pi-mem), by Husni Adil Makmur, under MIT. The original [Pi adapter PR #2532](https://github.com/thedotmack/claude-mem/pull/2532) was closed by its author because native Pi uses HTTP. This integration follows that HTTP design.

## DeepSeek Harness

Install DSH and its package manager (`pnpm`) first, then:

```sh
npx claude-mem install --ide dsh --dsh-profile tui
```

`tui` is the default profile; choose another profile with `--dsh-profile`. The installer uses DSH's own `plugin --profile <name> add` command to install the bundled `@claude-mem/dsh` package. Restart DSH and start or restart the Claude-Mem worker. The plugin awaits DSH's `agent/created` event to inject checkout context before the first turn. It offers `mem_search`, `mem_timeline`, `mem_get_observations`, `mem_save`, and `mem_context`.

Automatic capture belongs to the worker's existing DSH transcript watcher. The installer adds one managed watch under `~/.dsh/sessions` (`DSH_HOME` overrides the directory), using the configured `CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH`. New installations start at the end of existing transcripts, avoiding an unexpected historical import. Existing user-managed DSH watches remain authoritative and are preserved during uninstall. Plugin ingestion and plugin summarization are off, so live capture has one writer.

The plugin uses the worker's configured address and timeout. `DSH_MEM_BASE_URL` or the plugin's `baseUrl` configuration can point recall at another worker; a remote address does not auto-start a local worker. Remote recall does not change the local transcript watch.

This integration adapts [Bleed00/dsh-claude-mem](https://github.com/Bleed00/dsh-claude-mem), by Bleed00, under Apache-2.0. Its license, notice, and bundled dependency licenses ship with the package.

## Diagnostics and limits

Use `npx claude-mem doctor` if the worker is unavailable. Pi and DSH honor persisted worker settings and environment overrides. A missing native bundle or failed DSH package-manager command is reported as an install failure. If the plugin installs but transcript setup is incomplete, the installer reports a warning with a retry command. Explicitly disabled transcript capture is preserved and reported.

Pi and DSH currently require `--runtime worker`; the installer rejects their combination with server runtime before copying files. Full `npx claude-mem uninstall` removes the managed extension, DSH plugin from recorded profiles, and managed watch while retaining unrelated host settings.

Source changes require `npm run build` before packing or installing from a checkout. Native bundles are produced by the release build and included in the npm package.
