# Upstream Divergences

This file records behavior that this fork intentionally keeps different from `can1357/oh-my-pi`.
It is not a changelog. Each entry describes a current decision that upstream merges must preserve or retire explicitly.

**Reviewed against:** `v18.8.6` on 2026-10-08.

**Verification:** Source setup, `bun check`, launcher checks, and `omp --smoke-test` passed.
The launcher targets this checkout and reports `18.8.6`.
The merge had conflicts in six files. The resolutions preserve every fork decision and retain upstream behavior.
The resolutions also preserve raw advisor chains, filter new xAI search fallbacks, and cancel speckit-auto checks before exit planning.
The isolated TypeScript run exercised 2908 test files. Of these, 2905 passed on the first run.
The SIXEL suite then passed after removal of the host's `PI_FORCE_IMAGE_PROTOCOL=kitty` override.
Two suites retain identical failures at pre-merge commit `eddc3a062b`:
- `packages/coding-agent/test/sdk-tool-activation.test.ts`: five Cursor cases fail with `No API key found for cursor`.
- `packages/coding-agent/test/eval/js-package-environment.test.ts`: the missing-project-package case returns exit code 0 instead of 1.

The user authorized the local merge commit with these confirmed baseline failures.
`bun run test:rs` passed all 3240 tests, with 5 skipped.
Local proxy discovery, pinned composer resize, and direct and tmux Ghostel directory reporting passed.
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
- **Decision:** Under the kitty keyboard protocol, hold a split OSC/DCS/APC packet for up to 10 seconds, not 150ms. SSH links stall mid-packet for over a second, and the short hold dropped verified paste data.
- **Runtime:** Rebuild the native addon with `bun run setup`. Existing OMP processes must restart to load the portable TIFF decoder.
- **Why:** Incomplete or stale transfers must not alter a draft or attach an image to the wrong destination. Local and legacy image routes stay unchanged.
- **Key paths:** `packages/coding-agent/src/utils/enhanced-paste.ts`, `packages/coding-agent/src/modes/controllers/input-controller.ts`, `packages/coding-agent/src/modes/interactive-mode.ts`, `packages/tui/src/chat/image-loading.ts`, `packages/tui/src/stdin-buffer.ts`, and `packages/tui/src/tui.ts`.
- **Checks:** `packages/coding-agent/test/utils/enhanced-paste.test.ts`, `packages/coding-agent/test/input-controller-enhanced-paste.test.ts`, `packages/coding-agent/test/image-input.test.ts`, `packages/tui/test/image-loading.test.ts`, `packages/tui/test/start-listener.test.ts`, and `packages/tui/test/stdin-buffer.test.ts`.

### Empty Enter with live-steering messages

- **Decision:** Count displayable live-steering claims as pending until the agent loop records their delivery.
- **Behavior:** Empty Enter interrupts the active response and resumes with the pending message in both main and focused sessions.
- **Why:** Upstream commit `a969abf4d6` introduced live steering. A claimed message left the queue count at zero while the screen still showed `Steering · 1`, disabling empty-Enter interruption.
- **Key paths:** `packages/agent/src/agent.ts` and `packages/coding-agent/src/session/agent-session.ts`.
- **Checks:** `packages/coding-agent/test/agent-session-queued-steer-delivery.test.ts` covers accepted and rejected claims in main and focused sessions. `packages/coding-agent/test/rpc-queued-message.test.ts` (`withdraws a steer the streaming response already claimed live`) waits for the fixture's `live-steer-claimed` marker, because the RPC state still counts the claimed steer. It then checks that `abort_and_restore_queue` withdraws that steer.
- **Retire when:** Upstream pending counts include unrecorded live-steering deliveries and the regression check passes.


### Local source installation

- **Decision:** Use this fork's checkout and `bun run setup` for installation, repair, and updates.
- **Why:** Upstream packages and installers replace the fork and omit its changes.
- **Key paths:** `README.md`, `AGENTS.md`, `packages/coding-agent/README.md`, `scripts/setup.ts`, and `scripts/link-omp.sh`.
- **Checks:** Follow the command-target and runtime checks in `README.md` under Install.

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

- **Decision:** With `composer.tokenRate` on, show each pinned subagent's live or last generation rate and the live total.
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
- **Why:** A stable input position reduces visual movement in long sessions.
- **Key paths:** `packages/tui/src/prompt/composer.ts`, `packages/coding-agent/src/modes/interactive-mode.ts`, and `packages/tui/src/tui.ts`.
- **Checks:** `packages/coding-agent/test/composer-pin-bottom.test.ts`, `packages/tui/test/composer-inline-shrink.test.ts`, and `packages/coding-agent/test/startup-composer.test.ts`.

### Full assistant text during streaming

- **Decision:** Keep `display.streamingScrollback` as an opt-in setting, defaulting to `false`.
- **Decision:** Render the full mutable Markdown transcript through atomic history replacements when earlier rows change.
- **Decision:** Preserve existing shell history on startup. Shutdown appends the unretired tail without clearing or replaying accepted history.
- **Decision:** Use row-pressure retirement by default, with capacity based on current chrome. A live append-only head retires finished rows to native history in one batch per cycle.
- **Why:** Users can read early assistant text before finalization, including unfinished paragraphs and open code fences.
- **Key paths:** `packages/tui/src/prompt/composer.ts`, `packages/coding-agent/src/modes/settings.ts`, and `packages/tui/src/tui.ts`.
- **Checks:** `packages/coding-agent/test/composer-streaming-scrollback.test.ts` and `packages/tui/test/history-frame-plan.test.ts`.
- **Known gap:** CLI startup still requests history clearing in `startup-composer.ts` and `main.ts`. This predates `v18.3.2`. The composer checks do not verify shell-history preservation through those callers. Keep the preservation decision.

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
- **Why:** One action must switch the complete role-model set for a workflow.
- **Key paths:** `packages/coding-agent/src/config/model-roles.ts`, `packages/coding-agent/src/config/settings.ts`, `packages/coding-agent/src/session/model-controls.ts`, and `packages/coding-agent/src/session/agent-session.ts`.
- **Checks:** `packages/coding-agent/test/agent-session-model-profiles.test.ts`, `packages/coding-agent/test/sdk-nested-session-shared-settings.test.ts`, `packages/coding-agent/test/cli-model-profile-flag.test.ts`, `packages/coding-agent/test/model-profile-picker.test.ts`, and `packages/coding-agent/test/slash-commands/model-profile.test.ts`.

### Prewalk controls

- **Decision:** Keep `prewalk.into`, including `@@` to keep the active model and `@@:<level>` to change only its thinking level.
- **Decision:** Keep `/prewalk off` and the unbound-by-default `app.prewalk.toggle` action. The key preserves the editor draft. Upstream `v18.7.0` added its own `/prewalk off`. The fork keeps its wording and its silent disarm. Like upstream, `off` drops only the current session's handoff, and `/new` re-arms when `prewalk.enabled` is on.
- **Decision:** Disarming is silent. `prewalk.armNotice` (default `true`) controls the arm notice and slash-command success output. `/prewalk off` prints `Prewalk: nothing armed.` only when nothing was armed.
- **Decision:** Upstream's `/new` re-arm resolves `prewalk.into`, not `@smol`. With `@@`, it keeps the model that is active after `/new`. A plain `@@` handoff records no handoff, so `/new` restores nothing.
- **Key paths:** `packages/coding-agent/src/session/prewalk.ts`, `packages/coding-agent/src/session/settings.ts`, `packages/coding-agent/src/slash-commands/builtin-modes.ts`, and `packages/coding-agent/src/modes/controllers/input-controller.ts`.
- **Checks:** `packages/coding-agent/test/agent-session-prewalk.test.ts`, `packages/coding-agent/test/agent-session-prewalk-off.test.ts`, `packages/coding-agent/test/input-controller-keybindings.test.ts`, `packages/coding-agent/test/prewalk-discovery-provider.test.ts`, and `packages/coding-agent/test/task/executor-prewalk.test.ts`.

### Per-call subagent model selection

- **Decision:** Keep `model` on flat task calls, each batch item, eval `agent()`, and eval `workpool()`. Reject `model` on a batch container.
- **Decision:** A model array is an ordered preference. Explicit selectors take precedence over agent defaults and parent inheritance.
- **Decision:** Inherit the live model route and effective thinking level when no explicit selector applies. Preserve agent-level effort precedence.
- **Decision:** Explicit selectors must not remove OAuth account pools or cyber restrictions. Configured retry chains remain separate from selector preferences.
- **Why:** Upstream commit `31876ff53e` removed per-call selectors. This fork keeps them for task-specific model choices.
- **Key paths:** `packages/coding-agent/src/config/model-resolver.ts`, `packages/coding-agent/src/sdk.ts`, `packages/coding-agent/src/task/`, `packages/coding-agent/src/eval/agent-bridge.ts`, `packages/coding-agent/src/eval/workpool-bridge.ts`, and `packages/coding-agent/src/vibe/runtime.ts`.
- **Checks:** `packages/coding-agent/test/model-resolver.test.ts`, `packages/coding-agent/test/sdk-active-selector.test.ts`, `packages/coding-agent/test/task/task-schema.test.ts`, `packages/coding-agent/test/task/structured-subagent.test.ts`, `packages/coding-agent/test/sdk-model-selection.test.ts`, `packages/coding-agent/test/sdk-subagent-auth-inheritance.test.ts`, `packages/coding-agent/test/eval/agent-bridge-policy.test.ts`, `packages/coding-agent/test/eval/workpool-bridge.test.ts`, `packages/coding-agent/test/eval/prelude-agent.test.ts`, `packages/coding-agent/test/eval/prelude-runtime.test.ts`, `packages/coding-agent/test/eval/py/prelude.test.ts`, `packages/coding-agent/test/task/workpool.test.ts`, and `packages/coding-agent/test/interactive-mode-vibe-toggle.test.ts`.

### Five-level task effort

- **Decision:** Keep `low`, `medium`, `high`, `xhigh`, and `max`. Reject upstream's `lo`, `med`, and `hi` names.
- **Decision:** Resolve effort through the role model map and retain the `task.maxEffort` ceiling.
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
- **Why:** One global threshold cannot fit models with very different context windows.
- **Key paths:** `packages/coding-agent/src/session/context-settings.ts`, `packages/coding-agent/src/session/session-maintenance.ts`, and `packages/coding-agent/src/session/session-advisors.ts`.
- **Checks:** `packages/coding-agent/test/compaction-model-overrides.test.ts`, `packages/coding-agent/test/config/compaction-threshold.test.ts`, `packages/coding-agent/test/task/executor-pass-through.test.ts`, and `packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts`.

### Native JJ snapshot contract test

- **Decision:** Keep the fork's `native JJ workspace queries` snapshot test. It asserts that status comes from the recorded working copy until `changedFiles([], true)` takes an explicit snapshot.
- **Why:** The revised assertions match the observed native `pi-vcs` behavior. Upstream deleted the older version of this test instead of revising it, so an unwatched merge would drop the coverage.
- **Key path:** `packages/coding-agent/test/utils/jj.test.ts`.
- **Check:** `packages/coding-agent/test/utils/jj.test.ts`.

### Composer input packets and queue-body commands

- **Decision:** Accept `ESC _ pi:prompt;<command> ESC \` and `ESC _ pi:keyword;<word> ESC \` input packets from terminal hosts. A prompt packet replaces or inserts the draft's leading slash command, a keyword packet places a standalone word at the message start, and neither moves the body cursor.
- **Decision:** Treat a `->` / `=>` queue shorthand as a header. Packets, the leading-command edits, and command recognition take the body line and anchor from `queueShorthandBodyStart`, so a command never lands in front of the shorthand and a bare prefix keeps its header line with the body appended below.
- **Decision:** Color-highlight a fully recognized leading command and inline `/skill:name` tokens in the composer, scanning from the message start rather than column 0 so a queued body keeps its highlight. A replaced autocomplete provider invalidates the cached recognition.
- **Decision:** Expand file commands before prompt templates in steering and follow-up messages. Queue shorthand and `/queue` also load registered skill commands.
- **Decision:** Preserve command images and queue modes during compaction replay, including mixed and command-only queues.
- **Why:** Editors such as claude-code-ide.el drive the composer through these packets instead of terminal keystrokes, and a command queued for the next yield must stay visible and reach the message body. Upstream has no packet intake, no leading-command editor API, and no recognition ranges.
- **Key paths:** `packages/tui/src/prompt/composer.ts`, `packages/tui/src/prompt/queue-input.ts`, `packages/tui/src/prompt/custom-editor.ts`, `packages/coding-agent/src/modes/controllers/input-controller.ts`, `packages/coding-agent/src/modes/utils/ui-helpers.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/tui/src/components/editor.ts`, and `packages/tui/src/autocomplete.ts`.
- **Checks:** `packages/coding-agent/test/startup-composer.test.ts`, `packages/tui/test/custom-editor.test.ts`, `packages/coding-agent/test/agent-session-queued-steer-delivery.test.ts`, `packages/coding-agent/test/input-controller-skill-queue.test.ts`, and `packages/tui/test/editor.test.ts`.

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
- **Decision:** Parked subagent settings retain their exact protection claims during warm revival. Dynamic retry-role installation preserves raw configured chains.
- **Revival and retry checks:** `packages/coding-agent/test/task/parked-subagent-session-release.test.ts` and `packages/coding-agent/test/retry-fallback.test.ts`.
- **Decision:** Apply installed membership checks to background overrides, fallback traversal, cache-warm replays, and dispatch. A retained callback re-checks protection before it dispatches, and a session that shares another session's protection stays constrained while its own indicator is off.
- **Why:** Operators need to restrict cyber work to approved models. This allowlist does not bypass provider safety restrictions. Preserve the filtering, switch guard, `cyber` status-line segment, and lifecycle rules.
- **Key paths:** `packages/coding-agent/src/config/cyber-mode.ts`, `packages/coding-agent/src/config/model-resolver.ts`, `packages/coding-agent/src/config/settings.ts`, `packages/coding-agent/src/config/model-roles.ts`, `packages/coding-agent/src/session/model-controls.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/session/turn-recovery.ts`, `packages/coding-agent/src/session/session-advisors.ts`, `packages/coding-agent/src/session/session-maintenance.ts`, `packages/coding-agent/src/eval/completion-bridge.ts`, `packages/coding-agent/src/tiny/online-candidates.ts`, `packages/coding-agent/src/judgment/index.ts`, `packages/coding-agent/src/mnemopi/backend.ts`, `packages/coding-agent/src/sdk.ts`, `packages/tui/src/status-line/segments.ts`, `packages/coding-agent/src/slash-commands/builtin-modes.ts`, and `docs/cyber-mode.md`.
- **Checks:** `packages/coding-agent/test/cyber-mode.test.ts`, `packages/coding-agent/test/cyber-mode-session.test.ts`, `packages/coding-agent/test/cyber-mode-shared-settings.test.ts`, `packages/coding-agent/test/cyber-switch-guard.test.ts`, `packages/coding-agent/test/agent-session-retry-fallback.test.ts`, `packages/coding-agent/test/eval/completion-bridge.test.ts`, `packages/coding-agent/test/online-tiny-candidates.test.ts`, `packages/coding-agent/test/judgment/index.test.ts`, `packages/coding-agent/test/compaction-cyber-candidates.test.ts`, `packages/coding-agent/test/compaction-cyber-dispatch.test.ts`, `packages/coding-agent/test/main-cyber-warnings.test.ts`, `packages/coding-agent/test/status-line-cyber.test.ts`, and `packages/coding-agent/test/slash-commands/cyber.test.ts`.
- **Decision:** Skip the session model's `imageModel` and `webSearchModel` companions when the allowlist excludes them.
- **Companion key paths and checks:** `packages/coding-agent/src/tools/image-gen.ts` and `packages/coding-agent/src/web/search/index.ts`, checked by `packages/coding-agent/test/tools/image-gen.test.ts` and `packages/coding-agent/test/web/search/default-chain.test.ts`.
- **Known gap:** `web_search` and `generate_image` still dispatch their default `priority.json` fallback entries and an explicit request `model` without a membership check. Those entries include non-LLM search engines, so a blanket filter would disable search under cyber mode. This predates `v18.4.3`.

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
- **Decision:** Fail closed with `BackgroundUnavailable` when no application window is under the point or a macOS system surface (Window Server, Dock, Control Center, ...) is on top.
- **Why:** Upstream posts all desktop-root pointer input through the global tap, which moves the user's cursor even when background delivery was requested.
- **Retire when:** Upstream routes background desktop-root pointer input without the global tap.
- **Key path:** `crates/pi-natives/src/desktop/macos/input.rs` (`desktop_background_target`, `background_window_pointer`, `pointer_origin`, `is_system_surface`).
- **Check:** `bun run test:rs` (`desktop_background_target_*` and `pointer_origin_uses_first_drag_point` in `input.rs`).

### Speckit-auto mode

- **Decision:** Keep the builtin speckit-auto mode (`/speckit-auto-mode`, `/speckit-auto <description>|resume|next`). It runs the speckit phases after clarify on its own. It checks each settled phase turn with one judge call and a text fallback, then starts the next phase after an 800 ms grace tick. It holds on questions, errors, and unreadable turns. The setting is `speckitAuto.convergeRounds` (default `3`).
- **Decision:** In analyze, a user turn without a readable report gets one more judge question, `fixed`, with the user's request in the judge state. A yes re-runs `/speckit.analyze` and counts as a remediation round. Without a judge answer the mode holds.
- **Decision:** After clarify, the mode removes a closing handoff sentence ("Run `/speckit.implement`, or say `go`") before it checks the reply. It never auto-answers a reply that offers another phase. On a turn that the user starts with free text, the next phase starts only when the reply has the phase's own report. A side reply that prints a phase's own result (such as `✅ Converged`) still counts, so steering answers keep working.
- **Decision:** While the mode acts between phases (a settled reply waits for its check, a check runs, or a start waits to submit), the terminal title and the IDE state stay `working`. The mode publishes the settled state when it holds (`needs-input`), pauses, or ends the run.
- **Why:** The user wants an unattended spec-kit pipeline with the same status bar, Esc pause, and notifications as the other modes. An extension cannot reach the submit guard and the mode-exclusion seams.
- **Retire when:** Upstream ships an equivalent spec-kit pipeline mode.
- **Key paths:** `packages/coding-agent/src/modes/speckit-auto.ts`, `packages/coding-agent/src/prompts/speckit-auto/`, `packages/coding-agent/src/modes/interactive-mode.ts` (speckit-auto fields, tick, restore, exclusion), `packages/coding-agent/src/modes/controllers/input-controller.ts` (Esc pause, submit counter), `packages/coding-agent/src/modes/controllers/event-controller.ts` (notification suppression), `packages/coding-agent/src/modes/controllers/selector-controller.ts` and `extension-ui-controller.ts` (restore the run after a cancelled or failed session switch), `packages/coding-agent/src/slash-commands/builtin-modes.ts`, `packages/coding-agent/src/modes/settings.ts`, `packages/tui/src/status-line/`.
- **Checks:** `packages/coding-agent/test/speckit-auto.test.ts`, `packages/coding-agent/test/interactive-mode-speckit-auto.test.ts`, `packages/tui/test/status-line-speckit-auto.test.ts`.

### Working state during background-job waits

- **Decision:** Keep the terminal title and the IDE session state at `working` while `AgentSession.hasPendingAsyncWork()` is true. This holds after the model yields with `awaitingAsyncWork`. Publish `idle`, `done`, or `failed` only after the work ends without a wake.
- **Why:** Upstream drops the title to idle and publishes `done` at the yield, so a session that still waits on a job looks finished.
- **Key paths:** `packages/coding-agent/src/modes/controllers/event-controller.ts` (`#handleTurnEnd`, `#handleAgentEnd`), `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts`, `packages/coding-agent/src/modes/controllers/session-focus-controller.ts`, and `packages/coding-agent/src/modes/interactive-mode.ts` (`#hidePlanReview`).
- **Checks:** `packages/coding-agent/test/modes/controllers/event-controller-abort-guard.test.ts` and `packages/coding-agent/test/modes/controllers/event-controller-ide-state.test.ts`.
