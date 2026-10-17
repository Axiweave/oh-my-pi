# Prewalk

Prewalk is a one-shot handoff from the active model to a faster or cheaper model after planning reaches implementation. It lets the starting model inspect the repository, create a todo list, and begin the change before the target model continues the session.

Prewalk is off by default. Its default target is the model assigned to the `@smol` role. Set `prewalk.into` to change it. To have OMP decide per task whether a prompt is worth it, see [Auto-prewalk](#auto-prewalk).

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
| `--no-prewalk` | Leave prewalk disabled for the startup session, even when `prewalk.enabled` is `true`, and keep [auto-prewalk](#auto-prewalk) out of it. `/new` still follows the settings. |
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

`/new` starts a fresh cycle using `prewalk.enabled` and the current `prewalk.into` target, rather than inheriting a consumed handoff or the previous todo gate. With `@@`, the target is the model that is active after `/new`. Startup flags (`--prewalk`, `--no-prewalk`, `--prewalk-into`) apply only to the startup session; `/new` always uses the configured setting. When prewalk is enabled, the new session restores the previous planning model and thinking level after a handoff unless a later selection replaced them. If the planning model can no longer be used (for example, its credentials were removed), `/new` warns and stays on the current model. Resuming an existing session does not automatically re-arm prewalk.

Any model or thinking-level change made after the handoff counts as a replacement, including the switches plan mode makes on entry and exit. Automatic retry fallback, fallback restoration, and context promotion do not; if the session is back on the handoff model and thinking level when you run `/new`, it still restores the planning model.

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

`/prewalk off` silently drops a pending handoff for this session. The session stays on the active model, and pending planning steering is removed. Continuation history that was already delivered stays. It does not switch back to the planning model after a handoff. When nothing is armed, it prints "Prewalk: nothing armed." It also keeps [auto-prewalk](#auto-prewalk) from arming again until `/new`. It does not change `prewalk.enabled`, so `/new` and the next session re-arm prewalk when that setting is `true`.

The unbound `app.prewalk.toggle` keybinding runs `/prewalk` when disarmed or `/prewalk off` when armed. It preserves the current draft.

`/prewalk`, the `app.prewalk.toggle` key, turning `prewalk.enabled` on, and an auto-prewalk arm show an "armed" notice. Set `prewalk.armNotice: false` to hide it.

## Auto-prewalk

`prewalk.enabled` and `/prewalk` unconditionally arm a one-shot handoff. Auto-prewalk asks OMP's native judge, per task, whether prewalk is worthwhile, and arms the same handoff from the active model when it is. It is a prewalk-suitability check, not a difficulty rating or a general model router: it never picks a different planning model.

```yaml
prewalk:
  enabled: false
  auto: on
  autoTarget: "@smol"
```

`prewalk.autoTarget` (default `@smol`) takes a model pattern or role, resolved with the normal role and model-matching rules, including authentication.

| `prewalk.auto` | Behavior |
| --- | --- |
| `off` (default) | No classification; nothing changes. |
| `suggest` | Classifies each new task and reports the decision only. Never arms prewalk or switches models. |
| `on` | Classifies each new task. When the judge is confident the task fits and the target resolves with a usable credential, arms a handoff from the active model to the target; otherwise nothing changes. |

Run `suggest` for a while to see how it judges your prompts, then set `auto: on`. To plan on a stronger model, make it your active (`@default`) model; auto-prewalk hands off from whatever you are on.

`prewalk.enabled` keeps its meaning: unconditional prewalk, independent of `prewalk.auto`.

### Requirements

Auto-prewalk needs the `judge` model role to resolve first to a native judgment backend, the same condition as `find.enabled: auto`. It uses the existing judge-role provider support, including TypeSafe `jev`, OpenRouter, OpenAI Decisions, and Workers AI Clef. It relies on calibrated probabilities and never executes a prompted on-device or chat judge, even if the judge-role cache predates a login or discovery change. Without a native judge nothing is classified, and nothing is reported.

### What it decides

The judge sorts each task by where its expensive reasoning belongs, not by how hard or large it is:

| Route | Meaning | Typical tasks |
| --- | --- | --- |
| `prewalk` | The hard thinking comes first; once it settles the approach, the remaining implementation and verification are bounded. | Tracing an unfamiliar subsystem before a localized change; reading several interacting files before implementing a clear design; diagnosing a bug down to a concrete fix; a migration whose hard part is finding the transformation and everything it touches. |
| `primary` | Strong reasoning stays necessary while implementing, debugging, or validating, so the first edit is too early to hand off. | Unresolved races or invariants; subtle lifecycle changes; a bug whose cause will still be unclear after a first look; high-risk or algorithmically hard changes. |
| `direct` | There is no up-front phase worth handing off from. | Explanations and read-only questions; trivial, mechanical, or fully specified edits; tiny localized fixes. |

Volume of work alone and difficulty alone never make a task a prewalk candidate, and a wrong handoff costs more than a missed one: between `prewalk` and `primary` the judge is told to choose `primary`, and for a small task to choose `direct`. OMP arms only when `prewalk` wins **and** its probability is at least 0.70. That threshold is fixed, and a `prewalk` winner below it counts as a "no".

`suggest` reports one line per judged task:

```text
Auto-prewalk: prewalk 0.84
Auto-prewalk: primary (prewalk 0.18)
Auto-prewalk: direct (prewalk 0.06)
Auto-prewalk: prewalk 0.55 (below threshold)
```

Under `on`, a confident decision shows the usual `Prewalk: armed for …` notice (unless `prewalk.armNotice` is `false`); other decisions are only logged. The plan nudge travels with the task's first request, and the existing handoff does the switching, with its todo gate and first `edit`/`write` trigger unchanged. Like a configured prewalk, an armed task skips the `todo.eager` reminder, since the plan nudge owns todo creation.

### One task at a time

An automatic handoff belongs to the task that armed it. When the next task starts, OMP returns to the model and thinking level that task planned on, then judges the new task, so a `primary` task is never left on the handoff target. `/new` does the same. An auto arm that its task never used is dropped at the next task, which is judged on its own.

An explicit model or thinking-level selection after the handoff takes ownership: the session stays where you put it. Handoffs made by `/prewalk`, `--prewalk`, or `prewalk.enabled` are never restored by auto-prewalk.

### What is classified

Only new, user-authored tasks in the top-level session: typed prompts, user-invoked `/skill:` prompts, and queued follow-ups when they are delivered. Steering is never classified, since it amends the task already running. Acknowledgements such as `ok` or `thanks`, synthetic continuation turns, agent-attributed messages, subagents, plan mode, and tasks where prewalk is already armed are skipped.

The judge runs alongside the rest of prompt setup (memory recall, hooks, auto thinking), and its decision is applied just before the request is sent, so it adds latency only when it is the slowest setup step.

A follow-up such as `do that` or `continue` cannot be judged alone, so the judge also sees the previous substantive user request and the agent's last reply, each truncated like other small-model input. The current request stays authoritative: the context only resolves what it points at.

### Manual controls win

A negative, direct, or sub-threshold decision, or a classifier error, leaves the model, thinking level, and prewalk exactly as they were.

A pending prewalk from `/prewalk`, `prewalk.enabled`, or `--prewalk` is never replaced, retargeted, or reclassified. `/prewalk off` and `--no-prewalk` keep auto-prewalk out of the session (for `--no-prewalk`, the startup session) until `/new`, and neither switches models. An explicit `/prewalk` or `/prewalk restart` takes over a pending auto arm, which then behaves like a manual one.

### Failure behavior

Auto-prewalk is an optimization and fails open. A missing native judge, a judge error or malformed answer, the 4-second timeout, an abort, or a prompt superseded while the judge ran all leave the task exactly as it would be without auto-prewalk. Answers with invalid probabilities, an inconsistent winning route, or invalid confidence are rejected. Judge failures are logged rather than shown; an unusable target reports an `Auto-prewalk not armed: target …` warning. Judgments are journaled as model usage under the purpose `auto-prewalk`.

## Subagent prewalk

Task subagents have separate prewalk controls: agent frontmatter, `task.prewalk`, and per-agent `task.agentPrewalk` overrides. See [Task agent discovery](./task-agent-discovery.md) for their precedence and target selection.
