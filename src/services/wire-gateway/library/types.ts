// SPDX-License-Identifier: Apache-2.0
//
// The Library (plan Phase 14): one data-driven engine that writes
// claude-mem's hooks, MCP server, instruction block, skills and plugin
// bundles into each agent and records what it wrote, so it removes only that.
// Modeled on magpie's internal/library (hooks.go, mcp.go, instructions.go,
// skills.go, sync.go, backup.go), MIT, Copyright (c) 2026 yetone.
//
// An installer describes what it wants as LibraryItems; the engine
// (library-engine.ts) decides, per item, whether to write, keep, leave to
// the user or remove it, and edits each file through one path:
//   json  → json-file-edit.ts (canonical files re-render byte for byte as
//           before; any other file is edited in place with the Phase 7
//           JSONC editor, so a user's formatting and comments survive)
//   toml/yaml → the Phase 7 editors
//   text  → text-block.ts (marker-delimited blocks)

/**
 * Exit code of `claude-mem library install <agent>` when the agent's hooks
 * went in but its MCP server did not (Cursor, Kimi), so the npx installer
 * running it in a Bun child can say which half failed.
 */
export const LIBRARY_INSTALL_MCP_STEP_FAILED_EXIT_CODE = 3;

/**
 * Stands in for a claude-mem script path (worker-service.cjs, mcp-server.cjs)
 * a remove cannot find, because the plugin folder is gone. A remove matches
 * claude-mem's entries by its record and their signatures, never by the
 * command an install would write, so it needs no real path. The engine
 * refuses to write any item that carries it.
 */
export const SCRIPT_PATH_NOT_FOUND_FOR_REMOVAL = '<claude-mem script not found: removal only>';

/**
 * What an item is, as the plan names it (task 1), plus `setting`: a value
 * claude-mem needs set for its other items to load. No installer gives an
 * agent skills yet, so `skills` has no item place; the record keeps its list
 * (the plan's shape) for when one does.
 */
export type LibraryItemKind = 'hook' | 'mcp' | 'instructions' | 'skills' | 'bundle' | 'setting';

export type LibraryConfigFormat = 'json' | 'toml' | 'yaml';

/** JSON-compatible value an item writes. */
export type LibraryValue = null | boolean | number | string | LibraryValue[] | { [key: string]: LibraryValue };

interface LibraryItemBase {
  kind: LibraryItemKind;
  /** Stable within the agent: the record is keyed by it (`hook:stop:0`, `mcp:/home/u/.cursor/mcp.json`). */
  id: string;
  /**
   * The set this item belongs to. An apply names the groups it owns; a
   * recorded item of an owned group that the apply no longer lists is
   * removed (an event an upgrade dropped). Items of other groups are kept
   * (another workspace's rules file).
   */
  group: string;
}

/** One entry appended to a JSON array (`hooks.<event>`, `watches`, `plugin`). Ownership: the entry's canonical JSON. */
export interface JsonArrayEntryItem extends LibraryItemBase {
  place: 'json-array-entry';
  file: string;
  arrayKeyPath: string[];
  entry: LibraryValue;
  /**
   * Entries claude-mem wrote before the Library kept a record (matched by
   * their command signature). They are replaced while the record holds
   * nothing in this file yet; afterwards only recorded entries are claude-mem's.
   */
  isPreLibraryEntry?: (entry: unknown) => boolean;
  /** A scalar where the array belongs (OpenCode's `plugin: "x"`) is taken as a one-entry array. */
  scalarIsOneEntryArray?: boolean;
}

/** One value at a key path of a JSON, TOML or YAML file. Ownership: the value, and what was there before. */
export interface ConfigMemberItem extends LibraryItemBase {
  place: 'member';
  file: string;
  format: LibraryConfigFormat;
  keyPath: string[];
  value: LibraryValue;
  /**
   * What to do when the key already holds a value claude-mem has no record of:
   *  - `adopt`: the key is claude-mem's by name (`claude-mem` in mcpServers;
   *    an earlier install wrote it): it is set, and a remove deletes it.
   *  - `replace-and-stash`: it is set, and the value that was there is put
   *    back by a remove (a feature flag, a marketplace registration).
   *  - `leave`: the user's (a generic name, like Kimi's `mcp-search`).
   */
  whenUnrecorded: 'adopt' | 'replace-and-stash' | 'leave';
  /**
   * Values an earlier claude-mem install wrote here; a remove takes them out
   * even with no record. With `replace-and-stash`, such a value found before
   * the first write is claude-mem's, not the user's: it is not stashed as
   * what to put back (see `valueAfterRemoveOfPreLibraryValue`).
   */
  isPreLibraryValue?: (value: unknown) => boolean;
  /**
   * What a remove leaves at the key when what was there before claude-mem's
   * first write was claude-mem's own pre-Library value (Codex: `enabled =
   * false`, as uninstall always left a claude-mem plugin). Absent: the key is
   * deleted.
   */
  valueAfterRemoveOfPreLibraryValue?: LibraryValue;
  /**
   * When a remove leaves the object holding this key empty, take that object
   * out too: it exists only for claude-mem (OpenCode's `mcp`, agy's named
   * `claude-mem` hook). Applies to recorded, adopted and pre-Library values.
   */
  dropEmptiedParentOnRemove?: boolean;
  /**
   * Written only when absent and never removed: something of the user's may
   * rely on it (the DSH transcript schema a user's own watch can name, which
   * the pre-Library uninstall kept). A remove drops it from the record and
   * leaves the file's other bytes as they are.
   */
  keepOnRemove?: boolean;
  /** Set only when the key is absent (OpenClaw's plugin config defaults); never overwrites. */
  onlyWhenAbsent?: boolean;
}

/** Where a new marker block goes in a text file that has none. */
export type TextBlockPlacement =
  /** Kimi's managed TOML block: after one blank line (none when the file is empty), a newline after it. */
  | 'after-blank-line'
  /** The shared context injector: after the text with its trailing whitespace trimmed and a blank line. */
  | 'after-trimmed-text'
  /** GEMINI.md: like after-blank-line, but a block already there is left as it is. */
  | 'once-after-blank-line';

/** A marker-delimited block in a text file (Markdown instructions, Kimi's TOML hooks). */
export interface TextBlockItem extends LibraryItemBase {
  place: 'text-block';
  file: string;
  open: string;
  close: string;
  body: string;
  placement: TextBlockPlacement;
  /** A file that does not exist yet starts with this line and a blank line. */
  headerLineForNewFile?: string;
  /**
   * claude-mem's runtime rewrites the block's body later (context refreshes),
   * so the block is claude-mem's by its markers, whatever its body. Without
   * this a block whose body the user changed is theirs (hash ownership).
   */
  bodyManagedAtRuntime?: boolean;
  /** Check the file still parses as this format after the edit (Kimi's TOML). */
  validateAs?: 'toml';
}

/** A whole file claude-mem owns: plugin bundle files, OMP's hook module, rules files. */
export interface OwnedFileItem extends LibraryItemBase {
  place: 'file';
  path: string;
  /** null: record the path without writing (claude-mem's runtime already wrote it, e.g. generated context). */
  contents: Uint8Array | null;
  /** The bundle's own folder: removed when a remove leaves it empty. Folders above it are never removed. */
  bundleRoot?: string;
  /** claude-mem's runtime rewrites the file (context refreshes): it stays claude-mem's whatever its bytes. */
  contentsManagedAtRuntime?: boolean;
}

export type LibraryItem = JsonArrayEntryItem | ConfigMemberItem | TextBlockItem | OwnedFileItem;

/** How a JSON file is written when claude-mem re-renders it (canonical files only). */
export interface JsonFileStyle {
  /** End the file with a newline (Windsurf and Cursor write none). */
  finalNewline: boolean;
  /** The document a file that does not exist starts as (OpenCode's `$schema`). */
  initialDocument?: Record<string, LibraryValue>;
}

export type LibraryConfigEdit = { op: 'set'; keyPath: string[]; value: LibraryValue } | { op: 'delete'; keyPath: string[] };

/**
 * A change to an existing file before the items apply: claude-mem's own
 * pre-Library entries in older shapes (Antigravity's event-keyed hooks,
 * Codex's `[mcp_servers.mcp-search]`, the memory block an older install left
 * in AGENTS.md). Runs on every apply and remove; returns nothing when there
 * is nothing to migrate.
 */
export type LibraryMigration =
  | {
    file: string;
    format: LibraryConfigFormat;
    compute(document: unknown): LibraryConfigEdit[];
  }
  | {
    file: string;
    format: 'text';
    /** The file's new text, `{ deleteFile: true }`, or null to leave it. */
    computeText(text: string): { text: string } | { deleteFile: true } | null;
  };

export interface LibraryApplyRequest {
  agentId: string;
  items: LibraryItem[];
  /** The groups this apply owns (see LibraryItemBase.group). */
  ownedGroups: string[];
  jsonStyles?: Record<string, JsonFileStyle>;
  migrations?: LibraryMigration[];
}

export type LibraryItemOutcome =
  | 'written'
  | 'unchanged'
  | 'removed'
  | 'restored'
  | 'left-to-user'
  | 'skipped';

export interface LibraryItemReport {
  id: string;
  kind: LibraryItemKind;
  outcome: LibraryItemOutcome;
  detail?: string;
}

export interface LibraryApplyResult {
  agentId: string;
  items: LibraryItemReport[];
  filesWritten: string[];
  /** A change an earlier command left pending was rolled back first: what that did, file by file. */
  recoveryNotes?: string[];
}

/**
 * Each recovery note an installer's Library call returns is printed on its
 * own line with this prefix (library-runtime.ts), so a caller that captures
 * the installer's output (the npx install spinner, a Bun child) can pick the
 * notes out and show them even when the step succeeded.
 */
export const LIBRARY_RECOVERY_NOTE_PREFIX = 'claude-mem Library recovered an interrupted change: ';

/** The recovery notes in captured installer output (see LIBRARY_RECOVERY_NOTE_PREFIX). */
export function libraryRecoveryNotesIn(output: string): string[] {
  return output.split(/\r?\n/).filter((line) => line.startsWith(LIBRARY_RECOVERY_NOTE_PREFIX)).map((line) => line.slice(LIBRARY_RECOVERY_NOTE_PREFIX.length));
}

/** One change's backup folder; every apply and remove of one CLI invocation shares one (backups.ts). */
export interface LibraryBackupChangeHandle {
  keep(agentId: string, filePath: string, bytes: Uint8Array | null): void;
}

/** The parts of the environment the Library reads, injectable for tests. */
export interface LibraryContext {
  /** <DATA_DIR>/wire-gateway/library: library.json and backups/. */
  libraryDirectory: string;
  now?: () => Date;
  /** The backup change to keep first bytes in; default: this process's own (one per CLI invocation). */
  backupChange?: LibraryBackupChangeHandle;
  /**
   * Test seam: runs after a change's config files are written and before
   * library.json records them, the window a crash leaves for the pending
   * change in library.json to recover from.
   */
  afterConfigFilesWritten?: () => void;
}
