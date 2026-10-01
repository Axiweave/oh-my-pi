# Quickstart: Validate Task Effort Mapping

## Prerequisites

- Repository dependencies are installed (`bun install`).
- `PATH="$HOME/.cargo/bin:$PATH"` is set for `bun check`.

## 1. Type check

```sh
PATH="$HOME/.cargo/bin:$PATH" bun check
```

Expected: exit code 0.

## 2. Mapping and ceiling tests

```sh
bun test packages/coding-agent/test/auto-thinking-classifier.test.ts
bun test packages/coding-agent/test/task/executor-pass-through.test.ts
bun test packages/coding-agent/test/task/task-batch.test.ts
```

Expected: all pass. The mapping test covers 63 supported lists × 5 requests against the reference (see [data-model.md](data-model.md)).

## 3. Smoke: resolve real catalog models

Run a throwaway script with `bun -e` that calls `resolveTaskEffortLevel` for each request on these models:

| Model | Expected `low, medium, high, xhigh, max` |
|---|---|
| A `low..max` model (for example `anthropic/claude-opus-5-5`) | low, medium, high, xhigh, max |
| A `low,medium,high` mock | low, medium, medium, high, high |
| A `minimal..xhigh` model | low, medium, high, xhigh, xhigh |
| No model | low, medium, high, xhigh, max |

## 4. Smoke: tool description and schema

1. Set `task.enableEffort: true` in a scratch config.
2. Start `omp` and read the task tool description.
3. Make sure the `effort` line lists the five levels with their criteria (see [contracts/task-effort.md](contracts/task-effort.md)).
4. Spawn one subagent with `effort: "medium"`.
5. Make sure the subagent row shows the mapped level.
6. Spawn one subagent with `effort: "med"`.
7. Make sure the call fails with the five-value error.
