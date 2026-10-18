# Contract: Job Settle Judge

## Judge question (`src/prompts/judge/needs-user.json`)

One question with the id `needsUser`. It uses the `judgeQuestions` file format of `unexpected-stop.json`: `instructions` plus `criteria.true` and `criteria.false` example lists.

- The state has `message` (the final reply) and, if known, `request`.
- The `true` criteria include: "To start the E6 E7 pair, reply with approval of the two sha256 values above. …" after a status report, and "The server is up. Must I run the migration now?".
- The `false` criteria include: "Next action: when the first E6 Runs finish, I will check their cost and their errors." and "Tests run in the background. I will report when they finish.".

## Classifier (`src/session/unexpected-stop-classifier.ts`)

```ts
export async function classifyNeedsUser(
	turn: UnexpectedStopTurn,
	deps: ClassifyUnexpectedStopDeps,
): Promise<boolean | undefined>;
```

- The judge comes from the `judge` role chain (`resolveJudge`), with the purpose `needs-user` and the shared judgment cache.
- It returns `true` when the yes probability is 0.5 or more and `false` below 0.5. It returns `undefined` on an error or an abort. It never throws.
- `deps.onUsage` records every billed attempt in the session ledger (FR-009).

## TUI context (`src/modes/types.ts`)

```ts
/** True while the main session's last settle got a "needs input" verdict and no new run started. */
readonly jobWaitNeedsInput: boolean;
```

## Surface behavior

| Event | IDE state | Title / OSC 7501 | Loader | Notification |
|---|---|---|---|---|
| `agent_end` with `awaitingAsyncWork` | `working` | `working` | runs | none |
| Verdict `true` (still current) | `needs-input` | `done` | stops | completion, once |
| Verdict `false` or `undefined` | `working` (no change) | `working` | runs | none |
| Jobs drain with no wake after `true` | `needs-input` (no change) | `done` | stopped | none |
| Jobs drain with no wake after `false` | settled state, as today | settled, as today | stops | as today |
| Dialog closes or the plan review hides, after `true` | `needs-input` | — | — | — |

The wire events do not change: `agent_end`, `isTerminal`, `yielded`, and `awaitingAsyncWork` stay as today for RPC, ACP, and extensions (FR-010).
