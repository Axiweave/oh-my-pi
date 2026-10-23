# Upstream Divergences

This file records behavior that this fork intentionally keeps different from `can1357/oh-my-pi`.
It is not a changelog. Each entry describes a current decision that upstream merges must preserve or retire explicitly.

**Reviewed against:** `v18.12.6` on 2026-10-21.

**Verification:** Source setup, launcher checks, and `omp --smoke-test` passed.
The launcher targets this checkout and reports `18.12.6`. `bun check` passes.
The merge had conflicts in 2 files. The resolutions preserve every fork decision and keep upstream behavior:
- The first `model_change` entry of a new session keeps the fork's cyber and review-plan state. Upstream's deferred-pattern retry-role entry follows it and also records the cyber state.
- The ACP builtin `/todo` HUD verbs (`expand`, `collapse`, `compact`) take upstream's failed result.
Three auto-merged gaps were fixed:
- Upstream's ACP `_session/steering` path (`joinActiveTurn`) now expands file commands and keeps the command card, as `steer()` does.
- Upstream's new deferred-pattern test host gets the fork's `reviewPlanActive`.
- Upstream lets an empty subagent chain reach `getRetryFallbackRole`, so a cyber-excluded primary persisted as its allowlisted substitute. The read-back now uses the raw role, as the install does.
846 test files ran in separate processes, and 843 passed. The set covered every divergence check, every test file that both sides changed, every test file that upstream added or changed in this release, and the tests that import each source file that both sides changed.
`sdk-tool-activation` (5 Cursor cases) also fails at the pre-merge commit.
`model-registry` (`getApiKey does not mutate bundled github-copilot baseUrl`) relied on a key check moving the round-robin turn. That breaks the fork's key-check rule, which `454748ffa5` extended to `smart`. The code stays, and the test now spends the turn on the request path.
`main-model-suggestions` timed out under load and passes alone.
`bun run test:rs` passed all 3954 tests, with 5 skipped.
The full `bun run test` plan did not run for this merge.
The build reports that this host lacks Swift 6.4 with the macOS 27 SDK, so Apple Foundation Models support remains unavailable.

## Maintenance

1. Read every entry before an upstream merge or conflict resolution.
2. Preserve each decision unless the user explicitly retires it.
3. After a merge, verify each entry against upstream and update the reviewed release.
4. Add or update an entry in the same commit as each fork-only feature or decision.
5. Remove an entry when upstream adopts the behavior or this fork drops it.

## Divergences

### Verified Ghostel image paste

- **Decision:** Verify OSC 5522 request identity, framing, byte count, SHA-256, expiry, and image decoding before one guarded editor commit.
- **Decision:** Cancel pending receipt when the session, editor, or terminal lifecycle changes. Require a known image container only for verified receipt.
- **Decision:** Use the Rust image library for classic TIFF in either byte order. Preserve original TIFF bytes during transfer and storage. Normalize the model attachment to PNG, and prefer PNG when both clipboard formats are available.
- **Runtime:** Rebuild the native addon with `bun run setup`. Existing OMP processes must restart to load the portable TIFF decoder.
- **Upstream as of `v18.12.2`:** Upstream resolves stalled OSC/DCS/APC strings by grammar (`091f36ca41` and follow-ups). A pending string head never takes the key flush timer, it is abandoned only after 5s without a read, and it then stays dormant for 10s so a late tail still completes it. This covers the fork's former 10-second kitty hold, so the fork dropped `stringHoldTimeout` and its interrupted-OSC filter. The fork keeps its torn-string discard exit on a fresh ESC.
- **Why:** Incomplete or stale transfers must not alter a draft or attach an image to the wrong destination. Local and legacy image routes stay unchanged.
- **Key paths:** `packages/coding-agent/src/utils/enhanced-paste.ts`, `packages/coding-agent/src/modes/controllers/input-controller.ts`, `packages/coding-agent/src/modes/interactive-mode.ts`, `packages/tui/src/chat/image-loading.ts`, `packages/tui/src/stdin-buffer.ts`, and `packages/tui/src/tui.ts`.
- **Checks:** `packages/coding-agent/test/utils/enhanced-paste.test.ts`, `packages/coding-agent/test/input-controller-enhanced-paste.test.ts`, `packages/coding-agent/test/image-input.test.ts`, `packages/tui/test/image-loading.test.ts`, `packages/tui/test/start-listener.test.ts`, and `packages/tui/test/stdin-buffer.test.ts`.

### Empty Enter with live-steering messages

- **Decision:** Count displayable live-steering claims as pending until the agent loop records their delivery.
- **Behavior:** Empty Enter interrupts the active response and resumes with the pending message in both main and focused sessions.
- **Why:** Upstream commit `a969abf4d6` introduced live steering. A claimed message left the queue count at zero while the screen still showed `Steering · 1`, disabling empty-Enter interruption.
- **Upstream as of `v18.9.2`:** Upstream gates empty Enter through `hasInterruptibleInput`, which also peeks undelivered messages. Its `queuedMessageCount` still omits them. The fork keeps the broader count, which also feeds RPC `queuedMessageCount`, `hasPendingMessages`, and settle checks.
- **Key paths:** `packages/agent/src/agent.ts` and `packages/coding-agent/src/session/agent-session.ts`.
- **Checks:** `packages/coding-agent/test/agent-session-queued-steer-delivery.test.ts` covers accepted and rejected claims in main and focused sessions. `packages/coding-agent/test/rpc-queued-message.test.ts` (`withdraws a steer the streaming response already claimed live`) waits for the fixture's `live-steer-claimed` marker, because the RPC state still counts the claimed steer. It then checks that `abort_and_restore_queue` withdraws that steer.
- **Retire when:** Upstream's `queuedMessageCount` includes unrecorded live-steering deliveries and the regression check passes.


### Local source installation

- **Decision:** Use this fork's checkout and `bun run setup` for installation, repair, and updates.
- **Why:** Upstream packages and installers replace the fork and omit its changes.
- **Key paths:** `README.md`, `AGENTS.md`, `packages/coding-agent/README.md`, `scripts/setup.ts`, and `scripts/link-omp.sh`.
- **Checks:** Follow the command-target and runtime checks in `README.md` under Install.

### Host-only Rust toolchain

- **Decision:** `rust-toolchain.toml` lists no extra `targets`. Rustup installs only the host standard library.
- **Why:** This fork builds from source on the maintainer's machine and ships no release artifacts. The upstream list adds three cross-target standard libraries to every pinned toolchain.
- **Key path:** `rust-toolchain.toml`.
- **Check:** `bun run setup` and `bun run check:rs` pass.
- **Merge note:** Upstream changes `channel` in this file on toolchain bumps. Take the new `channel` and keep the `targets` line out.

### Move into an existing worktree

- **Decision:** Keep `/wtmove` to move the current session into an existing worktree without creating a branch or carrying source changes.
- **Decision:** Match branch names and worktree paths. Preserve exact-root identity for trailing spaces and Unicode spaces.
- **Decision:** Offer existing worktrees in slash-command completion. Do not add a move destination to the launch's exit-removal list.
- **Why:** A session must reuse an existing checkout without creating another worktree or changing its files.
- **Key paths:** `packages/coding-agent/src/session/session-worktree.ts`, `packages/coding-agent/src/modes/controllers/command-controller.ts`, `packages/coding-agent/src/modes/interactive-mode.ts`, and `packages/coding-agent/src/slash-commands/`.
- **Checks:** `packages/coding-agent/test/session-worktree-move.test.ts`, `packages/coding-agent/test/modes/controllers/move-command.test.ts`, and `packages/coding-agent/test/session-manager/move-to.test.ts`.
- **Retire when:** Upstream provides the same existing-worktree move and completion behavior.

### Project-local prompt history

- **Decision:** Start Ctrl-R history in the active working directory and let Tab switch to all projects without changing the query.
- **Decision:** Keep each prompt unique globally while preserving its membership and latest metadata in every recorded working directory.
- **Decision:** Omit transient lifecycle commands and non-interactive `/mcp add` arguments from persisted prompt history.
- **Decision:** Upstream `v18.12.2` quarantines a damaged `history.db` and salvages its readable rows. The salvage also copies `history_locations` and each salvaged prompt's own directory, so project-local recall survives it. Every recall query, scoped or global, skips rows whose prompt, timestamp, or use count decodes with a foreign column type. A scoped query checks the timestamp of the location row it returns.
- **Why:** Local-first results remove unrelated project prompts. The filter also removes stale actions and protects credentials in MCP command arguments.
- **Key paths:** `packages/coding-agent/src/session/history-storage.ts`, `packages/tui/src/overlays/history-search.ts`, `packages/coding-agent/src/modes/controllers/selector-controller.ts`, and `packages/coding-agent/src/modes/controllers/input-controller.ts`.
- **Checks:** `packages/coding-agent/test/history-storage-search.test.ts`, `packages/coding-agent/test/history-storage-sqlite-compat.test.ts`, `packages/coding-agent/test/modes/components/history-search.test.ts`, `packages/coding-agent/test/keybindings-selector-navigation.test.ts`, `packages/coding-agent/test/slash-commands/history-security.test.ts`, and `packages/coding-agent/test/input-controller-slash-history.test.ts`.

### Debate plan workflow with implementation review

- **Decision:** Keep the `/debate` plan workflow: an independent read-only reviewer must reach exact-byte consensus on the plan before human approval, capped at `plan.debateMaxRounds` with deadlock escalation.
- **Decision:** Extend the contract through execution: after debate approval, the agent submits the finished implementation through `xd://propose` and the reviewer must accept it (toggle: `plan.implReview`, default on).
- **Decision:** Restore active and paused debate state in ACP after session load, including consensus and interrupted reviews.
- **Why:** Upstream plan mode ends at human approval; this fork wants machine review on both the plan and its implementation with the human as the escalation path.
- **Key paths:** `packages/coding-agent/src/plan-mode/state.ts`, `packages/coding-agent/src/plan-mode/debate.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/modes/interactive-mode.ts`, `packages/coding-agent/src/modes/acp/acp-agent.ts`, `packages/coding-agent/src/prompts/agents/impl-reviewer.md`, and `docs/debate-plan-mode.md`.
- **Checks:** `packages/coding-agent/test/plan-mode/debate.test.ts`, `packages/coding-agent/test/plan-mode/impl-review.test.ts`, `packages/coding-agent/test/agent-session-impl-review.test.ts`, `packages/coding-agent/test/interactive-mode-impl-review.test.ts`, and `packages/coding-agent/test/acp-agent.test.ts`.

### Claude three-line footer

- **Decision:** Support `composerStyle.footerMode: claude3` across composer shapes and extension shapes.
- **Appearance:** Keep the loader spinner when the footer hides the `pi` brand segment.
- **Appearance:** Use the theme model color in this footer instead of the session accent.
- **Why:** The fixed footer replaces the normal status layout, so upstream spinner and accent assumptions do not apply.
- **Key paths:** `packages/tui/src/status-line/component.ts`, `packages/tui/src/components/composer/preferences.ts`, and `packages/coding-agent/src/modes/interactive-mode.ts`.
- **Checks:** `packages/coding-agent/test/modes/components/status-line/component.test.ts` and `packages/coding-agent/test/interactive-mode-working-accent.test.ts`.

### Working message icon spacing

- **Decision:** Leave one extra visual cell between the working icon and its message.
- **Why:** Spinner and Escape glyphs otherwise touch the message in common terminal fonts.
- **Key path:** `packages/coding-agent/src/modes/interactive-mode.ts`.
- **Check:** `packages/coding-agent/test/interactive-mode-working-accent.test.ts`.

### Working message timer

- **Decision:** Show elapsed turn time on the working row with `tui.workingTimer` (default: `true`).
- **Decision:** Use `tui.workingTimerMinSeconds` (default: `0`) to delay the timer. Hide it when the status brand already shows one.
- **Decision:** Keep the working-row suffix order tok/s readout, session title, turn timer. The readout comes from upstream's `composer.tokenRate` (default off); the timer keeps its own gating beside it.
- **Decision:** Between turns, keep the last turn's time docked right on the idle row. Native rendering puts it in upstream's `omp.hud.activity` status column, ahead of the todo HUD. The idle tok/s reading is upstream's composer-bar rate, so the idle row does not repeat it.
- **Why:** Users need turn duration when the selected footer omits the status brand.
- **Key paths:** `packages/coding-agent/src/modes/interactive-mode.ts` (`#describeIdleStatusHud`, `describeStatusHud`), `packages/coding-agent/src/modes/settings.ts`, and `packages/utils/src/format.ts`.
- **Checks:** `packages/coding-agent/test/interactive-mode-working-accent.test.ts`, `packages/coding-agent/test/interactive-mode-idle-turn-timer.test.ts`, and `packages/utils/test/format.test.ts`.

### Subagent generation rates

- **Decision:** With `composer.tokenRate` on, show each pinned subagent's live or last generation rate and the live total. The total follows upstream's `Subagents · N running` header and comes before upstream's agent-hub key hint.
- **Decision:** Preserve rates alongside upstream live tool previews. Quiet streaming spans still refresh rates, and a focused subagent uses the same reading.
- **Key paths:** `packages/coding-agent/src/modes/interactive-mode.ts`.
- **Check:** `packages/coding-agent/test/subagent-hud-render.test.ts`.

### IDE selection and open-file context

- **Decision:** Read IDE MCP notifications for selections and open files.
- **Decision:** Add the full file path to model reminders and show IDE state in the status footer.
- **Decision:** Rediscover and reconnect the IDE MCP endpoint after the editor restarts.
- **Decision:** Keep IDE-provider servers out of the generic lost-server retry schedule (`#lostRemoteServers`). The lockfile poll (`#scheduleIdeReconnectPoll`) owns discovery and pacing for the IDE bridge, so a second schedule would double every reconnect attempt.
- **Decision:** Publish `session_state_changed` (`idle`, `working`, `needs-input`, `done`, `failed`) to the IDE MCP server at turn and modal-dialog boundaries, and re-announce it after every reconnect. Only the main session publishes: focusing a subagent sends nothing, and returning to main or closing an idle dialog re-announces how the main session's last turn ended instead of a blanket `idle`.
- **Decision:** Carry the session working directory in every `session_state_changed` payload, and republish the unchanged state when the directory moves (`/wt`, `/move`, persistent `!cd`, cross-project `/resume`), so the editor can relabel a running session instead of showing its start directory.
- **Why:** The model needs current editor context even when the editor or its endpoint restarts, and the editor needs the exact agent state instead of terminal-output guesses.
- **Key paths:** `packages/coding-agent/src/discovery/ide.ts`, `packages/coding-agent/src/mcp/config.ts`, `packages/coding-agent/src/mcp/manager.ts`, `packages/coding-agent/src/mcp/ide-selection.ts`, `packages/coding-agent/src/session/ide-selection-reminder.ts`, `packages/tui/src/status-line/segments.ts`, `packages/coding-agent/src/mcp/ide-state.ts`, `packages/coding-agent/src/modes/controllers/event-controller.ts`, `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts`, and `packages/coding-agent/src/modes/controllers/session-focus-controller.ts`.
- **Checks:** `packages/coding-agent/test/discovery/ide.test.ts`, `packages/coding-agent/test/mcp-manager-ide-reconnect.test.ts`, `packages/coding-agent/test/mcp/ide-selection.test.ts`, `packages/coding-agent/test/ide-selection-reminder.test.ts`, `packages/coding-agent/test/ide-selection-segment.test.ts`, `packages/coding-agent/test/mcp/ide-state.test.ts`, `packages/coding-agent/test/modes/controllers/event-controller-ide-state.test.ts`, `packages/coding-agent/test/modes/controllers/extension-ui-controller-ide-state.test.ts`, and `packages/coding-agent/test/modes/controllers/ide-state-approval.test.ts`.

### Pinned composer

- **Decision:** Let `tui.pinComposerBottom` keep the composer at the viewport bottom.
- **Decision:** Preserve the pin after transcript history commits and cold startup.
- **Decision:** Size filler from the current chrome and visible history. Let real content grow to full screen height and move older history into scrollback.
- **Decision:** Use the current chrome height for history retirement. Save displaced command and tool rows before clipping the viewport.
- **Decision:** Keep `RuntimeChildrenOptions.transient`. The report panel mounts as a transient root, so it clips the transcript without retiring rows.
- **Upstream as of `v18.11.3`:** Upstream (`25d28798d9`, then #15820) bills chrome at a floor. It promotes the floor after an idle settle and feeds run state through `Composer.setRunActive`. The fork keeps current-chrome retirement and `RuntimeChildrenOptions.transient`. It does not carry the floor, `setRunActive`, `transientChrome`, or `selfClearingChrome`. It adopts upstream's `getFilledHistoryRows` slack, parked below the live rows. That slack is off while a bottom overlay restore is active.
- **Upstream as of `v18.12.2`:** Upstream added `tui.completeScrollback` (default `false`), which bills all chrome at its current height instead of the floor. The fork already bills current chrome, so in the fork the setting only decides whether a transient root (a command report) also retires the rows it covers. Off keeps the clip-without-retire decision above.
- **Why:** A stable input position reduces visual movement in long sessions.
- **Key paths:** `packages/tui/src/prompt/composer.ts`, `packages/coding-agent/src/modes/interactive-mode.ts`, and `packages/tui/src/tui.ts`.
- **Checks:** `packages/coding-agent/test/composer-pin-bottom.test.ts`, `packages/tui/test/composer-inline-shrink.test.ts`, `packages/tui/test/transcript-seam-loss.test.ts`, `packages/tui/test/report-panel.test.ts`, and `packages/coding-agent/test/startup-composer.test.ts`.

### Full assistant text during streaming

- **Decision:** Keep `display.streamingScrollback` as an opt-in setting, defaulting to `false`.
- **Decision:** Render the full mutable Markdown transcript through atomic history replacements when earlier rows change.
- **Decision:** Preserve existing shell history on startup. Shutdown appends the unretired tail without clearing or replaying accepted history.
- **Decision:** Use row-pressure retirement by default, with capacity based on current chrome. A live append-only head retires finished rows to native history in one batch per cycle.
- **Decision:** An append batch keeps growing until it covers the overflow, even when its last block reaches back onto the screen.
- **Upstream as of `v18.10.4`:** Upstream (`ddb2cfff2b`) stops a batch before any block that would reach the screen. A streamed paragraph renders as several rows, so its rows above the screen were in neither the frame nor native history.
- **Why:** Users can read early assistant text before finalization, including unfinished paragraphs and open code fences.
- **Key paths:** `packages/tui/src/prompt/composer.ts`, `packages/tui/src/chrome/transcript-container.ts` (`#measuredAppendBatch`, `#renderedAppendBatch`), `packages/coding-agent/src/modes/settings.ts`, and `packages/tui/src/tui.ts`.
- **Checks:** `packages/coding-agent/test/composer-streaming-scrollback.test.ts`, `packages/tui/test/transcript-container.test.ts`, and `packages/tui/test/history-frame-plan.test.ts`.
- **Known gap:** CLI startup still requests history clearing in `startup-composer.ts`. This predates `v18.3.2`. The composer checks do not verify shell-history preservation through that caller. Keep the preservation decision.

### Collapsed command cards

- **Decision:** Show submitted prompt-template and file commands in bordered normal-prompt blocks with terminal prompt markers.
- **Decision:** Keep the command, size, line count, and `ctrl+o` summary below. Hide the expanded template body until `ctrl+o`.
- **Decision:** Gate both card kinds at render time with `display.collapseCommandCards` (default on).
- **Decision:** Preserve compact command cards for steering and follow-up messages. Queue labels and restored drafts use the original command and arguments.
- **Why:** The transcript should show the submitted command without repeating expanded template text.
- **Key paths:** `packages/coding-agent/src/config/prompt-templates.ts`, `packages/coding-agent/src/extensibility/slash-commands.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/tui/src/chat/user-message.ts`, `packages/tui/src/chat/chat-transcript-builder.ts`, `packages/coding-agent/src/modes/utils/ui-helpers.ts`, `packages/coding-agent/src/modes/controllers/selector-controller.ts`, and `packages/coding-agent/src/modes/settings.ts`.
- **Checks:** `packages/coding-agent/test/agent-session-command-card.test.ts` and `packages/coding-agent/test/agent-session-queued-steer-delivery.test.ts`.

### Emacs-hosted resize behavior

- **Decision:** Skip the transient alternate-screen resize borrow in direct Emacs terminal buffers.
- **Why:** Emacs shows the borrow as a full-buffer swap and flicker. Its discrete resizes do not need the drag optimization.
- **Key paths:** `packages/tui/src/terminal-capabilities.ts` and `packages/tui/src/tui.ts`.
- **Checks:** `packages/tui/test/process-terminal-render.test.ts` and `packages/tui/test/resize-multiplexer-anchor.test.ts`.

### Opt-in terminal directory reporting

- **Decision:** Keep `terminal.reportCwd` disabled by default. Only the active interactive TUI sends OSC 7 directory reports.
- **Decision:** Report startup, successful main-process directory changes, and live enable transitions. Use tmux passthrough when needed.
- **Why:** Ghostel must follow OMP directory changes without changing the parent shell's directory or adding bytes to non-interactive output.
- **Key paths:** `packages/utils/src/dirs.ts`, `packages/coding-agent/src/utils/terminal-directory.ts`, `packages/coding-agent/src/modes/interactive-mode.ts`, and `packages/coding-agent/src/modes/settings.ts`.
- **Checks:** `packages/utils/test/dirs.test.ts`, `packages/coding-agent/test/terminal-directory.test.ts`, and source CLI checks in Ghostel with direct and tmux output.

### Constant write preview height

- **Decision:** Keep the streaming write-tool preview at a constant height.
- **Decision:** Wrapped collapsed-preview rows hang under the code column inside the reserved gutter width, so the row count stays the same.
- **Why:** Stable preview geometry prevents the composer and transcript from moving during streamed arguments.
- **Key path:** `packages/tui/src/tools/write.ts`.
- **Checks:** `packages/tui/test/write-streaming-incremental-render.test.ts` and `packages/coding-agent/test/write-streaming-preview-expand.test.ts`.

### Image identity keyed on content

- **Decision:** Key terminal-graphics ids on the image bytes, not the placement site alone. Call sites embed `imageContentTag(image)` in the `imageKey` (assistant, tool, and bash images) or pass it as `contentTag` (composer attachment chips).
- **Decision:** Keep `ImageBudget.acquireId(key, contentTag)`: a key names the placement site, and a changed tag supersedes the id so the new bytes transmit instead of the terminal redrawing the previous image.
- **Decision:** Retire a superseded id like a demotion on the pass's own surface — cancel an unflushed transmit or queue `d=I` — and leave a copy resident on the other surface, plus its key, alone.
- **Why:** A site whose bytes changed kept an id `shouldTransmit()` had already marked sent, so the terminal re-drew the earlier image forever. Upstream keys on the placement site and has no content tag.
- **Key paths:** `packages/tui/src/components/image.ts`, `packages/tui/src/prompt/image-references.ts`, `packages/tui/src/chat/assistant-message.ts`, `packages/tui/src/chat/tool-execution.ts`, `packages/tui/src/chat/bash-execution.ts`, and `packages/tui/src/prompt/attachment-chips.ts`.
- **Checks:** `packages/tui/test/image-budget.test.ts` (`supersedes a key's id when its content tag changes so the new bytes transmit`, `cancels a superseded id's transmit instead of purging it when the bytes never flushed`).

### Model profiles

- **Decision:** Support named `modelProfiles` bundles for role models.
- **Decision:** Support startup selection, cycling, CLI selection, and `/model-profile` changes.
- **Decision:** Preserve project profiles during discovery reloads and restore the profile default after plan mode.
- **Decision:** Nested session construction must not replace a live session's role bundle. Explicit session restoration still applies the incoming session's profile policy.
- **Decision:** Keep `modelProfileSwitchNotice` (default `true`). When disabled, picker and resume-prompt switches omit success notices without hiding errors.
- **Decision:** Profiles switch the main session's role bundle only. Upstream `v18.12.3` lets `/model`, `/switch`, `/effort`, Ctrl+P, and Shift+Tab act on a focused subagent. `/model-profile`, the profile picker, and profile cycling still refuse in a focused view.
- **Why:** One action must switch the complete role-model set for a workflow.
- **Key paths:** `packages/coding-agent/src/config/model-roles.ts`, `packages/coding-agent/src/config/settings.ts`, `packages/coding-agent/src/session/model-controls.ts`, and `packages/coding-agent/src/session/agent-session.ts`.
- **Checks:** `packages/coding-agent/test/agent-session-model-profiles.test.ts`, `packages/coding-agent/test/sdk-nested-session-shared-settings.test.ts`, `packages/coding-agent/test/cli-model-profile-flag.test.ts`, `packages/coding-agent/test/model-profile-picker.test.ts`, and `packages/coding-agent/test/slash-commands/model-profile.test.ts`.

### Prewalk controls

- **Decision:** Keep `prewalk.into`, including `@@` to keep the active model and `@@:<level>` to change only its thinking level.
- **Decision:** Keep `/prewalk off` and the unbound-by-default `app.prewalk.toggle` action. The key preserves the editor draft. Upstream `v18.7.0` added its own `/prewalk off`. The fork keeps its wording and its silent disarm. Like upstream, `off` drops only the current session's handoff and keeps `prewalk.auto` from arming until `/new`, and `/new` re-arms when `prewalk.enabled` is on.
- **Decision:** Disarming is silent. `prewalk.armNotice` (default `true`) controls the arm notice, including auto-prewalk arms, and slash-command success output. `/prewalk off` prints `Prewalk: nothing armed.` only when nothing was armed.
- **Decision:** Upstream's `/new` re-arm resolves `prewalk.into`, not `@smol`. With `@@`, it keeps the model that is active after `/new`. A plain `@@` handoff records no handoff, so `/new` restores nothing.
- **Upstream as of `v18.11.3`:** Upstream added auto-prewalk (`prewalk.auto`, `prewalk.autoTarget`). The fork adopts it. Auto arms use the fork's arm-notice gate. `prewalk.autoTarget` does not accept `@@`, which stays limited to `prewalk.into`, `--prewalk-into`, and subagent targets.
- **Key paths:** `packages/coding-agent/src/session/prewalk.ts`, `packages/coding-agent/src/session/settings.ts`, `packages/coding-agent/src/slash-commands/builtin-modes.ts`, and `packages/coding-agent/src/modes/controllers/input-controller.ts`.
- **Checks:** `packages/coding-agent/test/agent-session-prewalk.test.ts`, `packages/coding-agent/test/agent-session-prewalk-off.test.ts`, `packages/coding-agent/test/agent-session-prewalk-auto.test.ts`, `packages/coding-agent/test/input-controller-keybindings.test.ts`, `packages/coding-agent/test/prewalk-discovery-provider.test.ts`, and `packages/coding-agent/test/task/executor-prewalk.test.ts`.

### Per-call subagent model selection

- **Decision:** Keep `model` on flat task calls, each batch item, eval `agent()`, and eval `workpool()`. Reject `model` on a batch container. Upstream's `guardBatchAgent` also rejects `agent` there.
- **Decision:** Upstream's seance agent also reads `model`, as its source-model override. Keep `model` valid for every agent. `validateSeanceFields` in `packages/coding-agent/src/task/seance.ts` rejects only `sourceSession` on other agents.
- **Decision:** A model array is an ordered preference. Explicit selectors take precedence over agent defaults and parent inheritance.
- **Decision:** Inherit the live model route and effective thinking level when no explicit selector applies. Preserve agent-level effort precedence.
- **Decision:** Explicit selectors must not remove OAuth account pools or cyber restrictions. Configured retry chains remain separate from selector preferences.
- **Why:** Upstream commit `31876ff53e` removed per-call selectors. This fork keeps them for task-specific model choices.
- **Key paths:** `packages/coding-agent/src/config/model-resolver.ts`, `packages/coding-agent/src/sdk.ts`, `packages/coding-agent/src/task/`, `packages/coding-agent/src/eval/agent-bridge.ts`, `packages/coding-agent/src/eval/workpool-bridge.ts`, and `packages/coding-agent/src/vibe/runtime.ts`.
- **Checks:** `packages/coding-agent/test/model-resolver.test.ts`, `packages/coding-agent/test/sdk-active-selector.test.ts`, `packages/coding-agent/test/task/task-schema.test.ts`, `packages/coding-agent/test/task/structured-subagent.test.ts`, `packages/coding-agent/test/sdk-model-selection.test.ts`, `packages/coding-agent/test/sdk-subagent-auth-inheritance.test.ts`, `packages/coding-agent/test/eval/agent-bridge-policy.test.ts`, `packages/coding-agent/test/eval/workpool-bridge.test.ts`, `packages/coding-agent/test/eval/prelude-agent.test.ts`, `packages/coding-agent/test/eval/prelude-runtime.test.ts`, `packages/coding-agent/test/eval/py/prelude.test.ts`, `packages/coding-agent/test/task/workpool.test.ts`, and `packages/coding-agent/test/interactive-mode-vibe-toggle.test.ts`.

### Five-level task effort

- **Decision:** Keep `low`, `medium`, `high`, `xhigh`, and `max`. Reject upstream's `lo`, `med`, and `hi` names.
- **Decision:** Resolve effort through the role model map and retain the `task.maxEffort` ceiling.
- **Decision:** The task tool lists each level with the `auto` classifier's criterion, read from `packages/coding-agent/src/prompts/judge/auto-thinking.json`.
- **Decision:** Caller effort wins over an explicit selector suffix, agent effort, and inherited parent effort.
- **Key paths:** `packages/coding-agent/src/task/types.ts`, `packages/coding-agent/src/task/executor.ts`, `packages/coding-agent/src/prompts/tools/task.md`, and `docs/tools/task.md`.
- **Checks:** `packages/coding-agent/test/task/task-schema.test.ts`, `packages/coding-agent/test/task/executor-pass-through.test.ts`, `packages/coding-agent/test/sdk-subagent-auth-inheritance.test.ts`, and `packages/tui/test/task-render.test.ts`.

### Per-model compaction thresholds

- **Decision:** Resolve compaction settings per active model through `compaction.modelOverrides` selector patterns. An exact `provider/id` key wins, else the first matching wildcard in declaration order.
- **Decision:** A matching override replaces the whole threshold policy (`thresholdTokens`, `thresholdPercent`, `reserveTokens`); it never merges into the global group.
- **Decision:** An exact agent override wins over `modelOverrides`, upstream's `modelThresholds`, and global settings, in that order.
- **Decision:** Use upstream's `modelThresholds` only when no fork pattern matches. Keep its longest-prefix rule and global reserve.
- **Decision:** Apply `compaction.modelThresholdsEnabled` to both maps. Restore the root policy for descendants after an exact agent override.
- **Decision:** Resolve session, advisor, promotion, and Model Hub policies through the same resolver. Reject Model Hub writes that a fork pattern would hide.
- **Decision:** A matching `modelOverrides` pattern also hides the `modelThresholds` extended-window opt-in. `ModelRegistry` checks fork patterns before it opens an extended window. A fork policy never opens one itself. The Model Hub preview shows nothing for an input that a fork pattern would hide. A hub reset previews the fork policy.
- **Why:** One global threshold cannot fit models with very different context windows.
- **Key paths:** `packages/coding-agent/src/session/context-settings.ts`, `packages/coding-agent/src/session/model-compaction-threshold.ts`, `packages/coding-agent/src/config/model-registry.ts`, `packages/coding-agent/src/session/session-maintenance.ts`, and `packages/coding-agent/src/session/session-advisors.ts`.
- **Checks:** `packages/coding-agent/test/compaction-model-overrides.test.ts`, `packages/coding-agent/test/config/compaction-threshold.test.ts`, `packages/coding-agent/test/model-registry.test.ts`, `packages/coding-agent/test/task/executor-pass-through.test.ts`, and `packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts`.

### Native JJ snapshot contract test

- **Decision:** Keep the fork's `native JJ workspace queries` snapshot test. It asserts that status comes from the recorded working copy until `changedFiles([], true)` takes an explicit snapshot.
- **Why:** The revised assertions match the observed native `pi-vcs` behavior. Upstream deleted the older version of this test instead of revising it, so an unwatched merge would drop the coverage.
- **Key path:** `packages/coding-agent/test/utils/jj.test.ts`.
- **Check:** `packages/coding-agent/test/utils/jj.test.ts`.

### Composer input packets and queue-body commands

- **Decision:** Accept `ESC _ pi:prompt;<command> ESC \` and `ESC _ pi:keyword;<word> ESC \` input packets from terminal hosts. A prompt packet replaces or inserts the draft's leading slash command, a keyword packet places a standalone word at the message start, and neither moves the body cursor.
- **Decision:** Treat a `->` / `=>` queue shorthand as a header. Packets, the leading-command edits, and command recognition take the body line and anchor from `queueShorthandBodyStart`, so a command never lands in front of the shorthand and a bare prefix keeps its header line with the body appended below.
- **Decision:** Color-highlight a fully recognized leading command and inline `/skill:name` tokens in the composer, scanning from the message start rather than column 0 so a queued body keeps its highlight. A replaced autocomplete provider invalidates the cached recognition.
- **Decision:** Expand file commands before prompt templates in steering and follow-up messages. This includes upstream `v18.12.6`'s ACP `_session/steering` admission (`AgentSession.joinActiveTurn`), which also keeps the command card. Queue shorthand and `/queue` also load registered skill commands.
- **Decision:** Preserve command images and queue modes during compaction replay, including mixed and command-only queues.
- **Decision:** Keep `app.message.toggleQueue` (default `Alt+Q`, `Alt+Shift+Q`). It calls `CustomEditor.toggleQueuePrefix`, which adds a `->` header line or removes an existing `->` / `=>` prefix, and keeps the body cursor.
- **Why:** Editors such as claude-code-ide.el drive the composer through these packets instead of terminal keystrokes, and a command queued for the next yield must stay visible and reach the message body. Upstream has no packet intake, no leading-command editor API, and no recognition ranges.
- **Key paths:** `packages/tui/src/prompt/composer.ts`, `packages/tui/src/prompt/queue-input.ts`, `packages/tui/src/prompt/custom-editor.ts`, `packages/coding-agent/src/modes/controllers/input-controller.ts`, `packages/coding-agent/src/modes/utils/ui-helpers.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/tui/src/components/editor.ts`, and `packages/tui/src/autocomplete.ts`.
- **Checks:** `packages/coding-agent/test/startup-composer.test.ts`, `packages/tui/test/custom-editor.test.ts`, `packages/coding-agent/test/agent-session-queued-steer-delivery.test.ts`, `packages/coding-agent/test/input-controller-skill-queue.test.ts`, `packages/tui/test/editor.test.ts`, and `packages/coding-agent/test/agent-session-prompt-abort-race.test.ts` (`joinActiveTurn queues the same expanded steer as steer()`).

### OSC 133 prompt markers on submitted messages

- **Decision:** Emit OSC 133 `A` before the first content row's one-column margin and `B` before its text. Close `C` and `D;0` after the last content row.
- **Decision:** Leave padding outside the prompt zone. Empty messages and synthetic bodies emit no prompt markers.
- **Why:** Ghostel navigation must find one input boundary per submitted message, not a separate prompt on each rendered row.
- **Key path:** `packages/tui/src/chat/user-message.ts`.
- **Checks:** `packages/coding-agent/test/modes/components/user-message-keywords.test.ts`.

### Escape drops a hidden autocomplete popup

- **Decision:** When Escape runs the interrupt, first cancel an open autocomplete that has no visible row. Its pending refresh cannot show a popup after the interrupt. A single Escape still interrupts.
- **Why:** An `@` list narrowed to no match stays open internally while its refresh is pending. Upstream's interrupt shortcut returned before the base editor dropped it, so a late popup appeared after Escape.
- **Key paths:** `packages/tui/src/prompt/custom-editor.ts` and `packages/tui/src/components/editor.ts` (`cancelAutocomplete`).
- **Check:** `packages/tui/test/custom-editor-keybindings.test.ts`.
- **Retire when:** Upstream's interrupt path cancels hidden autocomplete state.

### Cyber mode allowlist

- **Decision:** Keep `cyberModels` and `cyberMode`. Filter every role chain and refuse operator model switches outside the allowlist. Empty chains use the first resolved declaration.
- **Decision:** Bind filtered selectors and primary fallback to concrete model identities. A reduced catalog cannot select an excluded fuzzy match. Block launch selection when no approved target remains.
- **Decision:** Report startup and live substitutions once per role/model pair in each transcript. Same-transcript reloads retain notice history. Enable and status output list every allowed model.
- **Decision:** Record cyber state on every model change, including recovery. Resume, fork, side-answer branches, and tree navigation restore the destination state. Context reset retains the current state.
- **Decision:** Revalidate inherited state for `/new`, `/delete`, forks, and branch adoption. Unusable declarations disable the session with a warning. Branch adoption records a degraded off state.
- **Decision:** Failed session switches restore outgoing protection and notice history. Publish cyber notices only after a successful switch. Resumed active-model substitutions use the startup warning channel.
- **Decision:** Send print/RPC startup warnings to stderr at CLI session creation. Publish ACP warnings after registration, excluding temporary-session transitions.
- **Decision:** Keep protection on shared configuration state. An implicit clear removes only its owner's claim. An explicit operator switch-off clears all claims.
- **Decision:** Parked subagent settings retain their exact protection claims during warm revival. Dynamic retry-role installation preserves raw configured chains, and the `session_init` read-back persists the raw primary, not its filtered substitute.
- **Revival and retry checks:** `packages/coding-agent/test/task/parked-subagent-session-release.test.ts` and `packages/coding-agent/test/retry-fallback.test.ts`.
- **Decision:** Apply installed membership checks to background overrides, fallback traversal, cache-warm replays, and dispatch. A retained callback re-checks protection before it dispatches, and a session that shares another session's protection stays constrained while its own indicator is off.
- **Why:** Operators need to restrict cyber work to approved models. This allowlist does not bypass provider safety restrictions. Preserve the filtering, switch guard, `cyber` status-line segment, and lifecycle rules.
- **Key paths:** `packages/coding-agent/src/config/cyber-mode.ts`, `packages/coding-agent/src/config/model-resolver.ts`, `packages/coding-agent/src/config/settings.ts`, `packages/coding-agent/src/config/model-roles.ts`, `packages/coding-agent/src/session/model-controls.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/session/turn-recovery.ts`, `packages/coding-agent/src/session/session-advisors.ts`, `packages/coding-agent/src/session/session-maintenance.ts`, `packages/coding-agent/src/eval/completion-bridge.ts`, `packages/coding-agent/src/tiny/online-candidates.ts`, `packages/coding-agent/src/judgment/index.ts`, `packages/coding-agent/src/mnemopi/backend.ts`, `packages/coding-agent/src/sdk.ts`, `packages/tui/src/status-line/segments.ts`, `packages/coding-agent/src/slash-commands/builtin-modes.ts`, and `docs/cyber-mode.md`.
- **Checks:** `packages/coding-agent/test/cyber-mode.test.ts`, `packages/coding-agent/test/cyber-mode-session.test.ts`, `packages/coding-agent/test/cyber-mode-shared-settings.test.ts`, `packages/coding-agent/test/cyber-switch-guard.test.ts`, `packages/coding-agent/test/agent-session-retry-fallback.test.ts`, `packages/coding-agent/test/eval/completion-bridge.test.ts`, `packages/coding-agent/test/online-tiny-candidates.test.ts`, `packages/coding-agent/test/judgment/index.test.ts`, `packages/coding-agent/test/compaction-cyber-candidates.test.ts`, `packages/coding-agent/test/compaction-cyber-dispatch.test.ts`, `packages/coding-agent/test/main-cyber-warnings.test.ts`, `packages/coding-agent/test/status-line-cyber.test.ts`, and `packages/coding-agent/test/slash-commands/cyber.test.ts`.
- **Decision:** Skip the session model's `imageModel` and `webSearchModel` companions when the allowlist excludes them.
- **Companion key paths and checks:** `packages/coding-agent/src/tools/image-gen.ts` and `packages/coding-agent/src/web/search/index.ts`, checked by `packages/coding-agent/test/tools/image-gen.test.ts` and `packages/coding-agent/test/web/search/default-chain.test.ts`.
- **Known gap:** `web_search` and `generate_image` still dispatch their default fallback entries (the catalog `role-defaults` chains in `packages/catalog/src/compat/rules/runtime/behavior.kdl`, formerly `priority.json`) and an explicit request `model` without a membership check. Those entries include non-LLM search engines, so a blanket filter would disable search under cyber mode. This predates `v18.4.3`.

- **Decision:** Headless "Did you mean" suggestions list only models that the launch scope (`--models`, else `enabledModels`) and the allowlist both admit.
- **Suggestion key path and check:** `packages/coding-agent/src/main.ts`, checked by `packages/coding-agent/test/main-model-suggestions.test.ts`.

### Review plan mode

- **Decision:** Keep `reviewUsesPlan` and `/review-plan`. While the switch is on and a `plan` role resolves, `@reviewer` reads `plan` in agent resolution, retry chains, and eval completion chains. Those retry views also set aside the `reviewer` chain key (`reviewPlanRetryContext`), so it cannot claim a plan-model session by YAML order.
- **Decision:** The switch wins over saved `task.agentModelOverrides` and frontmatter for `reviewer`, `plan-reviewer`, `impl-reviewer`, and any selector whose first role alias is `@reviewer`. Only a request `model` wins over the switch. A remapped reviewer retries through the `plan` chain.
- **Decision:** Keep the live state per session in `ModelControls`, never in the shared `Settings`. Record it on `model_change.reviewPlan`. Restore order: transcript, then the parent's state, then `reviewUsesPlan`. Warn once per inactive stretch when the switch is on with no `plan` role at start, restore, or profile change.
- **Why:** A review must keep working when the reviewer's provider has no usage left. Preserve the `review_plan` status-line segment and the lifecycle rules.
- **Key paths:** `packages/coding-agent/src/config/model-resolver.ts`, `packages/coding-agent/src/session/retry-fallback-chains.ts`, `packages/coding-agent/src/session/model-controls.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/session/turn-recovery.ts`, `packages/coding-agent/src/task/executor.ts`, `packages/coding-agent/src/slash-commands/builtin-modes.ts`, `packages/tui/src/status-line/segments.ts`.
- **Checks:** `packages/coding-agent/test/review-plan-switch.test.ts`, `packages/coding-agent/test/review-plan-switch-session.test.ts`, `packages/coding-agent/test/slash-commands/review-plan.test.ts`, `packages/coding-agent/test/status-line-review-plan.test.ts`.

### CLIProxyAPI catalog discovery

- **Decision:** Support `discovery.type: cliproxyapi` for any named provider entry in `models.yml`.
- **Decision:** Read `/v1/models?client_version=pi` for advertised limits, modalities, and reasoning efforts. Claude models use `anthropic-messages` and family-specific compaction. Other models retain the configured API.
- **Decision:** Keep credentials and caches separate for each provider. Do not import catalog prompts or tool policy.
- **Why:** Multiple proxy servers need independent connections without copies of a single-connection Pi extension.
- **Key paths:** `packages/coding-agent/src/config/model-discovery.ts`, `packages/coding-agent/src/config/model-registry.ts`, and `packages/coding-agent/src/config/models-config-schema-bundle.ts`.
- **Checks:** `packages/coding-agent/test/cliproxyapi-discovery.test.ts` and a source CLI replay against two local servers.

### Compact todo HUD

- **Decision:** Keep `todo.hud` (`preview` | `compact`, default `preview`) and `/todo compact`. The HUD layout is `full | preview | compact`. A `/todo` choice is tagged with the main session id and ends with that session. A `todo.hud` change clears it.
- **Decision:** The one-line summary is shared with the short-terminal fold. It shows `TODO closed/total · current task · N blocked`, falls back to the first blocked task when no task is in progress or pending, and hides with the HUD after dismissal or auto-clear.
- **Decision:** The summary takes its own row directly above the working (spinner) row, so the working text keeps its full width. On a narrow row, the task text shrinks first, down to 12 cells, before the counts.
- **Why:** The Preview tree used 9 or more rows on long plans.
- **Key paths:** `packages/coding-agent/src/modes/interactive-mode.ts` (`todoLayout`, `setTodoLayout`, `renderCompactStatusLine`), `packages/coding-agent/src/modes/controllers/todo-command-controller.ts`, `packages/coding-agent/src/slash-commands/helpers/todo.ts`, `packages/coding-agent/src/tools/settings.ts`.
- **Checks:** `packages/coding-agent/test/interactive-mode-todo-clear.test.ts` (`selectable todo HUD layout` and the session and auto-clear cases), `packages/coding-agent/test/acp-builtins.test.ts`.

### Background pointer input on the macOS desktop root

- **Decision:** With `delivery: "background"`, pointer input on the `desktop` target, or on a `Display` target, hit-tests the frontmost listed window at the pointer origin. The input then goes through that window's background path. Foreground delivery keeps the global HID tap. Keyboard input on the desktop root is unchanged.
- **Decision:** A `menu` on a desktop-root click is refused for every delivery mode, as upstream does. A background desktop-root click goes through upstream's window background path (`background_window_pointer`) with its focus, overlay, intervention, and iPhone Mirroring guards.
- **Decision:** Fail closed with `BackgroundUnavailable` when no application window is under the point or a macOS system surface (Window Server, Dock, Control Center, ...) is on top.
- **Why:** Upstream posts all desktop-root pointer input through the global tap, which moves the user's cursor even when background delivery was requested.
- **Retire when:** Upstream routes background desktop-root pointer input without the global tap.
- **Key path:** `crates/pi-natives/src/desktop/macos/input.rs` (`desktop_background_target`, `background_window_pointer`, `pointer_origin`, `is_system_surface`).
- **Check:** `bun run test:rs` (`desktop_background_target_*` and `pointer_origin_uses_first_drag_point` in `input.rs`).

### Speckit-auto mode

- **Decision:** Keep the builtin speckit-auto mode (`/speckit-auto-mode`, `/speckit-auto <description>|resume|next`). It runs the speckit phases after clarify on its own. It checks each settled phase turn with one judge call and a text fallback, then starts the next phase after an 800 ms grace tick. It holds on questions, errors, and unreadable turns. The setting is `speckitAuto.convergeRounds` (default `3`).
- **Decision:** In analyze, a user turn without a readable report gets one more judge question, `fixed`, with the user's request in the judge state. A yes re-runs `/speckit.analyze` and counts as a remediation round. Without a judge answer the mode holds.
- **Decision:** After clarify, the mode removes a closing handoff sentence ("Run `/speckit.implement`, or say `go`") before it checks the reply. It never auto-answers a reply that offers another phase. On a turn that the user starts with free text, the next phase starts only when the reply has the phase's own report. A side reply that prints a phase's own result (such as `✅ Converged`) still counts, so steering answers keep working.
- **Decision:** While the mode acts between phases (a settled reply waits for its check, a check runs, or a start waits to submit), the terminal title, the OSC 7501 run status, and the IDE state stay `working`. The mode publishes the settled state when it holds (`needs-input`), pauses, or ends the run. A hold on the user publishes `needs-input` also while the phase's background job runs, and a later job drain does not replace it.
- **Decision:** `/speckit-auto-mode` turned on after a phase command started follows the latest user turn when it is a phase command. A settled turn gets its check at once. `/speckit-auto <description>` does not do this, because it starts its own specify turn.
- **Decision:** `/speckit-auto-mode` and `app.speckitAuto.toggle` cycle off → on → on and stopping before implement → off. The second scope (`scope: "tasks"` in the saved state) runs through analyze and remediation, then ends the run as "stopped before implement" when the decision would start implement or converge. `/speckit-auto next` follows the same stop. The scope exists so a run does not edit code while other agents work. A `/speckit.implement` or `/speckit.converge` that the user starts while the mode is on sets `run.editing`, and that run then decides like `full` (implement → converge loop). A cycle to `tasks` clears the flag, and a turn-on that follows a running phase command never sets it. A stop after an implement turn reads "stopped after <phase> (tasks mode)". The status bar shows `Speckit→analyze` while the stop applies.
- **Decision:** `speckitAuto.defaultOnStartup` (`off`/`full`/`tasks`) turns the mode on in a brand-new session (no conversation and no saved speckit-auto entry) at launch, after `/new`, and after `/delete`. The project `.omp/config.yml` overrides the global value. It stays quiet without the phase commands and gives way to plan mode, `--plan-yolo`, and `--goal`. `/speckit-auto-mode <value> [global|project]` saves it. Project saves go through the shared `Settings.setProjectValue`, which replaced the per-field `setProjectCyberMode`, `setProjectReviewUsesPlan`, and `setProjectModelProfile`.
- **Why:** The user wants an unattended spec-kit pipeline with the same status bar, Esc pause, and notifications as the other modes. An extension cannot reach the submit guard and the mode-exclusion seams.
- **Retire when:** Upstream ships an equivalent spec-kit pipeline mode.
- **Key paths:** `packages/coding-agent/src/modes/speckit-auto.ts`, `packages/coding-agent/src/prompts/speckit-auto/`, `packages/coding-agent/src/modes/interactive-mode.ts` (speckit-auto fields, tick, restore, exclusion, startup default), `packages/coding-agent/src/modes/controllers/input-controller.ts` (Esc pause, submit counter), `packages/coding-agent/src/modes/controllers/event-controller.ts` (notification suppression), `packages/coding-agent/src/modes/controllers/selector-controller.ts` and `extension-ui-controller.ts` (restore the run after a cancelled or failed session switch), `packages/coding-agent/src/slash-commands/builtin-modes.ts`, `packages/coding-agent/src/modes/settings.ts`, `packages/coding-agent/src/config/settings.ts` (`setProjectValue`), `packages/coding-agent/src/main.ts` (`startupBlocker`), `packages/tui/src/status-line/`.
- **Checks:** `packages/coding-agent/test/speckit-auto.test.ts`, `packages/coding-agent/test/interactive-mode-speckit-auto.test.ts`, `packages/tui/test/status-line-speckit-auto.test.ts`, `packages/coding-agent/test/settings-manager.test.ts`, `packages/coding-agent/test/settings-reload-cwd.test.ts`.

### Working state during background-job waits

- **Decision:** Keep the terminal title, the OSC 7501 run status, and the IDE session state at `working` while `AgentSession.hasPendingAsyncWork()` is true. This holds after the model yields with `awaitingAsyncWork`. Publish `idle`, `done`, or `failed` only after the work ends without a wake.
- **Decision:** At such a yield (a clean stop with no tool call, own jobs still running, no result waiting to wake, main session in view, no active speckit-auto run), the TUI asks the `judge` role (purpose `needs-user`, 15 s limit) whether the reply needs the user. On yes, it runs the settled teardown at once: the loader stops, the title shows `done`, the IDE shows `needs-input`, and the completion notification fires. The verdict lasts until a main-session `agent_start`, or until the judged reply is no longer the session's last reply (`/new`, `/resume`, fork, branch). A queued message drops a late yes. Viewing a running subagent does not end it, and the later job drain does not run the teardown again. The wire `agent_end`, stop hooks, RPC, ACP, and print mode do not change.
- **Why:** Upstream drops the title to idle and publishes `done` at the yield, so a session that still waits on a job looks finished. A fixed `working` state hides a question that the agent asks while a watcher runs.
- **Key paths:** `packages/coding-agent/src/modes/controllers/event-controller.ts` (`#handleTurnEnd`, `#handleAgentEnd`, `#judgeJobWait`, `jobWaitNeedsInput`), `packages/coding-agent/src/session/unexpected-stop-classifier.ts` (`classifyNeedsUser`), `packages/coding-agent/src/prompts/judge/needs-user.json`, `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts`, `packages/coding-agent/src/modes/controllers/session-focus-controller.ts`, and `packages/coding-agent/src/modes/interactive-mode.ts` (`#hidePlanReview`).
- **Checks:** `packages/coding-agent/test/modes/controllers/event-controller-abort-guard.test.ts`, `packages/coding-agent/test/modes/controllers/event-controller-ide-state.test.ts`, and `packages/coding-agent/test/unexpected-stop-classifier.test.ts`.

### Per-provider account routing

- **Decision:** Keep `auth.routing.<provider>` with `mode` (`smart`, `order`, `rotate`, `weight`, `usage`, `pace`), `stays` (`auto`, `session`, `turn`, `off`, `strict`), and `sink`. `auth.accountPolicies` uses `capPct` and `windowCapPct` instead of `reservePct`, plus `weight`, `disabled`, and `account.keySuffix`. Upstream's `reclaimAbovePct` stays: the reserve is 100 minus the smallest cap, and reclaim moves only a warm automatic pin under `stays: auto`.
- **Decision:** A `strict` session never moves to another account. After its account is removed, it fails until that account signs in again or the provider's set of accounts changes. The hold persists with the session pin, survives a restart, follows subagents, and respects session account pools.
- **Decision:** `getApiKey(model, { withinTurn })` in the agent loop and the gateway keeps the account for a request whose last message is a tool result. Key checks do not move rotation, weight, sink, or learn-once state. For an auth-gateway client scoped to accounts, the key lookups and the `strict` check use the client's credential session (`gatewayCredentialSessionId`), so all conversations on that client share one `stays` pin and one `strict` hold. This is upstream's client scope. `ModelRegistry.getApiKey` and `getApiKeyForProvider` throw unless the caller passes `{ skipMissing: true }`.
- **Decision:** A credential peek never moves the round-robin cursor in any routing mode. Upstream scans stored credentials in order. In `smart` mode, a peek for a session starts at that session's hashed index.
- **Why:** The fork ports magpie's account pool policies. Upstream has only the `smart` selection.
- **Key paths:** `packages/ai/src/auth/` (`routing.ts`, `select.ts`, `affinity.ts`, `rank.ts`, `rotation.ts`, `health.ts`), `packages/ai/src/auth-storage.ts`, `packages/ai/src/auth-gateway/dispatch.ts`, `packages/agent/src/agent.ts`, `packages/agent/src/agent-loop.ts`, `packages/coding-agent/src/session/credential-pin.ts`, `packages/coding-agent/src/session/turn-recovery.ts`, and `packages/coding-agent/src/config/model-registry.ts`.
- **Checks:** `packages/ai/test/auth-storage-routing-modes.test.ts`, `packages/ai/test/auth-gateway-account-routing.test.ts`, `packages/ai/test/auth-gateway-within-turn.test.ts`, `packages/ai/test/auth-storage-session-restriction.test.ts`, `packages/agent/test/agent.test.ts`, `packages/coding-agent/test/credential-pin.test.ts`, `packages/coding-agent/test/sdk-subagent-auth-inheritance.test.ts`, `packages/coding-agent/test/sdk-credential-disabled-bridge.test.ts`, `packages/coding-agent/test/agent-session-retry-cap.test.ts`, and `packages/coding-agent/test/advisor-toggle.test.ts`.
- **Known gap:** `packages/coding-agent/src/extensibility/skill-descriptions.ts`, `packages/coding-agent/src/eval/completion-bridge.ts`, and `packages/coding-agent/src/session/session-advisors.ts` send real requests with a key from `ModelRegistry.getApiKey`, which is a key check. Their requests therefore never move routing state. In `smart` without a session ID, they stay on one account until another request moves the turn. Follow-up: move them to `getApiKeyWithCredentialForProvider`.
- **Retire when:** Upstream ships equivalent per-provider routing and stays modes.

### /loop fixed interval and replace

- **Decision:** Keep `/loop every <duration>` (same duration grammar as the time limit). A run starts one interval after the previous run started. A due run waits for an idle session and then starts once. The wait re-checks the wall clock every second, so a run starts on time after a system sleep. While the loop waits, the status line shows `every 15m next HH:MM`.
- **Decision:** `/loop` with arguments while loop mode is on replaces the limit, interval, and condition, and keeps the prompt unless a new one is given. Only a bare `/loop` turns loop mode off. A loop run keeps the draft text and attachments in the input box (`preserveDraft`).
- **Why:** The user wants a prompt to run on a fixed schedule (for example, to check CI every 15 minutes) without cron tools, and wants to change a running loop without stopping it.
- **Key paths:** `packages/coding-agent/src/modes/loop-limit.ts` (`takeLoopInterval`, `takeDuration`), `packages/coding-agent/src/modes/interactive-mode.ts` (`#scheduleLoopAutoSubmit`, `#armLoopDueTimer`, `handleLoopCommand`), `packages/coding-agent/src/slash-commands/builtin-modes.ts`, `packages/tui/src/status-line/` (`formatLoopInterval`).
- **Checks:** `packages/coding-agent/test/loop-limit.test.ts` ("every clause"), `packages/coding-agent/test/interactive-mode-loop.test.ts` ("every interval"), and `packages/tui/test/status-line-loop.test.ts`.
- **Retire when:** Upstream ships a fixed-interval loop or a cron-style schedule for prompts.

### /guided-loop

- **Decision:** Keep `/guided-loop [rough idea]`. The agent asks one question per reply about the prompt, the frequency, and the stop rule. It then calls the hidden `loop` tool. The tool builds the `/loop` line and rejects a setup that `parseLoopArgs` reads back differently. A `Start this loop?` dialog with **No** selected first shows that line. Yes runs the normal `/loop` code (`handleLoopCommand`) and queues the prompt as the first run.
- **Decision:** The `loop` tool is active only while the interview has installed its `LoopStartHandler` (`AgentSession.setLoopStartHandler`). One function (`#endGuidedLoopInterview`) ends the interview and removes the tool: on Yes, `cancel`, a turn that uses another tool, a typed `/loop`, a kickoff failure, or a session switch. The `AgentSession` tool activation methods drop `loop` while no handler is installed. A goal, plan, or impl-review tool snapshot taken during the interview therefore cannot bring the tool back.
- **Decision:** The interval clock of the first run starts at that run's user message, not at the tool call, the same as a typed `/loop`.
- **Decision:** A running loop pauses during the interview, and `setLoopPrompt` ignores answers until the interview ends. `c` and `.` are answers, not continue shortcuts. The IDE flag `goalInterviewActive` is renamed to `interviewActive` and covers both guided interviews.
- **Why:** Users who do not know the `/loop` grammar can still set up an interval, a limit, and a `--while`/`--until` condition, and they see the equal `/loop` line for next time.
- **Key paths:** `packages/coding-agent/src/tools/loop.ts`, `packages/coding-agent/src/prompts/loop/guided-loop-interview.md`, `packages/coding-agent/src/modes/interactive-mode.ts` (`handleGuidedLoopCommand`, `#handleLoopStartRequest`, `#endGuidedLoopInterview`), `packages/coding-agent/src/session/agent-session.ts` (`#withoutIdleLoopTool`), `packages/coding-agent/src/tools/index.ts` (`isToolAllowed`), and `packages/coding-agent/src/modes/controllers/input-controller.ts`.
- **Checks:** `packages/coding-agent/test/tools/loop-tool.test.ts`, `packages/coding-agent/test/guided-loop.test.ts`, `packages/coding-agent/test/input-controller-keybindings.test.ts`, and `packages/coding-agent/test/interactive-mode-speckit-auto.test.ts`.
- **Retire when:** Upstream ships a guided setup for loop mode.

### Expand key in job views

- **Decision:** `app.tools.expand` switches the `/jobs` report between cut and full commands, and the jobs sheet between upstream's bounded command preview (4 lines natively, 12 lines with shortened paths in the text fallback) and the full command. The full command has no height bound, so the sheet forwards PgUp/PgDn to the scroller around its detail pane, as `ReportPanel` does for its body. Both views read `toolOutputExpanded`, so one key and one state drive the transcript and the job views. `/jobs full` sets the state on. The report rebuilds on each change, so a toggle can move it between the dock and the full-screen page. Overlay views (full-screen report, native report sheet, jobs sheet) handle the key themselves, because the global listener stops under overlays. The hidden-tool-activity refusal is skipped while a job view is open.
- **Why:** The user wants to read a long background-job command from the report without closing it and typing `/jobs full`.
- **Key paths:** `packages/tui/src/overlays/report-panel.ts` (`expand` option), `packages/tui/src/overlays/jobs-panel.ts` (`JobsSheetSource.expanded`/`toggleExpanded`), `packages/coding-agent/src/modes/controllers/command-controller.ts` (`#showJobsReport`, `refreshJobsReport`), `packages/coding-agent/src/modes/controllers/input-controller.ts` (`setToolsExpanded`, `toggleToolOutputExpansion`), `packages/coding-agent/src/modes/interactive-mode.ts` (`jobsViewOpen`, `showJobsSheet`).
- **Checks:** `packages/coding-agent/test/modes/controllers/jobs-command.test.ts` ("/jobs expand toggle"), `packages/coding-agent/test/modes/controllers/input-controller-tool-expansion.test.ts`, `packages/tui/test/report-panel.test.ts`, and `packages/tui/test/jobs-panel.test.ts`.
- **Retire when:** Upstream ships a way to expand job commands in its job views.
