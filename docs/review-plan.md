# Review plan mode

Review plan mode sends reviews to the active profile's `plan` model instead of its `reviewer` model. Use it when the reviewer's provider has no usage left.

## Turning it on and off

```text
/review-plan                # toggle for this session
/review-plan on             # reviews use the plan model
/review-plan off            # reviews use the reviewer model
/review-plan status         # show the state and the review model
/review-plan on global      # also save reviewUsesPlan: true in ~/.omp/agent/config.yml
/review-plan off project    # also save reviewUsesPlan: false in ./.omp/config.yml
```

`reviewUsesPlan` (default `false`) is the startup value. Plain `on` and `off` change only the current session.

## What it changes

While the switch is on and a `plan` role resolves:

- `@reviewer` reads the `plan` role in agent frontmatter, `task.agentModelOverrides`, and task requests.
- The `reviewer`, `plan-reviewer`, and `impl-reviewer` agents use `plan`, even when a saved override names a fixed model.
- A custom agent whose first role alias is `@reviewer` also uses `plan`.
- A review agent on the plan model retries through the `plan` fallback chain. In main-session and eval retries, a `reviewer` reference reads `plan` too, and `retry.fallbackChains.reviewer` is set aside, so it cannot claim a plan-model session.
- While the switch is on, the real reviewer model no longer owns the `reviewer` chain. A session or completion that runs on it retries only through a chain keyed by its own selector, for example `retry.fallbackChains["openai-codex/gpt-6-sol"]`.
- Only a `model` given on one task request wins over the switch. A request that names `@reviewer` still reads `plan`.

When no `plan` role resolves, the switch stays on but has no effect, and reviews keep the reviewer model. `/review-plan` says so. A warning also shows when a session starts or resumes in this state, and when a profile change removes the `plan` model.

A subagent that is already running keeps its model. The switch applies to the next spawn.

## Session lifecycle

The state belongs to one session. Two sessions on the same configuration keep separate states.

- The session transcript records the state. Resume, `/resume`, and a session switch read it back, even when `reviewUsesPlan` says otherwise.
- `/new` and `/clear` keep the current state.
- `/fork`, branch selection, and tree navigation restore the destination's recorded state.
- A subagent starts with its parent's state.
- A transcript that has no record starts from the parent's state, then from `reviewUsesPlan`.

## Status line

The `review_plan` segment shows `⇄ Review:Plan` (`[RP]` with ascii symbols) while the switch takes effect. It is in the default layout and the `claude3` footer. Custom layouts can add it through `statusLine.leftSegments` or `statusLine.rightSegments`.
