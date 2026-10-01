#!/usr/bin/env node
// standup — a markdown-based group chat for multiple AI coding agents.
//
// Each agent embodies its git branch name and talks to the others by appending
// turns to a single shared markdown file (default ~/.claude-mem/STANDUP.md).
// The file has YAML front matter holding the shared GOAL and PROMPT the group
// must converge on; the body is the chat log. Agents `watch` the file to listen,
// `post` to speak, `agree` to register consensus, and `summation` to close it.
//
// Zero deps. Node 20+ (top-level await, fs/promises). No network.
//
// Concurrency: every write takes an atomic lock (mkdir <file>.lock) so two
// agents posting at the same instant can't clobber each other — the exact
// failure mode that silently reverts work when multiple agents share a target.
//
// Config / resolution order:
//   --file <path>   | STANDUP_FILE  | ~/.claude-mem/STANDUP.md
//   --agent <name>  | STANDUP_AGENT | current git branch | "agent"
//
// Commands:
//   worktrees [--since 4h] [--json]                   list worktrees, newest
//                                                     first; --since N{m,h,d,w}
//                                                     keeps only those with a
//                                                     commit or uncommitted edit
//                                                     in the window ("all"=off)
//   prs       [--since 4h] [--json]                    list open GitHub PRs via
//                                                     gh, newest first; --since
//                                                     filters by last update
//   open    --goal "..." --prompt "..." [--agent N]   create the channel
//   join    [--agent N] [--message "..."]             add self + say hello
//   post    --message "..." [--agree "..."] [--agent N]   append a turn
//   agree   --deliverable "..." [--agent N]           append an AGREE turn
//   watch   [--agent N] [--timeout SEC] [--interval SEC]   block until someone
//                                                     ELSE posts; prints their turn
//   read    [--tail N] [--since AGENT]                print the chat
//   status                                            participants + consensus
//   summation --text "..." [--agent N]                close the room (status: agreed)
//
// Exit codes: 0 ok / change seen, 2 watch timeout, 1 usage or error.

import { readFile, writeFile, mkdir, rmdir, rename, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

// ----------------------------------------------------------------------- args
function parseArgs(argv) {
  const cmd = argv[0];
  const opts = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) opts[key] = true;
      else {
        opts[key] = next;
        i++;
      }
    }
  }
  return { cmd, opts };
}

const { cmd, opts } = parseArgs(process.argv.slice(2));

function defaultFile() {
  return (
    opts.file ||
    process.env.STANDUP_FILE ||
    join(homedir(), ".claude-mem", "STANDUP.md")
  );
}

function gitBranch() {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function agentName() {
  const n = opts.agent || process.env.STANDUP_AGENT || gitBranch() || "agent";
  return String(n).trim();
}

const FILE = defaultFile();

// --------------------------------------------------------------------- helpers
function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function read() {
  return (await readFile(FILE, "utf8")).toString();
}

// Atomic lock via mkdir (fails if the dir already exists). Retries with a
// short backoff so simultaneous agents serialize instead of clobbering.
async function withLock(fn) {
  const lock = FILE + ".lock";
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch {
      if (Date.now() > deadline) {
        // Stale lock? Take it rather than deadlock forever.
        try {
          await rmdir(lock);
        } catch {}
        await mkdir(lock).catch(() => {});
        break;
      }
      await sleep(80);
    }
  }
  try {
    return await fn();
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Split a standup doc into { yaml (raw text), body }.
function splitDoc(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { yaml: "", body: text };
  return { yaml: m[1], body: m[2] };
}

// Minimal front-matter readers (zero-dep; we only need a few fields).
function yamlScalar(yaml, key) {
  const re = new RegExp(`^${key}:\\s*(.*)$`, "m");
  const m = yaml.match(re);
  if (!m) return null;
  const inline = m[1].trim();
  // Block scalar (>- , >, | , |-): value is the indented lines that follow.
  if (/^[|>][+-]?$/.test(inline)) {
    const after = yaml.slice(m.index + m[0].length).split("\n").slice(1);
    const lines = [];
    for (const l of after) {
      if (/^\s+\S/.test(l) || l.trim() === "") lines.push(l.trim());
      else break;
    }
    return lines.join(" ").trim();
  }
  return inline.replace(/^["']|["']$/g, "");
}

function yamlList(yaml, key) {
  // Matches:  key:\n  - a\n  - b   (until a non-indented line)
  const re = new RegExp(`^${key}:\\s*\\n((?:\\s*-\\s*.+\\n?)*)`, "m");
  const m = yaml.match(re);
  if (!m) return [];
  return m[1]
    .split("\n")
    .map((l) => l.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
}

// Parse chat turns: each starts with "### <agent> — <iso>".
function parseTurns(body) {
  const turns = [];
  const re = /^###\s+(.+?)\s+—\s+(\S+)\s*$/gm;
  let m;
  const heads = [];
  while ((m = re.exec(body))) {
    heads.push({ agent: m[1].trim(), ts: m[2].trim(), idx: m.index, end: re.lastIndex });
  }
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].end;
    const stop = i + 1 < heads.length ? heads[i + 1].idx : body.length;
    turns.push({
      agent: heads[i].agent,
      ts: heads[i].ts,
      text: body.slice(start, stop).trim(),
    });
  }
  return turns;
}

function lastTurn(body) {
  const t = parseTurns(body);
  return t.length ? t[t.length - 1] : null;
}

// Append a turn under "## Chat", taking the lock. Adds the author to
// participants if missing. Optionally appends an AGREE line.
async function appendTurn({ agent, message, agree }) {
  await withLock(async () => {
    let text = await read();
    const { yaml, body } = splitDoc(text);

    // ensure participant listed
    let newYaml = yaml;
    const participants = yamlList(yaml, "participants");
    if (!participants.includes(agent)) {
      newYaml = yaml.replace(
        /^participants:\s*\n((?:\s*-\s*.+\n?)*)/m,
        (full) => full.replace(/\n?$/, `\n  - ${agent}\n`),
      );
      if (newYaml === yaml) {
        // no participants block — append one
        newYaml = yaml.trimEnd() + `\nparticipants:\n  - ${agent}\n`;
      }
    }

    let block = `\n### ${agent} — ${nowIso()}\n\n${message.trim()}\n`;
    if (agree) block += `\nAGREE: ${agree.trim()}\n`;

    // ensure a "## Chat" section exists
    let newBody = body;
    if (!/^##\s+Chat\s*$/m.test(newBody)) newBody += `\n## Chat\n`;
    newBody = newBody.replace(/\s*$/, "\n") + block;

    text = `---\n${newYaml.replace(/\n?$/, "\n")}---\n${newBody}`;
    await writeFile(FILE, text);
  });
}

// -------------------------------------------------------------------- commands
// Parse a time window like "1h", "4h", "24h", "7d", "30m", "2w" into
// milliseconds. "all" / "any" / "none" (or nothing) → null, meaning no filter.
// Anything unrecognized → null with a warning, so a typo widens rather than
// silently hiding worktrees.
function parseWindowMs(s) {
  if (!s || s === true) return null;
  const v = String(s).trim().toLowerCase();
  if (v === "all" || v === "any" || v === "none" || v === "*") return null;
  const m = v.match(/^(\d+)\s*([mhdw])$/);
  if (!m) {
    console.error(`standup: unrecognized window "${s}" — showing all worktrees`);
    return null;
  }
  const unit = { m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[m[2]];
  return Number(m[1]) * unit;
}

// Human-friendly "time since" for a unix-ms timestamp.
function humanAge(ms) {
  if (!ms) return "unknown";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// The most recent moment a worktree saw work: the newest of its last commit
// time and any uncommitted change (staged, modified, or untracked). This is
// what "active in the last N hours" keys off — a branch with live unpushed
// edits counts as active even if its last commit is old. Returns unix ms, or 0
// when nothing can be determined.
function worktreeActivityMs(path) {
  let last = 0;
  try {
    const sec = execSync("git log -1 --format=%ct", {
      cwd: path,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (sec) last = Math.max(last, Number(sec) * 1000);
  } catch {}
  try {
    const out = execSync("git status --porcelain", {
      cwd: path,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      // porcelain rows are "XY <path>" or, for renames, "XY old -> new".
      let p = line.slice(3).trim();
      const arrow = p.indexOf(" -> ");
      if (arrow >= 0) p = p.slice(arrow + 4);
      p = p.replace(/^"|"$/g, "");
      try {
        const mt = statSync(join(path, p)).mtimeMs;
        if (mt > last) last = mt;
      } catch {}
    }
  } catch {}
  return last;
}

// List git worktrees as { branch, path }. Used by the /standup orchestrator to
// discover who's in the room. Skips detached / bare entries.
function gitWorktrees() {
  let out;
  try {
    out = execSync("git worktree list --porcelain", {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
  } catch {
    return [];
  }
  const items = [];
  let cur = {};
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) cur = { path: line.slice(9).trim() };
    else if (line.startsWith("branch "))
      cur.branch = line.slice(7).replace("refs/heads/", "").trim();
    else if (line.trim() === "") {
      if (cur.path && cur.branch) items.push(cur);
      cur = {};
    }
  }
  if (cur.path && cur.branch) items.push(cur);
  return items;
}

// Open PRs via the gh CLI — the other kind of room candidate. A PR is a branch
// living on the remote; including one means an agent fetches it read-only,
// reports what it changes, and the consolidation plan folds it in alongside the
// local worktrees. Returns null when gh is unavailable / unauthenticated / the
// repo has no GitHub remote, so the orchestrator can degrade to worktrees-only.
function ghPRs() {
  let out;
  try {
    out = execSync(
      "gh pr list --state open --limit 200 --json number,title,headRefName,updatedAt,author,isDraft",
      { stdio: ["ignore", "pipe", "ignore"] },
    ).toString();
  } catch {
    return null;
  }
  try {
    return JSON.parse(out);
  } catch {
    return [];
  }
}

async function cmdPRs() {
  const prs = ghPRs();
  if (prs == null)
    die("gh unavailable, unauthenticated, or no GitHub remote (try `gh auth login`)");
  const windowMs = parseWindowMs(opts.since);
  const now = Date.now();
  let rows = prs.map((p) => ({
    number: p.number,
    title: p.title,
    branch: p.headRefName,
    author: p.author?.login || "",
    isDraft: !!p.isDraft,
    updatedAt: p.updatedAt || null,
    updatedMs: p.updatedAt ? Date.parse(p.updatedAt) : 0,
    age: p.updatedAt ? humanAge(Date.parse(p.updatedAt)) : "unknown",
  }));
  if (windowMs != null) rows = rows.filter((p) => p.updatedMs && now - p.updatedMs <= windowMs);
  rows.sort((a, b) => b.updatedMs - a.updatedMs);
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (!rows.length) {
    console.error(windowMs != null ? `no open PRs updated within "${opts.since}"` : `no open PRs`);
    return;
  }
  for (const p of rows) {
    const draft = p.isDraft ? " [draft]" : "";
    console.log(`#${p.number}\t${p.age.padEnd(8)}\t${p.branch}\t${p.title}${draft}`);
  }
}

async function cmdWorktrees() {
  const here = process.cwd();
  const windowMs = parseWindowMs(opts.since);
  const now = Date.now();
  let rows = gitWorktrees().map((w) => {
    const activityMs = worktreeActivityMs(w.path);
    return {
      branch: w.branch,
      path: w.path,
      current: w.path === here,
      lastActivity: activityMs
        ? new Date(activityMs).toISOString().replace(/\.\d{3}Z$/, "Z")
        : null,
      lastActivityMs: activityMs,
      age: humanAge(activityMs),
    };
  });
  // Scope to the window (commits OR uncommitted edits inside it), newest first.
  if (windowMs != null) {
    rows = rows.filter((w) => w.lastActivityMs && now - w.lastActivityMs <= windowMs);
  }
  rows.sort((a, b) => (b.lastActivityMs || 0) - (a.lastActivityMs || 0));

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (!rows.length) {
    console.error(
      windowMs != null
        ? `no worktrees active within "${opts.since}" — widen the window or use --since all`
        : `no worktrees found`,
    );
    return;
  }
  for (const w of rows) {
    const mine = w.current ? "  (current)" : "";
    console.log(`${w.age.padEnd(8)}\t${w.branch}\t${w.path}${mine}`);
  }
}

async function cmdOpen() {
  const agent = agentName();
  const goal = opts.goal;
  const prompt = opts.prompt;
  if (!goal || !prompt) die("open needs --goal and --prompt");
  if (await exists(FILE)) {
    if (!opts.force) die(`channel exists: ${FILE} (use --force to rotate it aside)`);
    const archived = FILE.replace(/\.md$/, `-${nowIso().replace(/[:T]/g, "-").replace("Z", "")}.md`);
    await rename(FILE, archived);
    console.error(`rotated existing channel → ${archived}`);
  }
  await mkdir(dirname(FILE), { recursive: true });
  const ts = nowIso();
  const fold = (s) => s.replace(/\s+/g, " ").trim();
  const doc = `---
channel: STANDUP
opened_by: ${agent}
opened_at: ${ts}
status: open
goal: >-
  ${fold(goal)}
prompt: >-
  ${fold(prompt)}
participants:
  - ${agent}
protocol: |
  1. Before each turn, READ the whole file. Only respond to messages posted
     after your previous turn.
  2. Append your turn at the end of "## Chat" as:
         ### <agent-name> — <ISO-8601 UTC>
         <your message>
  3. To register consensus, include a line exactly: "AGREE: <deliverable>"
  4. When ALL participants have an AGREE line for the same deliverable, the
     last agent to agree appends "## SUMMATION" and flips status: agreed.
  5. New agent joining? Add yourself to participants and say Hello in Chat.
---

# Standup — group chat

The room is open. Post under **## Chat** following the protocol above.

## Chat

### ${agent} — ${ts}

Hello! 👋 I'm \`${agent}\`. The room is open — goal and prompt are in the
front matter. Counter-proposals welcome. I'm listening.
`;
  await writeFile(FILE, doc);
  console.log(`opened ${FILE} as "${agent}"`);
}

async function cmdJoin() {
  const agent = agentName();
  if (!(await exists(FILE))) die(`no channel at ${FILE} — run "open" first`);
  const msg =
    opts.message ||
    `Hello! 👋 I'm \`${agent}\`. Joining the room and listening.`;
  await appendTurn({ agent, message: msg });
  console.log(`joined as "${agent}"`);
}

async function cmdPost() {
  const agent = agentName();
  if (!opts.message) die("post needs --message");
  if (!(await exists(FILE))) die(`no channel at ${FILE}`);
  await appendTurn({ agent, message: opts.message, agree: opts.agree });
  console.log(`posted as "${agent}"`);
}

async function cmdAgree() {
  const agent = agentName();
  const d = opts.deliverable;
  if (!d) die("agree needs --deliverable");
  await appendTurn({
    agent,
    message: opts.message || `I'm in. AGREE on the deliverable below.`,
    agree: d,
  });
  console.log(`agreed as "${agent}": ${d}`);
}

async function cmdWatch() {
  const agent = agentName();
  if (!(await exists(FILE))) die(`no channel at ${FILE}`);
  const timeout = Number(opts.timeout || 1800) * 1000;
  const interval = Number(opts.interval || 5) * 1000;
  const baselineText = await read();
  let baseTurns = parseTurns(splitDoc(baselineText).body).length;
  const start = Date.now();
  process.stderr.write(
    `watching ${FILE} as "${agent}" (every ${interval / 1000}s, timeout ${
      timeout / 1000
    }s)…\n`,
  );
  for (;;) {
    if (Date.now() - start > timeout) {
      console.log("TIMEOUT — no one else posted.");
      process.exit(2);
    }
    await sleep(interval);
    let text;
    try {
      text = await read();
    } catch {
      continue;
    }
    const turns = parseTurns(splitDoc(text).body);
    if (turns.length <= baseTurns) continue;
    const fresh = turns.slice(baseTurns);
    baseTurns = turns.length;
    // ignore our own turns — keep listening for someone ELSE
    const others = fresh.filter((t) => t.agent !== agent);
    if (!others.length) continue;
    console.log(`NEW (${others.length}) after ${Math.round((Date.now() - start) / 1000)}s:\n`);
    for (const t of others) {
      console.log(`### ${t.agent} — ${t.ts}\n${t.text}\n`);
    }
    process.exit(0);
  }
}

async function cmdRead() {
  if (!(await exists(FILE))) die(`no channel at ${FILE}`);
  const { body } = splitDoc(await read());
  let turns = parseTurns(body);
  if (opts.since) {
    // turns after the named agent's last post
    let lastIdx = -1;
    turns.forEach((t, i) => {
      if (t.agent === opts.since) lastIdx = i;
    });
    if (lastIdx >= 0) turns = turns.slice(lastIdx + 1);
  }
  if (opts.tail) turns = turns.slice(-Number(opts.tail));
  for (const t of turns) console.log(`### ${t.agent} — ${t.ts}\n${t.text}\n`);
}

async function cmdStatus() {
  if (!(await exists(FILE))) die(`no channel at ${FILE}`);
  const { yaml, body } = splitDoc(await read());
  const participants = yamlList(yaml, "participants");
  const status = yamlScalar(yaml, "status") || "open";
  const turns = parseTurns(body);
  // latest AGREE per agent
  const agreeByAgent = new Map();
  for (const t of turns) {
    const m = t.text.match(/^AGREE:\s*(.+)$/m);
    if (m) agreeByAgent.set(t.agent, m[1].trim());
  }
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const agreedValues = participants.map((p) => agreeByAgent.get(p) || null);
  const allAgreed =
    participants.length > 0 &&
    agreedValues.every(Boolean) &&
    new Set(agreedValues.map(norm)).size === 1;
  console.log(`channel : ${FILE}`);
  console.log(`status  : ${status}`);
  console.log(`goal    : ${yamlScalar(yaml, "goal") || "(see file)"}`);
  console.log(`turns   : ${turns.length}`);
  console.log(`participants (${participants.length}):`);
  for (const p of participants) {
    const a = agreeByAgent.get(p);
    console.log(`  - ${p}${a ? `  ✓ AGREE: ${a}` : "  … no agree yet"}`);
  }
  console.log(
    allAgreed
      ? "consensus: REACHED — all participants agree. Write a ## SUMMATION."
      : "consensus: not yet",
  );
}

async function cmdSummation() {
  const agent = agentName();
  if (!opts.text) die("summation needs --text");
  await withLock(async () => {
    let text = await read();
    const { yaml, body } = splitDoc(text);
    const newYaml = yaml.replace(/^status:\s*.+$/m, "status: agreed");
    const block = `\n## SUMMATION\n\n_by ${agent} — ${nowIso()}_\n\n${opts.text.trim()}\n`;
    text = `---\n${newYaml.replace(/\n?$/, "\n")}---\n${body.replace(/\s*$/, "\n")}${block}`;
    await writeFile(FILE, text);
  });
  console.log(`summation written; status → agreed`);
}

function die(msg) {
  console.error(`standup: ${msg}`);
  process.exit(1);
}

const USAGE = `standup — markdown group chat for multiple coding agents

usage: standup <command> [--flags]

  open    --goal "..." --prompt "..."   create the channel (you say hello)
                                        [--force rotates an existing room aside]
  worktrees [--since 4h] [--json]       list worktrees, newest first; --since
                                        N{m,h,d,w} keeps only those active in the
                                        window (commit OR uncommitted edit)
  prs     [--since 4h] [--json]         list open GitHub PRs (via gh), newest
                                        first; --since filters by last update
  join    [--message "..."]             add yourself + say hello
  post    --message "..." [--agree "..."]   append a turn
  agree   --deliverable "..."           append an AGREE turn
  watch   [--timeout SEC] [--interval SEC]  block until someone ELSE posts
  read    [--tail N] [--since AGENT]    print the chat
  status                                participants + consensus check
  summation --text "..."                close the room (status: agreed)

agent name defaults to your git branch; override with --agent or STANDUP_AGENT.
file defaults to ~/.claude-mem/STANDUP.md; override with --file or STANDUP_FILE.`;

const table = {
  open: cmdOpen,
  worktrees: cmdWorktrees,
  prs: cmdPRs,
  join: cmdJoin,
  post: cmdPost,
  agree: cmdAgree,
  watch: cmdWatch,
  read: cmdRead,
  status: cmdStatus,
  summation: cmdSummation,
};

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(USAGE);
  process.exit(cmd ? 0 : 1);
}
const fn = table[cmd];
if (!fn) die(`unknown command "${cmd}"\n\n${USAGE}`);
await fn();
