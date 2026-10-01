# Quickstart: validate subagent rates in the Subagents HUD

## Prerequisites

1. Run `bun run setup` from the repository root. If the shell finds the wrong `cargo`, put `$HOME/.cargo/bin` first in `PATH`.
2. Make sure a model provider is configured, so that subagents can stream.

## Automated checks

```sh
bun test packages/coding-agent/test/subagent-hud-render.test.ts
bun test packages/coding-agent/test/utils/token-rate-meter.test.ts
bun check
```

The new HUD cases cover the properties in `research.md` R7. The rest of the subagent HUD suite must stay green. This proves SC-006 for callers without a rate lookup.

## Manual smoke run (real TUI)

1. Start `omp` in a scratch directory.
2. Run `/settings`, open the Appearance tab, and turn on "Generation Rate".
3. Ask for two parallel subagents that write long output. For example: "Use two task subagents. Each writes a 400-line poem. Then wait for both."
4. While both stream, check that each Subagents row shows `⚡ NN.N` after the agent name.
5. Check that the header shows `⚡ NNN.N tok/s`.
6. Watch a long stream for 10 seconds. The number must follow the stream and must not freeze. A steady stream can show the same value for some time. The cadence test (T007 in `tasks.md`) proves the redraw rate, not this visual check (SC-003).
7. When a subagent runs a tool, check that its rate stays visible and turns darker. Check that the header total drops (FR-004, FR-005).
8. Press `Ctrl+S` to open the agent hub, select one subagent, and press `Enter` to focus it. In each frame, its working-row tok/s must equal its HUD row (FR-011). Press `Esc` to go back.
9. Change `symbolPreset` to `nerd`, then to `ascii`. The HUD symbol must change together with the working-row symbol (US3).
10. Turn off "Generation Rate". The HUD must look as before this feature (SC-006).
11. After all subagents finish, make sure the Subagents block clears and the HUD shows no rate.

## Expected outcomes

| Check | Pass condition |
|---|---|
| Per-row rate | Each streaming agent row shows the symbol and one decimal place |
| Held rate | A row between requests keeps its number in the dimmed style |
| Header total | The header shows the sum of live rows only, including collapsed rows |
| Symbol | Same as the working-row readout for each of the 3 presets |
| Setting off | No rate anywhere in the HUD |
