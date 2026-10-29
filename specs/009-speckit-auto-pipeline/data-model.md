# Data Model: Speckit-Auto Mode

## Saved state (session entry)

The mode saves this object as the `data` of a `custom` session entry with `customType: "speckit-auto"`. The latest entry on the current branch wins.

```ts
type SpeckitPhase = "specify" | "clarify" | "plan" | "tasks" | "analyze" | "remediation" | "implement" | "converge";

interface SpeckitHold {
	kind: "user" | "needs-you"; // "user": waits for an answer. "needs-you": error, limit, or unreadable turn.
	reason: string;
}

interface SpeckitRun {
	phase: SpeckitPhase;
	history: SpeckitPhase[];   // every phase turn the run started, in order (FR-032 summary)
	remediationRounds: number; // 0..2
	convergeRounds: number;    // extra implement+converge rounds, 0..convergeLimit
	convergeLimit: number;     // speckitAuto.convergeRounds at run start
	autoAnswered: boolean;     // the automatic answer was sent in this phase run
	turnOpen: boolean;         // a run turn started and has not settled yet (cleared when the tick sees it settled, before the judge call)
	paused: boolean;
	hold?: SpeckitHold;
}

interface SpeckitAutoState {
	enabled: boolean;
	run?: SpeckitRun;
}
```

**Validation** (`parseSpeckitAutoState(data)`): an object with a boolean `enabled`. A `run` with an unknown phase, a non-array `history`, or a non-integer or negative count is dropped, and the rest of the state stays. Any other shape returns `undefined`, which means "mode off".

**Restore rule**: `enabled` turns the mode on. A restored `run` gets `paused = true`. Restore never classifies, parks, or submits. A restored `turnOpen: true` means omp quit during a turn, so resume sends the continue message.

## Transient state (InteractiveMode only, never saved)

| Field | Meaning |
|---|---|
| `#speckitGeneration: number` | Increments on a user turn start, Esc pause, mode off, `next`, `resume`, a new run, and session switch. Stale work compares and drops itself. |
| `#speckitDecidedKey: number \| undefined` | Timestamp of the last assistant message that the mode classified. |
| `#speckitTimer: Timer \| undefined` | The 800 ms tick (research R3). |
| `#speckitJudgeAbort: AbortController \| undefined` | Aborts the running judge call. Set while a check runs. |
| `#speckitParked: { text: string; phase: SpeckitPhase; generation: number } \| undefined` | A decided start that the next clear tick submits. |
| `#speckitOwnTurn: { text: string; phase: SpeckitPhase; generation: number } \| undefined` | The mode's own submission that waits for its `message_start`. Cleared by a match, a generation increment, or a tick that finds the guard clear (research R4). |
| `#speckitSubmitInFlight: number` | The editor submit handler runs (research R2). Blocks a submit. |
| `#speckitNextInFlight: boolean` | `next` awaits the abort. The tick does nothing. |

`speckitAutoActing` (for Esc) is true when a run is active, not paused, has no hold, and a run turn streams, `#speckitJudgeAbort` is set, or `#speckitParked` is set.

`speckitAutoRunActive` (for notification suppression) is true when the mode is on and a run is active and not paused.

## Turn verdict

```ts
type SpeckitNext =
	| "advance"   // the phase finished: start the successor (analyze: implement)
	| "proceed"   // the only blocking question asks to proceed with the agent's recommendation
	| "remediate" // analyze: a CRITICAL finding, or leave to make the fixes the report recommends
	| "recheck"   // analyze, user-started turn: the reply reports the fixes the user asked for
	| "complete"  // converge: the work meets the spec, no task added
	| "added"     // converge: tasks added for remaining gaps
	| "ask"       // a blocking question for the user
	| "error"     // a reported error or early stop
	| "unclear";  // the reply does not show the outcome

interface SpeckitVerdict {
	failed?: string;      // stopReason error, length, or aborted (an abort that did not come from Esc pause or next), with the reason
	next?: SpeckitNext;   // the judge's pick; undefined when the judge could not answer
	analyze?: { critical: number; high: number } | "unreadable"; // analyze only, from the text: the CRITICAL bound and the HIGH notice
}

// Text-pattern hints in the judge state. The judge decides. The hints only help it read the reply.
interface SpeckitEvidence {
	analyze?: { critical: number; high: number } | "unreadable"; // analyze only
	errorCue: boolean;       // an error line such as `ERROR:` or `T012 failed`; zero counts do not count
	reportCue?: boolean;     // specify, plan, tasks, implement, remediation: the phase's own completion report
	readyCue?: boolean;      // clarify only: no critical ambiguity, or /speckit.plan recommended, with no blocking Deferred item
	closingOffers: string[]; // handoff sentences, questions that name another phase, and the analyze fix offer
}
```

**Options per phase** (`speckitOutcomes(phase, userTurn)`): the judge picks from these only.

| Phase | Options |
|---|---|
| analyze | advance, remediate, recheck (only on a user-started turn), ask, error, unclear |
| converge | complete, added, proceed, ask, error, unclear |
| specify, clarify, remediation | advance, ask, error, unclear |
| plan, tasks, implement | advance, proceed, ask, error, unclear |

## Actions

```ts
type SpeckitAction =
	| { kind: "start"; phase: SpeckitPhase }                         // submit `/speckit.<phase>`
	| { kind: "answer" }                                             // submit the automatic answer, set autoAnswered
	| { kind: "remediate" }                                          // submit the remediation prompt, remediationRounds + 1
	| { kind: "hold"; hold: SpeckitHold }
	| { kind: "end"; result: "complete" | "open-tasks" | "stopped" }
	| { kind: "notice"; text: string; after: SpeckitAction };        // HIGH-only analyze notice
```

## Decision table: `decideSpeckitStep(run, verdict, scope)`

Checks run top to bottom. The first match wins. "Any" means every phase. The judge picks `next`. The rows only apply the deterministic bounds.

| # | Condition | Action |
|---|---|---|
| 1 | any, `failed` | hold needs-you: the failure reason |
| 2 | any, `next` undefined | hold needs-you: "the turn check failed; /speckit-auto next advances" |
| 3 | any, `ask` | hold user: "answer the question" |
| 4 | any, `error` | hold needs-you: "the phase reported an error or stopped early" |
| 5 | any, `proceed`, phase specify, clarify, analyze, or remediation, or `autoAnswered` | hold user: "answer the question" |
| 6 | any, `proceed` | answer |
| 7 | analyze, `recheck`, `remediationRounds < 2` | start analyze (counts a remediation round when its turn starts) |
| 8 | analyze, `recheck` | hold needs-you: "fixes applied after 2 rounds; run /speckit.analyze to check them" |
| 9 | converge, `complete` | end complete |
| 10 | converge, `added`, `convergeRounds < convergeLimit` | start implement (convergeRounds + 1) |
| 11 | converge, `added` | end open-tasks |
| 12 | analyze, `remediate`, or `advance` with `critical > 0`, `remediationRounds < 2` | remediate |
| 13 | analyze, as row 12, `critical > 0` | hold needs-you: "N CRITICAL findings remain after 2 rounds" |
| 14 | analyze, `remediate` | hold user: "answer the question" |
| 15 | analyze, `advance`, `high > 0` | notice "N HIGH findings", then start implement |
| 16 | analyze, `advance` | start implement |
| 17 | specify, clarify, plan, tasks, implement, or remediation, `advance` | start the successor: clarify, plan, tasks, analyze, converge, or analyze |
| 18 | any other pick (`unclear`, or a pick outside the phase) | hold needs-you: "cannot tell if the phase finished; /speckit-auto next advances" |

After the table, the scope applies: in a `tasks` scope run that the user did not move into editing, a start or remediation outside the scope (implement, converge) ends the run as `planned`. A notice before such a start drops.

Notes:

- No row reads text cues to pick a step. The judge sees the whole message tail (6000 characters), the earlier assistant text of the turn, and the evidence. Without a judge answer, row 2 holds every phase. No text fallback exists.
- Row 5 keeps the automatic answer out of specify, clarify, analyze, and remediation, and limits it to one per phase run (FR-019).
- Rows 12 and 13 are the CRITICAL bound: the text count stops an `advance` past a CRITICAL finding, even when the judge picked `advance` (FR-017). Row 14 is the analyze fix offer after the round limit: it goes to the user.
- A missing analyze report counts as zero findings in rows 12 to 16. The judge's `advance` criterion for analyze requires a printed findings report, so the judge picks `unclear` or `ask` for a turn without one.

## State transitions

```mermaid
stateDiagram-v2
    [*] --> Off
    Off --> Waiting: /speckit-auto-mode
    Waiting --> Running: /speckit.<phase> turn starts
    Running --> Next: turn settles, tick decides start, answer, or remediate
    Next --> Running: guard clear, own turn starts
    Running --> Hold: turn settles, tick decides hold
    Running --> Waiting: turn settles, tick decides end (summary)
    Hold --> Running: user turn starts
    Running --> Paused: Esc
    Next --> Paused: Esc
    Next --> Running: user turn starts (start dropped)
    Paused --> Running: resume, or a /speckit.<phase> turn starts
    Paused --> Next: next
    Hold --> Next: next
    Waiting --> Off: /speckit-auto-mode
    Running --> Off: /speckit-auto-mode (turn finishes)
    Next --> Off: /speckit-auto-mode
    Hold --> Off: /speckit-auto-mode
    Paused --> Off: /speckit-auto-mode
```

**Run start and reset**: A `/speckit.specify` turn start always makes a new run: `phase: "specify"`, `history: ["specify"]`, zero counts, `convergeLimit` from the setting, `autoAnswered: false`, `turnOpen: true`, no pause, and no hold. Any other phase command with no active run starts a run at that phase with the same reset.

**Phase turn start**: When a phase turn starts (user command or own start), the mode sets `phase`, appends it to `history`, sets `autoAnswered = false` and `turnOpen = true`, and clears the hold and the pause. An own answer or continue turn keeps the phase. An answer turn sets `autoAnswered = true`.

**User turn start**: Any user turn start in an active run increments the generation, drops the parked start, clears the hold, and sets `turnOpen = true`. The phase stays.

**Successor map** (for `/speckit-auto next`): specify → clarify → plan → tasks → analyze → implement → converge → end. remediation → analyze.

## Bounds (SC-004)

Without user input, one run has at most:

- 1 clarify start (only row 17 from specify starts clarify),
- 3 analyze turns (1 from tasks + 2 from remediation),
- 2 remediation rounds,
- 1 + `convergeLimit` implement turns,
- 1 automatic answer per phase run.
