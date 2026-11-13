/**
 * Makes one stage: a staged review of one request in one format (stage-formats.ts), built around what really needs
 * reviewing. The worker gathers the evidence first (the screenshots linked to the request's observations, the files
 * in its deliverables bucket, each commit's real diff from the local checkout), copies it beside the question, and
 * asks the owner's own agent once, through the same read-only runner as the refresh. The agent answers with the
 * document; the worker puts each evidence file's link where the document points, writes the file into the request's
 * deliverables bucket and records it in owner-runs.json. One call is one agent run; a failure is recorded and left.
 */
import type { spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { extname, join } from 'path';
import type { AgentRunResult, AgentTask } from '../agent-runner/run.js';
import { runCommand } from '../agent-runner/detect.js';
import { isInsideDeliverablesDir, resolveDeliverableBucketDir, resolveDeliverablesDir } from '../../shared/deliverables.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { logger } from '../../utils/logger.js';
import type { RecordDeliverableInput } from '../sqlite/deliverables.js';
import { AUTO_STAGE_LIMIT, STAGE_DELIVERABLE_KIND, type StageState } from './owner-runs.mjs';
import type { OwnerRunStore } from './owner-run-store.js';
import { inlineSkill, localAgentsOnly, readOnlyAgentTask, readOnlyRule, resolveStepModels, resolveTextLanguage } from './refresh-task.js';
import { readConversationProjects, readLedger, runCli, type LedgerDatabase } from './request-groups.mjs';
import { readStageFormats, type StageFormat } from './stage-formats.js';

const MAX_SCREENSHOTS = 12, MAX_DELIVERABLES = 8, MAX_COMMITS = 6, MAX_LINKS = 10;
const MAX_OPENED_FILE_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_CHARS = 120_000;
const MAX_STAGE_BYTES = 2 * 1024 * 1024;
const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;
const MEDIA_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The request as the snapshot shows it: what the stage reviews and where its evidence is recorded. */
export interface StageRequest {
  id: string; groupId: string; title: string | null; conversationKeys: string[];
  workProduct: Array<{ kind: string; title: string; url?: string; sha?: string; bucketPath?: string; deliverable?: boolean }>;
}

/** One piece of evidence the worker gathered. `file` is the copy the agent opens; null means it was not opened, and `note` says why. */
export interface StageEvidence {
  id: string; kind: 'screenshot' | 'deliverable' | 'diff' | 'link'; title: string; file: string | null; note: string | null;
  /** Where My Work serves it: the link the stage points at. */
  url: string | null;
}

export interface StageDependencies {
  /** ~/.claude-mem: settings.json and the media folder. */
  dataDir: string;
  ledgerDir: string;
  pluginRoot: string;
  store: OwnerRunStore;
  openDatabase: () => LedgerDatabase & { close(): void };
  /** The shared agent runner (agent-runner/run.ts runAgentTask). */
  runAgent: (task: AgentTask) => Promise<AgentRunResult>;
  spawnImpl: typeof spawn;
  sessionCwd: (platform: string, sessionId: string) => string | null;
  /** Records the stage file so the deliverables route serves it. Without it a ready stage has no link. */
  recordDeliverable?: ((input: RecordDeliverableInput) => { id: number }) | null;
  deliverablesDir?: string;
  now?: () => number;
}

const conversationOf = (key: string): { platform: string; sessionId: string } | null => {
  try {
    const [, platform, sessionId] = JSON.parse(key) as unknown[];
    return typeof platform === 'string' && typeof sessionId === 'string' ? { platform, sessionId } : null;
  } catch { return null; }
};

const isFile = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };
const isFolder = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };

/** Everything recorded for the request that a reviewer could look at, each opened copy inside `folder`. */
export async function gatherStageEvidence(request: StageRequest, folder: string, dependencies: Pick<StageDependencies, 'dataDir' | 'openDatabase' | 'spawnImpl' | 'sessionCwd' | 'deliverablesDir'>): Promise<StageEvidence[]> {
  mkdirSync(folder, { recursive: true });
  const evidence: StageEvidence[] = [];
  const add = (item: Omit<StageEvidence, 'id'>) => { evidence.push({ id: `E${evidence.length + 1}`, ...item }); return evidence.at(-1)!; };
  const copyIn = (source: string, extension: string) => {
    const path = join(folder, `E${evidence.length + 1}${extension}`);
    copyFileSync(source, path);
    return path;
  };
  const conversations = request.conversationKeys.map(conversationOf).filter((conversation): conversation is NonNullable<typeof conversation> => conversation !== null);

  let screenshots: Array<{ id: string; label: string; title: string | null }> = [];
  const database = dependencies.openDatabase();
  try {
    const linked = database.prepare(`SELECT l.attachment_id AS id, l.label AS label, o.title AS title
      FROM observation_media_links l JOIN observations o ON o.id = l.observation_id
      JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
      JOIN media_attachments a ON a.id = l.attachment_id
      WHERE s.platform_source = ? AND s.content_session_id = ? AND a.state = 'ready'
      ORDER BY o.created_at_epoch DESC, o.id DESC LIMIT ?`);
    for (const { platform, sessionId } of [...conversations].reverse()) screenshots.push(...linked.all(platform, sessionId, MAX_SCREENSHOTS));
  } catch (error) {
    // A database from before media capture has no such tables: the request then has no screenshots.
    if (!/no such (table|column)/i.test(String((error as Error).message))) throw error;
    screenshots = [];
  } finally { database.close(); }
  const seen = new Set<string>();
  for (const shot of screenshots) {
    if (seen.size >= MAX_SCREENSHOTS || seen.has(shot.id) || !MEDIA_ID.test(shot.id)) continue;
    seen.add(shot.id);
    const variant = (name: string) => join(dependencies.dataDir, 'media-v1', shot.id, `${name}.webp`);
    const readable = [variant('llm'), variant('viewer')].find(isFile);
    const title = [shot.label, shot.title].filter(Boolean).join(': ') || 'Screenshot';
    if (!readable) { add({ kind: 'screenshot', title, file: null, note: 'The image file is not on this computer; not opened.', url: null }); continue; }
    add({ kind: 'screenshot', title, file: copyIn(readable, '.webp'), note: null, url: `/api/media/${shot.id}/viewer` });
  }

  const deliverablesDir = dependencies.deliverablesDir ?? resolveDeliverablesDir();
  const made = request.workProduct.filter(product => product.deliverable && product.kind !== STAGE_DELIVERABLE_KIND && typeof product.bucketPath === 'string');
  for (const product of made.slice(0, MAX_DELIVERABLES)) {
    const path = product.bucketPath!;
    if (!isInsideDeliverablesDir(path, deliverablesDir) || !isFile(path)) { add({ kind: 'deliverable', title: product.title, file: null, note: 'The file is no longer in the deliverables bucket; not opened.', url: null }); continue; }
    const bytes = statSync(path).size, extension = extname(path).toLowerCase();
    if (bytes > MAX_OPENED_FILE_BYTES) { add({ kind: 'deliverable', title: product.title, file: null, note: `The file is ${bytes} bytes, too large to open here; not opened.`, url: product.url ?? null }); continue; }
    add({ kind: 'deliverable', title: product.title, file: copyIn(path, extension), note: null, url: product.url ?? null });
  }

  const checkouts = [...new Set(conversations.map(({ platform, sessionId }) => dependencies.sessionCwd(platform, sessionId)).filter((cwd): cwd is string => !!cwd && isFolder(cwd)))];
  const commits = request.workProduct.filter(product => product.kind === 'commit' && typeof product.sha === 'string' && COMMIT_SHA.test(product.sha));
  for (const commit of commits.slice(0, MAX_COMMITS)) {
    let diff: string | null = null;
    for (const cwd of checkouts) {
      // Argument array, no shell; the sha is hex only, so it can never be read as an option.
      const shown = await runCommand(dependencies.spawnImpl, 'git', ['-C', cwd, 'show', '--stat', '--patch', '--no-color', '--no-ext-diff', commit.sha!],
        { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
      if (shown.exitCode === 0 && shown.stdout.trim()) { diff = shown.stdout; break; }
    }
    if (diff === null) { add({ kind: 'diff', title: commit.title, file: null, note: 'The commit was not found in a checkout on this computer; its diff was not opened.', url: commit.url ?? null }); continue; }
    const cut = diff.length > MAX_DIFF_CHARS;
    const path = join(folder, `E${evidence.length + 1}.diff`);
    writeFileSync(path, cut ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[cut: the diff is ${diff.length} characters; only the first ${MAX_DIFF_CHARS} are here]\n` : diff, { mode: 0o600 });
    add({ kind: 'diff', title: commit.title, file: path, note: cut ? 'Only the start of this diff was opened; the rest was cut.' : null, url: commit.url ?? null });
  }

  const links = request.workProduct.filter(product => !product.deliverable && product.kind !== 'commit' && typeof product.url === 'string' && /^https?:\/\//.test(product.url));
  for (const link of links.slice(0, MAX_LINKS)) add({ kind: 'link', title: link.title, file: null, note: 'A link; the worker did not open it.', url: link.url! });
  return evidence;
}

/** The agent's answer as the stage document: the whole reply, without a code fence wrapped around all of it. */
function stageDocument(answer: string): string {
  const fenced = /^\s*```[\w-]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(answer);
  return (fenced ? fenced[1] : answer).trim();
}

/**
 * Puts the link My Work serves where the document points at a piece of evidence (`evidence:E3`). Pointing at evidence
 * that was never gathered, or that has no file My Work can open, refuses the document.
 */
export function placeStageEvidence(document: string, evidence: readonly StageEvidence[]): string {
  const byId = new Map(evidence.map(item => [item.id, item]));
  const cited = [...new Set([...document.matchAll(/evidence:(E\d+)/g)].map(match => match[1]))];
  const unknown = cited.filter(id => !byId.has(id));
  if (unknown.length) throw new Error(`The stage points at evidence that was not gathered (${unknown.join(', ')}).`);
  return document.replace(/\]\(evidence:(E\d+)\)/g, (_match, id: string) => {
    const item = byId.get(id)!;
    if (!item.url) throw new Error(`The stage shows ${id} ("${item.title}"), which has no file My Work can open.`);
    return `](${item.url})`;
  });
}

const skillPath = (pluginRoot: string) => join(pluginRoot, 'skills', 'review-stage', 'SKILL.md');

/** One run's hold on a stage, from claimStage. */
export interface StageClaim { startedAt: string; trigger: 'owner' | 'auto' }

/**
 * Claims the one run of this stage and records it as `generating`. The owner's click and automatic staging both start
 * here, and the claim is synchronous, so two starts of one stage never both run. Null while a run of it is in flight.
 */
export function claimStage(dependencies: Pick<StageDependencies, 'store' | 'ledgerDir'>, request: Pick<StageRequest, 'groupId'>, format: Pick<StageFormat, 'id'>, start: { token: string | null; trigger: StageClaim['trigger'] }): StageClaim | null {
  const reviewedThrough: string | null = readLedger(dependencies.ledgerDir).progress[request.groupId]?.reviewedThrough ?? null;
  const startedAt = dependencies.store.beginStage(request.groupId, format.id, start.token, { reviewedThrough, trigger: start.trigger });
  return startedAt === null ? null : { startedAt, trigger: start.trigger };
}

/** One claimed stage, start to finish. It never throws, and it ends in `ready` or `failed`. */
export async function generateStage(dependencies: StageDependencies, request: StageRequest, format: StageFormat, claim: StageClaim): Promise<StageState> {
  const { store, ledgerDir, dataDir, pluginRoot } = dependencies;
  const now = dependencies.now ?? Date.now;
  const { startedAt } = claim;
  const runDir = join(ledgerDir, 'agent-runs', `stage-${randomBytes(6).toString('hex')}`);
  const fail = (error: string): StageState => { store.finishStage(request.groupId, format.id, startedAt, { error: error.slice(0, 500) }); return 'failed'; };
  try {
    mkdirSync(runDir, { recursive: true });
    let evidence: StageEvidence[] = [];
    const written: { document: string | null } = { document: null };
    const task: AgentTask = {
      ...localAgentsOnly(readOnlyAgentTask({ reason: `stage:${claim.trigger}`, dataDir, ledgerDir, pluginRoot })),
      // One click is one run: a failed stage is never handed to a second agent, whatever the refresh's own setting.
      stayOnFirstUsableAgent: true,
      prepare: async () => { evidence = await gatherStageEvidence(request, join(runDir, 'evidence'), dependencies); },
      run: async (ask, agent) => {
        let show: unknown;
        const database = dependencies.openDatabase();
        // The whole request, not the update since its last review: a stage is made right after that review was saved.
        try { runCli(['show', request.groupId, '--full'], { dir: ledgerDir, database, now: now(), print: value => { show = value; } }); }
        finally { database.close(); }
        const showPath = join(runDir, 'show.json'), evidencePath = join(runDir, 'evidence.json');
        const listed = evidence.map(({ id, kind, title, file, note }) => ({ id, kind, title, file, note }));
        writeFileSync(showPath, JSON.stringify(show, null, 2), { mode: 0o600 });
        writeFileSync(evidencePath, JSON.stringify(listed, null, 2), { mode: 0o600 });
        const language = resolveTextLanguage(dataDir);
        // Gemini runs with no file tools: it gets the text evidence inline and is told it opened no image.
        const inline = agent !== 'gemini' ? '' : [
          'You have no file tools. The input files are supplied here; you opened no image, so describe none:',
          `--- ${showPath} ---\n${JSON.stringify(show, null, 2)}`, `--- ${evidencePath} ---\n${JSON.stringify(listed, null, 2)}`,
          ...evidence.filter(item => item.kind === 'diff' && item.file).map(item => `--- ${item.file} ---\n${readFileSync(item.file!, 'utf8')}`),
        ].join('\n\n');
        const answer = await ask([
          inlineSkill(skillPath(pluginRoot)), '---', readOnlyRule(agent, 'a claude-mem stage the owner asked for'),
          `The worker did steps 1 and 2 for you. The request (the \`show\` output) is in ${showPath}. The evidence it gathered is listed in ${evidencePath}: each entry has an id, a kind, a title and the \`file\` to open; an entry whose \`file\` is null was not opened, and its \`note\` says why.`,
          evidence.some(item => item.file) ? 'Open every evidence file before you write about it (read each image).' : 'No evidence file could be opened for this request. Say so plainly at the top of the stage; describe nothing you did not open.',
          `Format: ${format.label}. ${format.instructions}`,
          'To show a piece of evidence, write ![what it shows](evidence:E3) with its id; the worker puts the real file\'s link there. Quote a diff in a fenced code block.',
          'Reply with only the stage itself, as Markdown: no HTML, no JSON, no code fence around it, no words before or after.',
          language ? `Write it in ${language}; quotes stay as typed.` : '',
          inline,
        ].filter(Boolean).join('\n\n'), resolveStepModels(dataDir).review);
        const document = placeStageEvidence(stageDocument(answer), evidence);
        if (!document) throw new Error('The agent answered with an empty stage.');
        if (Buffer.byteLength(document) > MAX_STAGE_BYTES) throw new Error('The stage is too large to save.');
        written.document = document;
        return `${format.id} stage written`;
      },
    };
    const outcome = await dependencies.runAgent(task);
    const { document } = written;
    if (outcome.state !== 'ok' || document === null) return fail(outcome.error ?? 'The agent run did not finish.');

    const lastConversation = request.conversationKeys.map(conversationOf).filter(Boolean).at(-1) ?? null;
    let project = 'unknown-project';
    const database = dependencies.openDatabase();
    try { project = readConversationProjects(database, request.conversationKeys.slice(-1)).values().next().value ?? project; }
    catch { /* The bucket folder falls back to the unknown project's. */ }
    finally { database.close(); }
    const deliverablesDir = dependencies.deliverablesDir ?? resolveDeliverablesDir();
    const bucket = resolveDeliverableBucketDir(project, deliverablesDir);
    mkdirSync(bucket, { recursive: true });
    const name = `stage-${request.groupId}-${format.id}.md`;
    const file = join(bucket, name);
    // Every run of this stage writes this one path, so only the run that still holds the stage may write it.
    if (!store.holdsStage(request.groupId, format.id, startedAt)) return 'failed';
    writeFileSync(file, document, { mode: 0o600 });
    let url: string | null = null;
    if (dependencies.recordDeliverable && lastConversation) {
      const recorded = dependencies.recordDeliverable({
        project, contentSessionId: lastConversation.sessionId, platformSource: lastConversation.platform,
        title: `${format.label}: ${request.title ?? 'request'}`.slice(0, 200), kind: STAGE_DELIVERABLE_KIND, sourcePath: file, bucketPath: file,
        bytes: Buffer.byteLength(document), sha256: createHash('sha256').update(document).digest('hex'), declared: false, occurredAtEpoch: now(),
      });
      if (recorded.id > 0) url = `/api/deliverables/${recorded.id}/${encodeURIComponent(name)}`;
    }
    store.finishStage(request.groupId, format.id, startedAt, { file, url });
    return 'ready';
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

/** The format automatic generation makes, from CLAUDE_MEM_WORK_VIEW_AUTO_STAGE_FORMAT. Empty (the default) or a format
 * that does not exist is off: null. Read on every use, so a change applies to the next refresh. */
export function resolveAutoStageFormat(settingsPath: string, dataDir: string): StageFormat | null {
  const id = String(SettingsDefaultsManager.loadFromFile(settingsPath, true, { readOnly: true }).CLAUDE_MEM_WORK_VIEW_AUTO_STAGE_FORMAT ?? '').trim();
  if (!id) return null;
  return readStageFormats(dataDir).formats.find(candidate => candidate.id === id) ?? null;
}

/**
 * Automatic generation, the owner's opt-in: after a refresh that ran and finished, one stage in the chosen format for
 * each request whose review that refresh recorded and that the board files under Review. Which requests those are is
 * the board's own rule, asked through `awaitingCheck`, so a shipped request is never staged and one whose work waits
 * for a check below 100% is. Once per review: a stage already recorded for that `reviewedThrough`, ready or failed, is
 * never made again. Reviews recorded by earlier refreshes are never looked at, so turning the setting on backfills
 * nothing, and what the cap leaves out is not picked up later. Runs one stage at a time; answers the request groups it
 * asked for a stage of.
 */
export async function autoStageAfterRefresh({ ledgerDir, format, refreshState, refreshStartedAtEpoch, awaitingCheck, generate, limit = AUTO_STAGE_LIMIT }: {
  ledgerDir: string;
  format: StageFormat | null;
  /** The refresh's own outcome: stages are made only after one that ran and finished ('ok'). */
  refreshState: string;
  refreshStartedAtEpoch: number;
  /** The groups of the requests My Work files under Review now (to-work-model.ts isAwaitingCheck). Read only when this refresh recorded a review. */
  awaitingCheck: () => Promise<ReadonlySet<string>>;
  generate: (groupId: string, format: StageFormat) => Promise<unknown>;
  limit?: number;
}): Promise<string[]> {
  if (!format || refreshState !== 'ok') return [];
  const recorded = (Object.values(readLedger(ledgerDir).progress) as Array<{ groupId: string; checkedAt?: string; reviewedThrough?: string }>)
    .filter(review => Date.parse(review.checkedAt ?? '') >= refreshStartedAtEpoch);
  if (!recorded.length) return [];
  const awaiting = await awaitingCheck();
  // Read again after every wait: the owner may have staged this review meanwhile, and that stage is the one for it.
  const unstaged = (reviews: typeof recorded) => {
    const stages = readLedger(ledgerDir).ownerRuns?.stages ?? {};
    return reviews.filter(review => stages[review.groupId]?.[format.id]?.reviewedThrough !== review.reviewedThrough);
  };
  const due = unstaged(recorded.filter(review => awaiting.has(review.groupId)))
    .sort((a, b) => Date.parse(b.checkedAt!) - Date.parse(a.checkedAt!))
    .slice(0, limit);
  const started: string[] = [];
  for (const review of due) {
    if (!unstaged([review]).length) continue;
    started.push(review.groupId);
    await generate(review.groupId, format);
  }
  return started;
}
