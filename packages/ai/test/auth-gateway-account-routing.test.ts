import { afterEach, describe, expect, it, vi } from "bun:test";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import type { AuthStorage, ProviderRouting } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { Context } from "@oh-my-pi/pi-ai/types";
import { createCredential, createRoutingStorage, forAll, MODES } from "./helpers/routing-fixtures";

const PROVIDER = "openai-codex";
const MODEL_ID = "gateway-routing";
const context: Context = { systemPrompt: ["test"], messages: [{ role: "user", content: "hi", timestamp: 0 }] };

/**
 * Two-account gateway. `respond` scripts the upstream per bearer; the bearer
 * is the account's access token, so a 401 invalidation matches its row.
 */
async function withGateway(
	routing: ProviderRouting,
	respond: (apiKey: string) => MockResponse,
	run: (send: (sessionId: string) => Promise<Response>, keys: string[], authStorage: AuthStorage) => Promise<void>,
): Promise<void> {
	registerMockApi();
	const { authStorage, store } = await createRoutingStorage({
		credentials: [createCredential("acct-0", "a@example.test"), createCredential("acct-1", "b@example.test")],
		usageByAccount: new Map(),
		routing: { [PROVIDER]: routing },
	});
	vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
		const credential = credentials[PROVIDER] as OAuthCredentials;
		return { apiKey: credential.access, newCredentials: credential };
	});
	const keys: string[] = [];
	const mock = createMockModel({
		provider: PROVIDER,
		id: MODEL_ID,
		handler: (_context, options) => {
			const apiKey = String(options?.apiKey);
			keys.push(apiKey);
			return respond(apiKey);
		},
	});
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["test-token"],
		storage: authStorage,
		resolveModel: () => mock,
		version: "test",
	});
	const send = (sessionId: string) =>
		fetch(`${handle.url}/v1/pi/stream`, {
			method: "POST",
			headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
			body: JSON.stringify({ modelId: MODEL_ID, context, options: { sessionId }, stream: false }),
		});
	try {
		await run(send, keys, authStorage);
	} finally {
		await handle.close();
		store.close();
		clearCustomApis();
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("auth gateway account routing", () => {
	it("under `strict`, keeps an automatic pin on its account after a 401 or usage limit, and moves an explicit pin to the sibling (FR-013, FR-014)", async () => {
		await forAll(40, async g => {
			const mode = g.pick(MODES);
			const failure = g.pick(["401 Unauthorized", "429 usage_limit_reached"]);
			const pinned = g.int(0, 1);
			const explicit = g.chance(0.5);
			const pinnedKey = `access-acct-${pinned}`;
			await withGateway(
				{ mode, stays: "strict" },
				apiKey => (apiKey === pinnedKey ? { throw: failure } : { content: ["sibling served"] }),
				async (send, keys, authStorage) => {
					const id = authStorage.credentials.list(PROVIDER)[pinned]!.id;
					const pinOptions = explicit ? undefined : { restoredAtMs: Date.now() };
					expect(authStorage.sessions.pin(PROVIDER, "s", id, pinOptions)).toBe(true);
					const response = await send("s");
					await response.body?.cancel();
					// An automatic pin's error reaches the client; an explicit pin keeps today's fallback.
					expect({
						mode,
						failure,
						explicit,
						served: response.status === 200,
						first: keys[0],
						moved: keys.some(key => key !== pinnedKey),
					}).toEqual({ mode, failure, explicit, served: explicit, first: pinnedKey, moved: explicit });
				},
			);
		});
	});

	it("sinks an account refused with a non-usage 429, so `order` serves the next one", async () => {
		// FR-018: a rate limit with quota left moves the account behind its siblings.
		await withGateway(
			{ mode: "order", sink: true },
			apiKey =>
				apiKey === "access-acct-0" ? { throw: "429 Rate limit exceeded, too many requests" } : { content: ["ok"] },
			async (send, keys) => {
				const refused = await send("first-session");
				await refused.body?.cancel();
				expect(refused.status).toBe(429);
				expect(keys).toEqual(["access-acct-0"]);

				const served = await send("second-session");
				await served.body?.cancel();
				expect(served.status).toBe(200);
				expect(keys.at(-1)).toBe("access-acct-1");
			},
		);
	});

	it("answers 401 without account details when a strict session's account was signed out", async () => {
		// FR-013 (T076, T089): the session stays on its signed-out account, so the gateway
		// reports a missing credential (401) for it and never serves a sibling. The body
		// names neither the account nor the session.
		await withGateway(
			{ mode: "order", stays: "strict" },
			() => ({ content: ["served"] }),
			async (send, keys) => {
				const first = await send("strict-session");
				await first.body?.cancel();
				expect(first.status).toBe(200);
				expect(keys).toEqual(["access-acct-0"]);

				vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
					const credential = credentials[PROVIDER] as OAuthCredentials;
					if (credential.accountId === "acct-0")
						throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant"}');
					return { apiKey: credential.access, newCredentials: credential };
				});
				for (let request = 0; request < 2; request++) {
					const refused = await send("strict-session");
					expect({ request, status: refused.status }).toEqual({ request, status: 401 });
					const body = await refused.text();
					expect({
						request,
						email: body.includes("a@example.test"),
						session: body.includes("strict-session"),
					}).toEqual({
						request,
						email: false,
						session: false,
					});
				}
				expect(keys).toEqual(["access-acct-0"]);
			},
		);
	});
});
