# Contract: `/guided-loop` and the `loop` tool

## Command

`/guided-loop [rough idea]`

- **Autocomplete hint:** `[rough idea]`
- **Description:** "Have the agent interview you in chat, then set up loop mode"
- **Autocomplete text under speckit-auto mode:** "Guided loop: blocked by speckit-auto mode"

| State when typed | Effect | Message |
|---|---|---|
| speckit-auto mode on | Nothing. | The existing speckit-auto refusal |
| guided-goal interview active | Nothing. | `Finish the guided goal interview first.` |
| guided-loop interview active | A new kickoff starts. The old interview state stays. | none |
| loop on, not paused | Pause the loop, then start the interview. | none |
| loop paused, or loop off | Start the interview. | none |

While a guided-loop interview runs:

| Input | Effect |
|---|---|
| a normal message | It goes to the agent as an answer. It does not become a loop prompt. |
| `c` or `.` alone | It goes to the agent as an answer, not as a continue shortcut. |
| `/guided-goal` | `Finish the guided loop interview first.` |
| speckit-auto turn-on | `Finish the guided loop interview first.` |
| `/loop …` | The interview ends. Then `/loop` runs as usual. |

## Tool `loop` (hidden; available only during a guided-loop interview)

Input:

```json
{ "op": "start", "prompt": "…", "limit": "8h", "every": "15m", "until": "gh run view --exit-status" }
{ "op": "cancel" }
```

| Case | Dialog | Loop state | Result text to the agent |
|---|---|---|---|
| `start`, missing or blank `prompt` | none | no change | `prompt is required.` |
| `start`, both `while` and `until` | none | no change | `Use only one of while or until.` |
| `start`, `args` do not round-trip through `/loop` | none | no change | `This setup does not parse as /loop <args>: <reason>. Fix it and call loop again.` |
| `start`, no handler installed | none | no change | `No guided loop interview can confirm this loop.` |
| `start`, user chooses No, presses Enter on the default, closes the dialog, or the turn aborts | `Start this loop?` / `/loop <args>`, plus `This replaces the current loop (<bounds>).` when a loop is on or paused. **No** is selected first. | no change | `The user declined this loop. Ask what to change.` |
| `start`, user chooses Yes | as above | loop on (or replaced) with the setup. The prompt runs once, at once. | `Loop started: /loop <args>` and, on the next line, `End your turn now with no more text.` |
| `cancel` | none | no change. The interview ends. | `Guided loop interview ended. No loop started.` |

`args` = `[limit] [every <every>] [--while|--until '<cmd>'] <prompt>`, with the command in POSIX single quotes.

After Yes, the transcript shows `/loop <args>` as a status line, and then the usual `Loop mode enabled. …` or `Loop updated. …` message.
