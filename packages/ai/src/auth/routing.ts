import { orderUsageRankedCandidates, type UsageRankedCandidate } from "./rank";
import type { AuthCredential, RoutingMode } from "./types";

type Ranked = UsageRankedCandidate<AuthCredential>;

/** `pace`: share used at or above which an account drops to the low tier, and to the spent tier. */
const PACE_LOW_SHARE = 0.9;
const PACE_SPENT_SHARE = 0.98;
/** `pace`: paces within this ratio of their band's top count as equal. */
const PACE_BAND_RATIO = 0.9;

/** Smooth weighted round-robin state (NGINX) for one provider pool. */
export interface WeightRound {
	/** Current weight by credential id. */
	cur: Map<number, number>;
	/** Pool weight the last pick was charged. */
	total: number;
	/** Credential id the current ordering picked; unset when it picked none. */
	last?: number;
}

/** Per-selection inputs to {@link orderRankedCandidates}. */
export interface RoutingContext {
	planGated: boolean;
	/** `rotate`: sign-in position this selection starts from. */
	rotateStart: number;
	/** `weight`: the provider's round; the pick advances it. */
	weightRound: WeightRound;
	weightOf: (candidate: Ranked) => number;
	recentTokens: (candidate: Ranked) => number;
	/** `usage`/`pace`: credential ids with no report yet that go first once. */
	learnable: ReadonlySet<number>;
	/** Sunk credential ids, in refusal order. */
	sink: readonly number[];
}

/** Whether `candidate` can serve now: unblocked, inside its caps and allowance, not plan-ineligible. */
export function isRoutable(candidate: Ranked, planGated: boolean): boolean {
	return (
		!candidate.blocked &&
		!candidate.inReserve &&
		!candidate.allowanceSpent &&
		!(planGated && candidate.planPriority === 2)
	);
}

/** Hard checks every mode applies before its own order: blocks (earliest unblock first), plan, caps/allowance. */
function compareHard(left: Ranked, right: Ranked, planGated: boolean): number {
	if (left.blocked !== right.blocked) return left.blocked ? 1 : -1;
	if (left.blocked) {
		const leftUntil = left.blockedUntil ?? Number.POSITIVE_INFINITY;
		const rightUntil = right.blockedUntil ?? Number.POSITIVE_INFINITY;
		return leftUntil === rightUntil ? 0 : leftUntil - rightUntil;
	}
	if (planGated && left.planPriority !== right.planPriority) return left.planPriority - right.planPriority;
	const leftOut = left.inReserve || left.allowanceSpent;
	return leftOut === (right.inReserve || right.allowanceSpent) ? 0 : leftOut ? 1 : -1;
}

/** Split hard-sorted `candidates` into runs that tie on every hard check. */
function hardGroups<C extends Ranked>(candidates: C[], planGated: boolean): C[][] {
	const groups: C[][] = [];
	for (const candidate of candidates) {
		const group = groups.at(-1);
		if (group && compareHard(group[0]!, candidate, planGated) === 0) group.push(candidate);
		else groups.push([candidate]);
	}
	return groups;
}

/** Move `sink` members (in refusal order) behind the rest, keeping the rest's order. */
export function applySink<C extends { credentialId?: number }>(ordered: C[], sink: readonly number[]): C[] {
	if (sink.length === 0) return ordered;
	const rest = ordered.filter(
		candidate => candidate.credentialId === undefined || !sink.includes(candidate.credentialId),
	);
	return [...rest, ...sink.flatMap(id => ordered.filter(candidate => candidate.credentialId === id))];
}

/** Advance `round` over `members` (smooth weighted round robin) and return the index it picks. */
function weightPick(round: WeightRound, members: Ranked[], weightOf: (candidate: Ranked) => number): number {
	let best = -1;
	let bestCur = Number.NEGATIVE_INFINITY;
	let total = 0;
	for (const [index, member] of members.entries()) {
		if (member.credentialId === undefined) continue;
		const weight = weightOf(member);
		const cur = (round.cur.get(member.credentialId) ?? 0) + weight;
		round.cur.set(member.credentialId, cur);
		total += weight;
		if (cur > bestCur) {
			best = index;
			bestCur = cur;
		}
	}
	if (best === -1) return -1;
	const id = members[best]!.credentialId!;
	round.cur.set(id, bestCur - total);
	round.total = total;
	round.last = id;
	return best;
}

/**
 * Move one pick's charge in `round` from `from` onto `to`, which a stays rule kept instead.
 * `to` may be outside the round (blocked or over a cap); it still pays for the request.
 */
export function chargeKept(round: WeightRound, from: number | undefined, to: number): void {
	if (from === undefined || from === to) return;
	round.cur.set(from, (round.cur.get(from) ?? 0) + round.total);
	round.cur.set(to, (round.cur.get(to) ?? 0) - round.total);
}

/** `pace` bands over the free tier: start a new band when a pace falls below 90% of the band's top. */
function paceBands(members: Ranked[]): Map<Ranked, number> {
	const bands = new Map<Ranked, number>();
	let band = -1;
	let top = 0;
	for (const member of [...members].sort((left, right) => right.pace - left.pace)) {
		if (band === -1 || member.pace < PACE_BAND_RATIO * top) {
			band += 1;
			top = member.pace;
		}
		bands.set(member, band);
	}
	return bands;
}

/** Order one hard group of every mode but `smart`; already sorted by sign-in position. */
function orderGroup<C extends Ranked>(
	mode: RoutingMode,
	group: C[],
	ctx: RoutingContext,
	total: number,
	leading: boolean,
): C[] {
	const learnFirst = (left: C, right: C) =>
		Number(ctx.learnable.has(right.credentialId ?? -1)) - Number(ctx.learnable.has(left.credentialId ?? -1));
	const byTokens = (left: C, right: C) => ctx.recentTokens(left) - ctx.recentTokens(right);
	switch (mode) {
		case "order":
			return group.sort(
				(left, right) => right.accountPriority - left.accountPriority || left.orderPos - right.orderPos,
			);
		case "rotate": {
			const turn = (candidate: C) => (candidate.orderPos - ctx.rotateStart + total) % total;
			return group.sort((left, right) => turn(left) - turn(right));
		}
		case "weight": {
			const pick = leading ? weightPick(ctx.weightRound, group, ctx.weightOf) : -1;
			return pick <= 0 ? group : [group[pick]!, ...group.filter((_candidate, index) => index !== pick)];
		}
		case "usage":
			return group.sort(
				(left, right) =>
					learnFirst(left, right) ||
					left.shareUsed - right.shareUsed ||
					byTokens(left, right) ||
					left.orderPos - right.orderPos,
			);
		default: {
			// pace
			const tier = (candidate: C) =>
				candidate.shareUsed >= PACE_SPENT_SHARE ? 2 : candidate.shareUsed >= PACE_LOW_SHARE ? 1 : 0;
			const bands = paceBands(
				group.filter(candidate => tier(candidate) === 0 && !ctx.learnable.has(candidate.credentialId ?? -1)),
			);
			return group.sort((left, right) => {
				const tiers = tier(left) - tier(right);
				if (tiers !== 0) return tiers;
				const metric =
					tier(left) === 0
						? learnFirst(left, right) || (bands.get(left) ?? 0) - (bands.get(right) ?? 0)
						: left.shareUsed - right.shareUsed;
				return metric || byTokens(left, right) || left.orderPos - right.orderPos;
			});
		}
	}
}

/**
 * Order ranked candidates for `mode`. `smart` keeps its comparator; every other mode sorts the
 * hard checks first and orders inside each unblocked group. Sink then applies inside each group
 * for every mode but `rotate` and `weight`.
 */
export function orderRankedCandidates<C extends Ranked>(mode: RoutingMode, candidates: C[], ctx: RoutingContext): C[] {
	if (mode === "smart") {
		const ordered = orderUsageRankedCandidates(candidates, ctx.planGated);
		return ctx.sink.length === 0
			? ordered
			: hardGroups(ordered, ctx.planGated).flatMap(group => applySink(group, ctx.sink));
	}
	candidates.sort((left, right) => compareHard(left, right, ctx.planGated) || left.orderPos - right.orderPos);
	const groups = hardGroups(candidates, ctx.planGated).map((group, index) =>
		group[0]!.blocked ? group : orderGroup(mode, group, ctx, candidates.length, index === 0),
	);
	return mode === "rotate" || mode === "weight" ? groups.flat() : groups.flatMap(group => applySink(group, ctx.sink));
}
