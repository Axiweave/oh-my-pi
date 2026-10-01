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

Session flags override the configured value:

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

At startup, OMP resolves the target with the normal model-role and model-matching rules. A role tries its configured models in order and uses the first one with credentials. `@default` means the `default` role from your config, also when `--model` sets the starting model. If the target cannot be resolved or has no configured credentials, OMP prints a warning and starts with prewalk unarmed.

## Handoff trigger

An armed prewalk injects a planning nudge. When the `todo` tool is active, any successful `todo` call—including the read-only `view` operation—opens the handoff gate. OMP then switches models after the first completed `edit` or `write` call.

Calls to other tools do not trigger the handoff. A read-only `xd://` device request routed through `write`, such as LSP navigation, also does not count; only device operations classified as workspace writes or execution count.

The switch is one-shot: after the handoff, prewalk disarms itself. The target model and thinking level are not changed when they already match the active session, because that handoff would be a no-op.

## Arm from an active session

Run either slash command without restarting OMP:

```text
/prewalk
/prewalk restart
```

`/prewalk` arms a one-shot handoff from the active model to the current `prewalk.into` target.

After a handoff, `/prewalk restart` immediately returns the session to the current `@default` assignment and re-arms the handoff to the `prewalk.into` target. Both selectors are resolved when the command runs, so the cycle is independent of concrete model names and does not alter either role's persisted configuration. When the target resolves to the same model and thinking level as `@default`, the command only returns to `@default` and arms no handoff.

If prewalk is already armed, the command leaves the existing target in place. To choose a different target, set `prewalk.into` or use `--prewalk-into` at startup.

## Subagent prewalk

Task subagents have separate prewalk controls: agent frontmatter, `task.prewalk`, and per-agent `task.agentPrewalk` overrides. See [Task agent discovery](./task-agent-discovery.md) for their precedence and target selection.
