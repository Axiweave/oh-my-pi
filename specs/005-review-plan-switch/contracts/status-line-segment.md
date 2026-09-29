# Contract: `review_plan` status-line segment

| Property | Value |
|---|---|
| Segment id | `review_plan` |
| Visible when | `ctx.session.reviewPlan === true`. Interactive mode fills it from `session.reviewPlanActive`. |
| Content | `withIcon(theme.icon.reviewPlan, "Review:Plan")` |
| Color | `warning`, the same as `cyber` |
| Default preset | Left segments, directly after `cyber` |
| `claude3` footer | Rendered beside `cyber`. No user configuration. |
| Custom layouts | A valid id in `statusLine.leftSegments` / `rightSegments` |

Symbol key `icon.reviewPlan`:

| Preset | Glyph |
|---|---|
| unicode | `⇄` |
| nerd | `⇄` |
| ascii | `[RP]` |

The indicator changes in the same render after a toggle (SC-005). It reads
only its own session's state.
