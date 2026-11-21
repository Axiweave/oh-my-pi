/**
 * The session inbox of one top-level interactive session.
 *
 * Serves the published endpoint (snapshot, send, interrupt) and is the sending
 * side for the `session_inbox` tool. Messages travel in threads. A message from
 * the opener enters the receiver as user input from the sender (`collab-prompt`,
 * agent-attributed so it never closes the receiver user's dialog); when the turn
 * that carried it yields without an explicit reply, the receiver sends its last
 * visible answer back once. A message to the opener arrives as an `inbox-reply`
 * notice. A notification is routed as an external advisor note and gets no reply.
 */
import * as crypto from "node:crypto";
import type { IpcConnection } from "@oh-my-pi/pi-natives";
import type { AdvisorSeverity } from "@oh-my-pi/pi-tui/chat/messages";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { COLLAB_PROMPT_MESSAGE_TYPE, type CollabPromptDetails } from "../collab/protocol";
import { tokenMatches } from "../ipc/private-registry";
import { RpcPromptResults } from "../modes/rpc/rpc-prompt-results";
import type { RpcPromptResultFrame } from "../modes/rpc/rpc-types";
import type { AgentSession } from "../session/agent-session";
import { escapeHarnessTags } from "../session/harness-tags";
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

export type InboxKind = "thread" | "notification";
export type InboxDelivery = "steer" | "after_turn";
export type ThreadMessageType = "message" | "progress" | "auto" | "failure";

/** Who sent a message; `entryId` is where the reply goes. */
export interface InboxIdentity {
	address: string;
	name: string;
	entryId: string;
}

/** One message in a thread; `auto` and `failure` come only from the system. */
export interface ThreadMessage {
	id: string;
	from: InboxIdentity;
	kind: "thread";
	thread: string;
	type: ThreadMessageType;
	/** Only on the first message of a thread, with `type: "message"`. */
	first?: true;
	text: string;
	/** Used only when the message takes the request path. */
	delivery?: InboxDelivery;
	/** Only on `failure`. */
	outcome?: "aborted" | "error";
	error?: string;
	/** Only on `auto`. */
	truncated?: true;
}

export interface InboxNotification {
	id: string;
	from: InboxIdentity;
	kind: "notification";
	text: string;
	level?: AdvisorSeverity;
}

export type InboxMessage = ThreadMessage | InboxNotification;

/** The target's answer to `send`. */
export type DeliveryResult =
	| { status: "delivered" | "queued"; conversationId: string; shown?: true; thread?: string }
	| { status: "not_delivered"; reason: string };

/** What the sender learns from one `send` call. */
export type SendOutcome =
	| DeliveryResult
	/** The endpoint is gone: the session ended between list and send. */
	| { status: "gone" }
	/** No answer before {@link SEND_TIMEOUT_MS}; the message may still arrive. */
	| { status: "no_answer" };

/** What `reply` returns; `to` is the peer address. */
export type ReplyOutcome = { status: "unknown_thread" } | (SendOutcome & { to: string });

export type InterruptOutcome = "interrupted" | "idle" | "gone" | "no_answer" | { error: string };

export type LookupResult =
	| { status: "found"; session: ReachableSession }
	| { status: "ambiguous"; sessions: ReachableSession[] }
	| { status: "none" };

const SEVERITIES: readonly AdvisorSeverity[] = ["nit", "concern", "blocker"];
const MAX_ID_CHARS = 128;
const THREAD_TYPES: readonly ThreadMessageType[] = ["message", "progress", "auto", "failure"];

export const THREAD_ID_RE = /^t-[0-9a-f]{8}$/;

/** A thread id: `t-` plus 8 lowercase hex characters, created by the opener. */
export function newThreadId(): string {
	return `t-${crypto.randomBytes(4).toString("hex")}`;
}

/** The request-path content of a message from the opener: thread prefix, text, and (except progress) the footer, escaped once. */
export function formatThreadPrompt(message: ThreadMessage): string {
	const word = message.type === "progress" ? "progress" : message.first ? "new" : "reply";
	const line = `[thread ${message.thread} ${word} from ${message.from.name} (${message.from.address})] ${message.text}`;
	if (message.type === "progress") return escapeHarnessTags(line);
	return escapeHarnessTags(
		`${line}\nAnswer with session_inbox reply, thread "${message.thread}", without progress. Use progress: true only for "on it". A progress note does not stop your last answer from going back.`,
	);
}

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
	if (typeof text !== "string") return "invalid";
	if (kind === "notification") {
		if (text.length === 0 || delivery !== undefined) return "invalid";
		if (level !== undefined && !SEVERITIES.includes(level as AdvisorSeverity)) return "invalid";
		if (utf8Bytes(text) > MAX_TEXT_BYTES) return "too_large";
		return { id, from, kind, text, level: level as AdvisorSeverity | undefined };
	}
	if (kind !== "thread") return "invalid";
	const { thread, type, first, outcome, error, truncated } = raw;
	if (typeof thread !== "string" || !THREAD_ID_RE.test(thread)) return "invalid";
	if (!THREAD_TYPES.includes(type as ThreadMessageType)) return "invalid";
	if (first !== undefined && (first !== true || type !== "message")) return "invalid";
	if (type === "failure") {
		if (outcome !== "aborted" && outcome !== "error") return "invalid";
		if (error !== undefined && typeof error !== "string") return "invalid";
	} else if (outcome !== undefined || error !== undefined || text.length === 0) return "invalid";
	if (truncated !== undefined && (truncated !== true || type !== "auto")) return "invalid";
	if (level !== undefined) return "invalid";
	if (delivery !== undefined && delivery !== "steer" && delivery !== "after_turn") return "invalid";
	if (utf8Bytes(text) > MAX_TEXT_BYTES) return "too_large";
	const message: ThreadMessage = { id, from, kind, thread, type: type as ThreadMessageType, text };
	if (first) message.first = true;
	if (delivery !== undefined) message.delivery = delivery;
	if (outcome !== undefined) message.outcome = outcome;
	if (error !== undefined) message.error = error as string;
	if (truncated) message.truncated = true;
	return message;
}

function parseDeliveryResult(raw: unknown): DeliveryResult | null {
	if (!isRecord(raw)) return null;
	if (raw.status === "not_delivered") {
		return { status: "not_delivered", reason: typeof raw.reason === "string" ? raw.reason : "unknown" };
	}
	if ((raw.status !== "delivered" && raw.status !== "queued") || typeof raw.conversationId !== "string") return null;
	const result: DeliveryResult = { status: raw.status, conversationId: raw.conversationId };
	if (raw.shown === true) result.shown = true;
	if (typeof raw.thread === "string") result.thread = raw.thread;
	return result;
}

/** One thread as this session sees it (data-model "Thread"). */
interface Thread {
	id: string;
	/** The other session; messages go to `peer.entryId`, never to the address. */
	peer: InboxIdentity;
	/** This session sent the first message. */
	opened: boolean;
	/** Open answer tickets for messages from the opener; above 0, this session owes the opener an answer. */
	openTickets: number;
	/** Turn keys in which this session sent a reply without progress while it owed an answer. */
	repliedTurns: Set<number>;
	/** The last turn key that got a decision; -1 before any. */
	decidedTurn: number;
}

/** The thread fields a sender sets; the rest come from the thread and this session. */
type ThreadBody = Pick<ThreadMessage, "type" | "text" | "delivery" | "outcome" | "error" | "truncated">;

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
	readonly #threads = new Map<string, Thread>();
	/** Open answer tickets: message id → its thread and turn key (research R4). */
	readonly #tickets = new Map<string, { thread: Thread; turn: number }>();
	/** Finished turns: a yielded end that leaves the queue empty, a ticket settled without a run, a conversation change. */
	#turn = 0;
	readonly #results: RpcPromptResults;

	constructor(session: AgentSession, options?: InboxHostOptions) {
		this.#session = session;
		this.#dir = options?.dir;
		const env = options?.env ?? process.env;
		this.#address = inboxAddress(env);
		this.#parent = env.OMP_SPAWN_PARENT || null;
		this.#results = new RpcPromptResults(session, (frame, text) => this.#ticketReported(frame, text), undefined, {
			costCapRefusal: () => session.costCapRefusal,
			settledWithoutRun: () => {
				this.#turn++;
			},
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
		const session = this.#session;
		this.#unsubscribe.push(
			session.subscribe(event => {
				this.#results.observe(event);
				// The same yield test `observe` uses: a run and its tail run stay one turn. Counted
				// here because `observe` returns early when no ticket is open.
				if (
					event.type === "agent_end" &&
					(event.yielded ?? event.isTerminal !== false) &&
					session.queuedMessageCount === 0
				)
					this.#turn++;
			}),
			// A new or resumed conversation: threads stay open, and the cut turn is over.
			// Its tickets report aborted, so each owed opener gets one failure.
			session.registerSessionChangeCallback(() => {
				this.#results.abortOpen();
				this.#turn++;
			}),
		);
	}

	/** Withdraw the endpoint and forget every thread. An opener still owed an answer gets none. */
	async stop(): Promise<void> {
		await this.#starting?.catch(() => {});
		const publication = this.#publication;
		this.#publication = undefined;
		for (const unsubscribe of this.#unsubscribe) unsubscribe();
		this.#unsubscribe = [];
		for (const connection of this.#connections) connection.destroy();
		this.#connections.clear();
		this.#threads.clear();
		this.#tickets.clear();
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
		message:
			| { kind: "message"; text: string; delivery?: InboxDelivery }
			| { kind: "notification"; text: string; level?: AdvisorSeverity },
	): Promise<SendOutcome> {
		const from = this.#identity();
		const id = crypto.randomUUID();
		if (message.kind === "notification") return this.#sendMessage(target, { id, from, ...message });
		const thread = newThreadId();
		// Registered before the send: a fast peer can reply before this call returns.
		this.#threads.set(thread, {
			id: thread,
			peer: { address: target.address, name: target.address, entryId: target.entryId },
			opened: true,
			openTickets: 0,
			repliedTurns: new Set(),
			decidedTurn: -1,
		});
		const first: ThreadMessage = {
			id,
			from,
			kind: "thread",
			thread,
			type: "message",
			first: true,
			text: message.text,
		};
		if (message.delivery) first.delivery = message.delivery;
		const result = await this.#sendMessage(target, first);
		// A missing answer may yet arrive, so only a refused or gone send drops the thread.
		if (result.status === "not_delivered" || result.status === "gone") this.#threads.delete(thread);
		if (result.status === "delivered" || result.status === "queued") return { ...result, thread };
		return result;
	}

	/** Send in a thread this session has. An unknown id sends nothing. */
	async reply(
		threadId: string,
		message: { text: string; progress?: boolean; delivery?: InboxDelivery },
	): Promise<ReplyOutcome> {
		const thread = this.#threads.get(threadId);
		if (!thread) return { status: "unknown_thread" };
		// Read before the send: the reply belongs to the turn that made it, even if a `/new` ends that turn meanwhile.
		const turn = this.#turn;
		const owed = thread.openTickets > 0;
		const body: ThreadBody = { type: message.progress ? "progress" : "message", text: message.text };
		if (message.delivery) body.delivery = message.delivery;
		const result = await this.#sendInThread(thread, body);
		// Only a delivered reply without progress stops this turn's automatic answer.
		if (!message.progress && owed && (result.status === "delivered" || result.status === "queued"))
			thread.repliedTurns.add(turn);
		return { ...result, to: thread.peer.address };
	}

	async #sendInThread(thread: Thread, body: ThreadBody): Promise<SendOutcome> {
		const entry = await readInboxEntry(thread.peer.entryId, this.#dir);
		if (!entry) return { status: "gone" };
		return this.#sendMessage(entry, {
			id: crypto.randomUUID(),
			from: this.#identity(),
			kind: "thread",
			thread: thread.id,
			...body,
		});
	}

	async #sendMessage(target: InboxEntry, message: InboxMessage): Promise<SendOutcome> {
		const outcome = await this.#call(target, { op: "send", message });
		if (outcome.status !== "ok") return outcome;
		return parseDeliveryResult(outcome.value.result) ?? { status: "not_delivered", reason: "malformed answer" };
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
				if (message.kind === "notification") return { ok: true, result: await this.#deliverNote(message) };
				return this.#deliverThread(message);
			}
			case "interrupt": {
				const from = parseIdentity(request.from);
				if (!from) return { ok: false, error: "invalid" };
				return { ok: true, result: this.#interrupt(from) };
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

	/** Check a thread message against this session's threads, then deliver it by the path the thread gives (R3). */
	async #deliverThread(message: ThreadMessage): Promise<Record<string, unknown>> {
		await this.#waitForTransition();
		const notDelivered = (reason: string) => ({ ok: true, result: { status: "not_delivered", reason } });
		let thread = this.#threads.get(message.thread);
		const created = !thread;
		if (!thread) {
			if (!message.first || message.type !== "message") return notDelivered("unknown_thread");
			thread = {
				id: message.thread,
				peer: message.from,
				opened: false,
				openTickets: 0,
				repliedTurns: new Set(),
				decidedTurn: -1,
			};
			this.#threads.set(thread.id, thread);
		} else if (message.first) {
			return notDelivered("thread_conflict");
		} else if (thread.peer.entryId !== message.from.entryId) {
			return notDelivered("unknown_thread");
		}
		// `auto` and `failure` answer the opener; they never enter a thread this session did not open.
		if ((message.type === "auto" || message.type === "failure") && !thread.opened)
			return { ok: false, error: "invalid" };
		thread.peer.name = message.from.name;
		const session = this.#session;
		if (thread.opened) {
			// Reply path: a message to the opener. It opens no ticket, so nothing goes back by itself.
			session
				.queueInboxReply({
					thread: thread.id,
					from: { address: message.from.address, name: message.from.name },
					type: message.type,
					text: message.text,
					outcome: message.outcome,
					error: message.error,
					truncated: message.truncated,
				})
				.catch(error => logger.debug("session inbox reply dropped", { error: String(error) }));
			return {
				ok: true,
				result: { status: "delivered", conversationId: session.sessionManager.getSessionId(), thread: thread.id },
			};
		}
		const result = await this.#deliverRequest(message, thread);
		if (result.status === "not_delivered") {
			if (created) this.#threads.delete(thread.id);
			return { ok: true, result };
		}
		return { ok: true, result: { ...result, thread: thread.id } };
	}

	/**
	 * Request path: hand a message from the opener to the agent and answer as
	 * soon as it is queued or admitted. A `message` opens an answer ticket that
	 * follows the run that carries it; a progress note opens none (R5).
	 */
	async #deliverRequest(message: ThreadMessage, thread: Thread): Promise<DeliveryResult> {
		const session = this.#session;
		// Admission fires before the session's own cost check, so a capped target would answer `delivered`.
		if (session.costGate.check()) return { status: "not_delivered", reason: "cost_cap" };
		const conversationId = session.sessionManager.getSessionId();
		const ticket = message.type === "message" ? this.#results.begin(message.id) : undefined;
		if (ticket) {
			this.#tickets.set(message.id, { thread, turn: this.#turn });
			thread.openTickets++;
		}
		const answer = Promise.withResolvers<DeliveryResult>();
		let answered = false;
		const respond = (result: DeliveryResult): void => {
			if (answered) return;
			answered = true;
			answer.resolve(result);
		};
		const refusalBefore = session.costCapRefusal;
		const drop = (reason: string): void => {
			if (ticket) {
				this.#results.discard(ticket);
				this.#tickets.delete(message.id);
				thread.openTickets--;
			}
			respond({ status: "not_delivered", reason });
		};
		const content = formatThreadPrompt(message);
		const details: CollabPromptDetails = { from: message.from.name };
		session
			.promptCustomMessage(
				{
					customType: COLLAB_PROMPT_MESSAGE_TYPE,
					content,
					display: true,
					details,
					// Agent attribution: a user-attributed steer would close the target user's open ask
					// or approval dialog and cut a running tool batch.
					attribution: "agent",
				},
				{
					streamingBehavior: message.delivery === "after_turn" ? "followUp" : "steer",
					queueChipText: escapeHarnessTags(message.text),
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
					if (ticket) this.#results.settle(ticket);
				},
				(error: unknown) => {
					const reason = `error: ${error instanceof Error ? error.message : String(error)}`;
					if (!answered) drop(reason);
					else if (ticket) this.#results.fail(ticket, reason);
				},
			);
		return answer.promise;
	}

	async #deliverNote(message: InboxNotification): Promise<DeliveryResult> {
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

	/** An answer ticket reported: decide once for its thread and turn (research R4). */
	#ticketReported(frame: RpcPromptResultFrame, text: string | undefined): void {
		const ticket = frame.id === undefined ? undefined : this.#tickets.get(frame.id);
		if (frame.id === undefined || !ticket) return;
		this.#tickets.delete(frame.id);
		const { thread, turn } = ticket;
		thread.openTickets--;
		// ponytail: one decision per turn key, kept as the maximum decided key. Known limits (R4): an older
		// turn's frame that reports after a newer turn's decision is dropped; a ticket that `abortOpen` keeps
		// for the new conversation may share a decided key; with a tail, an own-run ticket that reports first
		// sends run 0's text. Keep a set of decided keys if either of the first two occurs, and hold a turn's
		// decision until its last ticket reports if the third matters.
		if (turn <= thread.decidedTurn) return;
		thread.decidedTurn = turn;
		let body: ThreadBody | undefined;
		if (frame.status !== "completed") {
			body = { type: "failure", outcome: frame.status, text: "" };
			if (frame.error) body.error = frame.error.message;
		} else if (!thread.repliedTurns.has(turn)) {
			const cut = truncateUtf8(text || "(empty answer)", MAX_REPLY_TEXT_BYTES);
			body = { type: "auto", text: cut.text };
			if (cut.truncated) body.truncated = true;
		}
		for (const key of thread.repliedTurns) if (key <= turn) thread.repliedTurns.delete(key);
		if (!body) return;
		this.#sendInThread(thread, body).then(
			result => {
				if (result.status === "delivered" || result.status === "queued") return;
				logger.debug("session inbox automatic answer dropped", { to: thread.peer.address, status: result.status });
			},
			error => logger.debug("session inbox automatic answer dropped", { error: String(error) }),
		);
	}
}
