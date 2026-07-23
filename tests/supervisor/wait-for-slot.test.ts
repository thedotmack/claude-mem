import { afterEach, describe, expect, it } from 'bun:test';
import {
  getProcessRegistry,
  waitForSlot,
  type SlotReservation,
} from '../../src/supervisor/process-registry.js';

/**
 * Concurrency contract of waitForSlot() (#3287).
 *
 * The production caller (ClaudeProvider.startSession) has a wide await gap
 * between the slot grant and the moment the spawned process becomes a
 * registry record (OAuth refresh + SDK spawn). A grant that does not reserve
 * anything lets every concurrent caller observe the same stale count and all
 * of them spawn (the reporter saw 9 SDK agents against a max of 2). These
 * tests drive waitForSlot the same way: grant first, register (or never
 * register) later.
 *
 * State hygiene: waitForSlot works against the module-level singleton
 * registry plus a module-level reservation count, so every test releases
 * everything it acquired (afterEach re-releases defensively; release is
 * idempotent).
 */

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const granted: SlotReservation[] = [];
const registeredIds: string[] = [];

async function acquire(maxConcurrent: number, signal?: AbortSignal): Promise<SlotReservation> {
  const reservation = await waitForSlot(maxConcurrent, signal);
  granted.push(reservation);
  return reservation;
}

function registerFakeSdkProcess(id: string): void {
  getProcessRegistry().register(id, {
    pid: process.pid,
    type: 'sdk',
    sessionId: 3287,
    startedAt: new Date().toISOString(),
  });
  registeredIds.push(id);
}

describe('waitForSlot reservations (#3287)', () => {
  afterEach(() => {
    while (registeredIds.length > 0) {
      const id = registeredIds.pop();
      if (id) getProcessRegistry().unregister(id);
    }
    while (granted.length > 0) {
      granted.pop()?.release?.();
    }
  });

  it('admits at most maxConcurrent concurrent callers before any process registers', async () => {
    const maxConcurrent = 2;
    let admitted = 0;
    const grants = Array.from({ length: 5 }, () =>
      acquire(maxConcurrent).then(reservation => {
        admitted += 1;
        return reservation;
      })
    );

    // Nothing registers during this window, exactly like the OAuth-refresh
    // gap in production. A non-reserving check admits all 5 here.
    await sleep(50);
    expect(admitted).toBe(maxConcurrent);

    // Drain: each release wakes one queued caller, so every grant resolves.
    await Promise.all(grants.map(grant => grant.then(reservation => reservation.release())));
    expect(admitted).toBe(5);
  });

  it('holds the reserved slot until the reservation is released', async () => {
    const first = await acquire(1);

    let admitted = false;
    const second = acquire(1).then(reservation => {
      admitted = true;
      return reservation;
    });

    await sleep(30);
    expect(admitted).toBe(false);

    first.release();
    (await second).release();
    expect(admitted).toBe(true);
  });

  it('release is idempotent: double-releasing frees only one slot', async () => {
    const first = await acquire(2);
    const second = await acquire(2);

    first.release();
    first.release();

    // The double release must free exactly one slot: a third caller gets it,
    // and a fourth must queue behind the still-held second reservation.
    const third = await acquire(2);
    let fourthAdmitted = false;
    const fourth = acquire(2).then(reservation => {
      fourthAdmitted = true;
      return reservation;
    });

    await sleep(30);
    expect(fourthAdmitted).toBe(false);

    second.release();
    (await fourth).release();
    third.release();
  });

  it('counts a registered process and its released reservation as one occupant', async () => {
    const reservation = await acquire(1);

    // Mirror the spawn factory: the real registry record appears, then the
    // reservation is released. Total occupancy must stay at one.
    registerFakeSdkProcess('sdk:3287:reservation-convert');
    reservation.release();

    let admitted = false;
    const next = acquire(1).then(r => {
      admitted = true;
      return r;
    });

    await sleep(30);
    expect(admitted).toBe(false);

    getProcessRegistry().unregister(registeredIds.pop()!);
    (await next).release();
    expect(admitted).toBe(true);
  });

  it('a queued caller that aborts does not consume a slot', async () => {
    const first = await acquire(1);

    const controller = new AbortController();
    const queued = waitForSlot(1, controller.signal);
    await sleep(10);
    controller.abort();
    await expect(queued).rejects.toThrow('waitForSlot aborted');

    first.release();

    // The slot freed by the release must be grantable despite the abort.
    const again = await acquire(1);
    again.release();
  });
});
