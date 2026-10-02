# Prewalk

Prewalk is a one-shot handoff from the active model to a faster or cheaper model after planning reaches implementation. It lets the starting model inspect the repository, create a todo list, and begin the change before the target model continues the session.

Prewalk is off by default. Its default target is the model assigned to the `@smol` role. Set `prewalk.into` to change it.

## Enable prewalk

Enable prewalk persistently in the global config:

```bash
omp config set prewalk.enabled true
```

The equivalent YAML in `~/.omp/agent/config.yml` or a project `.omp/config.yml` is:

```yaml
prewalk:
  enabled: true
  into: "@default" # optional; model pattern or role, default "@smol"
```

The configured setting arms new sessions, not resumed/imported sessions. Explicit session flags can arm either:

| Flag | Effect |
| --- | --- |
| `--prewalk` | Arm prewalk for the new session. |
| `--no-prewalk` | Leave prewalk disabled for the session, even when `prewalk.enabled` is `true`. |
| `--prewalk-into <model-or-role>` | Arm prewalk and use the supplied model pattern or role instead of `prewalk.into`. |

For example:

```bash
omp --prewalk
omp --prewalk-into @smol
omp --prewalk-into openai/gpt-5-mini
```

At startup, OMP resolves the target with the normal model-role and model-matching rules. A role tries configured candidates in order for an authenticated, enabled provider. Extension-provided targets can resolve after extension registration. If no usable target remains, OMP prints a warning and starts with prewalk unarmed.

`--no-prewalk` cannot be combined with `--prewalk` or `--prewalk-into`. `@default` means the configured `default` role, even when `--model` changes the starting model.

### Keep the starting model: `@@`

The special target `@@` means "the model that the session or subagent starts on". Prewalk still runs its full flow: the planning nudge, the todo gate, and the checklist at the handoff. The handoff does not change the model. Use `@@:<level>`, for example `@@:low`, to keep the model and change only the thinking level at the handoff.

```yaml
prewalk:
  into: "@@"
task:
  agentPrewalk:
    task: "@@"
```

A normal target that resolves to the same model and thinking level is a no-op, and OMP disarms it. `@@` is never a no-op.

## Handoff trigger

An armed prewalk injects a planning nudge. When the `todo` tool is active, any successful `todo` call—including the read-only `view` operation—opens the handoff gate. Without an active `todo` tool, the gate is already open.

OMP switches at the completed assistant-turn boundary containing the first eligible `edit` or `write` result, after persisting that turn's assistant message and tool results. Unlike the todo gate, the edit/write trigger does not require a successful result.

Calls to other tools do not trigger the handoff. A read-only `xd://` device request routed through `write`, such as LSP navigation, also does not count; only device operations classified as workspace writes or execution count.

The handoff disarms prewalk, removes the planning nudge, and steers the target with an implementation checklist. It changes the active model and optional thinking level without rewriting model-role assignments. A normal target with the same model and effective thinking configuration disarms without switching. The `@@` target still sends the checklist.

## Control prewalk from an active session

In a top-level session, changes to `prewalk.enabled` take effect immediately. Enabling it arms the current `prewalk.into` target when none is armed. Disabling it disarms a pending handoff. This setting does not control subagent prewalk.

Run these slash commands without restarting OMP:

```text
/prewalk
/prewalk restart
/prewalk off
```

`/prewalk` arms a one-shot handoff from the active model to the current `prewalk.into` target.

After a handoff, `/prewalk restart` returns to the current `@default` assignment and re-arms the `prewalk.into` target. OMP resolves both selectors when the command runs without changing either role's saved configuration. A normal target that matches `@default` and its thinking level arms no handoff. With `@@`, restart retains the full prewalk flow on the returned model.

If prewalk is already armed, `/prewalk` leaves the existing target in place. `/prewalk restart` also preserves a matching arm. If the existing target differs from the current `prewalk.into` resolution, restart rejects the change before switching models. To choose another target, set `prewalk.into` or use `--prewalk-into` at startup.

`/prewalk off` drops a pending handoff for this session. The session stays on the active model, and the planning nudge is removed. It does not change `prewalk.enabled`, so the next session still starts with prewalk when that setting is `true`.

The unbound `app.prewalk.toggle` keybinding runs `/prewalk` when disarmed or `/prewalk off` when armed. It preserves the current draft.

`/prewalk`, the `app.prewalk.toggle` key, and turning `prewalk.enabled` on show an "armed" notice. Set `prewalk.armNotice: false` to hide it.

## Subagent prewalk

Task subagents have separate prewalk controls: agent frontmatter, `task.prewalk`, and per-agent `task.agentPrewalk` overrides. See [Task agent discovery](./task-agent-discovery.md) for their precedence and target selection.
