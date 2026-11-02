# Quickstart: Spawn During Speckit-Auto Mode

## Unit tests

From `packages/coding-agent`:

```sh
bun test test/interactive-mode-speckit-auto.test.ts test/spawn-command.test.ts test/speckit-auto.test.ts
```

The new tests (research R7) must pass. Before the change, each one fails, except the paused guards.

## Smoke run (real omp in zmx)

Prerequisites:
- `omp-dev` runs this checkout.
- `zmx` and `specify` are on `PATH`.
- Create sessions with `env -u ZMX_SESSION -u ZMX_SESSION_PREFIX -u EMACS_BUFFER_NAME`.

Setup:

1. Create a throwaway repository with one commit:

   ```sh
   git init -b main /tmp/spawn-speckit
   git -C /tmp/spawn-speckit commit --allow-empty -m init
   ```

2. Run `specify init --here --integration omp` in that repository. The default integration is Copilot, and only `omp` writes the `.omp/commands/speckit.*.md` commands.
3. Start the parent:

   ```sh
   zmx attach spawn-speckit-p omp-dev --auto-approve </dev/null
   ```

   Use `/tmp/spawn-speckit` as the working directory.

Runs:

| # | Input | Expected |
|---|---|---|
| 1 | `/speckit-auto-mode`, then `/spawn list the files` with no run | No "Turn off speckit-auto mode first" warning. A child session starts. The status line still shows the mode on and waiting. |
| 2 | Start a run with `/speckit.specify add a hello command`. Wait until the run holds or waits between phases. Then run `/spawn list the files`. | A child session starts. The status line shows the same phase and state as before the spawn. The last saved `speckit-auto` entry in the parent session file is the same as before the spawn. |
| 3 | Press Esc during a phase turn to pause the run (`pauseSpeckitAuto`). Then run `/spawn list the files`. | A child session starts. The run stays paused. |

## Cleanup

1. End each child zmx session and the parent session.
2. Delete `/tmp/spawn-speckit`.

## Repository checks

From the repository root, run `bun check`. Make sure that the exit code is 0.
