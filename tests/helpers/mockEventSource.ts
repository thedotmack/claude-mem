/**
 * Mock EventSource for SSE testing.
 *
 * This mock simulates Server-Sent Events (SSE) by programmatically
 * triggering events based on configured scenarios.
 */

export interface MockSSEEvent {
  /** Delay in milliseconds before this event fires */
  delay: number;
  /** Event data (will be JSON stringified) */
  data: any;
  /** Event type (default: 'processing_status') */
  type?: string;
}

export interface MockEventSourceOptions {
  /** Events to simulate */
  events?: MockSSEEvent[];
  /** Whether to trigger an error event */
  triggerError?: boolean;
  /** Delay before error triggers (ms) */
  errorDelay?: number;
  /** URL the EventSource was created with */
  url?: string;
}

/**
 * Creates a mock EventSource class that simulates SSE events.
 *
 * Usage:
 * ```typescript
 * global.EventSource = createMockEventSource({
 *   events: [
 *     { delay: 100, data: { queueDepth: 2 } },
 *     { delay: 200, data: { queueDepth: 0 } }
 *   ]
 * }) as any;
 * ```
 */
export function createMockEventSource(options: MockEventSourceOptions = {}) {
  const { events = [], triggerError = false, errorDelay = 50 } = options;

  return class MockEventSource {
    public url: string;
    public readyState: number = 1; // OPEN
    public onerror: ((event: any) => void) | null = null;
    public onopen: ((event: any) => void) | null = null;
    public onmessage: ((event: any) => void) | null = null;

    private listeners: Map<string, Function[]> = new Map();
    private timeouts: NodeJS.Timeout[] = [];
    private closed: boolean = false;

    constructor(url: string) {
      this.url = url;

      // Simulate open event
      setTimeout(() => {
        if (this.onopen && !this.closed) {
          this.onopen({ type: 'open' });
        }
      }, 10);

      // Simulate configured events
      events.forEach(({ delay, data, type = 'processing_status' }) => {
        const timeout = setTimeout(() => {
          if (this.closed) return;

          const event = {
            type,
            data: JSON.stringify(data),
            lastEventId: '',
            origin: url
          };

          // Trigger specific event listeners
          const listeners = this.listeners.get(type) || [];
          listeners.forEach(fn => fn(event));

          // Trigger generic onmessage handler
          if (this.onmessage) {
            this.onmessage(event);
          }
        }, delay);

        this.timeouts.push(timeout);
      });

      // Simulate error if requested
      if (triggerError) {
        const timeout = setTimeout(() => {
          if (this.closed) return;

          this.readyState = 2; // CLOSED
          const errorEvent = { type: 'error' };

          if (this.onerror) {
            this.onerror(errorEvent);
          }

          const errorListeners = this.listeners.get('error') || [];
          errorListeners.forEach(fn => fn(errorEvent));
        }, errorDelay);

        this.timeouts.push(timeout);
      }
    }

    addEventListener(type: string, callback: Function) {
      if (!this.listeners.has(type)) {
        this.listeners.set(type, []);
      }
      this.listeners.get(type)!.push(callback);
    }

    removeEventListener(type: string, callback: Function) {
      const listeners = this.listeners.get(type);
      if (listeners) {
        const index = listeners.indexOf(callback);
        if (index > -1) {
          listeners.splice(index, 1);
        }
      }
    }

    close() {
      this.closed = true;
      this.readyState = 2; // CLOSED

      // Clear all pending timeouts
      this.timeouts.forEach(timeout => clearTimeout(timeout));
      this.timeouts = [];

      // Clear all listeners
      this.listeners.clear();
    }

    // Standard EventSource constants
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
  };
}

/**
 * Helper to create a mock EventSource that immediately reports queue empty.
 */
export function createImmediateSuccessMockEventSource() {
  return createMockEventSource({
    events: [
      { delay: 50, data: { queueDepth: 0 } }
    ]
  });
}

/**
 * Helper to create a mock EventSource that counts down queue depth.
 */
export function createCountdownMockEventSource(startDepth: number, intervalMs: number = 100) {
  const events: MockSSEEvent[] = [];

  for (let depth = startDepth; depth >= 0; depth--) {
    events.push({
      delay: (startDepth - depth) * intervalMs,
      data: { queueDepth: depth }
    });
  }

  return createMockEventSource({ events });
}

/**
 * Helper to create a mock EventSource that triggers an error.
 */
export function createErrorMockEventSource(errorDelay: number = 50) {
  return createMockEventSource({
    triggerError: true,
    errorDelay
  });
}

/**
 * Helper to create a mock EventSource that never resolves (for timeout tests).
 */
export function createNeverResolvingMockEventSource() {
  return createMockEventSource({
    events: [
      // Send a high queue depth but never send queueDepth: 0
      { delay: 50, data: { queueDepth: 99 } },
      { delay: 100, data: { queueDepth: 98 } }
    ]
  });
}
