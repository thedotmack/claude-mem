/**
 * Worker boot progress, published on GET /api/ready (liveness over deadlines,
 * Phase 4). Replaces "poll /api/readiness and guess from uptime": a client
 * reads one stream and learns the outcome as soon as the worker knows it.
 *
 *   starting → db_ready → routes_ready → ready
 *                                     ↘ failed{message}   (from any non-ready phase)
 */

export type InitPhase = 'starting' | 'db_ready' | 'routes_ready' | 'ready' | 'failed';

export const TERMINAL_INIT_PHASES: readonly InitPhase[] = ['ready', 'failed'];

export interface InitPhaseState {
  phase: InitPhase;
  /** Set only for `failed`: why background init died. */
  message?: string;
}

export type InitPhaseListener = (state: InitPhaseState) => void;

/** What Server needs to serve /api/ready: the current phase plus transitions. */
export interface InitPhaseSource {
  getInitPhase(): InitPhaseState;
  /** Returns an unsubscribe function. */
  subscribeInitPhase(listener: InitPhaseListener): () => void;
}

export class InitPhaseTracker implements InitPhaseSource {
  private state: InitPhaseState = { phase: 'starting' };
  private readonly listeners = new Set<InitPhaseListener>();

  getInitPhase(): InitPhaseState {
    return this.state;
  }

  subscribeInitPhase(listener: InitPhaseListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  setInitPhase(phase: InitPhase, message?: string): void {
    this.state = message === undefined ? { phase } : { phase, message };
    for (const listener of [...this.listeners]) listener(this.state);
  }
}
