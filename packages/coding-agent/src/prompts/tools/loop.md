Finish a `/guided-loop` interview. Exists only while that interview runs.

Single `op` field:
- `start`: send the final setup. OMP shows the user a yes/no dialog with the equal `/loop` line; loop mode turns on only on yes. NEVER ask for a separate confirmation in chat first.
  - `prompt` (required): self-contained instruction repeated on each run.
  - `limit`: run count (`10`) or total time (`2h`, `90 minutes`). Omit for no limit.
  - `every`: fixed time between run starts (`15m`, `1h30m`). Omit to repeat after each turn.
  - `while` / `until`: shell command re-checked before each later run; `while` continues while it exits 0, `until` continues until it exits 0. At most one. NEVER run it yourself.
- `cancel`: end the interview with no loop. Call when the user declines or asks to stop.

Results:
- Setup does not parse as `/loop` → fix the named part and call again.
- User declined → ask what to change.
- Loop started → end your turn with no more text.
