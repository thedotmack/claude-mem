/**
 * Shared focus pages: one focus area of My Work, shared by link at cmem.ai/focus/<token>, that people and agents
 * comment on. The wire contract is claude-mem-pro's /api/focus-share (src/lib/focus-share/http.ts there).
 *
 * The worker builds each page from its own snapshot (focus-share-publisher.ts) and keeps it current whether or not
 * My Work is open; it signs the calls with the cloud sync credential, so the credential never reaches a browser.
 * Which areas are shared, and their links, live in focus-shares.json next to settings.json. A page that has not
 * changed since the last publish is not sent again.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface FocusShareEntry {
  token: string;
  url: string;
  sharedAt: string;
  /** When cmem.ai last took a page for it. */
  publishedAt: string | null;
  /** The last page sent, so an unchanged page is not sent again. */
  pageHash: string | null;
}

export interface FocusShareComment {
  id: string;
  authorKind: 'person' | 'agent';
  authorName: string;
  agentName: string | null;
  isOwner: boolean;
  body: string;
  createdAt: string;
}

export interface FocusShareOptions {
  origin: () => string;
  credentials: () => { token: string; userId: string };
  registryPath: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** A refusal the viewer can show as it is. `status` is the HTTP status this worker answers with. */
export class FocusShareError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

type Registry = Record<string, FocusShareEntry>;
const FOCUS_AREA_ID = /^.{1,200}$/s;

export class FocusShares {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  /** Publishes and stops for one area run one at a time, so a late answer never brings back a stopped link. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly options: FocusShareOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** Whether this install can share at all: cloud sync is connected. */
  connected(): boolean {
    const { token, userId } = this.options.credentials();
    return !!token && !!userId;
  }

  /** Every shared area by id. */
  list(): Registry {
    return this.read();
  }

  /**
   * Shares the area, or publishes its page to the link it already has. Starting a share always reaches cmem.ai;
   * a publish of the same page as last time does not. With `create: false` (the timed updates) an area that is not
   * shared, or was stopped meanwhile, is refused with 410 instead of getting a new link.
   */
  publish(focusAreaId: string, page: unknown, { create = true }: { create?: boolean } = {}): Promise<{ entry: FocusShareEntry; sent: boolean }> {
    if (!FOCUS_AREA_ID.test(focusAreaId)) return Promise.reject(new FocusShareError('That focus area id is not valid.', 400));
    return this.serial(focusAreaId, () => this.publishNow(focusAreaId, page, create));
  }

  private async publishNow(focusAreaId: string, page: unknown, create: boolean): Promise<{ entry: FocusShareEntry; sent: boolean }> {
    const pageHash = hashOf(page);
    const existing = this.read()[focusAreaId];
    if (existing && existing.pageHash === pageHash) return { entry: existing, sent: false };
    if (!existing && !create) throw new FocusShareError('This area is no longer shared.', 410);

    if (existing) {
      const answer = await this.call('PUT', `/api/focus-share/${existing.token}`, { snapshot: page });
      if (answer.status === 404) {
        // Stopped somewhere else (another machine, or the page's owner on cmem.ai): this link is dead for good.
        this.remove(focusAreaId, existing.token);
        throw new FocusShareError('This area is no longer shared. Share it again for a new link.', 410);
      }
      const body = this.expect(answer, 'publish the page');
      const entry = { ...existing, publishedAt: stringOr(body.publishedAt, existing.publishedAt), pageHash };
      // Another process may have stopped or replaced this share while the page was on its way.
      if (this.read()[focusAreaId]?.token !== existing.token) throw new FocusShareError('This area is no longer shared.', 410);
      this.write({ ...this.read(), [focusAreaId]: entry });
      return { entry, sent: true };
    }

    const body = this.expect(await this.call('POST', '/api/focus-share', { focusAreaId, snapshot: page }), 'share this area');
    const token = stringOr(body.token, '');
    const url = stringOr(body.url, '');
    if (!/^[A-Za-z0-9_-]{32}$/.test(token) || !url.startsWith(`${this.options.origin()}/focus/`)) {
      throw new FocusShareError('cmem.ai answered without a usable link.', 502);
    }
    const now = new Date().toISOString();
    const entry: FocusShareEntry = { token, url, sharedAt: now, publishedAt: stringOr(body.publishedAt, now), pageHash };
    this.write({ ...this.read(), [focusAreaId]: entry });
    return { entry, sent: true };
  }

  /** Stops sharing the area. The link stops working for everyone; sharing again makes a new one. */
  stop(focusAreaId: string): Promise<void> {
    return this.serial(focusAreaId, () => this.stopNow(focusAreaId));
  }

  private async stopNow(focusAreaId: string): Promise<void> {
    const existing = this.read()[focusAreaId];
    if (!existing) return;
    const answer = await this.call('DELETE', `/api/focus-share/${existing.token}`);
    // 404 too: there is nothing left to stop.
    if (answer.status !== 404) this.expect(answer, 'stop sharing');
    this.remove(focusAreaId, existing.token);
  }

  /** The shared page's comments, oldest first, with when its page was last published. */
  async comments(focusAreaId: string): Promise<{ comments: FocusShareComment[]; publishedAt: string | null }> {
    const existing = this.requireShared(focusAreaId);
    const answer = await this.call('GET', `/api/focus-share/${existing.token}`);
    if (answer.status === 404) {
      this.remove(focusAreaId, existing.token);
      throw new FocusShareError('This area is no longer shared.', 410);
    }
    const body = this.expect(answer, 'read the comments');
    return { comments: Array.isArray(body.comments) ? body.comments as FocusShareComment[] : [], publishedAt: stringOr(body.publishedAt, null) };
  }

  /** The owner's own comment, signed with the sync credential so it shows as the owner's. */
  async comment(focusAreaId: string, text: string): Promise<FocusShareComment> {
    const existing = this.requireShared(focusAreaId);
    const answer = await this.call('POST', `/api/focus-share/${existing.token}/comments`, { body: text });
    if (answer.status === 404) {
      this.remove(focusAreaId, existing.token);
      throw new FocusShareError('This area is no longer shared.', 410);
    }
    return this.expect(answer, 'post the comment').comment as FocusShareComment;
  }

  /** Runs `work` after every earlier publish or stop of the same area has settled. */
  private serial<T>(focusAreaId: string, work: () => Promise<T>): Promise<T> {
    const before = this.queues.get(focusAreaId) ?? Promise.resolve();
    const run = before.then(work, work);
    const settled = run.catch(() => undefined);
    this.queues.set(focusAreaId, settled);
    void settled.then(() => { if (this.queues.get(focusAreaId) === settled) this.queues.delete(focusAreaId); });
    return run;
  }

  private requireShared(focusAreaId: string): FocusShareEntry {
    const existing = this.read()[focusAreaId];
    if (!existing) throw new FocusShareError('This area is not shared.', 404);
    return existing;
  }

  private async call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> | null }> {
    const { token, userId } = this.options.credentials();
    if (!token || !userId) throw new FocusShareError('Sharing needs cloud sync. Connect cmem.ai first.', 409);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.options.origin()}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'X-User-Id': userId,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // The bearer goes to cmem.ai only.
        redirect: 'manual',
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* the status still says what happened */ }
      return { status: response.status, body: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null };
    } catch (error) {
      if (controller.signal.aborted) throw new FocusShareError('cmem.ai did not answer in time.', 504);
      throw new FocusShareError(`Could not reach cmem.ai: ${error instanceof Error ? error.message : String(error)}`, 502);
    } finally {
      clearTimeout(timer);
    }
  }

  private expect(answer: { status: number; body: Record<string, unknown> | null }, what: string): Record<string, unknown> {
    if (answer.status >= 200 && answer.status < 300 && answer.body) return answer.body;
    const reason = stringOr(answer.body?.message, '') || stringOr(answer.body?.error, '') || `cmem.ai answered ${answer.status}`;
    if (answer.status === 401) throw new FocusShareError(`Could not ${what}: the cloud sync key was refused. Reconnect cmem.ai.`, 409);
    if (answer.status === 403) throw new FocusShareError(`Could not ${what}: cloud sync is not active on this account.`, 409);
    throw new FocusShareError(`Could not ${what}: ${reason}`, answer.status >= 400 && answer.status < 500 ? 400 : 502);
  }

  private read(): Registry {
    if (!existsSync(this.options.registryPath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.options.registryPath, 'utf8')) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Registry : {};
    } catch {
      return {};
    }
  }

  private write(registry: Registry): void {
    mkdirSync(dirname(this.options.registryPath), { recursive: true });
    const temp = `${this.options.registryPath}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.options.registryPath);
  }

  /** Forgets the area's share, but only the share `token` names: a late answer about an old link never drops a newer one. */
  private remove(focusAreaId: string, token: string): void {
    const registry = this.read();
    if (registry[focusAreaId]?.token !== token) return;
    delete registry[focusAreaId];
    this.write(registry);
  }
}

function hashOf(page: unknown): string {
  // generatedAt changes on every build of the page; what the page says is what counts.
  const { generatedAt: _generatedAt, ...rest } = (page && typeof page === 'object' ? page : {}) as Record<string, unknown>;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

function stringOr<T extends string | null>(value: unknown, fallback: T): string | T {
  return typeof value === 'string' && value ? value : fallback;
}
