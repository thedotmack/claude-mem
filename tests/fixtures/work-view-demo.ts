/** Sanitized, persisted local fixture for browser checks. Never opens the user's DB.
 * Start: bun tests/fixtures/work-view-demo.ts
 * Append a real update: bun tests/fixtures/work-view-demo.ts --update ready
 */
import express from 'express';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WorkViewRoutes } from '../../src/services/worker/http/routes/WorkViewRoutes.js';
import { TeamBrainRoutes } from '../../src/services/worker/http/routes/TeamBrainRoutes.js';
import { MOCK_SEAT_SETUP_TOKEN, MOCK_SEAT_USER_ID, startTeamBrainMock } from '../helpers/teambrain-mock-server.js';
import { WorkStateSource } from '../../src/services/work-view/data-source.mjs';
import { LocalReviewStore, contentFingerprint } from '../../src/services/work-view/review-store.js';

const root = process.env.WORK_VIEW_DEMO_DIR || '/tmp/claude-mem-work-view-demo-20261017';
mkdirSync(root, { recursive: true });
const databasePath = join(root, 'source.db');
const reviewPath = join(root, 'reviews.db');
const fresh = !existsSync(databasePath);
const db = new Database(databasePath, { create: true });
db.exec('PRAGMA journal_mode=WAL');
db.exec(`CREATE TABLE IF NOT EXISTS work_state_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER);
  CREATE TABLE IF NOT EXISTS sdk_sessions (id INTEGER PRIMARY KEY,project TEXT,platform_source TEXT,content_session_id TEXT,memory_session_id TEXT,user_prompt TEXT,custom_title TEXT,status TEXT,started_at_epoch INTEGER,completed_at_epoch INTEGER);
  CREATE TABLE IF NOT EXISTS tool_uses (id INTEGER PRIMARY KEY,project TEXT,platform_source TEXT,agent_id TEXT,agent_type TEXT,session_db_id INTEGER,memory_session_id TEXT,content_session_id TEXT,prompt_number INTEGER,tool_name TEXT,tool_input TEXT,created_at_epoch INTEGER);
  CREATE TABLE IF NOT EXISTS user_prompts (id INTEGER PRIMARY KEY,session_db_id INTEGER,prompt_number INTEGER,prompt_text TEXT,created_at_epoch INTEGER);`);

const examples = [
  { id: 'working', task: 'Refine the request cards', request: 'Refine the local work cards and make the layout clearer', status: 'doing', progress: 'Refining spacing and hierarchy across the request cards.', next: 'Compare the narrow layout and keyboard focus.', age: 2, platform: 'codex' },
  { id: 'ready', task: 'Build the local viewer', request: 'Build a viewer that brings local work into one place', status: 'done', request_complete: true, outcome: 'The local viewer brings requests, recorded progress and next actions together.', next: 'Review the viewer and recorded checks.', age: 16, platform: 'claude' },
  { id: 'needs', task: 'Finish release notes', request: 'Write release notes for the new local viewer', status: 'needs-you', progress: 'The release notes draft is ready for your choice.', next: 'Choose whether the announcement should include the walkthrough.', age: 8, platform: 'claude' },
  { id: 'checked', task: 'Write the installation guide', request: 'Make the first install easier to follow', status: 'done', request_complete: true, outcome: 'The guide now has fewer steps and a clear first-run check.', next: 'The guide has been reviewed locally.', age: 27, platform: 'codex' },
  { id: 'quiet', task: 'Improve return navigation', request: 'Find a way back to the right request after reading its sources', status: 'doing', progress: 'Recorded the return-to-list behavior for another pass.', next: 'Resume the keyboard and navigation check.', age: 7 * 60, platform: 'codex' },
];

function fieldsFor(example: typeof examples[number]) {
  const { id, request, age, platform, ...fields } = example;
  return { ...fields, request_id: `demo-${id}`, human_request: request };
}
if (fresh) {
  for (const [index, example] of examples.entries()) {
    const at = Date.now() - example.age * 60_000;
    const fields = fieldsFor(example);
    db.prepare('INSERT INTO work_state_entries(project,list_name,fields,created_at_epoch) VALUES(?,?,?,?)').run('Demo workspace', example.id, JSON.stringify(fields), at);
    // Deliberately adversarial unknown platform: the production UI must render
    // it as inert text. It is a fixture label, never an HTML template.
    const platform = example.id === 'working' && process.env.WORK_VIEW_DEMO_HOSTILE_PLATFORM === '1' ? '<img src=x onerror="window.__fixtureInjection=true">' : example.platform;
    const session = index + 1;
    db.prepare('INSERT INTO sdk_sessions VALUES(?,?,?,?,?,?,?,?,?,?)').run(session, 'Demo workspace', platform, `demo-${example.id}`, `demo-memory-${example.id}`, example.request, null, 'active', at - 60_000, null);
    db.prepare('INSERT INTO tool_uses VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(session, 'Demo workspace', platform, null, 'main', session, `demo-memory-${example.id}`, `demo-${example.id}`, 1, 'work_state_write', JSON.stringify({ list: example.id, fields }), at);
    db.prepare('INSERT INTO user_prompts VALUES(?,?,?,?,?)').run(session, session, 1, example.request, at - 60_000);
  }
  const source = new WorkStateSource({ databasePath });
  const checked = source.read().agentView.humanRequests.find(request => request.id.includes('demo-checked'));
  if (checked) {
    const reviews = new LocalReviewStore(reviewPath);
    reviews.set(checked.id, contentFingerprint(checked), true);
    reviews.close();
  }
  source.close();
}

const updateIndex = process.argv.indexOf('--update');
if (updateIndex !== -1) {
  const example = examples.find(example => example.id === process.argv[updateIndex + 1]);
  if (!example) throw new Error('Choose --update working|ready|needs|checked|quiet');
  const at = Date.now();
  db.prepare('INSERT INTO work_state_entries(project,list_name,fields,created_at_epoch) VALUES(?,?,?,?)').run('Demo workspace', example.id, JSON.stringify({ task: example.task, progress: `A new saved update arrived at ${new Date(at).toISOString()}.` }), at);
  db.close();
  console.log(`Appended a real fixture update to ${example.id}.`);
} else {
  db.close();
  const routes = new WorkViewRoutes({ databasePath, reviewPath, ledgerDir: null });
  const app = express();
  app.use(express.json());
  routes.setupRoutes(app);
  const teamId = '11111111-1111-4111-8111-111111111111';
  const teamUpstream = process.env.WORK_VIEW_DEMO_TEAM === '1' ? await startTeamBrainMock({
    teams: [{ id: teamId, name: 'Example product team', role: 'member', broadcasting: false, projects: ['shared-project'], seats_used: 3, seat_limit: 5 }],
    board: { body: {
      lists: [
        { user_id: 'one', display_name: 'Alex', project: 'shared-project', name: 'Make the first run clearer', closed: false, state: [['human_summary', 'Help new teammates find the right place to begin.'], ['next', 'Compare the walkthrough with the setup screen.']], state_updated_at: new Date().toISOString(), last_written_at: new Date().toISOString(), closed_task_count: 2, tasks: [{ name: 'Review the setup walkthrough', status: 'doing', details: [['next', 'Read the shared draft and leave a note in the source.']], updated_at: new Date().toISOString(), latest_feed_id: 1, finding_ids: [1] }] },
        { user_id: 'two', display_name: 'Sam', project: 'shared-project', name: 'Keep the launch in view', closed: false, state: [['human_summary', 'Track the remaining launch checks together.']], state_updated_at: new Date().toISOString(), last_written_at: new Date().toISOString(), closed_task_count: 1, tasks: [{ name: 'Choose the walkthrough example', status: 'needs-you', details: [['next', 'Agree on one example for the guide.']], updated_at: new Date().toISOString(), latest_feed_id: 2, finding_ids: [] }] },
      ], findings: [{ id: 1, type: 'collision', title: 'Two changes touch the setup guide', subtitle: null, narrative: 'Compare the two edits before merging so the same steps stay consistent.', member_ids: ['one', 'two'], created_at: new Date().toISOString() }],
    } },
  }) : null;
  new TeamBrainRoutes(() => teamUpstream ? {
    CLAUDE_MEM_TEAMBRAIN_URL: teamUpstream.origin, CLAUDE_MEM_TEAMBRAIN_TEAM_ID: teamId,
    CLAUDE_MEM_CLOUD_SYNC_TOKEN: MOCK_SEAT_SETUP_TOKEN, CLAUDE_MEM_CLOUD_SYNC_USER_ID: MOCK_SEAT_USER_ID,
  } : {}).setupRoutes(app);
  const uiRoot = join(import.meta.dir, '../../plugin/ui');
  app.get('/api/sync/status', (_req, res) => res.json({ configured: false }));
  app.get('/', (_req, res) => res.sendFile(join(uiRoot, 'work-view/index.html')));
  app.get('/viewer', (_req, res) => res.sendFile(join(uiRoot, 'viewer.html')));
  app.use(express.static(uiRoot));
  const port = Number(process.env.WORK_VIEW_DEMO_PORT || 37842);
  const server = app.listen(port, '127.0.0.1', () => console.log(`Sanitized fixture: http://127.0.0.1:${port}\nData: ${root}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { routes.close(); server.close(); void teamUpstream?.stop(); });
}
