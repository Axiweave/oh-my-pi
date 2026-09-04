# Upstream Divergences

This file records behavior that this fork intentionally keeps different from `can1357/oh-my-pi`.
It is not a changelog. Each entry describes a current decision that upstream rebases must preserve or retire explicitly.

**Reviewed against:** `v18.1.8` on 2026-09-04.

## Maintenance

1. Read every entry before an upstream rebase or conflict resolution.
2. Preserve each decision unless the user explicitly retires it.
3. After a rebase, verify each entry against upstream and update the reviewed release.
4. Add or update an entry in the same commit as each fork-only feature or decision.
5. Remove an entry when upstream adopts the behavior or this fork drops it.

## Divergences

### Project-local prompt history

- **Decision:** Start Ctrl-R history in the active working directory and let Tab switch to all projects without changing the query.
- **Decision:** Keep each prompt unique globally while preserving its membership and latest metadata in every recorded working directory.
- **Decision:** Omit transient lifecycle commands and non-interactive `/mcp add` arguments from persisted prompt history.
- **Why:** Local-first results remove unrelated project prompts. The filter also removes stale actions and protects credentials in MCP command arguments.
- **Key paths:** `packages/coding-agent/src/session/history-storage.ts`, `packages/coding-agent/src/modes/components/history-search.ts`, `packages/coding-agent/src/modes/controllers/selector-controller.ts`, and `packages/coding-agent/src/modes/controllers/input-controller.ts`.
- **Checks:** `packages/coding-agent/test/history-storage-search.test.ts`, `packages/coding-agent/test/history-storage-sqlite-compat.test.ts`, `packages/coding-agent/test/modes/components/history-search.test.ts`, `packages/coding-agent/test/keybindings-selector-navigation.test.ts`, `packages/coding-agent/test/slash-commands/history-security.test.ts`, and `packages/coding-agent/test/input-controller-slash-history.test.ts`.

### Debate plan workflow with implementation review

- **Decision:** Keep the `/debate` plan workflow: an independent read-only reviewer must reach exact-byte consensus on the plan before human approval, capped at `plan.debateMaxRounds` with deadlock escalation.
- **Decision:** Extend the contract through execution: after debate approval, the agent submits the finished implementation through `xd://propose` and the reviewer must accept it (toggle: `plan.implReview`, default on).
- **Why:** Upstream plan mode ends at human approval; this fork wants machine review on both the plan and its implementation with the human as the escalation path.
- **Key paths:** `packages/coding-agent/src/plan-mode/state.ts`, `packages/coding-agent/src/plan-mode/debate.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/modes/interactive-mode.ts`, `packages/coding-agent/src/modes/acp/acp-agent.ts`, `packages/coding-agent/src/prompts/agents/impl-reviewer.md`, and `docs/debate-plan-mode.md`.
- **Checks:** `packages/coding-agent/test/plan-mode/debate.test.ts`, `packages/coding-agent/test/plan-mode/impl-review.test.ts`, `packages/coding-agent/test/agent-session-impl-review.test.ts`, `packages/coding-agent/test/interactive-mode-impl-review.test.ts`, and `packages/coding-agent/test/acp-agent.test.ts`.

### Claude three-line footer

- **Decision:** Support `composerStyle.footerMode: claude3` across composer shapes and extension shapes.
- **Appearance:** Keep the loader spinner when the footer hides the `pi` brand segment.
- **Appearance:** Use the theme model color in this footer instead of the session accent.
- **Why:** The fixed footer replaces the normal status layout, so upstream spinner and accent assumptions do not apply.
- **Key paths:** `packages/coding-agent/src/modes/components/status-line/component.ts`, `packages/coding-agent/src/modes/interactive-mode.ts`, and `packages/tui/src/components/composer/types.ts`.
- **Checks:** `packages/coding-agent/test/modes/components/status-line/component.test.ts` and `packages/coding-agent/test/interactive-mode-working-accent.test.ts`.

### Working message icon spacing

- **Decision:** Leave one extra visual cell between the working icon and its message.
- **Why:** Spinner and Escape glyphs otherwise touch the message in common terminal fonts.
- **Key path:** `packages/coding-agent/src/modes/interactive-mode.ts`.
- **Check:** `packages/coding-agent/test/interactive-mode-working-accent.test.ts`.

### IDE selection and open-file context

- **Decision:** Read IDE MCP notifications for selections and open files.
- **Decision:** Add the full file path to model reminders and show IDE state in the status footer.
- **Why:** The model needs editor context even when the user does not paste the selected text.
- **Key paths:** `packages/coding-agent/src/mcp/ide-selection.ts`, `packages/coding-agent/src/session/ide-selection-reminder.ts`, and `packages/coding-agent/src/modes/components/status-line/segments.ts`.
- **Checks:** `packages/coding-agent/test/mcp/ide-selection.test.ts`, `packages/coding-agent/test/ide-selection-reminder.test.ts`, and `packages/coding-agent/test/ide-selection-segment.test.ts`.

### Pinned composer

- **Decision:** Let `tui.pinComposerBottom` keep the composer at the viewport bottom.
- **Decision:** Preserve the pin after transcript history commits and cold startup.
- **Why:** A stable input position reduces visual movement in long sessions.
- **Key paths:** `packages/coding-agent/src/modes/composer.ts`, `packages/coding-agent/src/modes/interactive-mode.ts`, and `packages/tui/src/tui.ts`.
- **Checks:** `packages/coding-agent/test/composer-pin-bottom.test.ts` and `packages/coding-agent/test/startup-composer.test.ts`.

### Collapsed prompt-template cards

- **Decision:** Collapse expanded prompt-template submissions into one-line transcript cards.
- **Why:** The transcript should show the submitted command without repeating expanded template text.
- **Key paths:** `packages/coding-agent/src/config/prompt-templates.ts`, `packages/coding-agent/src/modes/components/user-message.ts`, and `packages/coding-agent/src/session/agent-session.ts`.

### Emacs-hosted resize behavior

- **Decision:** Skip the transient alternate-screen resize borrow in direct Emacs terminal buffers.
- **Why:** Emacs shows the borrow as a full-buffer swap and flicker. Its discrete resizes do not need the drag optimization.
- **Key paths:** `packages/tui/src/terminal-capabilities.ts` and `packages/tui/src/tui.ts`.
- **Checks:** `packages/tui/test/process-terminal-render.test.ts` and `packages/tui/test/resize-multiplexer-anchor.test.ts`.

### Constant write preview height

- **Decision:** Keep the streaming write-tool preview at a constant height.
- **Why:** Stable preview geometry prevents the composer and transcript from moving during streamed arguments.
- **Key path:** `packages/coding-agent/src/tools/write.ts`.
- **Checks:** `packages/coding-agent/test/write-streaming-incremental.test.ts` and `packages/coding-agent/test/write-streaming-preview-expand.test.ts`.

### Model profiles

- **Decision:** Support named `modelProfiles` bundles for role models.
- **Decision:** Support startup selection, cycling, CLI selection, and `/model-profile` changes.
- **Decision:** Preserve project profiles during discovery reloads and restore the profile default after plan mode.
- **Why:** One action must switch the complete role-model set for a workflow.
- **Key paths:** `packages/coding-agent/src/config/model-roles.ts`, `packages/coding-agent/src/config/settings.ts`, `packages/coding-agent/src/session/model-controls.ts`, and `packages/coding-agent/src/session/agent-session.ts`.
- **Checks:** `packages/coding-agent/test/agent-session-model-profiles.test.ts`, `packages/coding-agent/test/cli-model-profile-flag.test.ts`, and `packages/coding-agent/test/slash-commands/model-profile.test.ts`.
