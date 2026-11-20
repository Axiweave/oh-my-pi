/**
 * The session inbox of one top-level interactive session.
 *
 * Serves the published endpoint (snapshot, send, interrupt, reply) and is the
 * sending side for the `session_inbox` tool. A request enters the target as
 * user input from the sender (`collab-prompt`, agent-attributed so it never
 * closes the target user's dialog); when the turn that carried it yields, the
 * target sends its last visible answer back once. A notification is routed as
 * an external advisor note and gets no reply.
 */
import type { IpcConnection } from "@oh-my-pi/pi-natives";
import type { AdvisorSeverity } from "@oh-my-pi/pi-tui/chat/messages";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { COLLAB_PROMPT_MESSAGE_TYPE, type CollabPromptDetails } from "../collab/protocol";
import { tokenMatches } from "../ipc/private-registry";
import { RpcPromptResults } from "../modes/rpc/rpc-prompt-results";
import type { RpcPromptResultFrame } from "../modes/rpc/rpc-types";
import type { AgentSession } from "../session/agent-session";
import type { InboxReply } from "../session/inbox-reply";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import {
	boundSnapshot,
	callInbox,
	INBOX_VERSION,
	type InboxEntry,
	type InboxPublication,
	type InboxSnapshot,
	inboxAddress,
	listInboxEntries,
	MAX_REPLY_TEXT_BYTES,
	MAX_TEXT_BYTES,
	publishInboxEntry,
	type ReachableSession,
	readInboxEntry,
	SEND_TIMEOUT_MS,
} from "./registry";

export type InboxKind = "request" | "notification";
export type InboxDelivery = "steer" | "after_turn";

/** Who sent a message; `entryId` is where the reply goes. */
export interface InboxIdentity {
	address: string;
	name: string;
	entryId: string;
}

export interface InboxMessage {
	id: string;
	from: InboxIdentity;
	kind: InboxKind;
	text: string;
	delivery?: InboxDelivery;
	level?: AdvisorSeverity;
}

/** The target's answer to `send`. */
export type DeliveryResult =
	| { status: "delivered" | "queued"; conversationId: string; shown?: true }
	| { status: "not_delivered"; reason: string };

/** What the sender learns from one `send` call. */
export type SendOutcome =
	| DeliveryResult
	/** The endpoint is gone: the session ended between list and send. */
	| { status: "gone" }
	/** No answer before {@link SEND_TIMEOUT_MS}; the message may still arrive. */
	| { status: "no_answer" };

export type InterruptOutcome = "interrupted" | "idle" | "gone" | "no_answer" | { error: string };

export type LookupResult =
	| { status: "found"; session: ReachableSession }
	| { status: "ambiguous"; sessions: ReachableSession[] }
	| { status: "none" };

const SEVERITIES: readonly AdvisorSeverity[] = ["nit", "concern", "blocker"];
const MAX_ID_CHARS = 128;

export function utf8Bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** Cut `text` to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return { text, truncated: false };
	let end = maxBytes;
	// Back off continuation bytes (10xxxxxx) so the cut lands on a character start.
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

function parseIdentity(raw: unknown): InboxIdentity | null {
	if (!isRecord(raw)) return null;
	const { address, name, entryId } = raw;
	if (typeof address !== "string" || typeof name !== "string" || typeof entryId !== "string") return null;
	return { address, name, entryId };
}

/** Validate a `send` message; the error string is the wire error code. */
export function parseInboxMessage(raw: unknown): InboxMessage | "invalid" | "too_large" {
	if (!isRecord(raw)) return "invalid";
	const { id, kind, text, delivery, level } = raw;
	const from = parseIdentity(raw.from);
	if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_CHARS || !from) return "invalid";
	if (kind !== "request" && kind !== "notification") return "invalid";
	if (typeof text !== "string" || text.length === 0) return "invalid";
	if (kind === "request" && level !== undefined) return "invalid";
	if (kind === "notification" && delivery !== undefined) return "invalid";
	if (delivery !== undefined && delivery !== "steer" && delivery !== "after_turn") return "invalid";
	if (level !== undefined && !SEVERITIES.includes(level as AdvisorSeverity)) return "invalid";
	if (utf8Bytes(text) > MAX_TEXT_BYTES) return "too_large";
	return { id, from, kind, text, delivery, level: level as AdvisorSeverity | undefined };
}

function parseReply(raw: unknown): InboxReply | null {
	if (!isRecord(raw)) return null;
	const { id, outcome, error, text, truncated } = raw;
	const from = isRecord(raw.from) ? raw.from : undefined;
	if (typeof id !== "string" || typeof text !== "string") return null;
	if (outcome !== "completed" && outcome !== "aborted" && outcome !== "error") return null;
	if (!from || typeof from.address !== "string" || typeof from.name !== "string") return null;
	if (error !== undefined && typeof error !== "string") return null;
	const reply: InboxReply = { id, from: { address: from.address, name: from.name }, outcome, text };
	if (error !== undefined) reply.error = error;
	if (truncated === true) reply.truncated = true;
	return reply;
}

function parseDeliveryResult(raw: unknown): DeliveryResult | null {
	if (!isRecord(raw)) return null;
	if (raw.status === "not_delivered") {
		return { status: "not_delivered", reason: typeof raw.reason === "string" ? raw.reason : "unknown" };
	}
	if ((raw.status !== "delivered" && raw.status !== "queued") || typeof raw.conversationId !== "string") return null;
	return raw.shown === true
		? { status: raw.status, conversationId: raw.conversationId, shown: true }
		: { status: raw.status, conversationId: raw.conversationId };
}

export interface InboxHostOptions {
	/** Registry directory override (tests). */
	dir?: string;
	env?: NodeJS.ProcessEnv;
}

export class InboxHost {
	readonly #session: AgentSession;
	readonly #dir: string | undefined;
	readonly #address: string;
	readonly #parent: string | null;
	#publication: InboxPublication | undefined;
	#starting: Promise<void> | undefined;
	readonly #connections = new Set<IpcConnection>();
	#unsubscribe: (() => void)[] = [];
	/** Requests this session sent that still owe a reply: message id → conversation it was sent from. */
	readonly #pending = new Map<string, string>();
	/** Requests this session received: message id → where the reply goes. */
	readonly #replyTo = new Map<string, InboxIdentity>();
	readonly #results: RpcPromptResults;

	constructor(session: AgentSession, options?: InboxHostOptions) {
		this.#session = session;
		this.#dir = options?.dir;
		const env = options?.env ?? process.env;
		this.#address = inboxAddress(env);
		this.#parent = env.OMP_SPAWN_PARENT || null;
		this.#results = new RpcPromptResults(session, (frame, text) => this.#sendReply(frame, text), undefined, {
			costCapRefusal: () => session.costCapRefusal,
		});
	}

	get address(): string {
		return this.#address;
	}

	get parent(): string | null {
		return this.#parent;
	}

	get entry(): InboxEntry | undefined {
		return this.#publication?.entry;
	}

	get started(): boolean {
		return this.#publication !== undefined;
	}

	get #name(): string {
		return this.#session.sessionName || this.#address;
	}

	/** Publish the endpoint. Safe to call again while running. */
	start(): Promise<void> {
		this.#starting ??= this.#start().finally(() => {
			this.#starting = undefined;
		});
		return this.#starting;
	}

	async #start(): Promise<void> {
		if (this.#publication) return;
		const publication = await publishInboxEntry({
			dir: this.#dir,
			address: this.#address,
			parent: this.#parent,
			onConnection: (connection, token, onClose) => this.#accept(connection, token, onClose),
		});
		this.#publication = publication;
		this.#unsubscribe.push(
			this.#session.subscribe(event => this.#results.observe(event)),
			// A new or resumed conversation: replies owed to it are gone, and requests it
			// received end aborted (their run was detached).
			this.#session.registerSessionChangeCallback(() => {
				this.#pending.clear();
				this.#results.abortOpen();
			}),
		);
	}

	/** Withdraw the endpoint. Open requests stay unanswered; their senders keep no state that leaks. */
	async stop(): Promise<void> {
		await this.#starting?.catch(() => {});
		const publication = this.#publication;
		this.#publication = undefined;
		for (const unsubscribe of this.#unsubscribe) unsubscribe();
		this.#unsubscribe = [];
		for (const connection of this.#connections) connection.destroy();
		this.#connections.clear();
		this.#pending.clear();
		this.#replyTo.clear();
		await publication?.close();
	}

	// ── sender side ─────────────────────────────────────────────────────────

	/** Every other reachable session, newest first. */
	async list(): Promise<ReachableSession[]> {
		const own = this.#publication?.entry.entryId;
		return (await listInboxEntries({ dir: this.#dir })).filter(session => session.entry.entryId !== own);
	}

	async lookup(address: string): Promise<LookupResult> {
		const matches = (await this.list()).filter(session => session.entry.address === address);
		if (matches.length === 0) return { status: "none" };
		if (matches.length > 1) return { status: "ambiguous", sessions: matches };
		return { status: "found", session: matches[0] };
	}

	#identity(): InboxIdentity {
		const entry = this.#publication?.entry;
		if (!entry) throw new Error("session inbox is not running");
		return { address: this.#address, name: this.#name, entryId: entry.entryId };
	}

	async send(
		target: InboxEntry,
		message: { kind: InboxKind; text: string; delivery?: InboxDelivery; level?: AdvisorSeverity },
	): Promise<SendOutcome> {
		const id = crypto.randomUUID();
		const conversationId = this.#session.sessionManager.getSessionId();
		// Registered before the send: a fast target can reply before this call returns.
		if (message.kind === "request") this.#pending.set(id, conversationId);
		const outcome = await this.#call(target, { op: "send", message: { id, from: this.#identity(), ...message } });
		let result: SendOutcome;
		if (outcome.status === "ok") {
			result = parseDeliveryResult(outcome.value.result) ?? { status: "not_delivered", reason: "malformed answer" };
		} else {
			result = outcome;
		}
		// Only a delivered or queued request can still be answered; a missing answer may yet arrive.
		if (result.status === "not_delivered" || result.status === "gone") this.#pending.delete(id);
		return result;
	}

	async interrupt(target: InboxEntry): Promise<InterruptOutcome> {
		const outcome = await this.#call(target, { op: "interrupt", from: this.#identity() });
		if (outcome.status !== "ok")
			return outcome.status === "not_delivered" ? { error: outcome.reason } : outcome.status;
		return outcome.value.result === "idle" ? "idle" : "interrupted";
	}

	async #call(
		target: InboxEntry,
		request: Record<string, unknown>,
	): Promise<
		| { status: "ok"; value: Record<string, unknown> }
		| { status: "not_delivered"; reason: string }
		| { status: "gone" }
		| { status: "no_answer" }
	> {
		const result = await callInbox(target, request, SEND_TIMEOUT_MS);
		if (result.status === "ok") return result;
		if (result.status === "dead") return { status: "gone" };
		if (result.error === "timeout") return { status: "no_answer" };
		return { status: "not_delivered", reason: result.error ?? "no valid answer" };
	}

	// ── target side ─────────────────────────────────────────────────────────

	#accept(connection: IpcConnection, token: string, onClose: () => void): void {
		this.#connections.add(connection);
		let handled = false;
		const respond = (payload: Record<string, unknown>): void => {
			if (!this.#connections.has(connection)) return;
			connection.send(JSON.stringify({ v: INBOX_VERSION, ...payload }));
			connection.end();
		};
		const fail = (error: string): void => respond({ ok: false, error });
		connection.start(
			line => {
				if (handled) return;
				handled = true;
				let request: unknown;
				try {
					request = JSON.parse(line.trim());
				} catch {
					fail("malformed_request");
					return;
				}
				if (!isRecord(request)) return fail("malformed_request");
				if (request.v !== INBOX_VERSION) return fail("unsupported_protocol");
				if (!tokenMatches(token, request.token)) return fail("authentication_failed");
				this.#handle(request).then(
					payload => respond(payload),
					(error: unknown) => {
						logger.debug("session inbox request failed", { error: String(error) });
						fail("error");
					},
				);
			},
			() => {
				this.#connections.delete(connection);
				onClose();
			},
		);
	}

	async #handle(request: Record<string, unknown>): Promise<Record<string, unknown>> {
		switch (request.op) {
			case "snapshot":
				return { ok: true, snapshot: boundSnapshot(await this.#snapshot()) };
			case "send": {
				const message = parseInboxMessage(request.message);
				if (typeof message === "string") return { ok: false, error: message };
				const result =
					message.kind === "request" ? await this.#deliverRequest(message) : await this.#deliverNote(message);
				return { ok: true, result };
			}
			case "interrupt": {
				const from = parseIdentity(request.from);
				if (!from) return { ok: false, error: "invalid" };
				return { ok: true, result: this.#interrupt(from) };
			}
			case "reply": {
				const reply = parseReply(request.reply);
				if (!reply) return { ok: false, error: "invalid" };
				return this.#acceptReply(reply) ? { ok: true, result: "accepted" } : { ok: false, error: "unknown_id" };
			}
			default:
				return { ok: false, error: "invalid_operation" };
		}
	}

	async #snapshot(): Promise<InboxSnapshot> {
		const entry = this.#publication?.entry;
		const cwd = this.#session.sessionManager.getCwd();
		const branch = await Promise.resolve(vcs.git(cwd)?.currentBranch())
			.then(value => value ?? null)
			.catch(() => null);
		return {
			address: this.#address,
			name: this.#name,
			parent: this.#parent,
			pid: process.pid,
			createdAt: entry?.createdAt ?? 0,
			cwd,
			branch,
			busy: this.#session.isStreaming,
			conversationId: this.#session.sessionManager.getSessionId(),
		};
	}

	async #waitForTransition(): Promise<void> {
		while (this.#session.isSessionTransitioning) await this.#session.waitForSessionTransition();
	}

	/**
	 * Hand the request to the agent and answer as soon as it is queued or
	 * admitted; the reply ticket follows the run that carries it.
	 */
	async #deliverRequest(message: InboxMessage): Promise<DeliveryResult> {
		await this.#waitForTransition();
		const session = this.#session;
		// Admission fires before the session's own cost check, so a capped target would answer `delivered`.
		if (session.costGate.check()) return { status: "not_delivered", reason: "cost_cap" };
		const conversationId = session.sessionManager.getSessionId();
		const ticket = this.#results.begin(message.id);
		this.#replyTo.set(message.id, message.from);
		const answer = Promise.withResolvers<DeliveryResult>();
		let answered = false;
		const respond = (result: DeliveryResult): void => {
			if (answered) return;
			answered = true;
			answer.resolve(result);
		};
		const refusalBefore = session.costCapRefusal;
		const drop = (reason: string): void => {
			this.#results.discard(ticket);
			this.#replyTo.delete(message.id);
			respond({ status: "not_delivered", reason });
		};
		const details: CollabPromptDetails = { from: message.from.name };
		session
			.promptCustomMessage(
				{
					customType: COLLAB_PROMPT_MESSAGE_TYPE,
					content: `[from ${message.from.name} (${message.from.address})] ${message.text}`,
					display: true,
					details,
					// Agent attribution: a user-attributed steer would close the target user's open ask
					// or approval dialog and cut a running tool batch.
					attribution: "agent",
				},
				{
					streamingBehavior: message.delivery === "after_turn" ? "followUp" : "steer",
					queueChipText: message.text,
					onPromptQueued: () => respond({ status: "queued", conversationId }),
					onPromptAdmitted: () => respond({ status: "delivered", conversationId }),
				},
			)
			.then(
				() => {
					if (!answered) {
						drop(session.costCapRefusal !== refusalBefore ? "cost_cap" : "aborted");
						return;
					}
					// Dispatched or refused after admission: the ticket reports the run, or cost_cap/aborted.
					this.#results.settle(ticket);
				},
				(error: unknown) => {
					const reason = `error: ${error instanceof Error ? error.message : String(error)}`;
					if (!answered) drop(reason);
					else this.#results.fail(ticket, reason);
				},
			);
		return answer.promise;
	}

	async #deliverNote(message: InboxMessage): Promise<DeliveryResult> {
		await this.#waitForTransition();
		const conversationId = this.#session.sessionManager.getSessionId();
		const channel = this.#session.routeInboxNote(
			`${message.from.name} (${message.from.address})`,
			message.text,
			message.level ?? "nit",
		);
		if (channel === "aside") return { status: "queued", conversationId };
		if (channel === "preserve") return { status: "delivered", conversationId, shown: true };
		return { status: "delivered", conversationId };
	}

	#interrupt(from: InboxIdentity): "interrupted" | "idle" {
		const session = this.#session;
		if (!session.isStreaming && session.queuedMessageCount === 0) return "idle";
		void session
			.abort({ reason: USER_INTERRUPT_LABEL })
			.then(() => session.emitNotice("info", `${from.name} interrupted`, "inbox"))
			.catch(error => logger.debug("session inbox interrupt failed", { error: String(error) }));
		return "interrupted";
	}

	#acceptReply(reply: InboxReply): boolean {
		const conversationId = this.#pending.get(reply.id);
		if (conversationId !== this.#session.sessionManager.getSessionId()) return false;
		this.#pending.delete(reply.id);
		this.#session
			.queueInboxReply(reply)
			.catch(error => logger.debug("session inbox reply dropped", { error: String(error) }));
		return true;
	}

	/** The turn that carried a received request yielded: answer its sender once. */
	#sendReply(frame: RpcPromptResultFrame, text: string | undefined): void {
		const id = frame.id;
		const sender = id === undefined ? undefined : this.#replyTo.get(id);
		if (id === undefined || !sender) return;
		this.#replyTo.delete(id);
		const cut = truncateUtf8(text ?? "", MAX_REPLY_TEXT_BYTES);
		const reply: InboxReply = {
			id,
			from: { address: this.#address, name: this.#name },
			outcome: frame.status,
			text: cut.text,
		};
		if (frame.error) reply.error = frame.error.message;
		if (cut.truncated) reply.truncated = true;
		void (async () => {
			const entry = await readInboxEntry(sender.entryId, this.#dir);
			if (!entry) {
				logger.debug("session inbox reply dropped: sender gone", { to: sender.address });
				return;
			}
			const result = await callInbox(entry, { op: "reply", reply }, SEND_TIMEOUT_MS);
			if (result.status !== "ok") {
				logger.debug("session inbox reply dropped", { to: sender.address, status: result.status });
			}
		})();
	}
}
