# Contract: `/cyber` Slash Command

One command toggles the protection and reports the resulting state. It registers
in `packages/coding-agent/src/slash-commands/builtin-modes.ts` beside
`/model-profile`, and is also bound to a configurable key
(`app.model.toggleCyber`, default `alt+shift+x`).

## Invocation forms

| Form | Behavior |
|---|---|
| `/cyber` | Toggle the state for the running session. Report the new state |
| `/cyber on` | Enable. Idempotent: enabling an enabled session reports the state, changes nothing |
| `/cyber off` | Disable. Idempotent the same way |
| `/cyber status` | Report the state and the allowlist in effect, without changing anything |
| `/cyber on global` | Enable and persist `cyberMode: true` in the global config |
| `/cyber on project` | Enable and persist `cyberMode: true` in the project config |
| `/cyber <anything else>` | Usage message. State unchanged |

The persistence scope argument mirrors `/model-profile [name] [global|project]`
(`persistModelProfile`, `builtin-modes.ts:107`; the command itself registers at `:637`), including that omitting it
changes the session only.

## Enabling

In order:

1. Read the allowlist. If empty, refuse: "No cyber-capable models configured —
   add `cyberModels` to your config." State stays off (FR-016).
2. Resolve every allowlist entry against available models. If none resolves,
   refuse with the offending entries named. State stays off (FR-016).
3. Filter every role chain. Keep allowlisted survivors in order; substitute the
   primary for a chain with none (FR-006, FR-007).
4. Install the filtered role view and mark the state on.
5. Re-point the active model if it is outside the allowlist, taking effect for
   the next model call (FR-008).
6. Emit the fallback report naming every changed role (FR-011).
7. Record the state on the session (FR-021).
8. Report the new state and the models in effect.

The enable is one operation from the operator's view. Partial application is not
a reachable state: steps 4 through 7 either all land or the enable was refused at
step 1 or 2.

## Disabling

Restores the configured role resolution exactly (FR-028) and reports the state.
The active model is deliberately left in place (research D4): it is a model the
operator allowed, and a mode toggle should not also be a model switch.

## Refusals

Every refusal names cyber mode as the reason and leaves the state unchanged:

| Situation | Message shape |
|---|---|
| Empty allowlist | ``No cyber-capable models configured — add `cyberModels` to your config.`` |
| No allowlist entry resolves | `Cyber mode unavailable: none of <entries> resolves to an available model.` |
| Bad argument | `Usage: /cyber [on\|off\|status] [global\|project]` |

## Reporting

Enabling and status both report the state, the allowlist size, every allowed model,
and the active model. Example shapes:

```text
Cyber mode on — 2 models allowed: anthropic/claude-sonnet-5, openai/gpt-5, active: anthropic/claude-sonnet-5
Cyber mode off — roles resolve from configuration.
```

The fallback report is a separate warning notice carrying the per-role list
(`contracts/session-entry.md` describes the recorded side; the notice goes
through `emitNotice`).

## Key binding

| Action | Default | Description |
|---|---|---|
| `app.model.toggleCyber` | `alt+shift+x` | Toggle cyber mode |

Declared in `AppKeybindings` and `KEYBINDINGS`
(`packages/coding-agent/src/config/keybindings.ts`), and bound in
`modes/controllers/input-controller.ts` beside `onCycleModelProfileForward`.
`alt+shift+c` is the shape the contract first named, but `app.clipboard.copyPrompt`
holds that chord, so the default is `alt+shift+x`.
The key is rebindable by the operator like every other action.

## Non-interactive behavior

`handle` (the text and ACP path) performs the same toggle and writes the state
line through `runtime.output`. `handleTui` adds `ctx.showStatus` reporting
through the cycle-track helper that model profile switches use.
