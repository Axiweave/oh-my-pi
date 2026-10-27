# Contract: Phase Load Detection

`speckitPhaseLoad(toolName: string, args: unknown): SpeckitPhase | undefined`, exported from `packages/coding-agent/src/modes/speckit-auto.ts`. Pure. `<phase>` is one of `specify`, `clarify`, `plan`, `tasks`, `analyze`, `implement`, `converge`.

## `bash`

`args.command` is split into segments at `;`, `&&`, `||`, `|`, and newlines. A call with `args.async === true` is never a load, because its end event comes before the job prints anything. A segment is a load when both conditions hold:

1. Its first word, without a leading directory (`/usr/local/bin/specify` → `specify`), is exactly `specify`.
2. A later word, without surrounding quotes, is exactly `speckit.<phase>` or `speckit-<phase>`.

The last matching segment wins.

| `command` | Result |
|---|---|
| `specify project command speckit.tasks --json > /tmp/tk.json; echo "exit=$?"` | `tasks` |
| `~/.local/bin/specify project command speckit-plan` | `plan` |
| `cd repo && specify project command 'speckit.analyze'` | `analyze` |
| `grep -rn speckit.tasks .specify/` | `undefined` (first word is `grep`) |
| `specify check` | `undefined` (no phase word) |
| `specify project command speckit.checklist` | `undefined` (not a phase) |
| `echo specify speckit.tasks` | `undefined` (first word is `echo`) |
| `uvx --from spec-kit specify project command speckit.tasks` | `undefined` (first word is `uvx`, a known limit) |
| `FOO=1 specify project command speckit.tasks` | `undefined` (first word is an assignment, a known limit) |
| `specify project command speckit.tasks` with `async: true` | `undefined` (async job) |

## `read`

`args.path` loses every trailing selector first (`:5-20`, `:raw`, `:-60`, `:raw:2-4`, and the other forms in the read tool docs). The match uses the base name in any directory. A path is a load when one of these holds:

1. Its last segment is `speckit.<phase>.md`.
2. It ends with `speckit-<phase>/SKILL.md`.
3. It is `skill://speckit-<phase>`, with or without `/SKILL.md`.

| `path` | Result |
|---|---|
| `.omp/commands/speckit.tasks.md` | `tasks` |
| `.omp/commands/speckit.plan.md:1-120` | `plan` |
| `.omp/commands/speckit.plan.md:raw:2-4` | `plan` |
| `skill://speckit-implement` | `implement` |
| `.omp/skills/speckit-converge/SKILL.md` | `converge` |
| `specs/017-x/tasks.md` | `undefined` |
| `.omp/commands/speckit.checklist.md` | `undefined` |

## Every other tool

The result is `undefined`. This includes `write`, `edit`, `grep`, and `glob`, so written content and searches never count (FR-002).

## Application

The interactive mode applies a load only at the `tool_execution_end` of the same `toolCallId`, and only when `isError !== true`. See `data-model.md` for the run transitions.
