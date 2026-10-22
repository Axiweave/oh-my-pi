# Quickstart: Validate the Speckit-Auto Startup Default

## 1. Automated checks

```sh
cd packages/coding-agent
bun test test/interactive-mode-speckit-auto.test.ts test/settings-manager.test.ts test/settings-reload-cwd.test.ts
bun run check:types
cd ../.. && bunx oxfmt --check
```

Expected: all pass. The speckit test file has new cases for the rows in section 3.

## 2. Smoke setup

1. Make `/tmp/speckit-default-smoke` with `.omp/` and the seven `speckit.*` commands (copy them from this repository's `.omp/commands`, or use the fake phase commands from `specs/009-speckit-auto-pipeline/quickstart.md` section 2).
2. Make `/tmp/no-speckit-smoke` with no speckit commands.
3. Back up `~/.omp/agent/config.yml`.

## 3. Scenarios (real `omp`)

| # | Setup | Action | Expected |
|---|---|---|---|
| 1 | global `full` | `omp` in the speckit dir | Status bar shows the mode on. `/speckit-auto-mode` autocomplete shows "Speckit auto: on (waiting)". |
| 2 | global `tasks` | `omp` in the speckit dir | Mode on, `Speckit→tasks`. |
| 3 | global `full`, project `off` | `omp` in the speckit dir | Mode off. |
| 4 | global `off`, project `tasks` | `omp` in the speckit dir | Mode on to tasks. |
| 5 | global `full` | `omp` in `/tmp/no-speckit-smoke` | Mode off, no warning. |
| 6 | global `full`, `plan.defaultOnStartup: true` | `omp` in the speckit dir | Plan mode on. Status "Speckit-auto mode stays off: plan mode is on." |
| 7 | global `full` | `omp --goal "say hi"` in the speckit dir | The goal runs. Speckit stays off with the goal notice. |
| 8 | global `full` | Turn the mode off, send one message, quit, `omp --resume` | Mode off. |
| 9 | global `full` | Old session with messages and no speckit entry: `omp --resume` | Mode off. |
| 10 | global `full` | `/speckit-auto-mode off`, then `/new` | The new session has the mode on (brand-new). |
| 11 | global `off` | `/speckit-auto-mode tasks project` | Mode on to tasks. `.omp/config.yml` has `speckitAuto.defaultOnStartup: tasks`. Restart: on to tasks. |
| 12 | any | `/speckit-auto-mode full global` | `~/.omp/agent/config.yml` has `full`. |
| 13 | any | `/speckit-auto-mode bogus` | Usage text. Nothing changes. |
| 14 | global `bogus` (edit the file) | `omp` | Mode off. The debug log has "ignoring invalid value". |

## 4. Cleanup

Restore `~/.omp/agent/config.yml` from the backup, then append `speckitAuto.defaultOnStartup: off` under the existing `speckitAuto:` block. Delete both `/tmp` dirs.
