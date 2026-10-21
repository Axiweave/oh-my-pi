# UI Contract: Expand Key in Job Views

The expand key is the first key bound to `app.tools.expand`. Ctrl+O is the default.

| View | Presentation | Who handles the key | Result |
|---|---|---|---|
| Background Jobs report | Above the editor | Global listener (existing) | The session state switches. The report rebuilds in the new form and can move to full-screen. |
| Background Jobs report | Full-screen view | `ReportPanel.handleInput` | Same toggle. A short form that fits moves back above the editor. |
| Background Jobs report | Native sheet (`/jobs full`) | `ReportPanel.handleInput`, or the `expand` action button | Same toggle. |
| Jobs sheet | Native or text overlay | `JobsSheet.handleInput`, or the `expand` action button (native) | Same toggle. The detail pane switches between preview and full command. |
| Any other report | Any | Not handled | No change (FR-007). |

## Hints

- **Report footer (text)**: `<key> full commands · <close hint>` in the short form, `<key> short commands · <close hint>` in the full form. This shows only on the jobs report.
- **Native report sheet and jobs sheet**: an action button labeled `Full commands` or `Short commands` (sheet: `Full command` or `Short command`), with `keys: <key>`, before Close.

## Status line

Each toggle shows `Tool output expansion: enabled` or `Tool output expansion: disabled`. This is the existing message (FR-005).

## Slash command

- `/jobs`: the form follows the session state. Native rendering opens the jobs sheet.
- `/jobs full`: sets the state to on, then opens the report in the full form.
