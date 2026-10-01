# Implementation Plan: Subagent Generation Rate in the Subagents HUD

**Branch**: `007-subagent-token-rate` | **Date**: 2026-10-01 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/007-subagent-token-rate/spec.md`

## Summary

Show each running subagent's generation rate in the pinned Subagents block, and show the sum of the live rates in the block header. Rows put the rate after the agent name. They use the working row's throughput symbol, which follows `symbolPreset`. While a message streams, the rate is live in `muted`. Between requests, the row holds the last reading in `dim`. The `composer.tokenRate` setting controls all of it.

The approach (see [research.md](research.md)):
1. Add a `live` getter to `TokenRateMeter`.
2. Add an optional `rateOf(id)` lookup parameter to the pure `renderSubagentHudLines`.
3. Make `#renderSubagentList` give that lookup from `AgentRegistry`.
4. Use progress frames for redraws while deltas stream. A 500 ms heartbeat covers silent spans, and every render restarts it.

## Technical Context

**Language/Version**: TypeScript on Bun (version from the root `packageManager` field)

**Primary Dependencies**: `@oh-my-pi/pi-tui` (theme, `truncateToWidth`, `visibleWidth`), the existing `AgentRegistry`, `TokenRateMeter` and `cfgComposerTokenRate`. No new packages.

**Storage**: N/A

**Testing**: `bun test` (vitest-compatible API) in `packages/coding-agent/test/`, then `bun check`

**Target Platform**: Terminal TUI on macOS and Linux

**Project Type**: CLI/TUI application in a monorepo

**Performance Goals**: The HUD rebuild stays a few rows of string work. It runs on the existing coalesced progress frames. A heartbeat adds a rebuild only after 500 ms with no frame, and only while a subagent streams.

**Constraints**:
- The output does not change when there is no rate lookup (SC-006).
- No new setting.
- No change to the progress event payload.
- No redraws when no agent streams (FR-010).

**Scale/Scope**: About 1 to 32 concurrent subagents. The code changes are in 2 source files and 1 or 2 test files, plus `CHANGELOG.md` and the setting description.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the unfilled template, so it defines no gates. The plan uses the repository rules (`AGENTS.md`) as gates:

| Gate | Status |
|---|---|
| Reuse existing patterns (meter, registry lookup, theme icon, setting) | Pass. Each item already exists. |
| No new abstraction without need | Pass. One getter and one optional parameter. |
| No backward-compatibility shims | Pass. No shims are needed. |
| Tests prove properties, not wiring | Pass. R7 lists properties. One test drives the real progress-frame path. |
| User-configurable feature updates `~/.omp/agent/config.yml` | N/A. The feature adds no setting. |

Re-check after Phase 1: all gates pass.

## Project Structure

### Documentation (this feature)

```text
specs/007-subagent-token-rate/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── subagent-hud-rate.md
└── tasks.md             # created by /speckit.tasks
```

### Source Code (repository root)

```text
packages/coding-agent/
├── src/utils/token-rate.ts          # + get live()
├── src/modes/interactive-mode.ts    # renderSubagentHudLines(rateOf), #renderSubagentList lookup + heartbeat, shutdown clear
├── src/modes/settings.ts            # composer.tokenRate description mentions the Subagents block
├── test/subagent-hud-render.test.ts # rate row, held style, header sum, width bound, preset symbol
├── test/utils/token-rate-meter.test.ts # live across begin/end
└── CHANGELOG.md                     # [Unreleased] entry
```

**Structure Decision**: All changes stay in `packages/coding-agent`. `packages/tui` does not change, because `ObservableSession` and the theme symbols stay as they are.

## Implementation Notes

1. **Meter.** In `TokenRateMeter`, add `get live(): boolean { return this.#startedAt !== null; }`.
2. **Render function.** In `renderSubagentHudLines`:
   - Add the optional `rateOf` parameter and the exported `SubagentRate` type.
   - In `renderItem`, after `badge`, ask `rateOf(session.id)`. Build `${theme.icon.throughput} ${rate.toFixed(1)}` with `muted` when live and `dim` when held.
   - Append ` ${rate}` to `line` only if it fits in `rowWidth`. Do this before the description budget step, so the description gets shorter first.
   - For the header, sum the live rates over all `running` agents, not only the drawn rows. If the sum is more than 0, append `  ${theme.fg("dim", `${icon} ${sum.toFixed(1)} tok/s`)}`, then truncate to `columns`.
3. **Caller.** In `#renderSubagentList`:
   - When `cfgComposerTokenRate` is on, give `rateOf = id => { const meter = AgentRegistry.global().get(id)?.session?.tokenRate; const rate = meter?.rate(); return rate == null ? undefined : { rate, live: meter!.live }; }`.
   - Track whether any running agent is live. If one is live and `#subagentRateTimer` is unset, arm `setTimeout(500)` with `unref()`. The callback clears the field, then calls `#renderSubagentList()` and `ui.requestRender()`.
4. **Shutdown.** Clear `#subagentRateTimer` in the same place as `#cancelObserverUiSyncTimer`.
5. **Documentation.** Extend the `composer.tokenRate` description to say "also per subagent in the Subagents block". Add a `CHANGELOG.md` entry under `[Unreleased]`.

## Complexity Tracking

No violations.
