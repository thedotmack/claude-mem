// SPDX-License-Identifier: Apache-2.0
//
// The rewrite seam (plan Phase 10 task 1, D7): in-process stages that may
// edit a request on its way upstream and its reply on its way back, each
// within a budget, each failing open. Ported from magpie's middleware runner
// (internal/middleware/run.go:16-404, middleware.go:32-38, 201-281, 382-439;
// the seam internal/gateway/middleware.go:10-33; MIT, Copyright (c) 2026
// yetone), with stages written in TypeScript instead of loaded JavaScript.
//
// Request order: memory injection → Endless Mode → memory_search tool
// definition (Phases 11–12 register them), then the relay's outbound mask,
// which is not a stage because it fails CLOSED. Response order: restore
// placeholders (relay) → the stages' onEvent/onResponse (memory_search
// stitcher, Phase 12) → the client-facing tee (recorder, live feed, usage).
//
// Fail open (D7.7): a hook that throws, takes longer than its budget, or
// returns something it may not leaves its input as it was; the stage's
// failure counter goes up and its last error is kept (logged at most 60
// times a minute across stages). Budgets are per hook, per stage, as
// magpie's (report 05 §Q1): 250 ms for onRequest and onResponse unless a
// stage declares its own (stages that wait on the worker declare
// CONTEXT_TIMEOUT_MS), 50 ms for each onEvent. JavaScript cannot interrupt a
// synchronous hook the way magpie's runtime is interrupted, so a hook that
// spins past its budget is let finish and its result thrown away; a hook
// that awaits is raced against its budget and left behind.

import { logger } from '../../../utils/logger.js';
import type { WireIdentity } from '../identity/resolve-identity.js';
import type { WireRequest } from '../ir/types.js';
import { JsonScanError, scanDocument } from '../json/scanner.js';
import { ledgerEntryIdOf, type WireConversationLedgerView, type WireLedgerEntry } from '../ledger/conversation-ledger.js';
import type { WireProtocol } from '../relay/protocols.js';
import type { WireGatewayRoute } from '../routes.js';

/** How long onRequest and onResponse may take (magpie `requestLimit`). */
export const REQUEST_STAGE_BUDGET_MS = 250;
/** How long onEvent may take for one event (magpie `eventLimit`). */
export const EVENT_STAGE_BUDGET_MS = 50;
/** Failures logged across all stages per minute (magpie `say`). */
const STAGE_FAILURE_LOGS_PER_MINUTE = 60;
/** A reject's status when a stage names none in 400–599 (magpie `reject`). */
const DEFAULT_REJECT_STATUS = 403;
const DEFAULT_REJECT_MESSAGE = 'turned away by a claude-mem wire gateway rewrite stage';

export interface WireRewriteRejection {
  status: number;
  message: string;
}

/** onRequest: new bytes, a rejection, or undefined to keep the bytes as they are. */
export type WireRewriteRequestResult = Uint8Array | { reject: { status?: number; message?: string } } | undefined;

/** One SSE event of a reply: its `event:` name ('' for none) and the JSON on its data line. */
export interface WireRewriteStreamEvent {
  name: string;
  dataJson: string;
}

/** What stages estimate they added or took out, for the usage ledger. */
export interface WireRewriteEstimates {
  injectedTokens: number;
  swappedTokens: number;
}

/** What every hook of a stage is told of the exchange. */
export interface WireRewriteContext {
  routeId: string;
  route: WireGatewayRoute;
  identity: WireIdentity;
  /**
   * The conversation's ledger; null for requests that have none (helpers,
   * compaction). What onRequest records is held until the relay knows what
   * goes upstream: written when the stages' bytes (or the unchanged body)
   * go, dropped when the original bytes go instead, and dropped for a stage
   * that failed. A stage left behind past its budget can record nothing more.
   */
  ledger: WireConversationLedgerView | null;
  protocol: WireProtocol;
  /** The gateway's settings (settings.json with env overrides), for stages that read their own keys. */
  settings: Readonly<Record<string, string>>;
  /** This stage's own state for this exchange, shared by its hooks (magpie `ctx.state`). */
  state: Record<string, unknown>;
  /**
   * The parsed form of `body` as handed to the hook: the relay's parse of the
   * request as it came, or a fresh parse when an earlier stage changed it.
   * Spans point into that body. Throws when the bytes do not parse.
   */
  requestOf(body: Uint8Array): WireRequest;
  /** Shared by the exchange's stages; a stage that failed has its additions taken back. */
  estimates: WireRewriteEstimates;
  /** The reply's status, for onEvent and onResponse. */
  status?: number;
}

export type MaybePromise<T> = T | Promise<T>;

export interface WireRewriteStage {
  name: string;
  /** onRequest's and onResponse's budget; defaults to REQUEST_STAGE_BUDGET_MS. */
  budgetMs?: number;
  /** Whether the stage takes part in this exchange at all; none of its hooks run when false. */
  appliesTo?(context: WireRewriteContext): boolean;
  onRequest?(context: WireRewriteContext, body: Uint8Array): MaybePromise<WireRewriteRequestResult>;
  /** A changed event, null to drop it, undefined to keep it as it was. */
  onEvent?(context: WireRewriteContext, event: WireRewriteStreamEvent): MaybePromise<WireRewriteStreamEvent | null | undefined>;
  /** A whole (non-stream) reply's new bytes, or undefined to keep them. */
  onResponse?(context: WireRewriteContext, body: Uint8Array): MaybePromise<Uint8Array | undefined>;
}

export interface WireRewriteStageState {
  calls: number;
  failures: number;
  averageMicros: number;
  lastError?: string;
}

/** Each stage's calls, failures and last error (magpie `States`), for status and tests. */
export class WireRewriteStageHealth {
  private readonly countersByStage = new Map<string, { calls: number; failures: number; totalMicros: number; lastError?: string }>();
  private logWindowStartedAt = 0;
  private logsInWindow = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private countersOf(stageName: string) {
    let counters = this.countersByStage.get(stageName);
    if (!counters) {
      counters = { calls: 0, failures: 0, totalMicros: 0 };
      this.countersByStage.set(stageName, counters);
    }
    return counters;
  }

  noteCall(stageName: string, elapsedMs: number): void {
    const counters = this.countersOf(stageName);
    counters.calls++;
    counters.totalMicros += elapsedMs * 1000;
  }

  /** A hook that failed; its input goes on as it was (magpie `fail`). */
  noteFailure(stageName: string, hookName: string, error: unknown): void {
    const counters = this.countersOf(stageName);
    counters.failures++;
    const message = `${hookName}: ${error instanceof Error ? error.message : String(error)}`;
    counters.lastError = message;
    const now = this.now();
    if (now - this.logWindowStartedAt >= 60_000) {
      this.logWindowStartedAt = now;
      this.logsInWindow = 0;
    }
    if (this.logsInWindow < STAGE_FAILURE_LOGS_PER_MINUTE) {
      this.logsInWindow++;
      logger.warn('WIRE', 'A rewrite stage failed; its input went on as it was', { stage: stageName, error: message });
    }
  }

  states(): Record<string, WireRewriteStageState> {
    const states: Record<string, WireRewriteStageState> = {};
    for (const [stageName, counters] of this.countersByStage) {
      states[stageName] = {
        calls: counters.calls,
        failures: counters.failures,
        averageMicros: counters.calls > 0 ? counters.totalMicros / counters.calls : 0,
        ...(counters.lastError !== undefined ? { lastError: counters.lastError } : {}),
      };
    }
    return states;
  }
}

class StageBudgetExceededError extends Error {
  constructor(budgetMs: number, elapsedMs: number) {
    super(`took ${Math.round(elapsedMs)} ms, over its ${budgetMs} ms budget`);
    this.name = 'StageBudgetExceededError';
  }
}

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return value !== null && typeof value === 'object' && typeof (value as Promise<T>).then === 'function';
}

/**
 * Call a hook within its budget. Resolves to its value, or rejects when it
 * threw, rejected, outlasted its budget (awaited) or overran it (synchronous).
 */
export async function callWithinBudget<T>(invokeHook: () => MaybePromise<T>, budgetMs: number): Promise<T> {
  const startedAt = performance.now();
  const returned = invokeHook();
  if (!isPromiseLike(returned)) {
    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs > budgetMs) throw new StageBudgetExceededError(budgetMs, elapsedMs);
    return returned;
  }
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const budgetExpired = new Promise<never>((_, reject) => {
    budgetTimer = setTimeout(() => reject(new StageBudgetExceededError(budgetMs, performance.now() - startedAt)), budgetMs);
  });
  // A hook left behind must not reject unobserved.
  returned.then(undefined, () => undefined);
  try {
    return await Promise.race([returned, budgetExpired]);
  } finally {
    clearTimeout(budgetTimer);
  }
}

const utf8Encoder = new TextEncoder();

/** Bytes that hold exactly one JSON value. */
function isOneJsonValue(bytes: Uint8Array): boolean {
  try {
    scanDocument(bytes);
    return true;
  } catch (error) {
    if (error instanceof JsonScanError) return false;
    throw error;
  }
}

/**
 * One exchange's ledger writes, held until the relay decides (D7.2 with
 * D7.7): a rewrite the ledger keeps is re-applied on every later request,
 * so it must never keep one whose bytes did not go upstream.
 */
class HeldLedgerWrites {
  private readonly heldByEntryId = new Map<string, { entry: WireLedgerEntry; stageName: string }>();
  private readonly revokedStageNames = new Set<string>();
  private decided = false;

  constructor(private readonly ledger: WireConversationLedgerView) {}

  viewFor(stageName: string): WireConversationLedgerView {
    const ledger = this.ledger;
    return {
      conversationKey: ledger.conversationKey,
      status: ledger.status,
      get: entryId => this.heldByEntryId.get(entryId)?.entry ?? ledger.get(entryId),
      entries: () => [...ledger.entries(), ...[...this.heldByEntryId.values()].map(held => held.entry)],
      record: entry => {
        if (this.revokedStageNames.has(stageName)) {
          throw new Error(`stage ${stageName} failed in this exchange; it records nothing more`);
        }
        // Once the request is decided (reply stages), a write goes straight to the ledger.
        if (this.decided) return ledger.record(entry);
        if (ledger.status !== 'born') {
          throw new Error(`conversation ${ledger.conversationKey} is ${ledger.status}; only a conversation born under the gateway is rewritten`);
        }
        const entryId = ledgerEntryIdOf(entry);
        const existing = this.heldByEntryId.get(entryId)?.entry ?? ledger.get(entryId);
        if (existing) return existing;
        this.heldByEntryId.set(entryId, { entry, stageName });
        return entry;
      },
    };
  }

  /** A failed stage's held writes go, and it may write no more. */
  revokeStage(stageName: string): void {
    this.revokedStageNames.add(stageName);
    for (const [entryId, held] of this.heldByEntryId) {
      if (held.stageName === stageName) this.heldByEntryId.delete(entryId);
    }
  }

  commit(): void {
    this.decided = true;
    const held = [...this.heldByEntryId.values()];
    this.heldByEntryId.clear();
    for (const { entry } of held) this.ledger.record(entry);
  }

  discard(): void {
    this.decided = true;
    this.heldByEntryId.clear();
  }
}

/** The shared fields of every stage's context; `state` is added per stage. */
export type WireRewriteContextBase = Omit<WireRewriteContext, 'state' | 'estimates'>;

export interface WireRequestStagesOutcome {
  body: Uint8Array;
  /** The stages whose bytes went on (in order). */
  appliedStageNames: string[];
  rejection: WireRewriteRejection | null;
}

/** One exchange's run through the stages that apply to it. */
export class WireRewriteRun {
  readonly estimates: WireRewriteEstimates = { injectedTokens: 0, swappedTokens: 0 };
  private readonly contextsByStage: Map<WireRewriteStage, WireRewriteContext>;

  constructor(
    readonly stages: WireRewriteStage[],
    contextsByStage: Map<WireRewriteStage, WireRewriteContext>,
    private readonly health: WireRewriteStageHealth,
    private readonly heldLedgerWrites: HeldLedgerWrites | null = null,
  ) {
    this.contextsByStage = contextsByStage;
  }

  /** The request went as the stages left it (changed or not): what they recorded is written to the ledger. Throws when a write fails. */
  commitLedgerEntries(): void {
    this.heldLedgerWrites?.commit();
  }

  /** The original bytes went (or nothing did): what the stages recorded is dropped. */
  discardLedgerEntries(): void {
    this.heldLedgerWrites?.discard();
  }

  get hasEventStages(): boolean {
    return this.stages.some(stage => stage.onEvent);
  }

  get hasResponseStages(): boolean {
    return this.stages.some(stage => stage.onResponse);
  }

  private contextOf(stage: WireRewriteStage): WireRewriteContext {
    return this.contextsByStage.get(stage)!;
  }

  /** Run a hook within its budget; a failure is noted, its estimates taken back, and undefined returned. */
  private async callHook<T>(stage: WireRewriteStage, hookName: string, budgetMs: number, invokeHook: () => MaybePromise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    const estimatesBefore = { ...this.estimates };
    const startedAt = performance.now();
    try {
      const value = await callWithinBudget(invokeHook, budgetMs);
      this.health.noteCall(stage.name, performance.now() - startedAt);
      return { ok: true, value };
    } catch (error) {
      this.health.noteCall(stage.name, performance.now() - startedAt);
      this.health.noteFailure(stage.name, hookName, error);
      Object.assign(this.estimates, estimatesBefore);
      this.heldLedgerWrites?.revokeStage(stage.name);
      return { ok: false };
    }
  }

  private noteBadReturn(stage: WireRewriteStage, hookName: string, why: string, estimatesBefore: WireRewriteEstimates): void {
    this.health.noteFailure(stage.name, hookName, new Error(why));
    Object.assign(this.estimates, estimatesBefore);
    this.heldLedgerWrites?.revokeStage(stage.name);
  }

  /**
   * Each stage's onRequest on the body in turn: what one returns is what the
   * next is given (magpie `Request`). The first rejection ends the run.
   */
  async runRequestStages(body: Uint8Array): Promise<WireRequestStagesOutcome> {
    let current = body;
    const appliedStageNames: string[] = [];
    for (const stage of this.stages) {
      if (!stage.onRequest) continue;
      const context = this.contextOf(stage);
      const estimatesBefore = { ...this.estimates };
      const input = current;
      const called = await this.callHook(stage, 'onRequest', stage.budgetMs ?? REQUEST_STAGE_BUDGET_MS, () => stage.onRequest!(context, input));
      if (!called.ok || called.value === undefined) continue;
      const returned = called.value as unknown;
      if (returned instanceof Uint8Array) {
        if (returned === input) continue;
        if (!isOneJsonValue(returned)) {
          this.noteBadReturn(stage, 'onRequest', 'returned bytes that are not one JSON value', estimatesBefore);
          continue;
        }
        current = returned;
        appliedStageNames.push(stage.name);
        continue;
      }
      if (returned !== null && typeof returned === 'object' && 'reject' in returned) {
        const reject = (returned as { reject: unknown }).reject as { status?: unknown; message?: unknown } | null;
        const status = typeof reject?.status === 'number' && reject.status >= 400 && reject.status <= 599 ? reject.status : DEFAULT_REJECT_STATUS;
        const message = typeof reject?.message === 'string' && reject.message !== '' ? reject.message : DEFAULT_REJECT_MESSAGE;
        // The first rejection wins, and the request goes nowhere.
        return { body, appliedStageNames: [], rejection: { status, message } };
      }
      this.noteBadReturn(stage, 'onRequest', 'returned neither bytes, a rejection nor undefined', estimatesBefore);
    }
    return { body: current, appliedStageNames, rejection: null };
  }

  /** Each stage's onEvent on one event; null when one dropped it. */
  async runEventStages(event: WireRewriteStreamEvent, status: number): Promise<WireRewriteStreamEvent | null> {
    let current = event;
    for (const stage of this.stages) {
      if (!stage.onEvent) continue;
      const context = this.contextOf(stage);
      context.status = status;
      const estimatesBefore = { ...this.estimates };
      const input = current;
      const called = await this.callHook(stage, 'onEvent', EVENT_STAGE_BUDGET_MS, () => stage.onEvent!(context, input));
      if (!called.ok || called.value === undefined) continue;
      if (called.value === null) return null;
      const returned = called.value as unknown as WireRewriteStreamEvent;
      if (typeof returned !== 'object' || typeof returned.dataJson !== 'string' || typeof returned.name !== 'string'
        || !isOneJsonValue(utf8Encoder.encode(returned.dataJson))) {
        this.noteBadReturn(stage, 'onEvent', 'returned neither an event with JSON data, null nor undefined', estimatesBefore);
        continue;
      }
      current = returned;
    }
    return current;
  }

  /** Each stage's onResponse on a whole reply. */
  async runResponseStages(body: Uint8Array, status: number): Promise<Uint8Array> {
    let current = body;
    for (const stage of this.stages) {
      if (!stage.onResponse) continue;
      const context = this.contextOf(stage);
      context.status = status;
      const estimatesBefore = { ...this.estimates };
      const input = current;
      const called = await this.callHook(stage, 'onResponse', stage.budgetMs ?? REQUEST_STAGE_BUDGET_MS, () => stage.onResponse!(context, input));
      if (!called.ok || called.value === undefined) continue;
      const returned = called.value as unknown;
      // null counts as a failure here (magpie run.go:305): a whole reply cannot be dropped.
      if (!(returned instanceof Uint8Array) || !isOneJsonValue(returned)) {
        this.noteBadReturn(stage, 'onResponse', 'returned neither JSON bytes nor undefined', estimatesBefore);
        continue;
      }
      current = returned;
    }
    return current;
  }

  /** The rewrite went back to the original bytes (a failed pairing check): nothing was added or taken out. */
  discardEstimates(): void {
    this.estimates.injectedTokens = 0;
    this.estimates.swappedTokens = 0;
  }
}

export interface WireRewriteSeamOptions {
  stages: WireRewriteStage[];
  health?: WireRewriteStageHealth;
}

/** The registered stages, in order; one per gateway. */
export class WireRewriteSeam {
  readonly stages: WireRewriteStage[];
  readonly health: WireRewriteStageHealth;

  constructor(options: WireRewriteSeamOptions) {
    this.stages = [...options.stages];
    this.health = options.health ?? new WireRewriteStageHealth();
  }

  /**
   * The run for one exchange, or null when no stage applies to it (the
   * relay then does exactly what it did before the seam existed). A stage
   * whose appliesTo throws is left out, as a failure.
   */
  begin(base: WireRewriteContextBase): WireRewriteRun | null {
    if (this.stages.length === 0) return null;
    const contextsByStage = new Map<WireRewriteStage, WireRewriteContext>();
    const applying: WireRewriteStage[] = [];
    const heldLedgerWrites = base.ledger ? new HeldLedgerWrites(base.ledger) : null;
    const run = new WireRewriteRun(applying, contextsByStage, this.health, heldLedgerWrites);
    for (const stage of this.stages) {
      const ledger = heldLedgerWrites ? heldLedgerWrites.viewFor(stage.name) : null;
      const context: WireRewriteContext = { ...base, ledger, state: {}, estimates: run.estimates };
      let applies: boolean;
      try {
        applies = stage.appliesTo ? stage.appliesTo(context) === true : true;
      } catch (error) {
        this.health.noteFailure(stage.name, 'appliesTo', error);
        applies = false;
      }
      if (!applies) continue;
      applying.push(stage);
      contextsByStage.set(stage, context);
    }
    return applying.length > 0 ? run : null;
  }
}
