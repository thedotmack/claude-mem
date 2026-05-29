#!/usr/bin/env node
/**
 * failfund transcript analyzer
 *
 * Locates the current Claude Code session transcript, tallies token usage
 * per turn, and emits a compact, token-attributed audit view that the model
 * can reason over WITHOUT reading the raw (often enormous) JSONL.
 *
 * Why a script and not inline parsing: this work is deterministic and
 * repetitive (find file -> parse JSONL -> sum usage -> truncate). Doing it
 * once here keeps every failfund invocation cheap and consistent, and means
 * the audit step spends its tokens on judgment, not on re-deriving the same
 * per-turn table.
 *
 * Usage:
 *   node analyze-transcript.cjs [transcriptPathOrProjectDir] [--cwd <dir>] [--json]
 *
 * Resolution order for the transcript:
 *   1. An explicit .jsonl path passed as the first arg.
 *   2. A project dir passed as the first arg -> newest .jsonl inside it.
 *   3. The encoded dir for --cwd (or process.cwd()) under
 *      ~/.claude/projects/<encoded> -> newest .jsonl inside it.
 *
 * Claude Code encodes the working directory into the projects dir name by
 * replacing every "/" and "." with "-". We reproduce that mapping. If the
 * encoded dir does not exist we FAIL LOUDLY with the path we looked for
 * rather than silently grabbing some other session's transcript — picking
 * the wrong transcript would quietly produce a refund request about work
 * that happened in a different chat.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function parseArgs(argv) {
  const args = { positional: null, cwd: process.cwd(), json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--cwd') {
      if (i + 1 >= argv.length) throw new Error('--cwd requires a path argument');
      args.cwd = argv[++i];
    }
    else if (!args.positional) args.positional = a;
  }
  return args;
}

function encodeCwd(cwd) {
  // Matches Claude Code's projects-dir encoding: "/" and "." -> "-".
  return cwd.replace(/[/.]/g, '-');
}

function newestJsonlIn(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const full = path.join(dir, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? files[0].full : null;
}

function resolveTranscript(args) {
  if (args.positional) {
    if (args.positional.endsWith('.jsonl')) {
      if (!fs.existsSync(args.positional)) {
        throw new Error(`Transcript path does not exist: ${args.positional}`);
      }
      return args.positional;
    }
    const found = newestJsonlIn(args.positional);
    if (!found) throw new Error(`No .jsonl transcripts found in: ${args.positional}`);
    return found;
  }

  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  const encoded = encodeCwd(args.cwd);
  const dir = path.join(projectsRoot, encoded);
  const found = newestJsonlIn(dir);
  if (found) return found;

  // Fail loud: list nearby candidates so the user can pass one explicitly.
  let hint = '';
  if (fs.existsSync(projectsRoot)) {
    const base = path.basename(args.cwd);
    const candidates = fs
      .readdirSync(projectsRoot)
      .filter((d) => d.includes(base))
      .slice(0, 10);
    if (candidates.length) {
      hint =
        `\nProject dirs that mention "${base}":\n` +
        candidates.map((c) => `  ${path.join(projectsRoot, c)}`).join('\n') +
        `\nPass the right one (or a .jsonl path) as the first argument.`;
    }
  }
  throw new Error(
    `No transcript dir for cwd:\n  ${args.cwd}\nExpected:\n  ${dir}${hint}`
  );
}

function asText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
  }
  return '';
}

function toolUses(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c) => c && c.type === 'tool_use')
    .map((c) => {
      const input = c.input || {};
      // A short, human-readable summary of the most telling input field.
      const summary =
        input.command ||
        input.file_path ||
        input.path ||
        input.pattern ||
        input.prompt ||
        input.description ||
        input.url ||
        '';
      return { name: c.name, summary: String(summary).replace(/\s+/g, ' ').slice(0, 160) };
    });
}

function truncate(s, n) {
  s = (s || '').replace(/\s+$/g, '');
  return s.length > n ? s.slice(0, n) + ` …[+${s.length - n} chars]` : s;
}

function main() {
  const args = parseArgs(process.argv);
  const transcriptPath = resolveTranscript(args);
  const raw = fs.readFileSync(transcriptPath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim());

  const totals = { input: 0, cache_creation: 0, cache_read: 0, output: 0 };
  const turns = [];
  const models = new Set();
  let sessionId = null;
  let assistantIndex = 0;

  // Claude Code writes ONE assistant API response as MULTIPLE JSONL lines —
  // one per content block (thinking, text, tool_use, tool_use, …) — and every
  // one of those lines repeats the SAME message.usage. Counting per line would
  // multiply the token tally by the number of blocks. So we group by the API
  // message id: usage is counted once per id, and the blocks are merged back
  // into a single turn.
  const assistantTurnsById = new Map();

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // tolerate truncated/partial lines
    }
    if (obj.sessionId && !sessionId) sessionId = obj.sessionId;
    // Skip subagent sidechains — they are charged work but not the main
    // conversation the user is judging. Note their presence separately.
    const isSidechain = obj.isSidechain === true;

    if (obj.type === 'user' && obj.message && !isSidechain) {
      const text = asText(obj.message.content);
      // Tool results come back as role:user too; only keep real user prose.
      const hasToolResult =
        Array.isArray(obj.message.content) &&
        obj.message.content.some((c) => c && c.type === 'tool_result');
      if (text.trim() && !hasToolResult) {
        turns.push({ role: 'user', text, ts: obj.timestamp });
      }
    } else if (obj.type === 'assistant' && obj.message) {
      const msgId = obj.message.id || `${obj.uuid || turns.length}`;
      if (obj.message.model) models.add(obj.message.model);

      let turn = assistantTurnsById.get(msgId);
      if (!turn) {
        // First line for this response: count its usage exactly once.
        const u = obj.message.usage || {};
        const usage = {
          out: u.output_tokens || 0,
          inp: u.input_tokens || 0,
          cc: u.cache_creation_input_tokens || 0,
          cr: u.cache_read_input_tokens || 0,
        };
        totals.output += usage.out;
        totals.input += usage.inp;
        totals.cache_creation += usage.cc;
        totals.cache_read += usage.cr;
        assistantIndex += 1;
        turn = {
          role: 'assistant',
          idx: assistantIndex,
          text: '',
          tools: [],
          usage,
          sidechain: isSidechain,
          ts: obj.timestamp,
        };
        assistantTurnsById.set(msgId, turn);
        turns.push(turn);
      }
      // Merge this line's blocks into the turn (text and tool_use arrive on
      // separate lines for the same message id).
      const text = asText(obj.message.content);
      if (text.trim()) turn.text = turn.text ? `${turn.text}\n${text}` : text;
      turn.tools.push(...toolUses(obj.message.content));
    }
  }

  const result = {
    transcriptPath,
    sessionId,
    models: [...models],
    totals,
    turns,
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2));
    return;
  }

  // Markdown audit view -------------------------------------------------
  const fmt = (n) => n.toLocaleString('en-US');
  const out = [];
  out.push(`# Transcript audit source`);
  out.push(``);
  out.push(`- File: ${transcriptPath}`);
  out.push(`- Session: ${sessionId || 'unknown'}`);
  out.push(`- Model(s): ${[...models].join(', ') || 'unknown'}`);
  out.push(
    `- Turns: ${turns.filter((t) => t.role === 'user').length} user / ${assistantIndex} assistant`
  );
  out.push(``);
  out.push(`## Session token totals`);
  out.push(`| metric | tokens |`);
  out.push(`| --- | --- |`);
  out.push(`| output (generated by Claude) | ${fmt(totals.output)} |`);
  out.push(`| input (fresh) | ${fmt(totals.input)} |`);
  out.push(`| cache creation | ${fmt(totals.cache_creation)} |`);
  out.push(`| cache read (context replayed each turn) | ${fmt(totals.cache_read)} |`);
  out.push(``);
  out.push(
    `> Attribution note: \`output\` is the most directly attributable cost of a turn — ` +
      `it is what Claude actually generated that turn. Every extra assistant turn ALSO ` +
      `forces the whole prior context to be re-read (the \`cache read\` column), so a ` +
      `multi-turn detour compounds. When tallying waste, sum the \`out\` of the flagged ` +
      `turns as the floor, and note the induced cache-read cost of the turns that followed.`
  );
  out.push(``);
  out.push(`## Turn-by-turn`);
  out.push(``);

  for (const t of turns) {
    if (t.role === 'user') {
      out.push(`### USER`);
      out.push('```');
      out.push(truncate(t.text, 2000));
      out.push('```');
      out.push(``);
    } else {
      const u = t.usage;
      const tag = t.sidechain ? ' (subagent sidechain)' : '';
      out.push(
        `### A${t.idx}${tag} — out=${fmt(u.out)} in=${fmt(u.inp)} cache_create=${fmt(
          u.cc
        )} cache_read=${fmt(u.cr)}`
      );
      const text = truncate(t.text, 1000);
      if (text.trim()) {
        out.push(text);
      }
      if (t.tools.length) {
        out.push(``);
        out.push(
          `tools: ` + t.tools.map((x) => `${x.name}(${x.summary})`).join(' · ')
        );
      }
      out.push(``);
    }
  }

  process.stdout.write(out.join('\n'));
}

try {
  main();
} catch (err) {
  // Fail fast and loud — a wrong/empty transcript must not silently yield a
  // bogus refund request.
  process.stderr.write(`[failfund] ${err.message}\n`);
  process.exit(1);
}
