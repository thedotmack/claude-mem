
import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { getMcpServerAbsolutePath, getNodeAbsolutePath } from './install-paths.js';
import { readJsonSafe } from '../../utils/json-utils.js';
import { parseJsonWithBom, parseJsonc, stripUtf8Bom, writeJsonFileAtomic, writeTextFileAtomic } from '../../shared/atomic-json.js';
import { injectContextIntoMarkdownFile } from '../../utils/context-injection.js';

export const PLACEHOLDER_CONTEXT = `# claude-mem: Cross-Session Memory

*No context yet. Complete your first session and context will appear here.*

Use claude-mem's MCP search tools for manual memory queries.`;

export function buildMcpServerEntry(mcpServerPath: string): { command: string; args: string[] } {
  return {
    command: getNodeAbsolutePath(),
    args: [mcpServerPath],
  };
}

export function writeMcpJsonConfig(
  configFilePath: string,
  mcpServerPath: string,
  serversKeyName: string = 'mcpServers',
): void {
  const parentDirectory = path.dirname(configFilePath);
  mkdirSync(parentDirectory, { recursive: true });

  const existingConfig = readJsonSafe<Record<string, any>>(configFilePath, {});

  if (!existingConfig[serversKeyName]) {
    existingConfig[serversKeyName] = {};
  }

  existingConfig[serversKeyName]['claude-mem'] = buildMcpServerEntry(mcpServerPath);

  // Other MCP servers live in this file too, so replace it rather than truncate
  // it: an interrupted write must not leave a config every MCP host then fails
  // to parse. writeJsonFileAtomic writes the same bytes via a temp file + rename.
  writeJsonFileAtomic(configFilePath, existingConfig);
}

interface McpInstallerConfig {
  ideId: string;
  ideLabel: string;
  configPath: string;
  configKey: 'servers' | 'mcpServers';
  contextPath?: string;
}

function installMcpIntegration(config: McpInstallerConfig): () => Promise<number> {
  return async (): Promise<number> => {
    console.log(`\nInstalling Claude-Mem MCP integration for ${config.ideLabel}...\n`);

    const mcpServerPath = getMcpServerAbsolutePath();
    if (!mcpServerPath) {
      console.error('Could not find MCP server script');
      console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/mcp-server.cjs');
      return 1;
    }

    const configPath = config.configPath;

    const skipWarpConfigWrite = config.ideId === 'warp' && !existsSync(path.dirname(configPath));

    const contextPath = config.contextPath;

    try {
      writeMcpConfigAndContext(config, configPath, mcpServerPath, skipWarpConfigWrite, contextPath);
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\nInstallation failed: ${message}`);
      return 1;
    }
  };
}

function writeMcpConfigAndContext(
  config: McpInstallerConfig,
  configPath: string,
  mcpServerPath: string,
  skipWarpConfigWrite: boolean,
  contextPath: string | undefined,
): void {
  if (skipWarpConfigWrite) {
    console.log(`  Note: ~/.warp/ not found. MCP may need to be configured via Warp Drive UI.`);
  } else {
    writeMcpJsonConfig(configPath, mcpServerPath, config.configKey);
    console.log(`  MCP config written to: ${configPath}`);
  }

  if (contextPath) {
    injectContextIntoMarkdownFile(contextPath, PLACEHOLDER_CONTEXT);
    console.log(`  Context placeholder written to: ${contextPath}`);
  }

  const summaryLines = [`\nInstallation complete!\n`];
  summaryLines.push(`MCP config:  ${configPath}`);
  if (contextPath) {
    summaryLines.push(`Context:     ${contextPath}`);
  }
  summaryLines.push('');
  summaryLines.push(`Note: This is an MCP-only integration providing search tools and context.`);
  summaryLines.push(`Transcript capture is not available for ${config.ideLabel}.`);
  if (config.ideId === 'warp') {
    summaryLines.push('If MCP config via file is not supported, configure MCP through Warp Drive UI.');
  }
  summaryLines.push('');
  summaryLines.push('Next steps:');
  summaryLines.push('  1. Start claude-mem worker: npx claude-mem start');
  summaryLines.push(`  2. Restart ${config.ideLabel} to pick up the MCP server`);
  summaryLines.push('');
  console.log(summaryLines.join('\n'));
}

const COPILOT_CLI_CONFIG: McpInstallerConfig = {
  ideId: 'copilot-cli',
  ideLabel: 'Copilot CLI',
  // Copilot CLI loads user-level MCP servers from mcp-config.json in its config
  // directory: ~/.copilot, or the directory COPILOT_HOME names.
  configPath: path.join(process.env.COPILOT_HOME || path.join(homedir(), '.copilot'), 'mcp-config.json'),
  configKey: 'mcpServers',
  contextPath: path.join(process.cwd(), '.github', 'copilot-instructions.md'),
};

/** Remove claude-mem from Copilot CLI's MCP servers so Copilot stops launching a deleted MCP server. Returns 0 when an entry was removed. */
export function uninstallCopilotCliMcpIntegration(): number {
  const { configPath } = COPILOT_CLI_CONFIG;
  const config = readJsonSafe<Record<string, any>>(configPath, {});
  if (!config.mcpServers?.['claude-mem']) return 1;
  delete config.mcpServers['claude-mem'];
  writeJsonFileAtomic(configPath, config);
  console.log(`  Removed claude-mem from the Copilot CLI MCP servers in: ${configPath}`);
  return 0;
}

const ROO_CODE_CONFIG: McpInstallerConfig = {
  ideId: 'roo-code',
  ideLabel: 'Roo Code',
  configPath: path.join(process.cwd(), '.roo', 'mcp.json'),
  configKey: 'mcpServers',
  contextPath: path.join(process.cwd(), '.roo', 'rules', 'claude-mem-context.md'),
};

const WARP_CONFIG: McpInstallerConfig = {
  ideId: 'warp',
  ideLabel: 'Warp',
  configPath: path.join(homedir(), '.warp', '.mcp.json'),
  configKey: 'mcpServers',
  contextPath: path.join(process.cwd(), 'WARP.md'),
};

/** Remove claude-mem from Warp's global MCP servers so Warp stops launching a deleted MCP server. Returns 0 when an entry was removed. */
export function uninstallWarpMcpIntegration(): number {
  const { configPath } = WARP_CONFIG;
  const config = readJsonSafe<Record<string, any>>(configPath, {});
  if (!config.mcpServers?.['claude-mem']) return 1;
  delete config.mcpServers['claude-mem'];
  writeJsonFileAtomic(configPath, config);
  console.log(`  Removed claude-mem from the Warp MCP servers in: ${configPath}`);
  return 0;
}

/** Goose reads config.yaml from %APPDATA%\Block\goose\config on Windows and ~/.config/goose on macOS and Linux (crates/goose/src/config/paths.rs). */
export function getGooseConfigPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(homedir(), 'AppData', 'Roaming');
    return path.win32.join(appData, 'Block', 'goose', 'config', 'config.yaml');
  }
  return path.join(homedir(), '.config', 'goose', 'config.yaml');
}

function buildGooseClaudeMemExtensionLines(mcpServerPath: string, indent: string): string[] {
  return [
    `${indent}claude-mem:`,
    `${indent}  enabled: true`,
    `${indent}  type: stdio`,
    `${indent}  name: claude-mem`,
    `${indent}  cmd: ${JSON.stringify(getNodeAbsolutePath())}`,
    `${indent}  args:`,
    `${indent}    - ${JSON.stringify(mcpServerPath)}`,
    `${indent}  timeout: 300`,
  ];
}

function leadingSpaceCount(line: string): number {
  return line.length - line.trimStart().length;
}

function isYamlContentLine(line: string): boolean {
  return line.trim() !== '' && !line.trimStart().startsWith('#');
}

/** What follows `key:` when `line` is that key at `indent`, written plain or quoted; null for any other line. */
function yamlKeyLineRest(line: string, indent: string, key: string): string | null {
  const match = new RegExp(`^${indent}(["']?)${key}\\1:`).exec(line);
  if (!match) return null;
  const rest = line.slice(match[0].length);
  return rest === '' || /^\s/.test(rest) ? rest : null;
}

interface GooseExtensionsSpan {
  lines: string[];
  /** Line of the top-level `extensions:` key. */
  header: number;
  /** First line after the mapping (the next top-level key, or end of file). */
  end: number;
  indent: string;
  /** The claude-mem entry's [start, end) lines, or null when there is none. */
  claudeMemEntry: [number, number] | null;
}

/** Where the top-level `extensions` mapping and its claude-mem entry sit in `content`; null when there is no such mapping. */
function findGooseExtensionsSpan(content: string): GooseExtensionsSpan | null {
  const lines = content.split('\n');
  const header = lines.findIndex(line => yamlKeyLineRest(line, '', 'extensions') !== null);
  if (header === -1) return null;
  if (isYamlContentLine(yamlKeyLineRest(lines[header], '', 'extensions')!)) {
    throw new Error('Goose config.yaml sets extensions inline; write it as a block mapping and try again');
  }

  // The mapping runs to the next top-level key; entries keep the indent of those already there.
  let end = header + 1;
  while (end < lines.length && !(isYamlContentLine(lines[end]) && leadingSpaceCount(lines[end]) === 0)) end++;
  const firstEntry = lines.slice(header + 1, end).find(isYamlContentLine);
  const indent = ' '.repeat(firstEntry ? leadingSpaceCount(firstEntry) : 2);

  const existing = lines.findIndex((line, index) => index > header && index < end && yamlKeyLineRest(line, indent, 'claude-mem') !== null);
  if (existing === -1) return { lines, header, end, indent, claudeMemEntry: null };
  // The entry runs to the next sibling; blank lines and comments just before it stay with it.
  let existingEnd = existing + 1;
  while (existingEnd < end && !(isYamlContentLine(lines[existingEnd]) && leadingSpaceCount(lines[existingEnd]) <= indent.length)) {
    existingEnd++;
  }
  while (existingEnd > existing + 1 && !isYamlContentLine(lines[existingEnd - 1])) existingEnd--;
  return { lines, header, end, indent, claudeMemEntry: [existing, existingEnd] };
}

/**
 * `content` with claude-mem set in the top-level `extensions` mapping, the
 * only place Goose starts MCP servers from: it never reads a `mcpServers` key
 * in config.yaml. Every other line stays as written, including the
 * `mcpServers` block that earlier installs left behind.
 */
function upsertGooseExtension(content: string, mcpServerPath: string): string {
  const span = findGooseExtensionsSpan(content);
  if (!span) {
    const lines = content.trimEnd() ? content.trimEnd().split('\n') : [];
    const documentEnd = lines.findIndex(line => /^\.\.\.(?:\s|$)/.test(line));
    // Entries after `...` are outside the YAML document and cannot be loaded.
    lines.splice(documentEnd === -1 ? lines.length : documentEnd, 0,
      'extensions:', ...buildGooseClaudeMemExtensionLines(mcpServerPath, '  '));
    return lines.join('\n') + '\n';
  }
  const { lines, header, indent, claudeMemEntry } = span;
  const extension = buildGooseClaudeMemExtensionLines(mcpServerPath, indent);
  if (!claudeMemEntry) {
    return [...lines.slice(0, header + 1), ...extension, ...lines.slice(header + 1)].join('\n');
  }
  return [...lines.slice(0, claudeMemEntry[0]), ...extension, ...lines.slice(claudeMemEntry[1])].join('\n');
}

/**
 * `content` without the claude-mem entry under `extensions` (and without the
 * `extensions:` key itself when nothing else is left in it); null when there
 * is no entry to remove.
 */
function removeGooseExtension(content: string): string | null {
  const span = findGooseExtensionsSpan(content);
  if (!span?.claudeMemEntry) return null;
  const { lines, header, end, claudeMemEntry: [entryStart, entryEnd] } = span;
  const remaining = [...lines.slice(0, entryStart), ...lines.slice(entryEnd)];
  const removedCount = entryEnd - entryStart;
  const mappingStillHasEntries = remaining.slice(header + 1, end - removedCount).some(isYamlContentLine);
  if (!mappingStillHasEntries) remaining.splice(header, 1);
  return remaining.join('\n');
}

export async function installGooseMcpIntegration(): Promise<number> {
  console.log('\nInstalling Claude-Mem MCP integration for Goose...\n');

  const mcpServerPath = getMcpServerAbsolutePath();
  if (!mcpServerPath) {
    console.error('Could not find MCP server script');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/mcp-server.cjs');
    return 1;
  }

  const configPath = getGooseConfigPath();
  const configDirectory = path.dirname(configPath);

  try {
    mkdirSync(configDirectory, { recursive: true });
    mergeGooseYamlConfig(configPath, mcpServerPath);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}

/** Remove claude-mem from Goose's extensions so Goose stops launching a deleted MCP server. Returns 0 when an entry was removed. */
export function uninstallGooseMcpIntegration(configPath: string = getGooseConfigPath()): number {
  if (!existsSync(configPath)) return 1;
  const updated = removeGooseExtension(stripUtf8Bom(readFileSync(configPath, 'utf-8')));
  if (updated === null) return 1;
  // The Goose config is a user-owned YAML file other extensions share: write it
  // through a temp file and a rename so an interrupted uninstall cannot leave a
  // half-written config.yaml that stops Goose from starting.
  writeTextFileAtomic(configPath, updated);
  console.log(`  Removed claude-mem from the Goose extensions of: ${configPath}`);
  return 0;
}

export function mergeGooseYamlConfig(configPath: string, mcpServerPath: string): void {
  const yamlContent = existsSync(configPath) ? stripUtf8Bom(readFileSync(configPath, 'utf-8')) : '';
  writeTextFileAtomic(configPath, upsertGooseExtension(yamlContent, mcpServerPath));
  console.log(`  Registered claude-mem in the Goose extensions of: ${configPath}`);

  console.log(`
Installation complete!

MCP config:  ${configPath}

Note: This is an MCP-only integration providing search tools and context.
Transcript capture is not available for Goose.

Next steps:
  1. Start claude-mem worker: npx claude-mem start
  2. Restart Goose to pick up the MCP server
`);
}

/**
 * Zed reads MCP servers from the `context_servers` key of settings.json —
 * `~/.config/zed/settings.json` on Linux and macOS, `%APPDATA%\Zed\settings.json`
 * on Windows (zed.dev/docs/ai/mcp). The `mcpServers` key is silently ignored
 * by Zed, so a Zed entry must never be written under that name. A project-level
 * `.zed/settings.json` exists too, but it is typically committed to git, so
 * the installer only ever writes the user-level file: an absolute local MCP
 * path must not leak into a shared repo.
 */
export function getZedSettingsPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(homedir(), 'AppData', 'Roaming');
    return path.win32.join(appData, 'Zed', 'settings.json');
  }
  const configHome = env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  return path.join(configHome, 'zed', 'settings.json');
}

/**
 * Owner-only dated backup of an existing settings file, taken before any
 * write. Same semantics as KimiHooksInstaller.backupOnce: one backup per day,
 * never overwritten, mode 0o600 because settings.json can hold provider keys.
 * settings.json is the user's whole editor config, not a claude-mem-owned
 * file, so install must never be the first thing to touch it without a copy.
 */
function backupZedSettingsOnce(configPath: string): void {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const backupPath = `${configPath}.bak-${stamp}`;
  if (existsSync(configPath) && !existsSync(backupPath)) {
    writeFileSync(backupPath, readFileSync(configPath, 'utf-8'), { mode: 0o600 });
  }
}

function corruptZedSettingsError(configPath: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`Corrupt JSON file, refusing to overwrite: ${configPath}: ${detail}`);
}

/**
 * Read Zed's settings.json. A file that parses as strict JSON takes the
 * exact current path. A file Zed itself reads fine but strict JSON.parse
 * refuses — comments or trailing commas — is parsed as JSONC instead, and
 * `jsonc` tells the caller the file must be edited textually so its
 * comments survive. A file that parses as neither is corrupt and throws,
 * so install/uninstall never overwrite it.
 */
function readZedSettings(configPath: string): { config: Record<string, any>; jsonc: boolean; raw: string } {
  const raw = readFileSync(configPath, 'utf-8');
  try {
    return { config: parseJsonWithBom<Record<string, any>>(raw), jsonc: false, raw };
  } catch (strictError) {
    try {
      return { config: parseJsonc<Record<string, any>>(raw), jsonc: true, raw };
    } catch {
      throw corruptZedSettingsError(configPath, strictError);
    }
  }
}

/** Index just past any whitespace and `//` / `/* *\/` comments from `i`. */
function skipJsoncTrivia(text: string, i: number): number {
  for (;;) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const newline = text.indexOf('\n', i + 2);
      i = newline === -1 ? text.length : newline + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new Error('Unterminated block comment in Zed settings');
      i = end + 2;
      continue;
    }
    return i;
  }
}

/** Index just past the JSON string starting at `i` (which must be `"`). */
function scanJsoncString(text: string, i: number): number {
  i++;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === '"') return i + 1;
    if (text[i] === '\n') throw new Error('Unterminated string in Zed settings');
    i++;
  }
  throw new Error('Unterminated string in Zed settings');
}

/** Index just past the JSON value starting at `i` (after trivia). */
function scanJsoncValue(text: string, i: number): number {
  i = skipJsoncTrivia(text, i);
  const ch = text[i];
  if (ch === '"') return scanJsoncString(text, i);
  if (ch === '{' || ch === '[') {
    const open = ch;
    const close = ch === '{' ? '}' : ']';
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i = scanJsoncString(text, i);
        continue;
      }
      if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
        i = skipJsoncTrivia(text, i);
        continue;
      }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    throw new Error('Unterminated value in Zed settings');
  }
  // Literal or number: runs to the next structural character.
  while (i < text.length && text[i] !== ',' && text[i] !== '}' && text[i] !== ']') i++;
  return i;
}

interface JsoncMemberSpan {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
  commaAfter: number;
}

/** Every member of the object starting at `objStart` (`{`). */
function scanJsoncObjectMembers(text: string, objStart: number, objEnd: number): JsoncMemberSpan[] {
  const members: JsoncMemberSpan[] = [];
  let i = skipJsoncTrivia(text, objStart + 1);
  while (i < objEnd) {
    if (text[i] === '}') return members;
    const keyStart = i;
    if (text[i] !== '"') throw new Error('Expected a string key in Zed settings');
    const keyEnd = scanJsoncString(text, i);
    let key: unknown;
    try {
      key = JSON.parse(text.slice(keyStart, keyEnd));
    } catch {
      throw new Error('Invalid object key in Zed settings');
    }
    if (typeof key !== 'string') throw new Error('Expected a string key in Zed settings');
    i = skipJsoncTrivia(text, keyEnd);
    if (text[i] !== ':') throw new Error('Expected ":" after an object key in Zed settings');
    i = skipJsoncTrivia(text, i + 1);
    const valueStart = i;
    const valueEnd = scanJsoncValue(text, i);
    i = skipJsoncTrivia(text, valueEnd);
    let commaAfter = -1;
    if (text[i] === ',') {
      commaAfter = i;
      i = skipJsoncTrivia(text, i + 1);
    } else if (text[i] !== '}') {
      throw new Error('Expected "," or "}" in Zed settings');
    }
    members.push({ key, keyStart, valueStart, valueEnd, commaAfter });
  }
  return members;
}

/** The whitespace indent of the line containing `pos`. */
function jsoncLineIndent(text: string, pos: number): string {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const match = /^[ \t]*/.exec(text.slice(lineStart, pos));
  return match ? match[0] : '';
}

/** Serialize `value` as 2-space JSON, continuation lines indented by `indent`. */
function formatJsoncValue(value: unknown, indent: string): string {
  const lines = JSON.stringify(value, null, 2).split('\n');
  return [lines[0], ...lines.slice(1).map((line) => indent + line)].join('\n');
}

/**
 * Insert a `"key": value` member (already formatted as `memberText`) into
 * the object spanning [objStart, objEnd), preserving every existing byte:
 * comments, trailing commas and other members are untouched.
 * `memberIndent` is the indent the new member's line gets.
 */
function insertJsoncMember(text: string, objStart: number, objEnd: number, memberText: string, memberIndent: string): string {
  const members = scanJsoncObjectMembers(text, objStart, objEnd);
  if (members.length === 0) {
    const objIndent = jsoncLineIndent(text, objStart);
    const needsCloseNewline = text[objStart + 1] === '}';
    return (
      text.slice(0, objStart + 1) +
      '\n' +
      memberIndent +
      memberText +
      (needsCloseNewline ? '\n' + objIndent : '') +
      text.slice(objStart + 1)
    );
  }
  const last = members[members.length - 1];
  if (last.commaAfter !== -1) {
    return text.slice(0, last.commaAfter + 1) + '\n' + memberIndent + memberText + text.slice(last.commaAfter + 1);
  }
  return text.slice(0, last.valueEnd) + ',\n' + memberIndent + memberText + text.slice(last.valueEnd);
}

/**
 * Remove one member from the object spanning [objStart, objEnd), keeping
 * the file valid: a following comma goes with the member when there is
 * one; otherwise the comma separating it from the previous member is
 * kept, which restores a trailing comma the file already had. Returns
 * null when the key is absent.
 */
function removeJsoncMember(text: string, objStart: number, objEnd: number, key: string): string | null {
  const members = scanJsoncObjectMembers(text, objStart, objEnd);
  const index = members.findIndex((m) => m.key === key);
  if (index === -1) return null;
  const member = members[index];
  if (index < members.length - 1) {
    // A comma follows this member: take the whole line with it.
    const lineStart = text.lastIndexOf('\n', member.keyStart - 1) + 1;
    const start = /^\s*$/.test(text.slice(lineStart, member.keyStart)) ? lineStart : member.keyStart;
    let end = member.commaAfter + 1;
    if (text[end] === '\n') end++;
    return text.slice(0, start) + text.slice(end);
  }
  if (index > 0) {
    // Last member: the comma before it separates it from the previous
    // one, and keeping it preserves a trailing comma the file already had.
    return text.slice(0, members[index - 1].commaAfter + 1) + text.slice(member.valueEnd);
  }
  // Only member: take its line too, plus the newline after its value.
  const lineStart = text.lastIndexOf('\n', member.keyStart - 1) + 1;
  const start = /^\s*$/.test(text.slice(lineStart, member.keyStart)) ? lineStart : member.keyStart;
  let end = member.valueEnd;
  const after = skipJsoncTrivia(text, end);
  if (text[after] === '}' && text.slice(end, after).includes('\n')) {
    end = text.indexOf('\n', end) + 1;
  }
  return text.slice(0, start) + text.slice(end);
}

/**
 * Insert or replace the `claude-mem` entry inside `context_servers`,
 * editing only that member in the original text: comments, trailing
 * commas and every unrelated setting survive byte for byte. The caller
 * has already validated the file parses as JSONC.
 */
function upsertZedContextServer(raw: string, entry: { command: string; args: string[] }): string {
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = stripUtf8Bom(raw);
  const objStart = skipJsoncTrivia(text, 0);
  if (text[objStart] !== '{') throw new Error('Zed settings must be a JSON object');
  const objEnd = scanJsoncValue(text, objStart);
  const topMembers = scanJsoncObjectMembers(text, objStart, objEnd);
  const servers = topMembers.find((m) => m.key === 'context_servers');
  const topIndent = jsoncLineIndent(text, objStart) + '  ';
  if (!servers) {
    const memberText = `"context_servers": ${formatJsoncValue({ 'claude-mem': entry }, topIndent)}`;
    return bom + insertJsoncMember(text, objStart, objEnd, memberText, topIndent);
  }
  const serversObjStart = skipJsoncTrivia(text, servers.valueStart);
  if (text[serversObjStart] !== '{') throw new Error('Zed settings context_servers must be an object');
  const serversObjEnd = scanJsoncValue(text, serversObjStart);
  const inner = scanJsoncObjectMembers(text, serversObjStart, serversObjEnd);
  const innerIndent = jsoncLineIndent(text, serversObjStart) + '  ';
  const existing = inner.find((m) => m.key === 'claude-mem');
  if (existing) {
    const formatted = formatJsoncValue(entry, jsoncLineIndent(text, existing.keyStart));
    return bom + text.slice(0, existing.valueStart) + formatted + text.slice(existing.valueEnd);
  }
  const memberText = `"claude-mem": ${formatJsoncValue(entry, innerIndent)}`;
  return bom + insertJsoncMember(text, serversObjStart, serversObjEnd, memberText, innerIndent);
}

/**
 * Remove the `claude-mem` entry from `context_servers`, editing only
 * that member in the original text. Returns null when there is no such
 * entry. The caller has already checked ownership from the parsed model.
 */
function removeZedContextServer(raw: string): string | null {
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = stripUtf8Bom(raw);
  const objStart = skipJsoncTrivia(text, 0);
  if (text[objStart] !== '{') throw new Error('Zed settings must be a JSON object');
  const objEnd = scanJsoncValue(text, objStart);
  const topMembers = scanJsoncObjectMembers(text, objStart, objEnd);
  const servers = topMembers.find((m) => m.key === 'context_servers');
  if (!servers) return null;
  const serversObjStart = skipJsoncTrivia(text, servers.valueStart);
  if (text[serversObjStart] !== '{') throw new Error('Zed settings context_servers must be an object');
  const serversObjEnd = scanJsoncValue(text, serversObjStart);
  const next = removeJsoncMember(text, serversObjStart, serversObjEnd, 'claude-mem');
  return next === null ? null : bom + next;
}

/**
 * Write the claude-mem entry into Zed's settings.json. A file that
 * parses as strict JSON takes the existing whole-file path
 * (writeMcpJsonConfig). A JSONC file — comments or trailing commas — is
 * edited textually so its comments survive (see upsertZedContextServer).
 * A file that parses as neither is refused, never overwritten.
 */
function writeZedMcpJsonConfig(configPath: string, mcpServerPath: string): void {
  const parentDirectory = path.dirname(configPath);
  mkdirSync(parentDirectory, { recursive: true });
  if (!existsSync(configPath)) {
    writeMcpJsonConfig(configPath, mcpServerPath, 'context_servers');
    return;
  }
  const { config, jsonc, raw } = readZedSettings(configPath);
  const servers = (config as Record<string, any>).context_servers;
  if (servers !== undefined && (typeof servers !== 'object' || servers === null || Array.isArray(servers))) {
    throw new Error(`Zed settings context_servers must be an object, refusing to overwrite: ${configPath}`);
  }
  if (!jsonc) {
    writeMcpJsonConfig(configPath, mcpServerPath, 'context_servers');
    return;
  }
  writeTextFileAtomic(configPath, upsertZedContextServer(raw, buildMcpServerEntry(mcpServerPath)));
}

export async function installZedMcpIntegration(): Promise<number> {
  console.log('\nInstalling Claude-Mem MCP integration for Zed...\n');

  const mcpServerPath = getMcpServerAbsolutePath();
  if (!mcpServerPath) {
    console.error('Could not find MCP server script');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/mcp-server.cjs');
    return 1;
  }

  const configPath = getZedSettingsPath();

  try {
    backupZedSettingsOnce(configPath);
    // writeZedMcpJsonConfig parses BOM-tolerantly and refuses (throws) on
    // a file that parses as neither JSON nor JSONC instead of replacing it
    // with an empty object, so a corrupt settings.json is left exactly as
    // it was; the backup above is the extra safety net for the user's
    // whole editor config. A JSONC file (comments/trailing commas) is
    // edited textually so its comments survive the merge.
    writeZedMcpJsonConfig(configPath, mcpServerPath);
    console.log(`  MCP config written to: ${configPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }

  console.log(`
Installation complete!

MCP config:  ${configPath}

Note: This is an MCP-only integration providing search tools and context.
Transcript capture is not available for Zed: Zed exposes no agent hooks or
transcript access, so native Zed Agent sessions are not recorded. Use the
MCP tools to search memory and save explicit notes.

Next steps:
  1. Start claude-mem worker: npx claude-mem start
  2. Restart Zed to pick up the MCP server, then check Settings -> AI -> MCP Servers
     for a green "Server is active" dot next to claude-mem
`);
  return 0;
}

/**
 * Remove claude-mem from Zed's context_servers, but only the entry this
 * installer wrote (its args end with mcp-server.cjs): the name is generic
 * enough that a user could have their own `claude-mem` server, and uninstall
 * must never remove that. Returns 0 when an entry was removed. A settings
 * file that does not parse is left alone (readZedSettings throws instead of
 * returning an empty object for it to overwrite). A JSONC file is edited
 * textually so its comments survive the removal.
 */
export function uninstallZedMcpIntegration(configPath: string = getZedSettingsPath()): number {
  if (!existsSync(configPath)) return 1;
  const { config, jsonc, raw } = readZedSettings(configPath);
  const entry = config.context_servers?.['claude-mem'] as { args?: unknown } | undefined;
  if (!entry) return 1;
  const args = entry.args;
  const isOurs = Array.isArray(args) && args.some((arg) => typeof arg === 'string' && arg.endsWith('mcp-server.cjs'));
  if (!isOurs) return 1;
  if (!jsonc) {
    delete config.context_servers['claude-mem'];
    writeJsonFileAtomic(configPath, config);
  } else {
    const next = removeZedContextServer(raw);
    if (next === null) return 1;
    writeTextFileAtomic(configPath, next);
  }
  console.log(`  Removed claude-mem from the Zed context servers in: ${configPath}`);
  return 0;
}

// NOTE: 'antigravity' is intentionally absent here. It graduated from an
// MCP-only integration to a full hooks+MCP installer — see
// AntigravityCliHooksInstaller.ts, which owns Antigravity's install/uninstall
// end-to-end (reusing writeMcpJsonConfig/buildMcpServerEntry from this file
// for its MCP half). Leaving an entry here too would create two competing
// install paths for the same IDE.
export const MCP_IDE_INSTALLERS: Record<string, () => Promise<number>> = {
  'copilot-cli': installMcpIntegration(COPILOT_CLI_CONFIG),
  'goose': installGooseMcpIntegration,
  'roo-code': installMcpIntegration(ROO_CODE_CONFIG),
  'warp': installMcpIntegration(WARP_CONFIG),
  'zed': installZedMcpIntegration,
};
