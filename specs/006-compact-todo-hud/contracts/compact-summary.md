# Contract: Compact summary line

`renderCompactStatusLine(width, childLines) → readonly string[]`

## Output shape

- It returns `childLines` without change when there is no task or when the HUD is hidden.
- Otherwise, it returns `[...leading, combined]`:
  - `leading` is `childLines` without the last row, or `[""]` when `childLines` has one row or fewer.
  - `combined` is the last child row, then padding, then the summary, then one space.

Summary grammar (visible text):

```text
TODO <closed>/<total> · <task-line>[ · <n> blocked]
<task-line> := <checkbox> <content>[ (blocked)][ <notes-marker>]  |  ☑ done
```

## Invariants

1. `visibleWidth(combined) <= width` for every `width >= 1`.
2. The summary is never wider than one row, and `combined` has no newline.
3. **Shortening order:** first the task text, down to 12 cells. After that, the left row is shortened. The label, the counts, and the blocked suffix are not cut before the task text.
4. **Current task:** the first `in_progress` task, else the first `pending` task, else the first `blocked` task. The order is plan order across phases.
5. `☑ done` shows only when every task is `completed` or `abandoned`.

## Examples (visible text, width 110)

```text
⠋ Finding readiness blockers…    TODO 10/12 · ☐ Complete T044 provider-free zero-hard-blocker readi… · 1 blocked
                    TODO 11/12 · ☐ Re-complete T041 with a separate disposable data… (blocked) · 1 blocked
                                                                                    TODO 12/12 · ☑ done
```
