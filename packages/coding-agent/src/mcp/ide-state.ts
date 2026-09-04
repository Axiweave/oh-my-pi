import { logger } from "@oh-my-pi/pi-utils";
import type { MCPManager } from "./manager";

/** Session lifecycle state shown by IDE integrations such as claude-code-ide.el. */
export type IdeSessionState = "idle" | "working" | "needs-input" | "done" | "failed";

interface IdeStateEntry {
	/** Newest state the session asked to publish. */
	state: IdeSessionState;
	/** State the IDE acknowledged (2xx); `undefined` forces a resend on the next flush. */
	delivered: IdeSessionState | undefined;
	/** At most one notify in flight per manager, so the wire sees states in order. */
	inflight: Promise<void> | undefined;
	/** Bumped on every `ide` (re)connect; a send acked by an older connection never counts as delivered. */
	generation: number;
	subscribers: number;
	unsubscribe: (() => void) | undefined;
}

const entries = new WeakMap<MCPManager, IdeStateEntry>();

function entryFor(manager: MCPManager): IdeStateEntry {
	let entry = entries.get(manager);
	if (!entry) {
		entry = {
			state: "idle",
			delivered: undefined,
			inflight: undefined,
			generation: 0,
			subscribers: 0,
			unsubscribe: undefined,
		};
		entries.set(manager, entry);
	}
	return entry;
}

function flush(manager: MCPManager, entry: IdeStateEntry): void {
	if (entry.inflight || entry.delivered === entry.state) return;
	const connection = manager.getConnection("ide");
	if (!connection) return;
	const state = entry.state;
	const generation = entry.generation;
	entry.inflight = connection.transport
		.notify("session_state_changed", {
			state,
			zmxSession: process.env.ZMX_SESSION,
			bufferName: process.env.EMACS_BUFFER_NAME,
		})
		.then(
			() => {
				// An ack from a connection that was replaced meanwhile says nothing
				// about the replacement, so it must not mark the state delivered.
				if (entry.generation === generation) entry.delivered = state;
			},
			(error: unknown) => {
				// Leave `delivered` untouched: the next publish (even of this same
				// state) or the next reconnect resends it. No retry here, so a dead
				// endpoint costs one bounded POST per state change, never a loop.
				logger.debug("IDE session_state_changed failed", { state, error: String(error) });
			},
		)
		.finally(() => {
			entry.inflight = undefined;
			if (entry.state !== state || entry.generation !== generation) flush(manager, entry);
		});
}

/** Publish STATE to MANAGER's `ide` server. Coalesces to the newest state while a send is in flight. */
export function publishIdeSessionState(manager: MCPManager | undefined, state: IdeSessionState): void {
	if (!manager) return;
	const entry = entryFor(manager);
	entry.state = state;
	flush(manager, entry);
}

/**
 * Re-announce MANAGER's latest state whenever its `ide` server (re)connects.
 * Reference-counted: sessions sharing one manager install one listener.
 */
export function subscribeIdeState(manager: MCPManager): () => void {
	const entry = entryFor(manager);
	entry.subscribers += 1;
	if (entry.subscribers === 1) {
		entry.unsubscribe = manager.addConnectionStatusListener(event => {
			if (event.type !== "connected" || event.serverName !== "ide") return;
			entry.delivered = undefined;
			entry.generation += 1;
			flush(manager, entry);
		});
		flush(manager, entry);
	}
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		entry.subscribers -= 1;
		if (entry.subscribers === 0) {
			entry.unsubscribe?.();
			entry.unsubscribe = undefined;
		}
	};
}
