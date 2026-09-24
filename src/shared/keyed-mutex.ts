
/**
 * In-process lock that serializes async critical sections sharing a key.
 * Sections with different keys still run concurrently. Used to stop concurrent
 * writers of the same corpus from clobbering each other's persisted state.
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<void>>();

  async runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);

    await previous;
    try {
      return await task();
    } finally {
      release();
      // Drop the entry once this is the last waiter so the map does not grow
      // without bound across many distinct keys. A section queued behind us has
      // already replaced the tail, so the identity check leaves it in place.
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}
