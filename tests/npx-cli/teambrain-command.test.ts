import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildTeamBrainJoinSettings,
  differentSyncAccountRefusal,
  membershipForChoice,
  parseShareFlags,
  parseTeamBrainInvite,
  resolveTeamBrainUrl,
} from '../../src/npx-cli/commands/teambrain.js';
import {
  MOCK_HUB_URL,
  MOCK_INVITE_TOKEN,
  MOCK_SEAT_SETUP_TOKEN,
  MOCK_SEAT_USER_ID,
  MOCK_TEAM,
  startTeamBrainMock,
  type TeamBrainMock,
} from '../helpers/teambrain-mock-server.js';

const repoRoot = join(import.meta.dir, '..', '..');
const cliEntry = join(repoRoot, 'src', 'npx-cli', 'index.ts');

describe('parseTeamBrainInvite', () => {
  const origin = 'https://cmem.ai';

  it('takes the token from an invite link or as a bare token', () => {
    expect(parseTeamBrainInvite(`https://cmem.ai/teambrain/app#invite=${MOCK_INVITE_TOKEN}`, origin)).toEqual({ ok: true, token: MOCK_INVITE_TOKEN });
    expect(parseTeamBrainInvite(`  ${MOCK_INVITE_TOKEN}\n`, origin)).toEqual({ ok: true, token: MOCK_INVITE_TOKEN });
  });

  it('refuses a link for another host, naming both', () => {
    const result = parseTeamBrainInvite(`https://teambrain.example.org/teambrain/app#invite=${MOCK_INVITE_TOKEN}`, origin);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('https://teambrain.example.org');
    expect(result.error).toContain('https://cmem.ai');
    expect(result.error).toContain('CMEM_PRO_ORIGIN=https://teambrain.example.org');
  });

  it('refuses links without an invite, garbage and nothing, without echoing the input', () => {
    for (const input of ['https://cmem.ai/teambrain/app', 'https://cmem.ai/teambrain/app#invite=x', 'not an invite at all', '', undefined]) {
      const result = parseTeamBrainInvite(input, origin);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('https://cmem.ai/teambrain/app#invite=');
    }
  });
});

describe('share flags', () => {
  it('reads --share lists, --share-all, and neither', () => {
    expect(parseShareFlags({ share: ' proj-a, proj-b ,proj-a,, ' })).toEqual({ ok: true, choice: { kind: 'projects', projects: ['proj-a', 'proj-b'] } });
    expect(parseShareFlags({ shareAll: true })).toEqual({ ok: true, choice: { kind: 'all' } });
    expect(parseShareFlags({})).toEqual({ ok: true, choice: null });
  });

  it('rejects both at once and an empty list', () => {
    expect(parseShareFlags({ share: 'a', shareAll: true }).ok).toBe(false);
    expect(parseShareFlags({ share: ' , ' }).ok).toBe(false);
  });

  it('turns a choice into the membership body: null shares everything, none stops sharing', () => {
    expect(membershipForChoice({ kind: 'all' })).toEqual({ broadcasting: true, projects: null });
    expect(membershipForChoice({ kind: 'projects', projects: ['a'] })).toEqual({ broadcasting: true, projects: ['a'] });
    expect(membershipForChoice({ kind: 'none' })).toEqual({ broadcasting: false, projects: [] });
  });
});

describe('join account and settings rules', () => {
  it('refuses an install that syncs as another account, and only then', () => {
    expect(differentSyncAccountRefusal('', 'user_b')).toBeNull();
    expect(differentSyncAccountRefusal(' user_b ', 'user_b')).toBeNull();
    const refusal = differentSyncAccountRefusal('user_a', 'user_b', 'https://cmem.ai');
    expect(refusal).toContain('already syncs memory as another cmem.ai account (user user_a)');
    expect(refusal).toContain('nothing on this install was changed');
  });

  it('writes the sync connection and the TeamBrain keys, and no observer or provider key', () => {
    const ready = { userId: 'user_b', setupToken: 'token_b', hubUrl: 'https://sync.cmem.ai' };
    expect(buildTeamBrainJoinSettings(ready, { CLAUDE_MEM_CLOUD_SYNC_USER_ID: '' }, { teambrainUrl: 'https://cmem.ai', teamId: 'team_1' }, 'laptop')).toEqual({
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'token_b',
      CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'user_b',
      CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://sync.cmem.ai',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: '',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'laptop',
      CLAUDE_MEM_TEAMBRAIN_URL: 'https://cmem.ai',
      CLAUDE_MEM_TEAMBRAIN_TEAM_ID: 'team_1',
    });
  });

  it('keeps the device of an install that already syncs this account', () => {
    const ready = { userId: 'user_b', setupToken: 'token_b', hubUrl: 'https://sync.cmem.ai' };
    const updates = buildTeamBrainJoinSettings(ready, { CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'user_b' }, { teambrainUrl: 'https://cmem.ai', teamId: 'team_1' }, 'laptop');
    expect(updates).not.toHaveProperty('CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID');
    expect(updates).not.toHaveProperty('CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME');
  });

  it('takes the TeamBrain address from the server, else the paired host, and only http(s)', () => {
    expect(resolveTeamBrainUrl('https://cmem.ai/', 'https://cmem.ai')).toEqual({ ok: true, url: 'https://cmem.ai' });
    expect(resolveTeamBrainUrl(null, 'http://localhost:3005')).toEqual({ ok: true, url: 'http://localhost:3005' });
    expect(resolveTeamBrainUrl('javascript:alert(1)', 'https://cmem.ai').ok).toBe(false);
    expect(resolveTeamBrainUrl('https://user:pass@cmem.ai', 'https://cmem.ai').ok).toBe(false);
  });
});

// ---- `npx claude-mem teambrain …` end to end, against the mock contract ----

let server: TeamBrainMock;
let dataDir: string;
let homeDir: string;

beforeAll(async () => {
  server = await startTeamBrainMock();
});

afterAll(async () => {
  await server.stop();
});

beforeEach(() => {
  server.requests.length = 0;
  server.state.workerPid = 100;
  server.state.syncConfigured = false;
  server.state.membership = {};
  server.state.leave = {};
  server.state.teams = [{ ...MOCK_TEAM, role: 'member', broadcasting: false, projects: null, seats_used: 2, seat_limit: 5 }];
});

function settingsPath(): string {
  return join(dataDir, 'settings.json');
}

function readSettingsFile(): Record<string, string> {
  return JSON.parse(readFileSync(settingsPath(), 'utf-8'));
}

async function runCli(args: string[], initialSettings?: Record<string, string>): Promise<{ exitCode: number; output: string }> {
  dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-teambrain-cli-'));
  homeDir = mkdtempSync(join(tmpdir(), 'claude-mem-teambrain-home-'));
  if (initialSettings) writeFileSync(settingsPath(), JSON.stringify(initialSettings, null, 2));
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    CLAUDE_MEM_DATA_DIR: dataDir,
    CMEM_PRO_ORIGIN: server.origin,
    CLAUDE_MEM_WORKER_PORT: String(server.port),
    CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
    CLAUDE_MEM_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
  };
  for (const key of ['CLAUDE_MEM_TEAMBRAIN_URL', 'CLAUDE_MEM_TEAMBRAIN_TEAM_ID', 'CLAUDE_MEM_CLOUD_SYNC_TOKEN', 'CLAUDE_MEM_CLOUD_SYNC_USER_ID', 'CLAUDE_MEM_CLOUD_SYNC_HUB_URL', 'CI']) {
    delete env[key];
  }
  const child = Bun.spawn([process.execPath, cliEntry, ...args], {
    cwd: repoRoot,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  // Bun's styleText colors even a pipe (Node's does not); compare the words.
  return { exitCode: await child.exited, output: (stdout + stderr).replace(ANSI_ESCAPE, '') };
}

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function cleanup(): void {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
}

const OWN_OBSERVER = {
  CLAUDE_MEM_PROVIDER: 'gemini',
  CLAUDE_MEM_GEMINI_API_KEY: 'personal-gemini-key',
  CLAUDE_MEM_OPENROUTER_BASE_URL: '',
  CLAUDE_MEM_OPENROUTER_API_KEY: '',
  CLAUDE_MEM_PRO_MEMORY_KEY: '',
};

const JOINED = {
  ...OWN_OBSERVER,
  CLAUDE_MEM_CLOUD_SYNC_TOKEN: MOCK_SEAT_SETUP_TOKEN,
  CLAUDE_MEM_CLOUD_SYNC_USER_ID: MOCK_SEAT_USER_ID,
  CLAUDE_MEM_CLOUD_SYNC_HUB_URL: MOCK_HUB_URL,
};

describe('npx claude-mem teambrain join', () => {
  it('pairs with the invite, writes only sync and TeamBrain settings, shares the flagged projects and restarts the worker', async () => {
    try {
      const { exitCode, output } = await runCli(['teambrain', 'join', `${server.origin}/teambrain/app#invite=${MOCK_INVITE_TOKEN}`, '--share', 'proj-a,proj-b'], OWN_OBSERVER);
      expect(exitCode, output).toBe(0);

      const [start] = server.requestsTo('/api/installer/oauth/start');
      expect(start.body).toMatchObject({ source: 'teambrain_join', team_invite: MOCK_INVITE_TOKEN });

      const settings = readSettingsFile();
      expect(settings).toEqual({
        ...OWN_OBSERVER,
        CLAUDE_MEM_CLOUD_SYNC_TOKEN: MOCK_SEAT_SETUP_TOKEN,
        CLAUDE_MEM_CLOUD_SYNC_USER_ID: MOCK_SEAT_USER_ID,
        CLAUDE_MEM_CLOUD_SYNC_HUB_URL: MOCK_HUB_URL,
        CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: '',
        CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: expect.any(String),
        CLAUDE_MEM_TEAMBRAIN_URL: server.origin,
        CLAUDE_MEM_TEAMBRAIN_TEAM_ID: MOCK_TEAM.id,
      });

      const [membership] = server.requestsTo('/api/teambrain/cli/membership');
      expect(membership.body).toEqual({ team_id: MOCK_TEAM.id, broadcasting: true, projects: ['proj-a', 'proj-b'] });
      expect(membership.authorization).toBe(`Bearer ${MOCK_SEAT_SETUP_TOKEN}`);
      expect(membership.userId).toBe(MOCK_SEAT_USER_ID);

      expect(server.requestsTo('/api/admin/restart')).toHaveLength(1);
      expect(output).toContain('Joined Acme Eng');
      expect(output).toContain('Sharing proj-a, proj-b with Acme Eng');
      expect(output).toContain('Cloud sync is on');
      expect(output).not.toContain(MOCK_SEAT_SETUP_TOKEN);
    } finally {
      cleanup();
    }
  }, 30_000);

  it('never changes the observer or provider for a Pro account either, and shares nothing without a flag', async () => {
    server.state.readyBody = {
      ...server.state.readyBody,
      plan: 'pro',
      memory_key: 'cm_pro_MEMORY_KEY_MUST_NOT_BE_WRITTEN',
      memory_base_url: `${server.origin}/api/inference/v1`,
      memory_model: 'cmem-observer',
    };
    try {
      const { exitCode, output } = await runCli(['teambrain', 'join', MOCK_INVITE_TOKEN], OWN_OBSERVER);
      expect(exitCode, output).toBe(0);
      const settings = readSettingsFile();
      expect(settings.CLAUDE_MEM_PROVIDER).toBe('gemini');
      expect(settings.CLAUDE_MEM_PRO_MEMORY_KEY).toBe('');
      expect(JSON.stringify(settings)).not.toContain('cm_pro_MEMORY_KEY_MUST_NOT_BE_WRITTEN');
      expect(server.requestsTo('/api/teambrain/cli/membership')).toHaveLength(0);
      expect(output).toContain('Not sharing any projects yet');
    } finally {
      delete server.state.readyBody.memory_key;
      delete server.state.readyBody.memory_base_url;
      delete server.state.readyBody.memory_model;
      server.state.readyBody.plan = 'teambrain_seat';
      cleanup();
    }
  }, 30_000);

  it('refuses an install that already syncs as another account and changes nothing', async () => {
    const otherAccount = {
      ...OWN_OBSERVER,
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'other-token',
      CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'user_other',
      CLAUDE_MEM_CLOUD_SYNC_HUB_URL: MOCK_HUB_URL,
    };
    try {
      const { exitCode, output } = await runCli(['teambrain', 'join', MOCK_INVITE_TOKEN, '--share-all'], otherAccount);
      expect(exitCode).toBe(1);
      expect(output).toContain('already syncs memory as another cmem.ai account (user user_other)');
      expect(readSettingsFile()).toEqual(otherAccount);
      expect(server.requestsTo('/api/teambrain/cli/membership')).toHaveLength(0);
      expect(server.requestsTo('/api/admin/restart')).toHaveLength(0);
    } finally {
      cleanup();
    }
  }, 30_000);

  it('rejects a bad invite before contacting anyone', async () => {
    try {
      const { exitCode, output } = await runCli(['teambrain', 'join', 'https://elsewhere.example/teambrain/app#invite=tb_inviteTokenFixture_0123456789']);
      expect(exitCode).toBe(1);
      expect(output).toContain('This invite is for https://elsewhere.example');
      expect(server.requests).toHaveLength(0);
    } finally {
      cleanup();
    }
  }, 30_000);

  it('explains a refused join request', async () => {
    server.state.oauthStart = { status: 410, body: { error: 'invite_expired' } };
    try {
      const { exitCode, output } = await runCli(['teambrain', 'join', MOCK_INVITE_TOKEN]);
      expect(exitCode).toBe(1);
      expect(output).toContain('The invite may have expired');
      expect(existsSync(settingsPath())).toBe(false);
    } finally {
      server.state.oauthStart = null;
      cleanup();
    }
  }, 30_000);
});

describe('npx claude-mem teambrain status, share, leave, start', () => {
  const joinedSettings = () => ({
    ...JOINED,
    CLAUDE_MEM_TEAMBRAIN_URL: server.origin,
    CLAUDE_MEM_TEAMBRAIN_TEAM_ID: MOCK_TEAM.id,
  });

  it('status lists the teams with what this install shares', async () => {
    server.state.teams = [{ ...MOCK_TEAM, role: 'owner', broadcasting: true, projects: ['proj-a'], seats_used: 3, seat_limit: 10 }];
    try {
      const { exitCode, output } = await runCli(['teambrain', 'status'], joinedSettings());
      expect(exitCode, output).toBe(0);
      expect(output).toContain('Acme Eng');
      expect(output).toContain('owner · sharing proj-a · 3 of 10 seats');
      expect(output).toContain('(this install)');
    } finally {
      cleanup();
    }
  }, 30_000);

  it('status without a team says how to start or join, and asks nobody', async () => {
    try {
      const { exitCode, output } = await runCli(['teambrain'], OWN_OBSERVER);
      expect(exitCode).toBe(0);
      expect(output).toContain('not joined on this install');
      expect(output).toContain('npx claude-mem teambrain start');
      expect(server.requests).toHaveLength(0);
    } finally {
      cleanup();
    }
  }, 30_000);

  it('share --share-all sends projects: null for the install team', async () => {
    try {
      const { exitCode, output } = await runCli(['teambrain', 'share', '--share-all'], joinedSettings());
      expect(exitCode, output).toBe(0);
      expect(server.requestsTo('/api/teambrain/cli/membership')[0].body).toEqual({ team_id: MOCK_TEAM.id, broadcasting: true, projects: null });
    } finally {
      cleanup();
    }
  }, 30_000);

  it('share without a terminal needs a flag', async () => {
    try {
      const { exitCode, output } = await runCli(['teambrain', 'share'], joinedSettings());
      expect(exitCode).toBe(1);
      expect(output).toContain('--share <a,b>');
      expect(server.requestsTo('/api/teambrain/cli/membership')).toHaveLength(0);
    } finally {
      cleanup();
    }
  }, 30_000);

  it('leave posts the team and switches TeamBrain off when no team is left', async () => {
    try {
      const { exitCode, output } = await runCli(['teambrain', 'leave'], joinedSettings());
      expect(exitCode, output).toBe(0);
      expect(server.requestsTo('/api/teambrain/cli/leave')[0].body).toEqual({ team_id: MOCK_TEAM.id });
      const settings = readSettingsFile();
      expect(settings.CLAUDE_MEM_TEAMBRAIN_URL).toBe('');
      expect(settings.CLAUDE_MEM_TEAMBRAIN_TEAM_ID).toBe('');
      expect(settings.CLAUDE_MEM_CLOUD_SYNC_TOKEN).toBe(MOCK_SEAT_SETUP_TOKEN);
      expect(output).toContain('Left Acme Eng');
    } finally {
      cleanup();
    }
  }, 30_000);

  it('leave tidies an install whose team is already gone on the server, without asking it to leave', async () => {
    server.state.teams = [];
    try {
      const { exitCode, output } = await runCli(['teambrain', 'leave'], joinedSettings());
      expect(exitCode, output).toBe(0);
      expect(server.requestsTo('/api/teambrain/cli/leave')).toHaveLength(0);
      expect(readSettingsFile().CLAUDE_MEM_TEAMBRAIN_URL).toBe('');
      expect(output).toContain(`no longer in team ${MOCK_TEAM.id}; removing it from this install`);
    } finally {
      cleanup();
    }
  }, 30_000);

  it('leave refuses a named team this account is not in, and changes nothing', async () => {
    try {
      const { exitCode, output } = await runCli(['teambrain', 'leave', 'team_typo'], joinedSettings());
      expect(exitCode).toBe(1);
      expect(output).toContain('This account is not in team team_typo');
      expect(server.requestsTo('/api/teambrain/cli/leave')).toHaveLength(0);
      expect(readSettingsFile().CLAUDE_MEM_TEAMBRAIN_URL).toBe(server.origin);
    } finally {
      cleanup();
    }
  }, 30_000);

  it('start prints the team page when there is no browser to open', async () => {
    try {
      const { exitCode, output } = await runCli(['teambrain', 'start']);
      expect(exitCode).toBe(0);
      expect(output).toContain(`${server.origin}/teambrain/start`);
      expect(output).toContain('Open that link in a browser');
    } finally {
      cleanup();
    }
  }, 30_000);

  it('rejects an unknown subcommand and an unknown flag with the usage', async () => {
    try {
      const unknown = await runCli(['teambrain', 'frobnicate']);
      expect(unknown.exitCode).toBe(1);
      expect(unknown.output).toContain('Usage: npx claude-mem teambrain <command>');
      const badFlag = await runCli(['teambrain', 'share', '--bogus']);
      expect(badFlag.exitCode).toBe(1);
      expect(badFlag.output).toContain('Usage: npx claude-mem teambrain <command>');
    } finally {
      cleanup();
    }
  }, 30_000);
});
