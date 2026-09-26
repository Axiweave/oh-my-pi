# Upstream Divergences

This file records behavior that this fork intentionally keeps different from `can1357/oh-my-pi`.
It is not a changelog. Each entry describes a current decision that upstream merges must preserve or retire explicitly.

**Reviewed against:** `v18.3.2` on 2026-09-25.

## Maintenance

1. Read every entry before an upstream merge or conflict resolution.
2. Preserve each decision unless the user explicitly retires it.
3. After a merge, verify each entry against upstream and update the reviewed release.
4. Add or update an entry in the same commit as each fork-only feature or decision.
5. Remove an entry when upstream adopts the behavior or this fork drops it.

## Divergences

### Empty Enter with live-steering messages

- **Decision:** Count displayable live-steering claims as pending until the agent loop records their delivery.
- **Behavior:** Empty Enter interrupts the active response and resumes with the pending message in both main and focused sessions.
- **Why:** Upstream commit `a969abf4d6` introduced live steering. A claimed message left the queue count at zero while the screen still showed `Steering · 1`, disabling empty-Enter interruption.
- **Key paths:** `packages/agent/src/agent.ts` and `packages/coding-agent/src/session/agent-session.ts`.
- **Check:** `packages/coding-agent/test/agent-session-queued-steer-delivery.test.ts` covers accepted and rejected claims in main and focused sessions.
- **Retire when:** Upstream pending counts include unrecorded live-steering deliveries and the regression check passes.


### Local source installation

- **Decision:** Use this fork's checkout and `bun run setup` for installation, repair, and updates.
- **Why:** Upstream packages and installers replace the fork and omit its changes.
- **Key paths:** `README.md`, `AGENTS.md`, `packages/coding-agent/README.md`, `scripts/setup.ts`, and `scripts/link-omp.sh`.
- **Checks:** Follow the command-target and runtime checks in `README.md` under Install.

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
- **Why:** Users need turn duration when the selected footer omits the status brand.
- **Key paths:** `packages/coding-agent/src/modes/interactive-mode.ts`, `packages/coding-agent/src/modes/settings.ts`, and `packages/utils/src/format.ts`.
- **Checks:** `packages/coding-agent/test/interactive-mode-working-accent.test.ts` and `packages/utils/test/format.test.ts`.

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
- **Why:** One action must switch the complete role-model set for a workflow.
- **Key paths:** `packages/coding-agent/src/config/model-roles.ts`, `packages/coding-agent/src/config/settings.ts`, `packages/coding-agent/src/session/model-controls.ts`, and `packages/coding-agent/src/session/agent-session.ts`.
- **Checks:** `packages/coding-agent/test/agent-session-model-profiles.test.ts`, `packages/coding-agent/test/sdk-nested-session-shared-settings.test.ts`, `packages/coding-agent/test/cli-model-profile-flag.test.ts`, and `packages/coding-agent/test/slash-commands/model-profile.test.ts`.

### Per-model compaction thresholds

- **Decision:** Resolve compaction settings per active model through `compaction.modelOverrides` selector patterns. An exact `provider/id` key wins, else the first matching wildcard in declaration order.
- **Decision:** A matching override replaces the whole threshold policy (`thresholdTokens`, `thresholdPercent`, `reserveTokens`); it never merges into the global group.
- **Why:** One global threshold cannot fit models with very different context windows.
- **Key paths:** `packages/coding-agent/src/session/context-settings.ts`, `packages/coding-agent/src/session/session-maintenance.ts`, and `packages/coding-agent/src/session/session-advisors.ts`.
- **Checks:** `packages/coding-agent/test/compaction-model-overrides.test.ts` and `packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts`.

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

### Cyber mode allowlist

- **Decision:** Keep `cyberModels` and `cyberMode`. Filter every role chain and refuse operator model switches outside the allowlist. Empty chains use the first resolved declaration.
- **Decision:** Bind filtered selectors and primary fallback to concrete model identities. A reduced catalog cannot select an excluded fuzzy match. Block launch selection when no approved target remains.
- **Decision:** Report startup and live substitutions once per role/model pair in each transcript. Same-transcript reloads retain notice history. Enable and status output list every allowed model.
- **Decision:** Record cyber state on every model change, including recovery. Resume, fork, side-answer branches, and tree navigation restore the destination state. Context reset retains the current state.
- **Decision:** Revalidate inherited state for `/new`, `/delete`, forks, and branch adoption. Unusable declarations disable the session with a warning. Branch adoption records a degraded off state.
- **Decision:** Failed session switches restore outgoing protection and notice history. Publish cyber notices only after a successful switch. Resumed active-model substitutions use the startup warning channel.
- **Decision:** Send print/RPC startup warnings to stderr at CLI session creation. Publish ACP warnings after registration, excluding temporary-session transitions.
- **Decision:** Keep protection on shared configuration state. An implicit clear removes only its owner's claim. An explicit operator switch-off clears all claims.
- **Decision:** Apply installed membership checks to background overrides, fallback traversal, and dispatch. A retained callback re-checks protection before it dispatches, and a session that shares another session's protection stays constrained while its own indicator is off.
- **Why:** Operators need to restrict cyber work to approved models. This allowlist does not bypass provider safety restrictions. Preserve the filtering, switch guard, `cyber` status-line segment, and lifecycle rules.
- **Key paths:** `packages/coding-agent/src/config/cyber-mode.ts`, `packages/coding-agent/src/config/model-resolver.ts`, `packages/coding-agent/src/config/settings.ts`, `packages/coding-agent/src/config/model-roles.ts`, `packages/coding-agent/src/session/model-controls.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/session/turn-recovery.ts`, `packages/coding-agent/src/session/session-advisors.ts`, `packages/coding-agent/src/session/session-maintenance.ts`, `packages/coding-agent/src/eval/completion-bridge.ts`, `packages/coding-agent/src/tiny/online-candidates.ts`, `packages/coding-agent/src/judgment/index.ts`, `packages/coding-agent/src/mnemopi/backend.ts`, `packages/coding-agent/src/sdk.ts`, `packages/coding-agent/src/modes/components/status-line/segments.ts`, `packages/coding-agent/src/slash-commands/builtin-modes.ts`, and `docs/cyber-mode.md`.
- **Checks:** `packages/coding-agent/test/cyber-mode.test.ts`, `packages/coding-agent/test/cyber-mode-session.test.ts`, `packages/coding-agent/test/cyber-mode-shared-settings.test.ts`, `packages/coding-agent/test/cyber-switch-guard.test.ts`, `packages/coding-agent/test/agent-session-retry-fallback.test.ts`, `packages/coding-agent/test/eval/completion-bridge.test.ts`, `packages/coding-agent/test/online-tiny-candidates.test.ts`, `packages/coding-agent/test/judgment/index.test.ts`, `packages/coding-agent/test/compaction-cyber-candidates.test.ts`, `packages/coding-agent/test/compaction-cyber-dispatch.test.ts`, `packages/coding-agent/test/main-cyber-warnings.test.ts`, `packages/coding-agent/test/status-line-cyber.test.ts`, and `packages/coding-agent/test/slash-commands/cyber.test.ts`.

### CLIProxyAPI catalog discovery

- **Decision:** Support `discovery.type: cliproxyapi` for any named provider entry in `models.yml`.
- **Decision:** Read `/v1/models?client_version=pi` for advertised limits, modalities, and reasoning efforts. Keep inference on the configured API.
- **Decision:** Keep credentials and caches separate for each provider. Do not import catalog prompts or tool policy.
- **Why:** Multiple proxy servers need independent connections without copies of a single-connection Pi extension.
- **Key paths:** `packages/coding-agent/src/config/model-discovery.ts`, `packages/coding-agent/src/config/model-registry.ts`, and `packages/coding-agent/src/config/models-config-schema-bundle.ts`.
- **Checks:** `packages/coding-agent/test/cliproxyapi-discovery.test.ts` and a source CLI replay against two local servers.
