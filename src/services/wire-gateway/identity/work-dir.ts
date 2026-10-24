// SPDX-License-Identifier: Apache-2.0
//
// The folder an agent works in, as it tells its model in the request (plan
// Phase 4 task 5). Ported from magpie (MIT, Copyright (c) 2026 yetone):
// `workPlace`/`workDirIn` (internal/gateway/workdir.go:31-134) and
// `GitSaid`/`GitOnDisk` (internal/provider/workplace.go:10-51).
//
// Each agent says it its own way:
// - Claude Code (2.1.296): " - Primary working directory: /x" in the system
//   prompt or a `role:"system"` message; after a move,
//   "Primary working directory: /y (was /x)"; < and > come as &lt; and &gt;.
// - Codex (0.162): <environment_context> with "<cwd>/x</cwd>", entities escaped.
// - Pi (1.1): the system prompt's "<cwd>\n/x\n</cwd>".
// - OpenCode (2.0): "<env>\n  Working directory: /x\n…</env>".
// The last one said wins. Only the agent's own text is read: never the
// model's (assistant) words and never a tool's result. Unknown is undefined,
// never "".

import { existsSync, statSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import type { WirePart, WireRequest } from '../ir/types.js';

// The four patterns of magpie workdir.go:31-37. Go's regexp runs in linear
// time; JavaScript's backtracks, so each is rewritten to match the same text
// without nested or overlapping repeats (a request body is up to 64 MiB and
// is read before it is forwarded):
// - `<cwd>\s*([^<\n]+?)\s*</cwd>` is `<cwd>([^<]*)</cwd>` whose content,
//   trimmed, is not empty and holds no line feed (see cwdTagValue);
// - `^\s*` and `\s*$` (multiline) keep to their line as `[ \t]*`;
// - ` \(was .*\)$` is cut with indexOf (see withoutWasSuffix).
const CLAUDE_CODE_WORK_DIR_PATTERN = /^(?: - )?Primary working directory: (.+)$/gm;
const CWD_TAG_PATTERN = /<cwd>([^<]*)<\/cwd>/g;
const OPENCODE_ENV_WORK_DIR_PATTERN = /^[ \t]*Working directory: (.+)$/m;
const WAS_DIR_SUFFIX = ' (was ';

/** magpie provider/workplace.go:14 `gitSaidRe`, kept to one line (see above). */
const GIT_REPOSITORY_SAID_PATTERN = /^[ \t]*(?:- )?Is (?:a git repository|directory a git repo): (true|false|yes|no)[ \t\r]*$/gim;

/** magpie's ` \(was .*\)$` strip: from the first " (was " when the text ends with ")". */
function withoutWasSuffix(said: string): string {
  if (!said.endsWith(')')) return said;
  const wasAt = said.indexOf(WAS_DIR_SUFFIX);
  return wasAt >= 0 ? said.slice(0, wasAt) : said;
}

/** What a <cwd> tag holds, trimmed; undefined when that is empty or holds a line feed (magpie's `[^<\n]`). */
function cwdTagValue(content: string): string | undefined {
  const value = content.trim();
  return value !== '' && !value.includes('\n') ? value : undefined;
}

const NAMED_HTML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * Go html.UnescapeString for what agents escape in a path: the named entities
 * above and numeric ones. Anything else is left as written.
 */
function unescapeHtmlEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (entity, body: string) => {
    if (body.startsWith('#')) {
      const codePoint = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    }
    return NAMED_HTML_ENTITIES[body] ?? entity;
  });
}

/** The last folder one text says, or undefined (magpie `workDirIn`). */
export function workDirSaidInText(text: string): string | undefined {
  if (!text.includes('irectory: ') && !text.includes('<cwd>')) return undefined;
  let lastMatchOffset = -1;
  let lastSaidDir: string | undefined;
  const take = (matchOffset: number, value: string) => {
    const dir = unescapeHtmlEntities(value).trim();
    if (dir !== '' && matchOffset > lastMatchOffset) {
      lastMatchOffset = matchOffset;
      lastSaidDir = dir;
    }
  };
  for (const match of text.matchAll(CLAUDE_CODE_WORK_DIR_PATTERN)) {
    take(match.index!, withoutWasSuffix(match[1]));
  }
  for (const match of text.matchAll(CWD_TAG_PATTERN)) {
    const value = cwdTagValue(match[1]);
    if (value !== undefined) take(match.index!, value);
  }
  // OpenCode's, only within its <env>.
  for (let searchFrom = 0; ;) {
    const envStart = text.indexOf('<env>', searchFrom);
    if (envStart < 0) break;
    const envEnd = text.indexOf('</env>', envStart);
    if (envEnd < 0) break;
    const envBlock = text.slice(envStart, envEnd);
    const match = OPENCODE_ENV_WORK_DIR_PATTERN.exec(envBlock);
    if (match) take(envStart + match.index, match[1]);
    searchFrom = envEnd;
  }
  return lastSaidDir;
}

/** The last yes/no a text says of its folder being a git repository (magpie `GitSaid`). */
export function gitRepositorySaidInText(text: string): boolean | undefined {
  const matches = [...text.matchAll(GIT_REPOSITORY_SAID_PATTERN)];
  const last = matches.at(-1);
  if (!last) return undefined;
  const answer = last[1].toLowerCase();
  return answer === 'true' || answer === 'yes';
}

/**
 * Whether a folder on this computer is in a git repository: a .git in it or
 * above it (magpie `GitOnDisk`). Undefined unless the path is absolute and
 * an existing directory here (an agent on another computer): unknown, never "no".
 */
export function gitRepositoryOnDisk(dir: string): boolean | undefined {
  if (!isAbsolute(dir)) return undefined;
  try {
    if (!statSync(dir).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  for (let current = resolve(dir); ;) {
    if (existsSync(join(current, '.git'))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** A part whose text is the agent's own: text, or a developer/system note Codex put after a reply. */
function agentAuthoredText(part: WirePart): string | undefined {
  if (part.kind === 'text') return part.text;
  if (part.kind === 'context' && (part.name === 'developer' || part.name === 'system')) return part.text;
  return undefined;
}

export interface WorkPlace {
  workDir?: string;
  /** What the text that said the folder says of git; undefined when it says nothing. */
  gitRepositorySaid?: boolean;
}

/**
 * The folder a request says its agent works in, and whether the same text
 * says it is a git repository (magpie `workPlace`). The system prompt is
 * read first, then every non-assistant message's text in order, including
 * `role:"system"` messages; tool results are never read.
 */
export function workPlaceOfRequest(request: WireRequest): WorkPlace {
  const workPlace: WorkPlace = {};
  const look = (text: string | undefined) => {
    if (!text) return;
    const dir = workDirSaidInText(text);
    if (dir === undefined) return;
    workPlace.workDir = dir;
    workPlace.gitRepositorySaid = gitRepositorySaidInText(text);
  };
  look(request.system.map(part => part.text ?? '').filter(text => text !== '').join('\n\n'));
  for (const message of request.messages) {
    if (message.role === 'assistant') continue;
    for (const part of message.parts) look(agentAuthoredText(part));
  }
  if (workPlace.gitRepositorySaid === undefined) delete workPlace.gitRepositorySaid;
  return workPlace;
}
