/**
 * In-process advisory WebSocket registry. Frames are hints; HTTP is truth.
 */

export interface RegisteredSocket {
	userId: string;
	deviceId: string;
	send: (data: string) => void;
	close: (code?: number, reason?: string) => void;
}

export class SocketRegistry {
	private readonly byUser = new Map<string, Set<RegisteredSocket>>();

	add(socket: RegisteredSocket): void {
		let set = this.byUser.get(socket.userId);
		if (!set) {
			set = new Set();
			this.byUser.set(socket.userId, set);
		}
		set.add(socket);
	}

	remove(socket: RegisteredSocket): void {
		const set = this.byUser.get(socket.userId);
		if (!set) return;
		set.delete(socket);
		if (set.size === 0) this.byUser.delete(socket.userId);
	}

	forUser(userId: string): RegisteredSocket[] {
		return [...(this.byUser.get(userId) ?? [])];
	}

	connectedDeviceIds(userId: string): Set<string> {
		const ids = new Set<string>();
		for (const socket of this.byUser.get(userId) ?? []) ids.add(socket.deviceId);
		return ids;
	}

	closeUser(userId: string, reason = "sync-hub reset"): void {
		for (const socket of this.forUser(userId)) {
			try { socket.close(1000, reason); } catch { /* already closed */ }
		}
		this.byUser.delete(userId);
	}
}
