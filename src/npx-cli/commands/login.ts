/**
 * `npx claude-mem login --request | --check | --dismiss [--json] [--no-browser]`
 *
 * Sign-in for agent-run installs, as commands that return straight away
 * (the Netlify / Stripe / Neon pattern): an agent asks for a link, the person
 * opens it, and the agent checks later. Nothing here blocks or polls in a loop.
 *
 *   --request  a FRESH login-only pairing every time (source npx-login-request);
 *              the secret goes to pending-signin.json (0600), never to stdout.
 *   --check    polls that pairing once: signed_in | pending | expired | none.
 *   --dismiss  marks the install dismissed, which stops the SessionStart reminder.
 */

import { parseArgs } from 'node:util';
import { readPluginVersion } from '../utils/paths.js';
import { getOrCreateInstallId } from '../../services/telemetry/consent.js';
import { captureCliEvent } from '../../services/telemetry/cli-telemetry.js';
import { signinArmForInstallId } from '../install/signin-arm.js';
import {
  pendingSigninExpired,
  readPendingSignin,
  readSigninState,
  writeSigninState,
} from '../install/signin-state.js';
import {
  LOGIN_CHECK_COMMAND,
  LOGIN_REQUEST_COMMAND,
  printResultLine,
  type ResultStatus,
  type SigninStatus,
} from '../install/result-line.js';
import {
  formatSigninFacts,
  lastOAuthStartFailure,
  maybeOpenSigninBrowser,
  pollInstallerPairingOnce,
  rememberLoginOnlyPairing,
  startInstallerOAuthPairing,
} from './install.js';

const LOGIN_REQUEST_SOURCE = 'npx-login-request';
const LOGIN_START_TIMEOUT_MS = 10_000;
const PAIRING_TTL_FALLBACK_MS = 30 * 60 * 1000;

type LoginMode = 'request' | 'check' | 'dismiss';

function usage(): void {
  console.error('Usage: npx claude-mem login --request [--json] [--no-browser] | --check [--json] | --dismiss');
}

/** The version is only reported, so a missing package.json must not stop a sign-in. */
function safePluginVersion(): string {
  try {
    return readPluginVersion();
  } catch {
    // [ANTI-PATTERN IGNORED]: reported as `unknown` in the result line; login itself does not need the version.
    return 'unknown';
  }
}

function emitJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}

export async function runLoginCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      request: { type: 'boolean' },
      check: { type: 'boolean' },
      dismiss: { type: 'boolean' },
      json: { type: 'boolean' },
      'no-browser': { type: 'boolean' },
    },
    strict: false,
    allowPositionals: true,
  });
  const modes = (['request', 'check', 'dismiss'] as const).filter((m) => values[m] === true);
  if (modes.length !== 1) {
    usage();
    return 1;
  }
  const mode: LoginMode = modes[0];
  const json = values.json === true;
  const version = safePluginVersion();

  if (mode === 'dismiss') return dismiss(version);
  if (mode === 'check') return check(version, json);
  return request(version, json, values['no-browser'] === true);
}

function dismiss(version: string): number {
  writeSigninState('dismissed');
  console.log('Sign-in reminders are off for this machine. A new link is still available with: ' + LOGIN_REQUEST_COMMAND);
  printResultLine({ command: 'login', status: 'ok', version, signin: { status: 'dismissed' } });
  return 0;
}

async function request(version: string, json: boolean, noBrowser: boolean): Promise<number> {
  const arm = signinArmForInstallId(getOrCreateInstallId());
  const pairing = await startInstallerOAuthPairing({ source: LOGIN_REQUEST_SOURCE, timeoutMs: LOGIN_START_TIMEOUT_MS });
  if (!pairing) {
    const failure = lastOAuthStartFailure() ?? 'network';
    await captureCliEvent('installer_oauth_start_failed', {
      version,
      outcome: failure,
      interactive: false,
      phase: 'login-request',
      signin_arm: arm,
    });
    const message = `Could not create a sign-in link: cmem.ai did not answer (${failure}). The local install is unaffected.`;
    if (json) emitJson({ status: 'failed', error: failure, retry_command: LOGIN_REQUEST_COMMAND });
    else {
      console.error(message);
      printResultLine({ command: 'login', status: 'failed', version, errorCategory: `signin-start-${failure}`, signin: { status: 'none' } });
    }
    return 1;
  }

  rememberLoginOnlyPairing(pairing, LOGIN_REQUEST_SOURCE);
  writeSigninState('unclaimed', arm);
  const expiresAt = pairing.expiresAt ?? Date.now() + PAIRING_TTL_FALLBACK_MS;
  const expiresIn = Math.round((expiresAt - Date.now()) / 1000);
  const browserOpen = maybeOpenSigninBrowser(pairing.authorizationUrl, arm, noBrowser);
  await captureCliEvent('installer_oauth_deferred', {
    version,
    interactive: false,
    phase: 'login-request',
    signin_arm: arm,
    browser_open: browserOpen,
  });

  if (json) {
    emitJson({
      status: 'pending',
      url: pairing.authorizationUrl,
      expires_in: expiresIn,
      check_command: LOGIN_CHECK_COMMAND,
      browser_opened: browserOpen === 'opened',
      for_the_user: 'Open this link to finish claude-mem sign-in (free). It creates the account used for cloud sync and the CMEM Pro trial offer.',
      agent_next_steps: [
        'The link needs the person: it signs them in with GitHub or Google in their browser.',
        `\`${LOGIN_CHECK_COMMAND}\` reports signed_in, pending, expired or none.`,
        `After expiry, \`${LOGIN_REQUEST_COMMAND}\` makes a new link.`,
      ],
    });
    return 0;
  }
  for (const line of formatSigninFacts(pairing.authorizationUrl, expiresAt, browserOpen === 'opened')) console.log(line);
  printResultLine({
    command: 'login',
    status: 'ok',
    version,
    signin: { status: 'pending', url: pairing.authorizationUrl, expiresIn },
  });
  return 0;
}

async function check(version: string, json: boolean): Promise<number> {
  const finish = (signin: SigninStatus, message: string, status: ResultStatus = 'ok', url: string | null = null): number => {
    if (json) {
      emitJson({
        status: signin,
        ...(url ? { url } : {}),
        ...(signin === 'expired' || signin === 'none' ? { next_command: LOGIN_REQUEST_COMMAND } : {}),
        ...(status === 'failed' ? { error: 'unreachable' } : {}),
      });
    } else {
      console.log(message);
      printResultLine({
        command: 'login',
        status,
        version,
        nextCommand: signin === 'expired' || signin === 'none' ? LOGIN_REQUEST_COMMAND : null,
        humanActionRequired: signin === 'pending' || signin === 'expired' || signin === 'none' ? 'sign-in' : null,
        signin: { status: signin, url },
      });
    }
    return status === 'failed' ? 1 : 0;
  };

  const state = readSigninState();
  const pending = readPendingSignin();
  if (!pending) {
    if (state?.state === 'claimed') return finish('signed_in', 'Signed in: this machine\'s claude-mem sign-in is finished.');
    return finish('none', `No sign-in has been requested on this machine. New link: ${LOGIN_REQUEST_COMMAND}`);
  }

  const outcome = await pollInstallerPairingOnce({
    pairingId: pending.pairingId,
    secret: pending.secret,
    userCode: '',
    authorizationUrl: pending.url,
    checkoutUrl: '',
    pollIntervalMs: 0,
  });
  switch (outcome.kind) {
    case 'authenticated':
    case 'ready':
      writeSigninState('claimed');
      await captureCliEvent('installer_login_checked', { version, outcome: 'signed_in', phase: 'login-check' });
      return finish('signed_in', 'Signed in: claude-mem sign-in is finished for this machine.');
    case 'pending':
      if (pendingSigninExpired(pending)) {
        return finish('expired', `The sign-in link expired before it was used. New link: ${LOGIN_REQUEST_COMMAND}`);
      }
      return finish('pending', `Sign-in not finished yet. The user can open: ${pending.url}`, 'ok', pending.url);
    case 'gone':
      return finish('expired', `The sign-in link expired before it was used. New link: ${LOGIN_REQUEST_COMMAND}`);
    case 'unreachable':
      return finish('pending', 'cmem.ai could not be reached, so the sign-in status is unknown. Try the check again later.', 'failed');
  }
}
