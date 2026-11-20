/**
 * In-process FIFO turn per user. Same-user work waits here, holding no
 * Postgres connection, so one user's backlog can occupy at most one connection
 * of the shared pool. The advisory lock in HubStore stays the cross-process
 * guard (rolling deploys); with this queue in front it is normally uncontended.
 */

export const SYNC_HUB_BUSY_ERROR = "sync_hub_busy";
export const CLIENT_CLOSED_REQUEST_ERROR = "client_closed_request";

export interface UserTurnOptions {
	/** Give up (SYNC_HUB_BUSY_ERROR) if earlier same-user work is still running after this long. */
	maxWaitMs: number;
	/** Give up (CLIENT_CLOSED_REQUEST_ERROR) if the client disconnects before the turn starts. */
	signal?: AbortSignal;
}

export class UserQueue {
	private readonly tails = new Map<string, Promise<void>>();

	async run<T>(userId: string, options: UserTurnOptions, work: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(userId) ?? Promise.resolve();
		let finishTurn!: () => void;
		const turnFinished = new Promise<void>((resolve) => { finishTurn = resolve; });
		// Successors wait for everything ahead of this caller as well as this
		// caller, so a caller that stops waiting never lets later work overtake
		// work that is still running.
		const tail = previous.then(() => turnFinished);
		this.tails.set(userId, tail);
		void tail.then(() => {
			if (this.tails.get(userId) === tail) this.tails.delete(userId);
		});
		try {
			await waitForTurn(previous, options);
			return await work();
		} finally {
			finishTurn();
		}
	}
}

async function waitForTurn(previous: Promise<void>, options: UserTurnOptions): Promise<void> {
	const { signal } = options;
	if (signal?.aborted) throw new Error(CLIENT_CLOSED_REQUEST_ERROR);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	const gaveUp = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(SYNC_HUB_BUSY_ERROR)), options.maxWaitMs);
		if (signal) {
			onAbort = () => reject(new Error(CLIENT_CLOSED_REQUEST_ERROR));
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
	try {
		await Promise.race([previous, gaveUp]);
	} finally {
		clearTimeout(timer);
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
	}
}
