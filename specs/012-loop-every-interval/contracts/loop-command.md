# Contract: `/loop` command

## Grammar

```text
/loop [LIMIT] [every DURATION] [--while|--until CMD] [PROMPT]

LIMIT     := COUNT | DURATION
COUNT     := positive integer
DURATION  := COMPACT | SPACED
COMPACT   := (INT UNIT)+          e.g. 15m, 90s, 1h30m
SPACED    := INT " " UNIT         e.g. 15 minutes
UNIT      := s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours
CMD       := one shell word; quote it when it has spaces
```

The parts must come in this order. Text after the last part that parses is `PROMPT`.

## Parse results

| Input | Result |
|---|---|
| `every 15m check CI` | interval 15 min, prompt `check CI` |
| `every 15 minutes` | interval 15 min, no prompt |
| `8h every 15m --until 'gh pr checks' check CI` | time limit 8 h, interval 15 min, until-condition, prompt |
| `3 every 1h30m` | count 3, interval 90 min |
| `every file has a test` | no interval, prompt `every file has a test` |
| `every` | error: `every needs a duration, for example /loop every 15m.` |
| `every 15` / `every 1.5h` | error: the `LOOP_USAGE` string |
| `every 0m` | error: `Loop duration must be positive.` |
| `every 10x` | error: `Loop duration unit must be seconds, minutes, or hours.` |
| `every 15m every 5m` | error: `Use only one every.` |
| `every 15m 2h go` | interval 15 min, prompt `2h go` |

## Behavior

| Loop state | Command | Effect | Message |
|---|---|---|---|
| off | `/loop` (no args) | Enable. Wait for the next prompt. | `Loop mode enabled. …` |
| off | `/loop ARGS` | Enable with ARGS. If PROMPT is given, it runs at once. | `Loop mode enabled. … Every 15 minutes. …` |
| off | `/loop BAD` | Nothing changes. | the error |
| on | `/loop` (no args) | Disable. Cancel the pending run and the running condition check. | `Loop mode disabled.` |
| on | `/loop ARGS` | Replace the limit, interval, and condition. Parts that are not given are cleared. The limit starts again. If PROMPT is given, it runs at once and becomes the loop prompt. If not, the current prompt stays and the next run is due at `max(now+800ms, lastStart + newInterval)`. During a turn, `next` stays hidden, and the turn end re-arms the run with the new interval. Without an interval, the next run starts as soon as the session is idle. | `Loop updated. …` |
| on | `/loop BAD` | Nothing changes. | the error |

## Run timing

- The first run starts at once, when a prompt is given.
- Run *N+1* is due at `max(end of turn N + 800 ms, start of run N + interval)`.
- At the due time, OMP checks in this order: the session is idle (if not, it tries again every 800 ms), the limit, the condition, and the budget. Then it compacts or resets if `loop.mode` asks for it, and then it sends the prompt.
- A run does not change the editor text, image links, or pending images.

## Status line (`mode` segment)

`Loop running every 15m next 10:21 <limit> until: gh pr checks`

The segment joins its parts with spaces, as it does today. `<limit>` is the existing limit text. `next HH:MM` uses the local time. It shows only while an interval loop waits for an armed run. It does not show during a turn, while paused, or when no interval is set.
