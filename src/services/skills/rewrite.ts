import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findClaudeExecutable } from '../../shared/find-claude-executable.js';
import { killProcessTree } from '../../shared/kill-process-tree.js';
import { readClaudeOAuthToken, resolveClaudeCredentialProfile } from '../../shared/oauth-token.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { paintedPassage, readPaintDocument, type RewriteStamp } from '../../shared/skill-paint.js';
import { skillMetadata } from '../../shared/skill-document.js';
import { type SkillCatalog, SkillCatalogError, MAX_SKILL_BYTES } from './catalog.js';
import { validateSkillText } from './save.js';
import { stampBriefs } from './stamp-briefs.js';

interface RewriteInput { stamp: RewriteStamp; text: string; passage: string; }
export type SkillRewriteRunner = (input: RewriteInput, signal: AbortSignal) => Promise<string>;
interface RewriteOptions { executable?: () => string; timeoutMs?: number; maxOutputBytes?: number; }
const cancelled = () => new SkillCatalogError(499, 'Rewrite cancelled.');

/** Give Claude access to its local signed-in profile without passing worker/provider credentials,
 * gateway URLs or runtime injection flags along with the document (see #2375). */
async function rewriteEnvironment(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { CLAUDE_MEM_INTERNAL: '1' };
  const systemKeys = ['PATH', 'HOME', 'USER', 'LOGNAME', 'USERNAME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TEMP', 'TMP', 'TMPDIR',
    'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CODE_TMPDIR'];
  for (const key of systemKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH, true, { readOnly: true });
  const profile = resolveClaudeCredentialProfile(settings.CLAUDE_MEM_CLAUDE_CONFIG_DIR);
  if (profile.explicitConfigDir) env.CLAUDE_CONFIG_DIR = profile.configDir;
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    const login = await readClaudeOAuthToken();
    if (login.kind === 'present') env.CLAUDE_CODE_OAUTH_TOKEN = login.token;
  }
  return env;
}

function cleanReply(bytes: Buffer): string {
  let reply: string;
  try { reply = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim(); }
  catch { throw new SkillCatalogError(502, 'Claude returned invalid text.'); }
  const wrapper = /^```[\w-]*\r?\n([\s\S]*?)\r?\n```$/.exec(reply);
  const markdown = wrapper ? wrapper[1] : reply;
  if (!markdown.trim()) throw new SkillCatalogError(502, 'Claude returned an empty rewrite.');
  return markdown;
}

/** The original Dario briefs and whole-skill context, with an isolated working directory and no tools. */
export function createClaudeRewriteRunner(options: RewriteOptions = {}): SkillRewriteRunner {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const maxBytes = options.maxOutputBytes ?? MAX_SKILL_BYTES;
  let active = 0;
  return async ({ stamp, text, passage }, signal) => {
    if (signal.aborted) throw cancelled();
    if (active >= 2) throw new SkillCatalogError(429, 'Two rewrites are in progress. Try again when one finishes.');
    active++;
    let cwd: string | undefined;
    try {
      let executable: string;
      try { executable = options.executable?.() ?? findClaudeExecutable('WORKER'); }
      catch { throw new SkillCatalogError(503, 'Install or update Claude Code and sign in to use this stamp.'); }
      cwd = await mkdtemp(join(tmpdir(), 'cmem-skill-paint-'));
      const env = await rewriteEnvironment();
      if (signal.aborted) throw cancelled();
      const prompt = 'The whole skill, for context:\n<skill>\n' + text +
        '\n</skill>\n\nThe painted passage to rewrite:\n<painted>\n' + passage + '\n</painted>';
      const child = spawn(executable, ['-p', '--model', 'opus', '--effort', 'low', '--safe-mode',
        '--setting-sources', 'project', '--strict-mcp-config', '--tools', '', '--no-session-persistence',
        '--settings', '{"disableAllHooks":true}', '--system-prompt', stampBriefs[stamp]], {
        cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32',
        env,
      });
      return await new Promise<string>((resolve, reject) => {
        let failure: SkillCatalogError | undefined;
        let stdoutBytes = 0, stderrBytes = 0;
        const stdout: Buffer[] = [], stderr: Buffer[] = [];
        const stop = (reason: SkillCatalogError) => {
          if (failure) return;
          failure = reason;
          if (child.pid) {
            if (process.platform === 'win32') {
              void killProcessTree(child.pid, { signalMode: 'immediate' }).catch(() => child.kill('SIGKILL'));
            } else {
              try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
            }
          }
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
        };
        const abort = () => stop(cancelled());
        const timeout = setTimeout(() => stop(new SkillCatalogError(504, 'Claude took too long. You can try the stamp again.')), timeoutMs);
        signal.addEventListener('abort', abort, { once: true });
        child.on('error', () => { failure ??= new SkillCatalogError(503, 'Claude Code could not start. Check the local installation.'); });
        child.stdout.on('data', (chunk: Buffer) => {
          stdoutBytes += chunk.length;
          if (stdoutBytes > maxBytes) stop(new SkillCatalogError(502, 'The rewritten passage exceeds the editor size limit.'));
          else stdout.push(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderrBytes += chunk.length;
          if (stderrBytes > 64 * 1024) stop(new SkillCatalogError(502, 'Claude exceeded the diagnostic output limit.'));
          else stderr.push(chunk);
        });
        child.once('close', (code) => {
          clearTimeout(timeout);
          signal.removeEventListener('abort', abort);
          if (failure) { reject(failure); return; }
          if (code !== 0) {
            const diagnostic = Buffer.concat(stderr).toString('utf8') + Buffer.concat(stdout).toString('utf8');
            if (/not logged in|sign in|please run \/login|authentication|oauth token/i.test(diagnostic)) {
              reject(new SkillCatalogError(503, 'Sign in to Claude Code on this computer, then try the stamp again.'));
            } else if (/unknown option|unrecognized argument/i.test(diagnostic)) {
              reject(new SkillCatalogError(503, 'Update Claude Code to use the Paint stamps.'));
            } else reject(new SkillCatalogError(502, 'Claude could not complete the rewrite. Check Claude Code and try again.'));
            return;
          }
          try { resolve(cleanReply(Buffer.concat(stdout))); } catch (error) { reject(error); }
        });
        // A CLI that exits early can close stdin before it has consumed the draft.
        child.stdin.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EPIPE') stop(new SkillCatalogError(502, 'Claude could not read the draft.'));
        });
        if (signal.aborted) abort();
        else child.stdin.end(prompt, 'utf8');
      });
    } finally {
      active--;
      if (cwd) await rm(cwd, { recursive: true, force: true });
    }
  };
}

export interface RewriteRequest { stamp: RewriteStamp; text: string; firstIndex: number; lastIndex: number; }

/** Read only the saved binding and compute the AI selection from this submitted draft. */
export async function rewriteSkill(catalog: SkillCatalog, id: string, input: RewriteRequest, run: SkillRewriteRunner, signal: AbortSignal) {
  validateSkillText(input.text);
  const { entry } = await catalog.read(id);
  if (!entry.editable) throw new SkillCatalogError(403, 'This skill is read-only.');
  const { problem } = skillMetadata(input.text, entry.name, entry.agent);
  if (problem) throw new SkillCatalogError(422, problem);
  let passage: string;
  try { passage = paintedPassage(readPaintDocument(input.text).blocks, input.firstIndex, input.lastIndex).trim(); }
  catch { throw new SkillCatalogError(422, 'Choose complete Markdown blocks in the current draft.'); }
  if (signal.aborted) throw cancelled();
  const replacementMarkdown = await run({ stamp: input.stamp, text: input.text, passage }, signal);
  if (signal.aborted) throw cancelled();
  validateSkillText(replacementMarkdown);
  if (!replacementMarkdown.trim()) throw new SkillCatalogError(502, 'Claude returned an empty rewrite.');
  return { replacementMarkdown };
}
