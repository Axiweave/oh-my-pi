import { Database } from "bun:sqlite";
import { vi } from "bun:test";
import { parseCodexRateLimitHeaders } from "@oh-my-pi/pi-ai";
import {
	type AuthAccountPolicies,
	AuthStorage,
	type ProviderRouting,
	type RoutingMode,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { defaultRankingStrategy } from "@oh-my-pi/pi-ai/usage/registry";

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
const SEED = Number(process.env.ROUTING_SEED ?? 20_260_511);
export const MODES: readonly RoutingMode[] = ["smart", "order", "rotate", "weight", "usage", "pace"];

export type Gen = {
	int(min: number, max: number): number;
	pick<T>(items: readonly T[]): T;
	chance(probability: number): boolean;
};

/** mulberry32: small, seedable, good enough for case generation. */
function gen(seed: number): Gen {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
	return {
		int: (min, max) => min + Math.floor(next() * (max - min + 1)),
		pick: items => items[Math.floor(next() * items.length)]!,
		chance: probability => next() < probability,
	};
}

/** Run `property` over generated cases; a failure names the seed and case so it can be replayed. */
export async function forAll(cases: number, property: (g: Gen) => Promise<void>): Promise<void> {
	for (let index = 0; index < cases; index += 1) {
		try {
			await property(gen(SEED + index));
		} catch (error) {
			throw new Error(
				`ROUTING_SEED=${SEED} case ${index}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

type UsageWindowSpec = {
	usedFraction: number;
	resetInMs: number;
};

export type UsageWindowConfig = {
	windowId: string;
	windowLabel: string;
	durationMs: number;
};

type CodexUsageMetadata = {
	accountId?: string;
	allowed?: boolean;
	limitReached?: boolean;
	planType?: string;
	email?: string;
};

export function createLimit(args: {
	key: "primary" | "secondary";
	windowId: string;
	windowLabel: string;
	durationMs: number;
	usedFraction: number;
	resetInMs: number;
}): UsageLimit {
	const clamped = Math.min(Math.max(args.usedFraction, 0), 1);
	const used = clamped * 100;
	return {
		id: `openai-codex:${args.key}`,
		label: args.windowLabel,
		scope: {
			provider: "openai-codex",
			windowId: args.windowId,
			shared: true,
		},
		window: {
			id: args.windowId,
			label: args.windowLabel,
			durationMs: args.durationMs,
			resetsAt: Date.now() + args.resetInMs,
		},
		amount: {
			unit: "percent",
			used,
			limit: 100,
			remaining: 100 - used,
			usedFraction: clamped,
			remainingFraction: Math.max(0, 1 - clamped),
		},
		status: clamped >= 1 ? "exhausted" : clamped >= 0.9 ? "warning" : "ok",
	};
}

export function createCodexUsageReport(args: {
	accountId: string;
	primary: UsageWindowSpec;
	secondary: UsageWindowSpec;
	primaryWindow?: UsageWindowConfig;
	secondaryWindow?: UsageWindowConfig;
	metadata?: CodexUsageMetadata;
}): UsageReport {
	const primaryWindow = args.primaryWindow ?? { windowId: "1h", windowLabel: "1 Hour", durationMs: HOUR_MS };
	const secondaryWindow = args.secondaryWindow ?? { windowId: "7d", windowLabel: "7 Day", durationMs: WEEK_MS };
	return {
		provider: "openai-codex",
		fetchedAt: Date.now(),
		limits: [
			createLimit({
				key: "primary",
				windowId: primaryWindow.windowId,
				windowLabel: primaryWindow.windowLabel,
				durationMs: primaryWindow.durationMs,
				usedFraction: args.primary.usedFraction,
				resetInMs: args.primary.resetInMs,
			}),
			createLimit({
				key: "secondary",
				windowId: secondaryWindow.windowId,
				windowLabel: secondaryWindow.windowLabel,
				durationMs: secondaryWindow.durationMs,
				usedFraction: args.secondary.usedFraction,
				resetInMs: args.secondary.resetInMs,
			}),
		],
		metadata: { accountId: args.accountId, ...args.metadata },
	};
}

export function createCredential(accountId: string, email: string): OAuthCredentials {
	return {
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + WEEK_MS,
		accountId,
		email,
	};
}

export async function countApiKeySelections(
	authStorage: AuthStorage,
	provider: string,
	sessionPrefix: string,
	samples = 150,
	modelId?: string,
): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	for (let index = 0; index < samples; index += 1) {
		const apiKey = await authStorage.keys.get(
			provider,
			`${sessionPrefix}-${index}`,
			modelId === undefined ? undefined : { modelId },
		);
		if (!apiKey) continue;
		counts.set(apiKey, (counts.get(apiKey) ?? 0) + 1);
	}
	return counts;
}

/**
 * In-memory `openai-codex` pool: SQLite store, usage served from `usageByAccount`
 * (mutable by the caller), and OAuth keys minted as `api-<accountId>`.
 * Callers restore the key mock with `vi.restoreAllMocks()` and close `store`.
 */
export async function createRoutingStorage(args: {
	credentials: readonly OAuthCredentials[];
	usageByAccount: ReadonlyMap<string, UsageReport>;
	accountPolicies?: AuthAccountPolicies;
	routing?: Readonly<Record<string, ProviderRouting>>;
	defaultReservePct?: number;
	/** Whether the usage provider parses rate-limit headers (default true). */
	headerLearning?: boolean;
	/** Warm window for automatic pins; unset keeps codex's indefinite warmth. */
	stickyWarmMs?: number;
}): Promise<{ authStorage: AuthStorage; store: SqliteAuthCredentialStore }> {
	const usageProvider: UsageProvider = {
		id: "openai-codex",
		...(args.headerLearning === false ? {} : { parseRateLimitHeaders: parseCodexRateLimitHeaders }),
		async fetchUsage(params) {
			const accountId = params.credential.accountId;
			if (!accountId) return null;
			return args.usageByAccount.get(accountId) ?? null;
		},
	};
	vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
		const credential = credentials["openai-codex"] as OAuthCredentials | undefined;
		if (!credential?.accountId) return null;
		return { apiKey: `api-${credential.accountId}`, newCredentials: credential };
	});
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	const authStorage = new AuthStorage(store, {
		usageProviderResolver: provider => (provider === "openai-codex" ? usageProvider : undefined),
		rankingStrategyResolver: provider => {
			const strategy = defaultRankingStrategy(provider);
			return strategy && args.stickyWarmMs !== undefined
				? { ...strategy, stickyWarmMs: args.stickyWarmMs }
				: strategy;
		},
		accountPolicies: args.accountPolicies,
		routing: args.routing,
		defaultReservePct: args.defaultReservePct,
	});
	await authStorage.credentials.set(
		"openai-codex",
		args.credentials.map(credential => ({ type: "oauth" as const, ...credential })),
	);
	return { authStorage, store };
}
