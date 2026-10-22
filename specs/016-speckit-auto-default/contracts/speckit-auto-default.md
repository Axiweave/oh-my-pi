# Contract: Speckit-Auto Startup Default

## Config

```yaml
# ~/.omp/agent/config.yml (global) or <project>/.omp/config.yml (project, wins)
speckitAuto:
  defaultOnStartup: off   # off | full | tasks
```

Settings panel: tab `interaction`, group `Input`, label "Speckit auto on startup", with the options `off`, `full`, and `tasks`.

## `/speckit-auto-mode [off|full|tasks] [global|project]`

Inline hint: `[off|full|tasks] [global|project]`. The autocomplete description stays `ctx.getSpeckitAutoDescription()`.

| Input | Session effect | Config effect | Feedback |
|---|---|---|---|
| (none) | Cycle off → full → tasks → off (unchanged) | none | unchanged messages |
| `<value> global` | as above | `speckitAuto.defaultOnStartup: <value>` in the global config | "Speckit-auto startup default: <value> — saved as the startup default (global config)" (the status bar shows the mode) |
| `<value> project` | as above | the same key in `.omp/config.yml` | "Speckit-auto startup default: <value> — saved as the startup default (.omp/config.yml)" |
| `<value> <scope>`, and turning on is refused | unchanged; the refusal warning shows | none | the existing refusal warning ("Exit plan mode first." / missing commands) |
| anything else | none | none | "Usage: /speckit-auto-mode [off\|full\|tasks] [global\|project]" |

## Startup notices

| Case | Message |
|---|---|
| Default applied | "Speckit-auto mode on. Run /speckit.specify <feature> to start." (existing) |
| Blocked by a mode | "Speckit-auto mode stays off: <mode> mode is on." (`<mode>` ∈ goal, plan, loop, vibe) |
| Missing phase commands, resumed session, setting off | no message |

## `InteractiveModeInitOptions`

`startsGoal?: boolean`. `main.ts` sets it when `--goal` starts goal mode after `init`. Then the default reports `goal` as the blocker.

## `InteractiveModeContext`

`setSpeckitAutoMode(target: "off" | "full" | "tasks"): boolean`. It returns true when the mode is in the target state at the end.

## `Settings`

`setProjectValue(setting: AnySetting, value: unknown): void`. It writes the project layer and saves it to `<cwd>/.omp/config.yml` on the next flush. It replaces `setProjectCyberMode`, `setProjectReviewUsesPlan`, and `setProjectModelProfile`.
