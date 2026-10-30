/**
 * The job My Work's automatic refresh hands the agent runner: refresh the
 * owner's goals when they are stale, then group, review, sort into focus areas and retell
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
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { FOCUS_BATCH, readGoals, readLedger, runCli, validateFocusAnswer, validateGroupingAnswer, type FocusInput, type LedgerDatabase, type RefreshNeeds } from './request-groups.mjs';
import { FOCUS_AUTO_PLACE_THRESHOLD, judgeFocusBatch, placesAlone, type FocusJudge, type FocusJudgement } from './focus-judge.mjs';
import { isWithdrawnArea, PROPOSAL_KINDS, readFocusAreas, type FocusArea, type RouterFocusBody } from './my-focus.mjs';
import { NAV_LABELS } from './nav-words.mjs';
import { routeUndecided, type RequestJudge } from './request-judge.mjs';

/** claude-mem MCP tools a refresh may call: reads only. Saves go through the skills' scripts and their
 * validators (save_goals.py, the request-groups CLI), never a raw work_state_write. */
export const MEMORY_TOOLS = ['search', 'dumb_search', 'timeline', 'get_observations', 'get_tool_uses', 'work_state_read'];
const PLUGIN_MCP_PREFIX = 'mcp__plugin_claude-mem_mcp-search__';
const REVIEW_BATCH = 8;
/** save_goals.py's FAILED_AFTER_WRITING_EXIT: it failed after its first write, so the goals step must not ask again. */
const SAVE_GOALS_FAILED_AFTER_WRITING_EXIT = 3;
/**
 * Review batches running at the same time. Each batch is one agent process, so this follows the
 * owner's cap on concurrent agent subprocesses, CLAUDE_MEM_MAX_CONCURRENT_AGENTS (default 2), rather
 * than a number of its own. Read on every run, so raising the setting takes effect without a restart.
 */
export function reviewConcurrency(dataDir: string): number {
  // A 0, negative or non-numeric value would start no review lanes and skip every review without a failure,
  // so each source is used only when it is a positive count: settings file, then environment, then built-in default.
  const positive = (value: string | undefined) => { const count = parseInt(value ?? '', 10); return Number.isFinite(count) && count >= 1 ? count : null; };
  return positive(SettingsDefaultsManager.loadFromFile(join(dataDir, 'settings.json'), true, { readOnly: true }).CLAUDE_MEM_MAX_CONCURRENT_AGENTS)
    ?? positive(SettingsDefaultsManager.get('CLAUDE_MEM_MAX_CONCURRENT_AGENTS'))
    ?? parseInt(SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_MAX_CONCURRENT_AGENTS, 10);
}

/** The model each step runs on. Small, fast models match conversations and goals; stronger ones judge
 * progress, write the story and pick verbatim quotes. Codex's careful steps use its CLI default model.
 * Ids checked against claude --help (aliases), codex-cli 0.163.0 models_cache.json and gemini 0.49.0 aliases. */
const LIGHT: StepModels = { 'claude-code': { model: 'haiku' }, codex: { model: 'gpt-6-luna', reasoningEffort: 'low' }, gemini: { model: 'flash-lite' } };
const CAREFUL: StepModels = { 'claude-code': { model: 'sonnet' }, codex: {}, gemini: { model: 'flash' } };
export const STEP_MODELS = { goals: CAREFUL, grouping: LIGHT, review: CAREFUL, focus: LIGHT, story: CAREFUL } as const;
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

/** The answer `record-focus` takes: every request placed by area id (or "other"), and areas proposed from Other.
 * sameAs is the model's judgment of which saved area (dismissed ones included) a proposal already is, or null. */
export const FOCUS_ANSWER_SCHEMA: AnswerSchema = strictObject({
  placements: { type: 'array', items: strictObject({ anchor: { type: 'string' }, focusAreaId: { type: 'string' }, evidence: { type: 'string' } }) },
  proposals: { type: 'array', items: strictObject({
    kind: { type: 'string', enum: [...PROPOSAL_KINDS] },
    name: { type: 'string' }, goal: { type: 'string' }, about: { type: 'string' },
    anchors: stringArray,
    sameAs: { type: ['string', 'null'] },
    evidence: { type: 'string' },
  }) },
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
  /** Files each new conversation under the request it continues before the grouping agent sees it (Jev on
   * a CMEM Pro or OpenRouter install, request-judge.mjs). Null or absent: code links alone route, and the
   * agent decides the rest as before. */
  judge?: RequestJudge | null;
  /** Asks Jev which kept focus area each request of a focus batch is part of, before the focus agent sees it
   * (focus-judge.mjs; built from the same settings as `judge`). Null or absent: the agent places alone, as before. */
  focusJudge?: FocusJudge | null;
  /** The confidence at which a focus-judge pick is placed without the agent; FOCUS_AUTO_PLACE_THRESHOLD (null: never)
   * unless a test injects one. */
  focusAutoPlaceThreshold?: number | null;
  now?: () => number;
  spawnImpl?: typeof spawn;
  /** This worker's sync device id ('' when cloud sync never started), so my-focus rows replay in the same order the
   * worker's snapshot uses. Required. */
  localDeviceId: () => string;
  /** The focus step's write: the worker's system-only my-focus write (WorkViewRoutes.recordRouterFocus), called
   * in-process. Throws a TypeError when it refused the answer before writing anything. */
  saveFocus?: (body: RouterFocusBody) => { placed: number; focusAreaIds: string[] } | Promise<{ placed: number; focusAreaIds: string[] }>;
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

/** A story preference's ISO time as the local minute owner-prompts.md headers use. */
const quoteMinute = (at: string) => {
  const epoch = Date.parse(at);
  if (!Number.isFinite(epoch)) throw new Error(`A saved owner-goals rule quote has no readable time: ${at}`);
  return localMinute(epoch);
};

/** The saved goals as the owner-goals.json the skill writes, so an update starts from them: the focus areas and
 * asks in owner-goals, and the rules owner-goals put in the build story's preferences. */
function goalsJson(saved: ReturnType<typeof readGoals>, story: { preferences?: Array<Record<string, any>> } | null) {
  const items = (kind: string) => saved.goals.filter(goal => goal.kind === kind);
  return {
    generated_at: saved.generatedAt, window_days: 31, human_summary: saved.summary,
    focus_areas: items('focus-area').map(goal => ({ rank: goal.rank, title: goal.title, goal: goal.goal, matches: goal.focusAreaId,
      latest_at: goal.latestAt, times_asked: goal.timesAsked, evidence: goal.evidence })),
    asks: items('ask').map(goal => ({ rank: goal.rank, title: goal.title, focus_area: goal.focusArea,
      latest_at: goal.latestAt, times_asked: goal.timesAsked, evidence: goal.evidence })),
    rules: (story?.preferences ?? []).filter(preference => preference.source === 'owner-goals').map(preference => {
      const evidence = (preference.quotes ?? []).map((quote: { quote: string; at: string }) => ({ at: quoteMinute(quote.at), quote: quote.quote }));
      return { when: preference.when ?? '', then: preference.preference, times_asked: preference.supportCount,
        latest_at: evidence.map((quote: { at: string }) => quote.at).sort().at(-1) ?? null, evidence };
    }),
  };
}

/** What the goals step tells the model about My Focus, so it judges which saved area each mined one already is. */
/** The worker refuses a new area named like a nav item (nav-words.mjs), so every prompt that names areas says so. */
const NAV_LABEL_RULE = `A focus area's name never reuses a nav label as whole words, in any case: ${NAV_LABELS.map(label => `"${label}"`).join(', ')}. The worker refuses such a name and the whole answer fails.`;
const focusAreasNote = (path: string) => `The focus areas already saved in My Focus are in ${path} (id, name, goal, status; do not run --print-focus-areas). For each focus area you write, set "matches" to the id of the saved area it already is, whatever its name, or null when none is. Never match by name alone. ${NAV_LABEL_RULE}`;

export function buildRefreshTask(options: RefreshTaskOptions): AgentTask & { steps: StepTiming[] } {
  const { needs, reason, dataDir, ledgerDir, pluginRoot, openDatabase } = options;
  if (typeof options.localDeviceId !== 'function') throw new TypeError('buildRefreshTask needs localDeviceId, the worker\'s sync device id.');
  const now = options.now ?? Date.now;
  const paths = skillPaths(pluginRoot);
  const goalsFolder = join(ledgerDir, 'owner-goals', localDay(now()));
  const writeOwnerPrompts = options.writeOwnerPrompts ?? ((folder, sinceMinute) => writeOwnerPromptsFile({ folder, sinceMinute }));
  // Owner-goals step 1 is the prompt importer's (one filter for every agent), run once as the task's prepare step:
  // with saved goals, it also writes the prompts typed since they were saved (new-owner-prompts.md).
  let savedGoals: ReturnType<typeof readGoals> | null = null;
  let savedAreas: FocusArea[] = [];
  let since: string | null = null;
  let exported: OwnerPromptsFile | null = null;
  let exportedAt = new Date(now()).toISOString();
  const prepareGoals = async () => {
    const database = openDatabase();
    // A withdrawn area (a seed undo) is no match target: the owner never had it, so it is left out of the saved areas.
    try { savedGoals = readGoals(database); savedAreas = readFocusAreas(database, { localDeviceId: options.localDeviceId() }).filter(area => !isWithdrawnArea(area)); } finally { database.close(); }
    since = savedGoals.goals.length && Number.isFinite(Date.parse(savedGoals.generatedAt ?? '')) ? localMinute(Date.parse(savedGoals.generatedAt!)) : null;
    exportedAt = new Date(now()).toISOString();
    exported = await writeOwnerPrompts(goalsFolder, since);
  };

  const steps: StepTiming[] = [];
  const run = async (askBackend: AskAgent, agent: UsableAgentId): Promise<string> => {
    const runDir = join(ledgerDir, 'agent-runs', randomBytes(6).toString('hex'));
    mkdirSync(runDir, { recursive: true });
    let fileNumber = 0;
    // Once any answer from this agent was refused, the run's error carries `answerRefused` whatever failed first,
    // so the runner never hands the refresh to another agent (#5189). Batches and focus can fail in any order.
    let answerWasRefused = false;
    const refused = (error: Error) => { answerWasRefused = true; return Object.assign(error, { answerRefused: true }); };
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
    const localDeviceId = options.localDeviceId();
    const cli = (argv: string[], input?: unknown) => {
      let output: any;
      const database = openDatabase();
      try { runCli(input === undefined ? argv : [...argv, writeInput(argv[0], input)], { dir: ledgerDir, database, now: now(), print: value => { output = value; }, localDeviceId }); }
      finally { database.close(); }
      return output;
    };
    /** record-focus: checked against the database, then written by the worker. The worker checks the whole answer before
     * its first write, so its refusal (a TypeError) is re-asked; any other failure is not, since a retry would not help. */
    const recordFocus = async (flags: string[], answer: unknown) => {
      if (!options.saveFocus) throw Object.assign(new Error('The focus step has no way to save: the worker did not pass its my-focus write.'), { retryable: false });
      let output: any;
      const database = openDatabase();
      try {
        await runCli(['record-focus', ...flags, writeInput('record-focus', answer)], {
          dir: ledgerDir, database, now: now(), print: value => { output = value; }, localDeviceId,
          saveFocus: async body => {
            try { return await options.saveFocus!(body); }
            catch (error) { throw error instanceof TypeError ? error : Object.assign(error instanceof Error ? error : new Error(String(error)), { retryable: false }); }
          },
        });
      } finally { database.close(); }
      return output as { placed: number; proposed: number };
    };
    let python: ReturnType<typeof resolvePythonCommand> | undefined;
    /** Resolve once per refresh, and never retry the script with another interpreter. The goals step re-asks the model
     * after a refusal, which save_goals.py gives before it writes anything (exit 1); a failure after it started writing
     * (FAILED_AFTER_WRITING_EXIT) is never retried, since a second answer would suggest its new areas again. */
    const runScript = async (args: string[]) => {
      const spawnImpl = options.spawnImpl ?? spawn;
      const interpreter = await (python ??= resolvePythonCommand(spawnImpl));
      const result = await runCommand(spawnImpl, interpreter.command, [...interpreter.args, ...args], { cwd: dataDir, env: { ...process.env, CLAUDE_MEM_INTERNAL: '1', PYTHONUTF8: '1' } });
      if (result.spawnError) throw result.spawnError;
      if (result.exitCode !== 0) {
        throw Object.assign(new Error(`${args[0].split('/').pop()} exited ${result.exitCode}: ${`${result.stdout}\n${result.stderr}`.trim().slice(-800)}`),
          { retryable: result.exitCode !== SAVE_GOALS_FAILED_AFTER_WRITING_EXIT });
      }
      return result.stdout;
    };
    const timed = async <T>(name: string, work: () => Promise<T>, extra: { groups?: number } = {}): Promise<T> => {
      const startedAt = new Date(now()).toISOString();
      try { return await work(); }
      finally { steps.push({ step: name, agent, startedAt, finishedAt: new Date(now()).toISOString(), ...extra }); }
    };
    /** Ask, save, and on a refusal (unreadable JSON or a validator's) ask once more with the answer and reason.
     * A step refused twice fails with its last raw answer kept in failed-answers/ for diagnosis. */
    const step = <T>(name: Step, question: string, save: (answer: any) => T | Promise<T>, answerSchema?: AnswerSchema): Promise<T> => timed(name, async () => {
      let refusal: string | null = null;
      let answer = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        answer = await ask(refusal ? `${question}\n\nYour previous answer was refused: ${refusal}\nRejected answer:\n${answer}\n\nFix it and answer again.` : question, STEP_MODELS[name], answerSchema);
        try { return await save(parseAgentJson(answer)); }
        catch (error) {
          // A save that failed after it started writing is not the answer's fault, and asking again would write twice.
          if ((error as { retryable?: boolean })?.retryable === false) throw error;
          refusal = error instanceof Error ? error.message : String(error);
        }
      }
      const failedDir = join(ledgerDir, 'failed-answers');
      mkdirSync(failedDir, { recursive: true });
      const answerPath = join(failedDir, `${new Date(now()).toISOString().replaceAll(':', '-')}-${name}-${agent}.txt`);
      writeFileSync(answerPath, answer, { mode: 0o600 });
      // The path goes first: the runner keeps only the first 500 characters of an error.
      throw refused(new Error(`${name} (raw answer: ${answerPath}): ${refusal}`));
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
          await runScript([paths.saveScript, '--goals', goalsPath, '--prompts', promptsPath, '--ledger-dir', ledgerDir, ...(mapPath ? ['--map', mapPath] : []), ...(since ? ['--carried-before', since] : [])]);
        };
        const previousMap = saved.mapPath && existsSync(saved.mapPath) ? saved.mapPath : null;
        if (!ownerPrompts) {
          // No evidence needs no model call. Save the validated empty snapshot so
          // the scheduler can continue grouping and will not retry every check.
          await save({ generated_at: exportedAt, window_days: 31, human_summary: 'No owner prompts in this window.', focus_areas: [], asks: [], rules: [] }, null);
          done.push('goals empty');
        } else if (!since) {
          await step('goals', [
            inlineSkill(paths.ownerGoalsSkill), '---', readOnly,
            `Step 1 is done: the owner's prompts are in ${promptsPath}. Do step 2 yourself (no subagent). Instead of writing owner-map.md and owner-goals.json, reply with only one JSON object: {"map": "<the owner-map.md markdown>", "goals": <the owner-goals.json object>}. The worker saves it with step 3.`,
            focusAreasNote(writeInput('focus-areas', savedAreas)),
          ].join('\n\n'), async answer => {
            if (typeof answer.map !== 'string' || !answer.goals || typeof answer.goals !== 'object') throw new Error('Answer needs "map" (markdown) and "goals" (object).');
            writeFileSync(join(goalsFolder, 'owner-map.md'), answer.map, { mode: 0o600 });
            await save({ ...answer.goals, generated_at: exportedAt }, join(goalsFolder, 'owner-map.md'));
          });
          done.push('goals mapped');
        } else {
          const previous = goalsJson(saved, readLedger(ledgerDir).story);
          // Items saved before the three tests (priorities and open asks), and focus areas hosted setup saved without a
          // goal sentence or a My Focus area, are sorted again even with nothing new typed.
          const needsSorting = saved.goals.some(goal => goal.legacy || (goal.kind === 'focus-area' && (!goal.goal || !goal.focusAreaId)));
          if (!newPrompts && !needsSorting) {
            // Nothing new typed: the saved goals still hold; re-save them as current.
            await save({ ...previous, generated_at: exportedAt }, previousMap);
            done.push('goals unchanged');
          } else {
            const previousPath = writeInput('previous-owner-goals', previous);
            await step('goals', [
              inlineSkill(paths.ownerGoalsSkill), '---', readOnly,
              `Do "Update the saved goals" yourself (no subagent). The saved goals are in ${previousPath}; the ${newPrompts} prompts the owner typed since they were saved are in ${join(goalsFolder, 'new-owner-prompts.md')}. Reply with only the updated owner-goals.json object. The worker saves it with step 3.`,
              ...(needsSorting ? ['Some saved items were not sorted with the three tests (a focus area with no "goal" or "matches", or an item with no "focus_area"). Apply the three tests to every saved item again, in order, and give each the fields its kind needs.'] : []),
              focusAreasNote(writeInput('focus-areas', savedAreas)),
            ].join('\n\n'), answer => save({ ...answer, generated_at: exportedAt }, previousMap));
            done.push('goals updated');
          }
        }
      }

      const requestProgress = inlineSkill(paths.requestProgressSkill);
      // The judge files each new conversation first: a code link joins at once, and Jev (when the
      // install has it) joins, suggests or starts a request from the opening ask. Only what it cannot
      // place reaches the agent batches below.
      const judgeStartedAt = new Date(now()).toISOString();
      const judgeDatabase = openDatabase();
      let routing: Awaited<ReturnType<typeof routeUndecided>>;
      try { routing = await routeUndecided({ dir: ledgerDir, database: judgeDatabase, judge: options.judge ?? null, now: now(), days: 14, apply: true }); }
      finally { judgeDatabase.close(); }
      if (routing.routed.length || routing.unplaced.length) steps.push({ step: 'judge', agent, startedAt: judgeStartedAt, finishedAt: new Date(now()).toISOString(), groups: routing.routed.length });
      if (routing.routed.length) done.push(`${routing.routed.length} new conversations judged (${routing.counts.joined} joined, ${routing.counts.suggested} suggested, ${routing.counts.new} new)`);
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
        let rejectedReviews: Array<{ groupId?: string }> = [];
        for (let attempt = 0; attempt < 2 && shows.length; attempt++) {
          const text = await ask([
            requestProgress, '---', readOnly,
            `Do only section 2's review for the groups whose \`show\` output is in ${writeInput('show', shows)}: decide each one from the evidence as the reviewer task describes (amend the previous review for a group in "amend" mode). Reply with only {"reviews": [<one record-progress input per group, with reviewBasis copied verbatim from its show output>]}.`,
            refusals.length ? `Your previous answer was refused for these groups:\n${refusals.join('\n')}\nFix them and answer again for those groups only. Here are the rejected reviews to correct, preserving their evidence and reviewBasis:\n${JSON.stringify(rejectedReviews)}` : '',
          ].join('\n\n'), STEP_MODELS.review);
          let reviews: Array<{ groupId?: string }> = [];
          try { const answer = parseAgentJson(text); reviews = Array.isArray(answer.reviews) ? answer.reviews : []; }
          catch { /* Every group in this batch is refused below as "no review was given". */ }
          refusals = [];
          rejectedReviews = [];
          const recorded = new Set<string>();
          for (const review of reviews) {
            try { cli(['record-progress'], review); recorded.add(String(review.groupId)); reviewed++; }
            catch (error) { rejectedReviews.push(review); refusals.push(`${review.groupId}: ${error instanceof Error ? error.message : String(error)}`); }
          }
          shows = shows.filter(show => !recorded.has(show.groupId));
          for (const show of shows) if (!refusals.some(line => line.startsWith(`${show.groupId}:`))) refusals.push(`${show.groupId}: no review was given.`);
        }
        if (shows.length) throw refused(new Error(`reviews: ${refusals.join('; ').slice(0, 500)}`));
      };
      // Batches are independent, so a few run at once; every batch finishes (and saves) before a failure is reported.
      // Not all at once: each batch is its own agent process, and a large backlog (Oct 25: ~1,100 due groups,
      // 138 batches) started every one of them in the same millisecond.
      const batches: Array<Array<{ groupId: string }>> = [];
      for (let index = 0; index < due.length; index += REVIEW_BATCH) batches.push(due.slice(index, index + REVIEW_BATCH));
      const outcomes: PromiseSettledResult<void>[] = [];
      let next = 0;
      const lane = async () => {
        while (next < batches.length) {
          const batch = batches[next++];
          outcomes.push(...await Promise.allSettled([timed('review', () => reviewBatch(batch), { groups: batch.length })]));
        }
      };
      await Promise.all(Array.from({ length: Math.min(reviewConcurrency(dataDir), batches.length) }, lane));
      const failed = outcomes.filter(outcome => outcome.status === 'rejected');
      if (failed.length) throw (failed[0] as PromiseRejectedResult).reason;
      if (reviewed) done.push(`${reviewed} requests reviewed`);

      // Focus: place the requests not placed yet (changed since, or whose area is gone) in batches, each saved before the
      // next is read, then propose areas from Other when the router-placed Other requests changed since the last pass.
      // The story does not depend on it, so a failed focus step is reported after the story has run.
      let focusError: unknown = null;
      try {
        let placed = 0, proposed = 0;
        const sorting = (question: string) => [
          requestProgress, '---', readOnly,
          // Inline with every anchor named, like grouping: on a file path Codex's light model linked 2 of 60 groups (Oct 23).
          question, NAV_LABEL_RULE,
        ].join('\n\n');
        let previousBatch = '';
        // The focus judge (Jev) asks once per request per run: a request it judged stays judged when a later batch lists it again.
        const focusJudge = options.focusJudge ?? null, threshold = options.focusAutoPlaceThreshold === undefined ? FOCUS_AUTO_PLACE_THRESHOLD : options.focusAutoPlaceThreshold;
        const judged = new Map<string, FocusJudgement>(), placedAlone = new Set<string>();
        for (let input: FocusInput = cli(['focus-input', '--limit', String(FOCUS_BATCH)]); input.requests.length; input = cli(['focus-input', '--limit', String(FOCUS_BATCH)])) {
          if (focusJudge) {
            const fresh = input.requests.filter(request => !judged.has(request.anchor));
            if (fresh.length) await timed('focus-judge', async () => {
              const database = openDatabase();
              try { for (const result of await judgeFocusBatch({ judge: focusJudge, input: { ...input, requests: fresh }, database, ledger: readLedger(ledgerDir) })) judged.set(result.anchor, result); }
              finally { database.close(); }
            }, { groups: fresh.length });
            // Picks at or above the threshold are router placements written now, through the same check and write as the
            // agent's answer; the batch is then read again, so the agent's answer is checked against exactly what it saw.
            const alone = input.requests.filter(request => placesAlone(judged.get(request.anchor)!, threshold));
            if (alone.length) {
              const again = alone.find(request => placedAlone.has(request.anchor));
              if (again) throw new Error(`focus: a request the judge placed is still queued (${again.anchor}).`);
              if (!options.saveFocus) throw new Error('The focus step has no way to save: the worker did not pass its my-focus write.');
              const body = validateFocusAnswer({ placements: alone.map(request => ({ anchor: request.anchor, focusAreaId: judged.get(request.anchor)!.focusAreaId, evidence: judged.get(request.anchor)!.evidence })), proposals: [] },
                { ...input, requests: alone }, readLedger(ledgerDir));
              const saved = await options.saveFocus({ ...body, placements: body.placements.map(placement => ({ ...placement, confidence: judged.get(placement.anchorConversationKey)!.confidence })) });
              for (const request of alone) placedAlone.add(request.anchor);
              placed += saved.placed;
              continue;
            }
            // Below the threshold a pick is only a hint on its request: the agent decides.
            input = { ...input, requests: input.requests.map(request => {
              const result = judged.get(request.anchor)!;
              return result.focusAreaId === null ? request : { ...request, judgeSuggestion: { focusAreaId: result.focusAreaId, confidence: result.confidence, evidence: result.evidence } };
            }) };
          }
          const anchors: string[] = input.requests.map((request: { anchor: string }) => request.anchor);
          // A saved batch leaves the queue; the same batch twice means the save did not take, and asking again would loop.
          if (anchors.join('\n') === previousBatch) throw new Error(`focus: the placed requests are still queued (${anchors.length} starting ${anchors[0]}).`);
          previousBatch = anchors.join('\n');
          const saved = await step('focus', sorting([
            `Do only section 3, steps 1–2 (place each request in a focus area, promoting one that holds several separate asks) for this batch, the \`focus-input\` output (also saved in ${writeInput('focus-input', input)}):\n\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``,
            `Place each of these ${anchors.length} requests exactly once, by its "anchor": ${anchors.join(', ')}. Reply with only the JSON that \`record-focus\` takes ({"placements": [...], "proposals": [...]}).`,
          ].join('\n\n')), answer => recordFocus(['--limit', String(FOCUS_BATCH)], answer), FOCUS_ANSWER_SCHEMA);
          placed += saved.placed; proposed += saved.proposed;
        }
        if (judged.size) {
          const results = [...judged.values()], picked = results.filter(result => result.focusAreaId !== null && result.focusAreaId !== 'other').length;
          const none = results.filter(result => result.focusAreaId === 'other').length, unjudged = results.length - picked - none;
          done.push(`${results.length} requests judged for focus (${picked} picked an area, ${none} none, ${unjudged} unjudged${placedAlone.size ? `, ${placedAlone.size} placed without the agent` : ''})`);
        }
        const other = cli(['focus-input', '--other']);
        if (other.due) {
          const saved = await step('focus', sorting(
            `Do only section 3, step 3 (propose focus areas from Other) for the \`focus-input --other\` output (also saved in ${writeInput('focus-input-other', other)}):\n\n\`\`\`json\n${JSON.stringify(other, null, 2)}\n\`\`\`\n\nPlace nothing ("placements": []). Reply with only the JSON that \`record-focus --other\` takes ({"placements": [], "proposals": [...]}), proposing nothing when nothing qualifies.`,
          ), answer => recordFocus(['--other'], answer), FOCUS_ANSWER_SCHEMA);
          proposed += saved.proposed;
        }
        if (placed || proposed) done.push([...(placed ? [`${placed} requests placed`] : []), ...(proposed ? [`${proposed} focus areas suggested`] : [])].join(', '));
      } catch (error) { focusError = error; }

      // Only reviews whose facts (state, percent, dates, milestones, preferences, outcome) moved since the last story; none means the story still holds.
      const storyInput = cli(['story-input']);
      if (storyInput.reviews.length) {
        await step('story', [
          requestProgress, '---', readOnly,
          `Do only section 4 (${storyInput.update ? 'update' : 'write'} the build story). The \`story-input\` output is in ${writeInput('story-input', storyInput)}. Reply with only the JSON that \`record-story\` takes ({"narrative": "...", "preferences": [...]}).`,
        ].join('\n\n'), answer => cli(['record-story'], answer));
        done.push(storyInput.update ? 'story updated' : 'story written');
      }
      if (focusError) throw focusError;
      return done.length ? `${done.join(', ')}.` : 'Nothing was due.';
    } catch (error) {
      if (!answerWasRefused) throw error;
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { answerRefused: true });
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
