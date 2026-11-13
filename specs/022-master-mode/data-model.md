# Data Model: Master Mode

Master mode keeps one flag per session branch. The allowlist is code, not data. Line numbers come from the tree at the start of this plan.

## MasterModeState

The in-memory state of one `AgentSession`. Defined in `session/master-mode.ts`.

| Field | Type | Meaning |
|---|---|---|
| `enabled` | `boolean` | The guard and the per-turn message apply while this is `true`. |

- `AgentSession.#masterModeState: MasterModeState | undefined`. `undefined` means off.
- `getMasterModeState()` and `setMasterModeState(state)` follow `getVibeModeState` and `setVibeModeState` (`session/agent-session.ts:8082-8110`).
- `setMasterModeState` with a missing or disabled state also removes the hidden master messages from the agent messages, the steering and follow-up queues, and `#pendingNextTurnMessages`.
- `ToolSession.getMasterModeState?: () => MasterModeState | undefined` (`tools/index.ts:464`). `sdk.ts:2721` wires it to `session?.getMasterModeState()`. Only `TaskTool` reads it (R3 in research.md).
- `InteractiveMode.masterModeEnabled: boolean` mirrors the flag for the UI, as `vibeModeEnabled` does (`interactive-mode.ts:1560`). The status line gets `{ enabled }` or `null`.

A subagent session never has a state. This is why the guard applies to the main agent only.

## MasterModeEntry

The saved form. One `custom` entry in the session file, written on each change.

| Field | Value |
|---|---|
| `type` | `"custom"` |
| `customType` | `"master-mode"` (`MASTER_MODE_ENTRY`) |
| `data` | `{ enabled: boolean }` |

- Writer: `InteractiveMode.#saveMasterModeState()` calls `sessionManager.appendCustomEntry` (`session-manager.ts:3747`).
- Reader: `restoreMasterMode()` takes the latest matching entry of `sessionManager.getBranch()`. A missing entry, or a malformed `data`, means off.
- The entry is not part of the model context.
- It is not a `mode_change` entry. `mode_change` holds one mode, and goal mode overwrites it (research R6).

## Master message

A hidden custom message, rebuilt every prompt turn while the mode is on. It is never saved.

| Field | Value |
|---|---|
| `role` | `"custom"` |
| `customType` | `"master-mode-context"` (`MASTER_MODE_CONTEXT_MESSAGE_TYPE`) |
| `content` | the rendered `prompts/system/master-mode-active.md` |
| `display` | `false` |
| `attribution` | `"agent"` |

The persistence step in `agent-session.ts:4702` skips this type, as it skips the vibe type.

## Master allowlist

A fixed rule in `masterRefusal(toolName, args)`. It has no state and no setting.

| Tool name | Condition for allow |
|---|---|
| `task` | Always at the guard. `TaskTool` refuses a foreground run itself. |
| `bash` | `args.async === true` and `args.name` is empty or blank. |
| `read`, `grep`, `glob`, `find`, `todo`, `ask`, `goal`, `loop`, `spawn_session` | Always. |
| `write` | The target resolves through `InternalUrlRouter.instance().writeTarget` to a scheme with write scope `coordination`, `reply`, or `sandbox`, or to a URL that the scheme's `cancels` accepts. |
| any other name | Never. |

Function result: `string | undefined`. A string is the refusal text. `undefined` means allow.

### Refusal cases

Each text says that master mode is on, names the allowed way, and ends with `Do not retry or route around this block.` The exact texts are in [contracts/master-mode.md](contracts/master-mode.md).

| Case | Trigger |
|---|---|
| `file-change` | `edit`, `ast_edit`, `write` to a project path or to `xd://`, `cfg://`, `conflict://`, `ssh://`, `vault://`, or `proc://…/stdin` |
| `foreground-bash` | `bash` without `async: true` |
| `service-bash` | `bash` with a non-blank `name` |
| `wait` | `wait` |
| `foreground-task` | `task` that would run in the foreground (from `TaskTool`) |
| `other` | any other tool, including MCP and extension tools |

`ast_grep` is refused as `other`. It is not on the allowlist, and `grep` and `glob` cover the search needs of the main agent.

## State transitions

```text
off ──/master or --master (checks pass)──▶ on
on  ──/master──▶ off
on  ──resume of a branch whose latest entry is enabled──▶ on
on  ──/new, or a session switch to a branch with no entry──▶ on (entry written), unless the target restores plan, vibe, impl_review, or speckit-auto
any ──session switch to a branch whose latest entry is disabled──▶ off
```

Entry checks (research R7): speckit-auto on, plan on or paused, vibe on, `async.enabled` off, no async job manager. Any failing check keeps the state `off` and shows a message. Goal mode and loop mode do not block entry. The status line, the guard, and the per-turn message all follow the one flag, so they change together.

Exit applies from the next tool call. A running turn is not aborted, and running background work is not stopped. A result that arrives after exit still reaches the main agent, because the async job sink does not depend on the mode.
