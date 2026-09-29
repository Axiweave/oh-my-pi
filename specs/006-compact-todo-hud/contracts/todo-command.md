# Contract: `/todo` layout verbs and `todo.hud`

## Interactive terminal

| Input | Effect | Reveals a dismissed HUD |
|---|---|---|
| `/todo expand` | selected layout = `full` | yes (as today) |
| `/todo collapse` | selected layout = `preview` | no (as today) |
| `/todo compact` | selected layout = `compact` | yes |

- If the verb matches the current selected layout, the command has no visible effect.
- The command changes the session state only. It never writes `todo.hud`.
- Usage row, placed after `collapse`:
  `  /todo compact                      Fold the HUD into one status-row line`

## Non-interactive command mode

- `/todo compact` returns the same refusal as `expand` and `collapse`:
  `/todo compact controls the interactive HUD and is unavailable in this mode.`
- Usage row, placed after `collapse`:
  `  /todo compact                      (TUI only) fold the sticky HUD to one line`

## Setting

```yaml
todo:
  hud: preview   # preview | compact
```

- An unknown value falls back to the default through the existing enum validation.
- A live change clears the command override. The HUD then renders again.
