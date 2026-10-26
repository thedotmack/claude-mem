/**
 * The job My Work's automatic refresh hands the agent runner: refresh the
 * owner's goals when they are stale, then group, review, align and retell
 * every request that is due. No day window beyond the skill's own default,
 * no group cap and no time limit (owner rule, Oct 22).
 *
 * Every backend (Claude Code, Codex, Gemini) runs the same way: the worker
 * runs the skills' CLI and scripts, asks the read-only agent one JSON
 * question per step, and saves the answer through the same validators the
 * skills' CLI uses.
 */

import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { AgentTask, AnswerSchema, AskAgent, StepModels } from '../agent-runner/run.js';
import type { UsableAgentId } from '../agent-runner/detect.js';
import { runCommand } from '../agent-runner/detect.js';
import { writeOwnerPromptsFile, type OwnerPromptsFile } from '../prompt-import/owner-prompts-file.js';
import { resolvePythonCommand } from './python.js';
import { readGoals, runCli, validateGroupingAnswer, type LedgerDatabase, type RefreshNeeds } from './request-groups.mjs';

/** claude-mem MCP tools a refresh may call: reads only. Saves go through the skills' scripts and their
 * validators (save_goals.py, the request-groups CLI), never a raw work_state_write. */
export const MEMORY_TOOLS = ['search', 'dumb_search', 'timeline', 'get_observations', 'get_tool_uses', 'work_state_read'];
const PLUGIN_MCP_PREFIX = 'mcp__plugin_claude-mem_mcp-search__';
const REVIEW_BATCH = 8;

/** The model each step runs on. Small, fast models match conversations and goals; stronger ones judge
 * progress, write the story and pick verbatim quotes. Codex's careful steps use its CLI default model.
 * Ids checked against claude --help (aliases), codex-cli 0.163.0 models_cache.json and gemini 0.49.0 aliases. */
const LIGHT: StepModels = { 'claude-code': { model: 'haiku' }, codex: { model: 'gpt-6-luna', reasoningEffort: 'low' }, gemini: { model: 'flash-lite' } };
const CAREFUL: StepModels = { 'claude-code': { model: 'sonnet' }, codex: {}, gemini: { model: 'flash' } };
export const STEP_MODELS = { goals: CAREFUL, grouping: LIGHT, review: CAREFUL, alignment: LIGHT, story: CAREFUL } as const;
type Step = keyof typeof STEP_MODELS;

const strictObject = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const stringArray = { type: 'array', items: { type: 'string' } };
/** The decisions `apply` takes, as Codex's structured-output schema (strict mode: every field required). */
export const GROUPING_ANSWER_SCHEMA: AnswerSchema = strictObject({
  groups: { type: 'array', items: strictObject({
    title: { type: 'string' },
    conversations: stringArray,
    links: { type: 'array', items: strictObject({ kind: { type: 'string', enum: ['shared-work-list', 'shared-request-id', 'agent-judgment'] }, conversations: stringArray, evidence: { type: 'string' } }) },
  }) },
  ignored: { type: 'array', items: strictObject({ conversation: { type: 'string' }, reason: { type: 'string' } }) },
});

/** When each step ran, for refresh.json's run record (not shown in My Work). */
export interface StepTiming { step: string; agent: UsableAgentId; startedAt: string; finishedAt: string; groups?: number }

export interface RefreshTaskOptions {
  needs: RefreshNeeds;
  reason: string;
  /** ~/.claude-mem: where the skill scripts run. */
  dataDir: string;
  /** ~/.claude-mem/work-view: every backend's working directory, and the only folder Claude Code may read. */
  ledgerDir: string;
  /** The installed plugin folder holding skills/ and .mcp.json. */
  pluginRoot: string;
  openDatabase: () => LedgerDatabase & { close(): void };
  now?: () => number;
  spawnImpl?: typeof spawn;
  /** Owner-goals step 1: writes owner-prompts.md into the folder from every agent's transcripts (prompt importer). */
  writeOwnerPrompts?: (folder: string, sinceMinute: string | null) => Promise<OwnerPromptsFile>;
}

function skillPaths(pluginRoot: string) {
  const skills = join(pluginRoot, 'skills');
  return {
    requestProgressSkill: join(skills, 'request-progress', 'SKILL.md'),
    ownerGoalsSkill: join(skills, 'owner-goals', 'SKILL.md'),
    cli: join(skills, 'request-progress', 'scripts', 'request-groups.mjs'),
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

const pad = (value: number) => String(value).padStart(2, '0');
const localDay = (epoch: number) => {
  const date = new Date(epoch);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
/** The local `YYYY-MM-DD HH:MM` that owner-prompts.md headers use. */
const localMinute = (epoch: number) => `${localDay(epoch)} ${pad(new Date(epoch).getHours())}:${pad(new Date(epoch).getMinutes())}`;

/** The saved goals as the owner-goals.json the skill writes, so an update starts from them. */
function goalsJson(saved: ReturnType<typeof readGoals>) {
  const items = (kind: string) => saved.goals.filter(goal => goal.kind === kind).map(goal => ({
    rank: goal.rank, title: goal.title, product: goal.product, latest_at: goal.latestAt, times_asked: goal.timesAsked, evidence: goal.evidence,
  }));
  return { generated_at: saved.generatedAt, window_days: 31, human_summary: saved.summary, priorities: items('priority'), open_asks: items('open-ask') };
}

export function buildRefreshTask(options: RefreshTaskOptions): AgentTask & { steps: StepTiming[] } {
  const { needs, reason, dataDir, ledgerDir, pluginRoot, openDatabase } = options;
  const now = options.now ?? Date.now;
  const paths = skillPaths(pluginRoot);
  const goalsFolder = join(ledgerDir, 'owner-goals', localDay(now()));
  const writeOwnerPrompts = options.writeOwnerPrompts ?? ((folder, sinceMinute) => writeOwnerPromptsFile({ folder, sinceMinute }));
  // Owner-goals step 1 is the prompt importer's (one filter for every agent), run once as the task's prepare step:
  // with saved goals, it also writes the prompts typed since they were saved (new-owner-prompts.md).
  let savedGoals: ReturnType<typeof readGoals> | null = null;
  let since: string | null = null;
  let exported: OwnerPromptsFile | null = null;
  let exportedAt = new Date(now()).toISOString();
  const prepareGoals = async () => {
    const database = openDatabase();
    try { savedGoals = readGoals(database); } finally { database.close(); }
    since = savedGoals.goals.length && Number.isFinite(Date.parse(savedGoals.generatedAt ?? '')) ? localMinute(Date.parse(savedGoals.generatedAt!)) : null;
    exportedAt = new Date(now()).toISOString();
    exported = await writeOwnerPrompts(goalsFolder, since);
  };

  const steps: StepTiming[] = [];
  const run = async (askBackend: AskAgent, agent: UsableAgentId): Promise<string> => {
    const runDir = join(ledgerDir, 'agent-runs', randomBytes(6).toString('hex'));
    mkdirSync(runDir, { recursive: true });
    let fileNumber = 0;
    const inlineEvidence = new Map<string, string>();
    if (agent === 'gemini' && needs.goalsStale) {
      for (const name of ['owner-prompts.md', 'new-owner-prompts.md']) {
        const path = join(goalsFolder, name);
        if (existsSync(path)) inlineEvidence.set(path, readFileSync(path, 'utf8'));
      }
    }
    const ask: AskAgent = (prompt, models, schema) => {
      const supplied = agent === 'gemini' ? [...inlineEvidence].filter(([path]) => prompt.includes(path)) : [];
      return askBackend(supplied.length ? `${prompt}\n\nThe following input files are supplied inline; no file tools are available:\n${supplied.map(([path, contents]) => `--- ${path} ---\n${contents}`).join('\n\n')}` : prompt, models, schema);
    };
    const writeInput = (name: string, value: unknown) => {
      const path = join(runDir, `${++fileNumber}-${name}.json`);
      const contents = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      writeFileSync(path, contents, { mode: 0o600 });
      inlineEvidence.set(path, contents);
      return path;
    };
    const cli = (argv: string[], input?: unknown) => {
      let output: any;
      const database = openDatabase();
      try { runCli(input === undefined ? argv : [...argv, writeInput(argv[0], input)], { dir: ledgerDir, database, now: now(), print: value => { output = value; } }); }
      finally { database.close(); }
      return output;
    };
    let python: ReturnType<typeof resolvePythonCommand> | undefined;
    /** Resolve once per refresh. Never retry a script that may already have saved goals. */
    const runScript = async (args: string[]) => {
      const spawnImpl = options.spawnImpl ?? spawn;
      const interpreter = await (python ??= resolvePythonCommand(spawnImpl));
      const result = await runCommand(spawnImpl, interpreter.command, [...interpreter.args, ...args], { cwd: dataDir, env: { ...process.env, CLAUDE_MEM_INTERNAL: '1', PYTHONUTF8: '1' } });
      if (result.spawnError) throw result.spawnError;
      if (result.exitCode !== 0) throw new Error(`${args[0].split('/').pop()} exited ${result.exitCode}: ${`${result.stdout}\n${result.stderr}`.trim().slice(-800)}`);
      return result.stdout;
    };
    const timed = async <T>(name: string, work: () => Promise<T>, extra: { groups?: number } = {}): Promise<T> => {
      const startedAt = new Date(now()).toISOString();
      try { return await work(); }
      finally { steps.push({ step: name, agent, startedAt, finishedAt: new Date(now()).toISOString(), ...extra }); }
    };
    /** Ask, save, and on a refusal (unreadable JSON or a validator's) ask once more with the reason.
     * A step refused twice fails with its last raw answer kept in failed-answers/ for diagnosis. */
    const step = <T>(name: Step, question: string, save: (answer: any) => T | Promise<T>, answerSchema?: AnswerSchema): Promise<T> => timed(name, async () => {
      let refusal: string | null = null;
      let answer = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        answer = await ask(refusal ? `${question}\n\nYour previous answer was refused: ${refusal}\nFix it and answer again.` : question, STEP_MODELS[name], answerSchema);
        try { return await save(parseAgentJson(answer)); }
        catch (error) { refusal = error instanceof Error ? error.message : String(error); }
      }
      const failedDir = join(ledgerDir, 'failed-answers');
      mkdirSync(failedDir, { recursive: true });
      const answerPath = join(failedDir, `${new Date(now()).toISOString().replaceAll(':', '-')}-${name}-${agent}.txt`);
      writeFileSync(answerPath, answer, { mode: 0o600 });
      // The path goes first: the runner keeps only the first 500 characters of an error.
      throw new Error(`${name} (raw answer: ${answerPath}): ${refusal}`);
    });
    const readOnly = [
      'You are running in a read-only sandbox for claude-mem\'s automatic refresh: you cannot run commands that write or save. Nobody is watching, so never ask a question.',
      agent === 'claude-code'
        ? 'Search claude-mem memory with its MCP tools (search, timeline, get_observations) for evidence beyond the input files.'
        : 'You have no memory tools: the input files hold the evidence (each conversation\'s asks and observations). Where the skill says to search memory, use them instead.',
    ].join(' ');

    try {
      const done: string[] = [];
      if (needs.goalsStale) {
        // With saved goals, update them from the prompts typed since; otherwise map the whole window.
        if (!savedGoals || !exported) throw new Error('The owner prompts were not prepared.');
        const saved: ReturnType<typeof readGoals> = savedGoals, { ownerPrompts, newPrompts } = exported as OwnerPromptsFile;
        const goalsPath = join(goalsFolder, 'owner-goals.json'), promptsPath = join(goalsFolder, 'owner-prompts.md');
        const save = async (goals: Record<string, unknown>, mapPath: string | null) => {
          writeFileSync(goalsPath, JSON.stringify({ ...goals, source_prompt_count: ownerPrompts }, null, 2), { mode: 0o600 });
          await runScript([paths.saveScript, '--goals', goalsPath, '--prompts', promptsPath, ...(mapPath ? ['--map', mapPath] : []), ...(since ? ['--carried-before', since] : [])]);
        };
        const previousMap = saved.mapPath && existsSync(saved.mapPath) ? saved.mapPath : null;
        if (!ownerPrompts) {
          // No evidence needs no model call. Save the validated empty snapshot so
          // the scheduler can continue grouping and will not retry every check.
          await save({ generated_at: exportedAt, window_days: 31, human_summary: 'No owner prompts in this window.', priorities: [], open_asks: [] }, null);
          done.push('goals empty');
        } else if (!since) {
          await step('goals', [
            inlineSkill(paths.ownerGoalsSkill), '---', readOnly,
            `Step 1 is done: the owner's prompts are in ${promptsPath}. Do step 2 yourself (no subagent). Instead of writing owner-map.md and owner-goals.json, reply with only one JSON object: {"map": "<the owner-map.md markdown>", "goals": <the owner-goals.json object>}. The worker saves it with step 3.`,
          ].join('\n\n'), async answer => {
            if (typeof answer.map !== 'string' || !answer.goals || typeof answer.goals !== 'object') throw new Error('Answer needs "map" (markdown) and "goals" (object).');
            writeFileSync(join(goalsFolder, 'owner-map.md'), answer.map, { mode: 0o600 });
            await save({ ...answer.goals, generated_at: exportedAt }, join(goalsFolder, 'owner-map.md'));
          });
          done.push('goals mapped');
        } else if (!newPrompts) {
          // Nothing new typed: the saved goals still hold; re-save them as current.
          await save({ ...goalsJson(saved), generated_at: exportedAt }, previousMap);
          done.push('goals unchanged');
        } else {
          const previousPath = writeInput('previous-owner-goals', goalsJson(saved));
          await step('goals', [
            inlineSkill(paths.ownerGoalsSkill), '---', readOnly,
            `Do "Update the saved goals" yourself (no subagent). The saved goals are in ${previousPath}; the ${newPrompts} prompts the owner typed since they were saved are in ${join(goalsFolder, 'new-owner-prompts.md')}. Reply with only the updated owner-goals.json object. The worker saves it with step 3.`,
          ].join('\n\n'), answer => save({ ...answer, generated_at: exportedAt }, previousMap));
          done.push('goals updated');
        }
      }

      const requestProgress = inlineSkill(paths.requestProgressSkill);
      // Only conversations the ledger has not decided, one project root per question, each beside
      // that root's open requests. Every batch is saved before the next is read, so a later batch
      // sees the requests an earlier one started.
      let grouped = 0;
      for (let input = cli(['grouping-input', '--days', '14']); input.conversations.length; input = cli(['grouping-input', '--days', '14'])) {
        await step('grouping', [
          requestProgress, '---', readOnly,
          // The batch is inline, with its keys named: on a file path alone Codex's light model sometimes
          // answered {"groups": [], "ignored": []} without reading it (Oct 23, twice in a row).
          `Do only section 1 (grouping) for this one batch of new conversations, the \`grouping-input\` output (also saved in ${writeInput('grouping-input', input)}):\n\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``,
          `Decide each of these ${input.conversations.length} conversations exactly once, in "groups" or "ignored": ${input.conversations.map((conversation: { conversationKey: string }) => conversation.conversationKey).join(', ')}. Reply with only the decisions JSON that \`apply\` takes ({"groups": [...], "ignored": [...]}), deciding every conversation in the batch and nothing else.`,
        ].join('\n\n'), answer => cli(['apply'], validateGroupingAnswer(answer, input)), GROUPING_ANSWER_SCHEMA);
        grouped += input.conversations.length;
      }
      if (grouped) done.push(`${grouped} new conversations grouped`);

      const due: Array<{ groupId: string }> = cli(['pending', '--days', '14', '--limit', '1000000']).groups;
      let reviewed = 0;
      /** One batch of reviews. Like step(), but a refusal re-asks only for the groups that were refused. */
      const reviewBatch = async (groups: Array<{ groupId: string }>) => {
        let shows = groups.map(group => cli(['show', group.groupId]));
        let refusals: string[] = [];
        for (let attempt = 0; attempt < 2 && shows.length; attempt++) {
          const text = await ask([
            requestProgress, '---', readOnly,
            `Do only section 2's review for the groups whose \`show\` output is in ${writeInput('show', shows)}: decide each one from the evidence as the reviewer task describes (amend the previous review for a group in "amend" mode). Reply with only {"reviews": [<one record-progress input per group, with reviewBasis copied verbatim from its show output>]}.`,
            refusals.length ? `Your previous answer was refused for these groups:\n${refusals.join('\n')}\nFix them and answer again for those groups only.` : '',
          ].join('\n\n'), STEP_MODELS.review);
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
      };
      // Batches are independent, so they run at once; every batch finishes (and saves) before a failure is reported.
      const batches: Array<Array<{ groupId: string }>> = [];
      for (let index = 0; index < due.length; index += REVIEW_BATCH) batches.push(due.slice(index, index + REVIEW_BATCH));
      const failed = (await Promise.allSettled(batches.map(batch => timed('review', () => reviewBatch(batch), { groups: batch.length })))).filter(outcome => outcome.status === 'rejected');
      if (failed.length) throw (failed[0] as PromiseRejectedResult).reason;
      if (reviewed) done.push(`${reviewed} requests reviewed`);

      // Only groups not yet aligned to the current goals.
      const alignInput = cli(['align-input']);
      if (alignInput.groups.length) {
        const aligned = await step('alignment', [
          requestProgress, '---', readOnly,
          // Inline with every id named, like grouping: on a file path Codex's light model linked 2 of 60 groups (Oct 23).
          `Do only section 3 (link each request to the goals it serves) for the groups in this \`align-input\` output (also saved in ${writeInput('align-input', alignInput)}):\n\n\`\`\`json\n${JSON.stringify(alignInput, null, 2)}\n\`\`\``,
          `Decide each of these ${alignInput.groups.length} groups, in "links" or "unaligned": ${alignInput.groups.map((group: { groupId: string }) => group.groupId).join(', ')}. Reply with only the JSON that \`record-alignment\` takes ({"links": [...], "unaligned": [...]}); every listed group must appear in one of them.`,
        ].join('\n\n'), answer => cli(['record-alignment'], answer));
        done.push(`${aligned.aligned} linked to goals`);
      }

      // Only reviews whose facts (state, percent, dates, milestones, preferences, outcome) moved since the last story; none means the story still holds.
      const storyInput = cli(['story-input']);
      if (storyInput.reviews.length) {
        await step('story', [
          requestProgress, '---', readOnly,
          `Do only section 4 (${storyInput.update ? 'update' : 'write'} the build story). The \`story-input\` output is in ${writeInput('story-input', storyInput)}. Reply with only the JSON that \`record-story\` takes ({"narrative": "...", "preferences": [...]}).`,
        ].join('\n\n'), answer => cli(['record-story'], answer));
        done.push(storyInput.update ? 'story updated' : 'story written');
      }
      return done.length ? `${done.join(', ')}.` : 'Nothing was due.';
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  };

  return {
    reason,
    steps,
    // The work-view folder holds every input file; the data dir above it holds .env and settings.json.
    cwd: ledgerDir,
    claudeCode: {
      // The plugin is loaded for its memory-search MCP server; steps read their input files and search memory, nothing else.
      plugins: [{ type: 'local', path: pluginRoot }],
      tools: ['Read', 'Grep', 'Glob'],
      allowedTools: MEMORY_TOOLS.map(tool => `${PLUGIN_MCP_PREFIX}${tool}`),
      // Prompts carry untrusted conversation text, so file reads are held to the input files' folder.
      readableFolders: [ledgerDir],
    },
    run,
    prepare: needs.goalsStale ? prepareGoals : undefined,
  };
}
