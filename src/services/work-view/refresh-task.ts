/**
 * The job My Work's automatic refresh hands the agent runner: refresh the
 * owner's goals when they are stale, then group, review, align and retell
 * every request that is due. No day window beyond the skill's own default,
 * no group cap and no time limit (owner rule, Oct 22).
 *
 * Claude Code runs the two skills themselves. Codex and Gemini run read-only,
 * so the worker prepares each step's input, asks for JSON, and saves the
 * answer through the same validators the skills' CLI uses.
 */

import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import type { AgentTask, AskAgent } from '../agent-runner/run.js';
import { runCli, type LedgerDatabase, type RefreshNeeds } from './request-groups.mjs';

/** claude-mem MCP tools a refresh may call: memory reads and work state. */
export const MEMORY_TOOLS = ['search', 'dumb_search', 'smart_search', 'timeline', 'get_observations', 'get_tool_uses', 'smart_outline', 'smart_unfold', 'work_state_read', 'work_state_write'];
const PLUGIN_MCP_PREFIX = 'mcp__plugin_claude-mem_mcp-search__';
const REVIEW_BATCH = 8;

export interface RefreshTaskOptions {
  needs: RefreshNeeds;
  reason: string;
  /** ~/.claude-mem: every backend's working directory. */
  dataDir: string;
  /** ~/.claude-mem/work-view */
  ledgerDir: string;
  /** The installed plugin folder holding skills/ and .mcp.json. */
  pluginRoot: string;
  openDatabase: () => LedgerDatabase & { close(): void };
  now?: () => number;
  spawnImpl?: typeof spawn;
}

/** The path with every existing folder on it resolved through symlinks, so a link cannot lead out of a folder. */
function realPath(path: string): string {
  const missing: string[] = [];
  let existing = resolve(path);
  while (!existsSync(existing) && dirname(existing) !== existing) { missing.unshift(basename(existing)); existing = dirname(existing); }
  return join(realpathSync(existing), ...missing);
}

/** Only an absolute path counts: a relative one would be read against the agent's working folder, not `parent`. */
const isWithin = (child: string, parent: string) => {
  if (!isAbsolute(child)) return false;
  const path = relative(realPath(parent), realPath(child));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};

const quoted = (path: string) => [path, `"${path}"`, `'${path}'`];

/**
 * The options a script may take. A `path` option's value must sit inside
 * `within`; any other option or argument is refused, abbreviations included
 * (argparse would read `--ou` as `--out`).
 */
export interface ScriptArguments { within: string; options: Record<string, 'path' | 'value' | 'switch'> }
export type RefreshProgram = [bin: string, path: string, args?: ScriptArguments];

/** Shell words of an operator-free command: "a b", 'a b' or a bare word. */
const shellWords = (text: string) => [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(match => match[1] ?? match[2] ?? match[3]);

function checkScriptArguments(words: string[], { within, options }: ScriptArguments): string | null {
  for (let index = 0; index < words.length; index++) {
    const [name, inlineValue] = words[index].startsWith('--') && words[index].includes('=') ? [words[index].slice(0, words[index].indexOf('=')), words[index].slice(words[index].indexOf('=') + 1)] : [words[index], undefined];
    const kind = options[name];
    if (!kind) return `This script takes only ${Object.keys(options).join(', ')}, spelled out in full.`;
    if (kind === 'switch') { if (inlineValue !== undefined) return `${name} takes no value.`; continue; }
    const value = inlineValue ?? words[++index];
    if (value === undefined || value.startsWith('-')) return `${name} needs a value.`;
    if (kind === 'path' && !isWithin(value, within)) return `${name} must name a file inside ${within}.`;
  }
  return null;
}

/** Bash may run only the skills' own scripts, one command per call, with JSON
 * passed through a quoted heredoc. A script with `args` takes only those
 * options, and its file paths stay inside their folder. Returns null when allowed. */
export function checkRefreshCommand(command: string, programs: RefreshProgram[]): string | null {
  const text = command.trim();
  const heredocAt = text.indexOf('<<');
  const head = (heredocAt === -1 ? text : text.slice(0, heredocAt)).trim();
  const allowedPrefixes = programs.flatMap(([bin, path]) => quoted(path).map(form => `${bin} ${form}`));
  if (!allowedPrefixes.some(prefix => head === prefix || head.startsWith(`${prefix} `))) {
    return `Only these commands may run here, called by their full path: ${programs.map(([bin, path]) => `${bin} "${path}"`).join(', ')}.`;
  }
  if (/[;&|`$><\n\\]/.test(head)) return 'Run one command per call, without shell operators, variables or redirects.';
  const program = programs.find(([bin, path]) => quoted(path).some(form => head === `${bin} ${form}` || head.startsWith(`${bin} ${form} `)))!;
  if (program[2]) {
    const prefix = quoted(program[1]).map(form => `${program[0]} ${form}`).find(form => head === form || head.startsWith(`${form} `))!;
    const problem = checkScriptArguments(shellWords(head.slice(prefix.length)), program[2]);
    if (problem) return problem;
  }
  if (heredocAt === -1) return null;
  const lines = text.slice(heredocAt).split('\n');
  const delimiter = /^<<-?\s*(?:'(\w+)'|"(\w+)")\s*$/.exec(lines[0]);
  if (!delimiter) return "Pass JSON through a quoted heredoc (<<'JSON'), with nothing after it on that line.";
  const word = delimiter[1] ?? delimiter[2];
  while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length < 3 || lines[lines.length - 1].trim() !== word || lines.slice(1, -1).some(line => line.trim() === word)) {
    return `End the command with the heredoc's closing ${word} line and nothing after it.`;
  }
  return null;
}


function skillPaths(pluginRoot: string) {
  const skills = join(pluginRoot, 'skills');
  return {
    requestProgressSkill: join(skills, 'request-progress', 'SKILL.md'),
    ownerGoalsSkill: join(skills, 'owner-goals', 'SKILL.md'),
    cli: join(skills, 'request-progress', 'scripts', 'request-groups.mjs'),
    exportScript: join(skills, 'owner-goals', 'scripts', 'export_owner_prompts.py'),
    saveScript: join(skills, 'owner-goals', 'scripts', 'save_goals.py'),
  };
}

/** A skill's instructions with its folder filled in, for agents without the Skill tool. */
function inlineSkill(path: string): string {
  return readFileSync(path, 'utf8').replaceAll('${CLAUDE_SKILL_DIR}', join(path, '..'));
}

/** The first JSON object in an agent's answer, with or without code fences. */
export function parseAgentJson(text: string): any {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) throw new Error('The answer held no JSON object.');
  return JSON.parse(text.slice(start, end + 1));
}

const localDay = (epoch: number) => {
  const date = new Date(epoch);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

export function buildRefreshTask(options: RefreshTaskOptions): AgentTask {
  const { needs, reason, dataDir, ledgerDir, pluginRoot, openDatabase } = options;
  const now = options.now ?? Date.now;
  const spawnImpl = options.spawnImpl ?? spawn;
  const paths = skillPaths(pluginRoot);
  const goalsFolder = join(ledgerDir, 'owner-goals', localDay(now()));
  // The owner-goals scripts write and read their files only in today's goals folder (--out, --goals, --prompts, --map).
  const programs: RefreshProgram[] = [
    ['bun', paths.cli],
    ['python3', paths.exportScript, { within: goalsFolder, options: { '--out': 'path', '--days': 'value', '--start': 'value', '--end': 'value' } }],
    ['python3', paths.saveScript, { within: goalsFolder, options: { '--goals': 'path', '--prompts': 'path', '--map': 'path', '--start': 'value', '--end': 'value', '--dry-run': 'switch' } }],
  ];

  const prompt = [
    'You are claude-mem\'s automatic refresh for My Work. You run in the background on the owner\'s computer with read-only tools; nobody is watching, so never ask a question.',
    `What is due now: ${JSON.stringify(needs)}.`,
    needs.goalsStale
      ? `1. Run the /claude-mem:owner-goals skill. Use the folder ${goalsFolder} for its files.\n2. Then run the /claude-mem:request-progress skill.`
      : '1. Run the /claude-mem:request-progress skill.',
    'Do every step of request-progress over its default 14-day window: group every ungrouped conversation, review every due group (run `pending` again after each round until `due` is 0; there is no group cap), link the groups to the goals, and write the build story. Take as long as the work needs.',
    'Rules for this run:',
    `- Call the CLI by its full path in every command, for example: bun "${paths.cli}" pending --days 14 --limit 48. Do not define shell variables. Bash may run only bun "${paths.cli}", python3 "${paths.exportScript}" and python3 "${paths.saveScript}", one command per call, with JSON passed through a quoted heredoc.`,
    `- Write files only inside ${goalsFolder}.`,
    '- Search memory with the claude-mem MCP tools (search, timeline, get_observations).',
    'When you finish, reply with one line: how many conversations were grouped, how many requests were reviewed and linked to goals, and whether the goals and the build story were refreshed.',
  ].join('\n');

  const checkTool = (toolName: string, input: Record<string, unknown>): true | string => {
    if (['Read', 'Grep', 'Glob', 'Agent', 'Skill'].includes(toolName)) return true;
    if (toolName === 'Bash') return checkRefreshCommand(String(input.command ?? ''), programs) ?? true;
    if (toolName === 'Write') {
      return typeof input.file_path === 'string' && isWithin(input.file_path, goalsFolder) ? true : `Write files only inside ${goalsFolder}.`;
    }
    if (toolName.startsWith('mcp__') && toolName.includes('claude-mem') && MEMORY_TOOLS.includes(toolName.split('__').pop() ?? '')) return true;
    return `${toolName} is not available to the automatic refresh, which uses read-only tools.`;
  };

  const inline = async (ask: AskAgent): Promise<string> => {
    const runDir = join(ledgerDir, 'agent-runs', randomBytes(6).toString('hex'));
    mkdirSync(runDir, { recursive: true });
    let fileNumber = 0;
    const writeInput = (name: string, value: unknown) => {
      const path = join(runDir, `${++fileNumber}-${name}.json`);
      writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
      return path;
    };
    const cli = (argv: string[], input?: unknown) => {
      let output: any;
      const database = openDatabase();
      try { runCli(input === undefined ? argv : [...argv, writeInput(argv[0], input)], { dir: ledgerDir, database, now: now(), print: value => { output = value; } }); }
      finally { database.close(); }
      return output;
    };
    const runScript = (args: string[]) => new Promise<void>((resolveRun, reject) => {
      const child = spawnImpl('python3', args, { cwd: dataDir, env: { ...process.env, CLAUDE_MEM_INTERNAL: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout?.on('data', chunk => { output = (output + chunk).slice(-4000); });
      child.stderr?.on('data', chunk => { output = (output + chunk).slice(-4000); });
      child.on('error', reject);
      child.on('close', code => (code === 0 ? resolveRun() : reject(new Error(`${args[0].split('/').pop()} exited ${code}: ${output.trim().slice(-800)}`))));
    });
    /** Ask, save, and on a validator's refusal ask once more with the reason. */
    const step = async <T>(name: string, question: string, save: (answer: any) => T | Promise<T>): Promise<T> => {
      let refusal: string | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const answer = await ask(refusal ? `${question}\n\nYour previous answer was refused: ${refusal}\nFix it and answer again.` : question);
        try { return await save(parseAgentJson(answer)); }
        catch (error) { refusal = error instanceof Error ? error.message : String(error); }
      }
      throw new Error(`${name}: ${refusal}`);
    };
    const readOnly = 'You are running in a read-only sandbox for claude-mem\'s automatic refresh: you cannot run commands that write or save. Nobody is watching, so never ask a question. Search claude-mem memory with its MCP tools if you have them.';

    try {
      const done: string[] = [];
      if (needs.goalsStale) {
        await runScript([paths.exportScript, '--out', goalsFolder, '--days', '31']);
        await step('owner goals', [
          inlineSkill(paths.ownerGoalsSkill), '---', readOnly,
          `Step 1 is done: the owner's prompts are in ${join(goalsFolder, 'owner-prompts.md')}. Do step 2 yourself (no subagent). Instead of writing owner-map.md and owner-goals.json, reply with only one JSON object: {"map": "<the owner-map.md markdown>", "goals": <the owner-goals.json object>}. The worker saves it with step 3.`,
        ].join('\n\n'), async answer => {
          if (typeof answer.map !== 'string' || !answer.goals || typeof answer.goals !== 'object') throw new Error('Answer needs "map" (markdown) and "goals" (object).');
          writeFileSync(join(goalsFolder, 'owner-map.md'), answer.map, { mode: 0o600 });
          writeFileSync(join(goalsFolder, 'owner-goals.json'), JSON.stringify(answer.goals, null, 2), { mode: 0o600 });
          await runScript([paths.saveScript, '--goals', join(goalsFolder, 'owner-goals.json'), '--prompts', join(goalsFolder, 'owner-prompts.md'), '--map', join(goalsFolder, 'owner-map.md')]);
        });
        done.push('goals refreshed');
      }

      const requestProgress = inlineSkill(paths.requestProgressSkill);
      const candidates = cli(['candidates', '--days', '14', '--brief']);
      if (candidates.candidates.some((candidate: { currentGroup: string | null }) => !candidate.currentGroup)) {
        const decisions = await step('grouping', [
          requestProgress, '---', readOnly,
          `Do only section 1 (grouping). The \`candidates --days 14 --brief\` output is in ${writeInput('candidates', candidates)}. Reply with only the decisions JSON that \`apply\` takes ({"groups": [...], "ignored": [...]}).`,
        ].join('\n\n'), answer => cli(['apply'], answer));
        done.push(`${decisions.conversations} conversations in ${decisions.groups} groups`);
      }

      const due: Array<{ groupId: string }> = cli(['pending', '--days', '14', '--limit', '1000000']).groups;
      let reviewed = 0;
      for (let index = 0; index < due.length; index += REVIEW_BATCH) {
        // Like step(), but a refusal re-asks only for the groups that were refused.
        let shows = due.slice(index, index + REVIEW_BATCH).map(group => cli(['show', group.groupId]));
        let refusals: string[] = [];
        for (let attempt = 0; attempt < 2 && shows.length; attempt++) {
          const text = await ask([
            requestProgress, '---', readOnly,
            `Do only section 2's review for the groups whose \`show\` output is in ${writeInput('show', shows)}: decide each one from the evidence as the reviewer task describes. Reply with only {"reviews": [<one record-progress input per group, with reviewBasis copied verbatim from its show output>]}.`,
            refusals.length ? `Your previous answer was refused for these groups:\n${refusals.join('\n')}\nFix them and answer again for those groups only.` : '',
          ].join('\n\n'));
          let reviews: Array<{ groupId?: string }> = [];
          try { const answer = parseAgentJson(text); reviews = Array.isArray(answer.reviews) ? answer.reviews : []; }
          catch { /* Every group in this batch is refused below as "no review was given". */ }
          refusals = [];
          const recorded = new Set<string>();
          for (const review of reviews) {
            try { cli(['record-progress'], review); recorded.add(String(review.groupId)); reviewed++; }
            catch (error) { refusals.push(`${review.groupId}: ${error instanceof Error ? error.message : String(error)}`); }
          }
          shows = shows.filter(show => !recorded.has(show.groupId));
          for (const show of shows) if (!refusals.some(line => line.startsWith(`${show.groupId}:`))) refusals.push(`${show.groupId}: no review was given.`);
        }
        if (shows.length) throw new Error(`reviews: ${refusals.join('; ').slice(0, 500)}`);
      }
      if (reviewed) done.push(`${reviewed} requests reviewed`);

      const alignInput = cli(['align-input']);
      if (alignInput.goals.goals.length) {
        const aligned = await step('alignment', [
          requestProgress, '---', readOnly,
          `Do only section 3 (link each request to the goals it serves). The \`align-input\` output is in ${writeInput('align-input', alignInput)}. Reply with only the JSON that \`record-alignment\` takes ({"links": [...], "unaligned": [...]}); every group must appear in one of them.`,
        ].join('\n\n'), answer => cli(['record-alignment'], answer));
        done.push(`${aligned.aligned} linked to goals`);
      }

      const storyInput = cli(['story-input']);
      if (reviewed || (!storyInput.previousStory && storyInput.reviews.length)) {
        await step('build story', [
          requestProgress, '---', readOnly,
          `Do only section 4 (write the build story). The \`story-input\` output is in ${writeInput('story-input', storyInput)}. Reply with only the JSON that \`record-story\` takes ({"narrative": "...", "preferences": [...]}).`,
        ].join('\n\n'), answer => cli(['record-story'], answer));
        done.push('story rewritten');
      }
      return done.length ? `${done.join(', ')}.` : 'Nothing was due.';
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  };

  return {
    reason,
    cwd: dataDir,
    claudeCode: {
      prompt,
      plugins: [{ type: 'local', path: pluginRoot }],
      skills: ['claude-mem:owner-goals', 'claude-mem:request-progress'],
      tools: ['Skill', 'Read', 'Grep', 'Glob', 'Agent', 'Bash', 'Write'],
      allowedTools: ['Read', 'Grep', 'Glob', 'Agent', ...MEMORY_TOOLS.map(tool => `${PLUGIN_MCP_PREFIX}${tool}`)],
      checkTool,
    },
    inline,
  };
}
