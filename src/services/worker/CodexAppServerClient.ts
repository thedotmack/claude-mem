import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { killProcessTree } from '../../shared/kill-process-tree.js';
import { spawnHidden } from '../../shared/spawn.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { getSupervisor } from '../../supervisor/index.js';
import { logger } from '../../utils/logger.js';

const APP_SERVER_WORKDIR_PREFIX = 'claude-mem-codex-app-server-';
const MAX_PROTOCOL_LINE_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_TAIL_BYTES = 64 * 1024;
const INTERRUPT_TIMEOUT_MS = 5_000;

const DISABLED_FEATURES = [
  'apps',
  'artifact',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'chronicle',
  'code_mode',
  'code_mode_only',
  'computer_use',
  'current_time_reminder',
  'default_mode_request_user_input',
  'deferred_executor',
  'goals',
  'hooks',
  'image_generation',
  'memories',
  'multi_agent',
  'multi_agent_v2',
  'plugins',
  'request_permissions_tool',
  'skill_search',
  'shell_tool',
  'standalone_web_search',
  'token_budget',
  'unified_exec',
  'view_image',
  'web_search_cached',
  'web_search_request',
  'workspace_dependencies',
] as const;

const FORBIDDEN_ITEM_TYPES = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'webSearch',
  'imageView',
  'imageGeneration',
]);
const TERMINAL_TURN_STATUSES = new Set(['completed', 'interrupted', 'failed']);

const EMPTY_HOOKS = {
  PreToolUse: [],
  PermissionRequest: [],
  PostToolUse: [],
  PreCompact: [],
  PostCompact: [],
  SessionStart: [],
  UserPromptSubmit: [],
  SubagentStart: [],
  SubagentStop: [],
  Stop: [],
};

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  removeAbort?: () => void;
}

interface ActiveTurn {
  threadId: string;
  turnId: string | null;
  finalText: string | null;
  tokenUsage: JsonObject | null;
  terminalTurn: JsonObject | null;
  protocolError: Error | null;
  completion: Promise<void>;
  complete: () => void;
}

interface PrivateRuntime {
  root: string;
  workspace: string;
  codexHome: string;
}

export interface CodexAppServerClientOptions {
  nativeCodexHome?: string;
}

export interface CodexAppServerTurnOptions {
  codexPath: string;
  model: string;
  reasoningEffort: string | null;
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Recheck caller-owned admission after waiting in the serialized queue. */
  beforeSend?: () => void;
}

export interface CodexAppServerTurnResult {
  content: string;
  inputTokens?: number;
  outputTokens?: number;
  tokensUsed?: number;
}

export function buildCodexAppServerArgs(): string[] {
  return ['app-server', '--listen', 'stdio://'];
}

export function buildCodexAppServerThreadConfig(mcpServerNames: readonly string[]): JsonObject {
  const config: JsonObject = {
    project_doc_max_bytes: 0,
    include_environment_context: false,
    'agents.enabled': false,
    'orchestrator.mcp.enabled': false,
    'orchestrator.skills.enabled': false,
    'skills.bundled.enabled': false,
    'skills.include_instructions': false,
    'tools.experimental_request_user_input.enabled': false,
    hooks: EMPTY_HOOKS,
    notify: [],
    web_search: 'disabled',
  };

  for (const feature of DISABLED_FEATURES) {
    config[`features.${feature}`] = false;
  }

  if (mcpServerNames.length > 0) {
    config.mcp_servers = Object.fromEntries(
      [...new Set(mcpServerNames)].sort().map(name => [name, { enabled: false }]),
    );
  }

  return config;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Codex app-server returned invalid ${label}`);
  }
  return value;
}

function executableFingerprint(codexPath: string): string {
  try {
    const resolved = realpathSync(codexPath);
    const stat = statSync(resolved);
    return `${resolved}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return codexPath;
  }
}

function resolveNativeCodexHome(explicitHome?: string): string {
  const configured = explicitHome?.trim() || process.env.CODEX_HOME?.trim();
  return configured || join(process.env.HOME?.trim() || homedir(), '.codex');
}

function createPrivateRuntime(nativeCodexHome: string): PrivateRuntime {
  const root = mkdtempSync(join(tmpdir(), APP_SERVER_WORKDIR_PREFIX));
  try {
    const workspace = join(root, 'workspace');
    const codexHome = join(root, 'codex-home');
    mkdirSync(workspace, { mode: 0o700 });
    mkdirSync(codexHome, { mode: 0o700 });
    if (process.platform !== 'win32') {
      chmodSync(root, 0o700);
      chmodSync(workspace, 0o700);
      chmodSync(codexHome, 0o700);
    }

    const nativeAuth = join(nativeCodexHome, 'auth.json');
    const authStat = statSync(nativeAuth);
    if (!authStat.isFile()) throw new Error(`Codex ChatGPT auth is not a file: ${nativeAuth}`);
    if (process.platform !== 'win32') {
      if (typeof process.getuid === 'function' && authStat.uid !== process.getuid()) {
        throw new Error(`Codex ChatGPT auth is not owned by the claude-mem worker user: ${nativeAuth}`);
      }
      if ((authStat.mode & 0o077) !== 0) {
        throw new Error(`Codex ChatGPT auth permissions must deny group and other access: ${nativeAuth}`);
      }
    }
    let auth: unknown;
    try {
      auth = JSON.parse(readFileSync(nativeAuth, 'utf8'));
    } catch (error) {
      throw new Error(`Cannot read Codex ChatGPT auth: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isObject(auth) || (auth.auth_mode !== 'chatgpt' && auth.auth_mode !== 'chatgptAuthTokens')) {
      throw new Error('claude-mem requires Codex CLI to be logged in with ChatGPT, not an API key');
    }

    const scopedAuth = join(codexHome, 'auth.json');
    if (process.platform === 'win32') linkSync(nativeAuth, scopedAuth);
    else symlinkSync(nativeAuth, scopedAuth, 'file');
    return { root, workspace, codexHome };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function tokenNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeUsage(usage: JsonObject | null): Omit<CodexAppServerTurnResult, 'content'> {
  if (!usage) return {};

  const total = isObject(usage.total) ? usage.total : usage;
  const inputTokens = tokenNumber(total.inputTokens ?? total.input_tokens);
  const cachedInputTokens = tokenNumber(total.cachedInputTokens ?? total.cached_input_tokens) ?? 0;
  const outputTokens = tokenNumber(total.outputTokens ?? total.output_tokens);
  const reasoningTokens = tokenNumber(total.reasoningOutputTokens ?? total.reasoning_output_tokens) ?? 0;
  const normalizedInput = inputTokens === undefined ? undefined : inputTokens + cachedInputTokens;
  const normalizedOutput = outputTokens === undefined ? undefined : outputTokens + reasoningTokens;
  const tokensUsed = normalizedInput === undefined && normalizedOutput === undefined
    ? undefined
    : (normalizedInput ?? 0) + (normalizedOutput ?? 0);

  return {
    ...(normalizedInput !== undefined ? { inputTokens: normalizedInput } : {}),
    ...(normalizedOutput !== undefined ? { outputTokens: normalizedOutput } : {}),
    ...(tokensUsed !== undefined ? { tokensUsed } : {}),
  };
}

export class CodexAppServerClient {
  private readonly nativeCodexHome: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private protocolBuffer = '';
  private stderrTail = '';
  private privateRoot: string | null = null;
  private workspace: string | null = null;
  private codexPath = '';
  private binaryFingerprint = '';
  private activeTurn: ActiveTurn | null = null;
  private queueTail: Promise<void> = Promise.resolve();
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: CodexAppServerClientOptions = {}) {
    this.nativeCodexHome = resolveNativeCodexHome(options.nativeCodexHome);
  }

  async runTurn(options: CodexAppServerTurnOptions): Promise<CodexAppServerTurnResult> {
    return this.withExclusive(options.signal, async () => this.runTurnExclusive(options));
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;

    this.closed = true;
    const queueDrained = this.queueTail;
    this.closePromise = (async () => {
      await this.invalidate(new Error('Codex app-server client closed'));
      await queueDrained;
    })();
    return this.closePromise;
  }

  private async withExclusive<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('Codex app-server client closed');

    const previous = this.queueTail;
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    this.queueTail = previous.then(() => hold);

    let removeAbort: (() => void) | undefined;
    try {
      if (signal?.aborted) throw new Error('Codex app-server turn aborted while queued');
      if (signal) {
        await Promise.race([
          previous,
          new Promise<never>((_, reject) => {
            const onAbort = () => reject(new Error('Codex app-server turn aborted while queued'));
            signal.addEventListener('abort', onAbort, { once: true });
            removeAbort = () => signal.removeEventListener('abort', onAbort);
          }),
        ]);
      } else {
        await previous;
      }
      if (this.closed) throw new Error('Codex app-server client closed');
      if (signal?.aborted) throw new Error('Codex app-server turn aborted while queued');
      return await operation();
    } finally {
      removeAbort?.();
      release();
    }
  }

  private async runTurnExclusive(options: CodexAppServerTurnOptions): Promise<CodexAppServerTurnResult> {
    await this.ensureStarted(options.codexPath, options.timeoutMs, options.signal);
    const workspace = this.workspace;
    if (!workspace) throw new Error('Codex app-server workspace is unavailable');

    const mcpServerNames = await this.readInheritedMcpServerNames(workspace, options.timeoutMs, options.signal);
    const threadConfig = buildCodexAppServerThreadConfig(mcpServerNames);
    const threadResponse = await this.request('thread/start', {
      ...(options.model ? { model: options.model } : {}),
      cwd: workspace,
      runtimeWorkspaceRoots: [workspace],
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      serviceName: 'claude-mem',
      baseInstructions: '',
      developerInstructions: [
        'You are the claude-mem memory compression worker.',
        'Use only the supplied text. Do not call tools or inspect the host.',
        'Return the requested text in the JSON content field.',
      ].join(' '),
      config: threadConfig,
      environments: [],
      dynamicTools: [],
      selectedCapabilityRoots: [],
      experimentalRawEvents: true,
      ephemeral: true,
    }, options.timeoutMs, options.signal);

    if (!isObject(threadResponse) || !isObject(threadResponse.thread)) {
      throw new Error('Codex app-server returned invalid thread/start response');
    }
    const instructionSources = threadResponse.instructionSources;
    if (!Array.isArray(instructionSources)) {
      throw new Error('Codex app-server omitted instructionSources attestation');
    }
    if (instructionSources.length > 0) {
      throw new Error(`Codex app-server loaded unexpected instruction sources: ${instructionSources.join(', ')}`);
    }

    const threadId = asString(threadResponse.thread.id, 'thread id');
    await this.attestMcpServersDisabled(threadId, mcpServerNames, options.timeoutMs, options.signal);

    let complete!: () => void;
    const completion = new Promise<void>(resolve => { complete = resolve; });
    const active: ActiveTurn = {
      threadId,
      turnId: null,
      finalText: null,
      tokenUsage: null,
      terminalTurn: null,
      protocolError: null,
      completion,
      complete,
    };
    this.activeTurn = active;

    try {
      options.beforeSend?.();
      const turnResponse = await this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: options.prompt }],
        ...(options.model ? { model: options.model } : {}),
        ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
        environments: [],
        outputSchema: {
          type: 'object',
          properties: { content: { type: 'string' } },
          required: ['content'],
          additionalProperties: false,
        },
      }, options.timeoutMs, options.signal);

      if (!isObject(turnResponse) || !isObject(turnResponse.turn)) {
        throw new Error('Codex app-server returned invalid turn/start response');
      }
      active.turnId = asString(turnResponse.turn.id, 'turn id');
      this.acceptTerminalTurn(active, turnResponse.turn);

      if (!active.terminalTurn) {
        await this.waitForTurn(active, options.timeoutMs, options.signal);
      }
      if (active.protocolError) throw active.protocolError;
      if (!active.terminalTurn) throw new Error('Codex app-server turn ended without terminal state');
      if (active.terminalTurn.status !== 'completed') {
        const detail = isObject(active.terminalTurn.error) && typeof active.terminalTurn.error.message === 'string'
          ? `: ${active.terminalTurn.error.message}`
          : '';
        throw new Error(`Codex app-server turn ${String(active.terminalTurn.status)}${detail}`);
      }
      if (active.finalText === null) {
        throw new Error('Codex app-server completed without a final agent message');
      }

      let structured: unknown;
      try {
        structured = JSON.parse(active.finalText);
      } catch (error) {
        throw new Error(`Codex app-server returned malformed structured output: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!isObject(structured) || typeof structured.content !== 'string') {
        throw new Error('Codex app-server structured output omitted string content');
      }

      return { content: structured.content.trim(), ...normalizeUsage(active.tokenUsage) };
    } finally {
      if (this.activeTurn === active) this.activeTurn = null;
      await this.request('thread/unsubscribe', { threadId }, INTERRUPT_TIMEOUT_MS).catch(() => undefined);
    }
  }

  private async waitForTurn(active: ActiveTurn, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbort: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Codex app-server turn timed out after ${timeoutMs}ms`);
        void this.interruptOrInvalidate(active).finally(() => reject(error));
      }, timeoutMs);
    });
    const aborted = new Promise<never>((_, reject) => {
      if (!signal) return;
      const onAbort = () => {
        const error = new Error('Codex app-server turn aborted');
        void this.interruptOrInvalidate(active).finally(() => reject(error));
      };
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbort = () => signal.removeEventListener('abort', onAbort);
      }
    });

    try {
      await Promise.race([active.completion, timeout, aborted]);
    } finally {
      if (timer) clearTimeout(timer);
      removeAbort?.();
    }
  }

  private async interruptOrInvalidate(active: ActiveTurn): Promise<void> {
    if (!active.turnId) {
      this.invalidate(new Error('Codex app-server turn aborted before turn id was available'));
      return;
    }
    try {
      await this.request('turn/interrupt', {
        threadId: active.threadId,
        turnId: active.turnId,
      }, INTERRUPT_TIMEOUT_MS);
    } catch (error) {
      this.invalidate(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async readInheritedMcpServerNames(cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<string[]> {
    const response = await this.request('config/read', { cwd, includeLayers: true }, timeoutMs, signal);
    if (!isObject(response) || !isObject(response.config)) {
      throw new Error('Codex app-server config/read returned invalid effective config');
    }
    const servers = response.config.mcp_servers;
    if (servers === undefined) return [];
    if (!isObject(servers)) throw new Error('Codex app-server config/read returned invalid mcp_servers');
    return Object.keys(servers).sort();
  }

  private async attestMcpServersDisabled(
    threadId: string,
    expectedNames: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.request(
      'mcpServerStatus/list',
      { threadId, detail: 'toolsAndAuthOnly' },
      timeoutMs,
      signal,
    );
    if (!isObject(response) || !Array.isArray(response.data)) {
      throw new Error('Codex app-server returned invalid MCP isolation attestation');
    }

    const expected = new Set(expectedNames);
    const observed = new Set<string>();
    for (const raw of response.data) {
      if (!isObject(raw) || typeof raw.name !== 'string' || !isObject(raw.tools)) {
        throw new Error('Codex app-server returned malformed MCP status');
      }
      if (!expected.has(raw.name) || raw.serverInfo !== null || Object.keys(raw.tools).length > 0) {
        throw new Error(`Codex app-server MCP server ${raw.name} is not fully disabled`);
      }
      observed.add(raw.name);
    }
    if (observed.size !== expected.size || [...expected].some(name => !observed.has(name))) {
      throw new Error('Codex app-server MCP isolation attestation is incomplete');
    }
  }

  private async ensureStarted(codexPath: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new Error('Codex app-server client closed');

    const fingerprint = executableFingerprint(codexPath);
    if (this.child && (this.codexPath !== codexPath || this.binaryFingerprint !== fingerprint)) {
      this.invalidate(new Error('Codex executable changed; restarting app-server'));
    }
    if (this.child) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.start(codexPath, fingerprint, timeoutMs, signal)
      .finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  private async start(codexPath: string, fingerprint: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const supervisor = getSupervisor();
    supervisor.assertCanSpawn('codex');
    const runtime = createPrivateRuntime(this.nativeCodexHome);
    this.privateRoot = runtime.root;
    this.workspace = runtime.workspace;
    this.codexPath = codexPath;
    this.binaryFingerprint = fingerprint;
    this.protocolBuffer = '';
    this.stderrTail = '';

    let expectedChild: ChildProcessWithoutNullStreams | undefined;
    try {
      const child = spawnHidden(codexPath, buildCodexAppServerArgs(), {
        cwd: this.workspace,
        env: sanitizeEnv(buildCodexAppServerEnv(process.env, runtime.codexHome)),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      }) as ChildProcessWithoutNullStreams;
      expectedChild = child;
      this.child = child;

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => this.onStdout(child, String(chunk)));
      child.stderr.on('data', chunk => {
        if (this.child !== child) return;
        this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-MAX_STDERR_TAIL_BYTES);
      });
      child.on('error', error => this.onChildExit(child, error));
      child.on('close', (code, childSignal) => {
        this.onChildExit(child, new Error(`Codex app-server exited with code ${String(code)} signal ${String(childSignal)}: ${this.stderrTail.trim()}`));
      });

      if (child.pid) {
        const id = `codex-app-server:${child.pid}`;
        const unregister = () => supervisor.unregisterProcess(id);
        child.once('exit', unregister);
        child.once('close', unregister);
        supervisor.registerProcess(id, {
          pid: child.pid, type: 'codex', startedAt: new Date().toISOString(),
        }, child);
      }

      await this.request('initialize', {
        clientInfo: { name: 'claude_mem', title: 'claude-mem', version: '1' },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: ['item/agentMessage/delta'],
        },
      }, timeoutMs, signal);
      this.writeMessage({ method: 'initialized', params: {} });
      logger.debug('SDK', 'Started persistent Codex app-server', { pid: child.pid });
    } catch (error) {
      // A rejected initialize RPC leaves a live but unusable child. Never cache it.
      await this.invalidate(error instanceof Error ? error : new Error(String(error)), expectedChild);
      throw error;
    }
  }

  private request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) {
      return Promise.reject(new Error(`Codex app-server ${method} aborted`));
    }
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) {
      return Promise.reject(new Error('Codex app-server is not running'));
    }

    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Codex app-server ${method} timed out after ${timeoutMs}ms`);
        reject(error);
        this.invalidate(error);
      }, timeoutMs);
      const pending: PendingRequest = { resolve, reject, timer };
      if (signal) {
        const onAbort = () => {
          this.pending.delete(id);
          clearTimeout(timer);
          const error = new Error(`Codex app-server ${method} aborted`);
          reject(error);
          this.invalidate(error);
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        pending.removeAbort = () => signal.removeEventListener('abort', onAbort);
      }
      this.pending.set(id, pending);
      try {
        this.writeMessage({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        pending.removeAbort?.();
        reject(error);
      }
    });
  }

  private writeMessage(message: JsonObject): void {
    const child = this.child;
    if (!child || !child.stdin.writable) throw new Error('Codex app-server stdin is unavailable');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onStdout(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (this.child !== child) return;
    this.protocolBuffer += chunk;
    if (Buffer.byteLength(this.protocolBuffer) > MAX_PROTOCOL_LINE_BYTES) {
      this.invalidate(new Error('Codex app-server protocol line exceeded safety limit'));
      return;
    }

    let newline: number;
    while ((newline = this.protocolBuffer.indexOf('\n')) !== -1) {
      const line = this.protocolBuffer.slice(0, newline).trim();
      this.protocolBuffer = this.protocolBuffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.invalidate(new Error(`Codex app-server emitted malformed JSON: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(message: unknown): void {
    if (!isObject(message)) return;
    if (typeof message.id === 'number' && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.removeAbort?.();
      if (isObject(message.error)) {
        pending.reject(new Error(`Codex app-server RPC error ${String(message.error.code)}: ${String(message.error.message)}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if ((typeof message.id === 'number' || typeof message.id === 'string') && typeof message.method === 'string') {
      this.handleServerRequest(message.id, message.method);
      return;
    }
    if (typeof message.method === 'string') this.handleNotification(message.method, message.params);
  }

  private handleServerRequest(id: number | string, method: string): void {
    if (method === 'item/permissions/requestApproval') {
      this.writeMessage({ id, result: { permissions: {}, scope: 'turn' } });
      return;
    }
    if (method.includes('requestApproval')) {
      this.writeMessage({ id, result: { decision: 'decline', reason: 'claude-mem does not permit tools' } });
      return;
    }
    if (method === 'mcpServer/elicitation/request') {
      this.writeMessage({ id, result: { action: 'decline', content: null } });
      return;
    }
    this.writeMessage({ id, error: { code: -32601, message: `Unsupported server request: ${method}` } });
  }

  private handleNotification(method: string, params: unknown): void {
    const active = this.activeTurn;
    if (!active || !isObject(params)) return;
    if (typeof params.threadId === 'string' && params.threadId !== active.threadId) return;

    if (method === 'item/completed' && isObject(params.item)) {
      const item = params.item;
      if (typeof item.type === 'string' && FORBIDDEN_ITEM_TYPES.has(item.type)) {
        active.protocolError = new Error(`Codex app-server attempted forbidden ${item.type} capability`);
        void this.interruptOrInvalidate(active).finally(() => active.complete());
      }
      if (item.type === 'agentMessage' && typeof item.text === 'string') {
        if (item.phase === 'final_answer' || active.finalText === null) active.finalText = item.text;
      }
      return;
    }

    if (method === 'thread/tokenUsage/updated' && isObject(params.tokenUsage)) {
      active.tokenUsage = params.tokenUsage;
      return;
    }

    if (method === 'turn/completed' && isObject(params.turn)) {
      this.acceptTerminalTurn(active, params.turn);
      return;
    }

    if (method === 'error') {
      active.protocolError = new Error(
        typeof params.message === 'string' ? params.message : 'Codex app-server reported an error',
      );
      active.complete();
    }
  }

  private acceptTerminalTurn(active: ActiveTurn, turn: JsonObject): void {
    if (typeof turn.status !== 'string' || !TERMINAL_TURN_STATUSES.has(turn.status)) return;
    active.terminalTurn = turn;
    if (Array.isArray(turn.items)) {
      for (const raw of turn.items) {
        if (isObject(raw) && raw.type === 'agentMessage' && typeof raw.text === 'string') {
          if (raw.phase === 'final_answer' || active.finalText === null) active.finalText = raw.text;
        }
      }
    }
    active.complete();
  }

  private onChildExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    void this.invalidate(error, child);
  }

  private invalidate(error: Error, expectedChild?: ChildProcessWithoutNullStreams): Promise<void> {
    if (expectedChild && this.child !== expectedChild) return Promise.resolve();
    const child = this.child;
    if (child) logger.debug('SDK', 'Stopping persistent Codex app-server', { pid: child.pid }, error);
    this.child = null;
    this.startPromise = null;
    let termination = Promise.resolve();
    if (child) {
      if (child.pid) {
        termination = killProcessTree(child.pid).catch(() => {
          try { child.kill('SIGKILL'); } catch { /* already closed */ }
        });
      } else {
        try { child.kill('SIGKILL'); } catch { /* already closed */ }
      }
    }

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.removeAbort?.();
      pending.reject(error);
    }
    this.pending.clear();
    if (this.activeTurn) {
      this.activeTurn.protocolError = error;
      this.activeTurn.complete();
    }
    if (this.privateRoot) {
      try { rmSync(this.privateRoot, { recursive: true, force: true }); } catch { /* best effort */ }
      this.privateRoot = null;
      this.workspace = null;
    }
    return termination;
  }
}

const APP_SERVER_ENV_ALLOWLIST = new Set([
  'APPDATA',
  'CODEX_HOME',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LOCALAPPDATA',
  'NODE_EXTRA_CA_CERTS',
  'PATH',
  'PATHEXT',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERPROFILE',
  'USERNAME',
  'WINDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
]);

export function buildCodexAppServerEnv(
  env: NodeJS.ProcessEnv = process.env,
  scopedCodexHome?: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && (APP_SERVER_ENV_ALLOWLIST.has(key) || key.startsWith('LC_'))) {
      result[key] = value;
    }
  }
  if (scopedCodexHome) result.CODEX_HOME = scopedCodexHome;
  return result;
}
