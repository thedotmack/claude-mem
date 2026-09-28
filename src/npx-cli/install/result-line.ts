/**
 * `CLAUDE_MEM_RESULT {json}` — the last stdout line of every install, update,
 * repair and login run, in every outcome. An agent reads one line instead of
 * scraping prose. Schema v1 is closed: the builder copies known keys only, so
 * a call site cannot leak a secret, path or email by passing extra fields.
 */

export const RESULT_LINE_PREFIX = 'CLAUDE_MEM_RESULT ';

export type ResultCommand = 'install' | 'update' | 'repair' | 'login' | 'advisor' | 'fix';
export type ResultStatus = 'ok' | 'partial' | 'failed';
export type SigninStatus = 'pending' | 'signed_in' | 'expired' | 'none' | 'dismissed';

export const LOGIN_CHECK_COMMAND = 'npx claude-mem login --check';
export const LOGIN_REQUEST_COMMAND = 'npx claude-mem login --request';

export interface ResultSignin {
  status: SigninStatus;
  url?: string | null;
  expiresIn?: number | null;
}

export interface ResultLineInput {
  command: ResultCommand;
  status: ResultStatus;
  version: string;
  failedStep?: string | null;
  errorCategory?: string | null;
  fixTried?: string | null;
  attemptN?: number;
  retrySameCommand?: boolean;
  nextCommand?: string | null;
  humanActionRequired?: 'sign-in' | null;
  signin?: ResultSignin | null;
}

export interface ResultLineV1 {
  v: 1;
  command: ResultCommand;
  status: ResultStatus;
  version: string;
  failed_step: string | null;
  error_category: string | null;
  fix_tried: string | null;
  attempt_n: number;
  retry_same_command: boolean;
  next_command: string | null;
  human_action_required: 'sign-in' | null;
  signin: {
    status: SigninStatus;
    url: string | null;
    expires_in: number | null;
    check_command: string;
    renew_command: string;
  } | null;
}

export const RESULT_LINE_KEYS = [
  'v', 'command', 'status', 'version', 'failed_step', 'error_category', 'fix_tried',
  'attempt_n', 'retry_same_command', 'next_command', 'human_action_required', 'signin',
] as const;

export const RESULT_SIGNIN_KEYS = ['status', 'url', 'expires_in', 'check_command', 'renew_command'] as const;

// Ids, categories and commands are our own closed vocabularies; anything that
// does not look like one (a path, a message, an email) becomes null.
const TOKEN_RE = /^[a-z0-9][a-z0-9.:_-]{0,79}$/i;
const COMMAND_RE = /^npx claude-mem [a-z0-9 ._=-]{1,120}$/i;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;

function token(value: string | null | undefined): string | null {
  return typeof value === 'string' && TOKEN_RE.test(value) ? value : null;
}

/** Only an https link without userinfo; the sign-in link carries no secret. */
function safeUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (/secret=/i.test(url.search)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function buildResultLine(input: ResultLineInput): ResultLineV1 {
  const signin = input.signin
    ? {
      status: input.signin.status,
      url: safeUrl(input.signin.url),
      expires_in: typeof input.signin.expiresIn === 'number' && Number.isFinite(input.signin.expiresIn)
        ? Math.max(0, Math.round(input.signin.expiresIn))
        : null,
      check_command: LOGIN_CHECK_COMMAND,
      renew_command: LOGIN_REQUEST_COMMAND,
    }
    : null;
  return {
    v: 1,
    command: input.command,
    status: input.status,
    version: VERSION_RE.test(input.version) ? input.version : 'unknown',
    failed_step: token(input.failedStep),
    error_category: token(input.errorCategory),
    fix_tried: token(input.fixTried),
    attempt_n: Number.isInteger(input.attemptN) && (input.attemptN as number) > 0 ? input.attemptN as number : 1,
    retry_same_command: input.retrySameCommand ?? input.status !== 'ok',
    next_command: typeof input.nextCommand === 'string' && COMMAND_RE.test(input.nextCommand)
      ? input.nextCommand
      : null,
    human_action_required: input.humanActionRequired ?? (signin?.status === 'pending' ? 'sign-in' : null),
    signin,
  };
}

export function formatResultLine(input: ResultLineInput): string {
  return RESULT_LINE_PREFIX + JSON.stringify(buildResultLine(input));
}

/** Prints to stdout. Never throws: the result line must not break a run. */
export function printResultLine(input: ResultLineInput): void {
  try {
    process.stdout.write('\n' + formatResultLine(input) + '\n');
  } catch {
    // [ANTI-PATTERN IGNORED]: a closed stdout cannot carry the line anyway; the exit status still reports the outcome.
  }
}

/** Parses the last CLAUDE_MEM_RESULT line from captured output, or null. */
export function parseLastResultLine(output: string): ResultLineV1 | null {
  const lines = output.split(/\r?\n/).filter((line) => line.startsWith(RESULT_LINE_PREFIX));
  const last = lines[lines.length - 1];
  if (!last) return null;
  try {
    return JSON.parse(last.slice(RESULT_LINE_PREFIX.length)) as ResultLineV1;
  } catch {
    return null;
  }
}
