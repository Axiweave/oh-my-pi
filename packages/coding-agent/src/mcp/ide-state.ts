import { getProjectDir, logger, onProjectDirChanged } from "@oh-my-pi/pi-utils";
import type { MCPManager } from "./manager";

/** Session lifecycle state shown by IDE integrations such as claude-code-ide.el. */
export type IdeSessionState = "idle" | "working" | "needs-input" | "done" | "failed";

/**
 * Resting state of a session from its transcript: how its last assistant
 * message stopped. `idle` when nothing has run yet or the user aborted.
 * `awaitingReply` turns a clean stop into `needs-input`: the guided-goal
 * interview asks its questions as plain assistant text, so the transcript
 * alone cannot tell a question from a finished answer.
 *
 * A missing transcript reads as `idle` like an empty one. Dialog boundaries
 * publish from inside a settle handler, so a session view without messages
 * must not throw there and abort the dismissal.
 */
export function ideTurnState(
	messages: readonly { role: string; stopReason?: string }[] | undefined,
	awaitingReply = false,
): IdeSessionState {
	const last = messages?.findLast(message => message.role === "assistant");
	if (!last) return "idle";
	if (last.stopReason === "error") return "failed";
	if (last.stopReason === "aborted") return "idle";
	return awaitingReply ? "needs-input" : "done";
}

interface IdeStateEntry {
	/** Newest state the session asked to publish. */
	state: IdeSessionState;
	/** Working directory published with the state; follows `/wt`, `/move`, `!cd`, and cross-project `/resume`. */
	directory: string;
	/** Payload the IDE acknowledged (2xx); `undefined` forces a resend on the next flush. */
	delivered: string | undefined;
	/** At most one notify in flight per manager, so the wire sees states in order. */
	inflight: Promise<void> | undefined;
	/** Bumped on every `ide` (re)connect; a send acked by an older connection never counts as delivered. */
	generation: number;
	subscribers: number;
	unsubscribe: (() => void) | undefined;
	unsubscribeDirectory: (() => void) | undefined;
}

/** Delivery identity of a notification: a directory change resends even when the state is unchanged. */
function payloadKey(entry: IdeStateEntry): string {
	return `${entry.state}\u0000${entry.directory}`;
}

const entries = new WeakMap<MCPManager, IdeStateEntry>();

function entryFor(manager: MCPManager): IdeStateEntry {
	let entry = entries.get(manager);
	if (!entry) {
		entry = {
			state: "idle",
			directory: getProjectDir(),
			delivered: undefined,
			inflight: undefined,
			generation: 0,
			subscribers: 0,
			unsubscribe: undefined,
			unsubscribeDirectory: undefined,
		};
		entries.set(manager, entry);
	}
	return entry;
}

function flush(manager: MCPManager, entry: IdeStateEntry): void {
	const key = payloadKey(entry);
	if (entry.inflight || entry.delivered === key) return;
	const connection = manager.getConnection("ide");
	if (!connection) return;
	const state = entry.state;
	const generation = entry.generation;
	entry.inflight = connection.transport
		.notify("session_state_changed", {
			state,
			directory: entry.directory,
			zmxSession: process.env.ZMX_SESSION,
			bufferName: process.env.EMACS_BUFFER_NAME,
		})
		.then(
			() => {
				// An ack from a connection that was replaced meanwhile says nothing
				// about the replacement, so it must not mark the state delivered.
				if (entry.generation === generation) entry.delivered = key;
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
			if (payloadKey(entry) !== key || entry.generation !== generation) flush(manager, entry);
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
 * Re-announce MANAGER's latest state whenever its `ide` server (re)connects,
 * and publish the working directory whenever the session moves (`/wt`,
 * `/move`, persistent `!cd`, cross-project `/resume`) so the editor can
 * relabel the session without restarting it.
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
		entry.unsubscribeDirectory = onProjectDirChanged(cwd => {
			entry.directory = cwd;
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
			entry.unsubscribeDirectory?.();
			entry.unsubscribeDirectory = undefined;
		}
	};
}
