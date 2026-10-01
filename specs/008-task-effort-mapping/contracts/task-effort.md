# Contract: Task Tool `effort` Field

## Wire schema

When `task.enableEffort` is `true`, each task item (batch form) or the call (flat form) has this optional field:

```text
effort?: "low" | "medium" | "high" | "xhigh" | "max"
```

When `task.enableEffort` is `false`, the field is absent from the schema and from the tool description. This does not change.

## Tool description

When the field is present, the description shows one line for the field, then one line for each level with the auto classifier criterion for that level:

```text
`effort`: thinking level by how open-ended the problem is; maps onto the child's model:
- `low`: <LEVEL_CRITERIA.low>
- `medium`: <LEVEL_CRITERIA.medium>
- `high`: <LEVEL_CRITERIA.high>
- `xhigh`: <LEVEL_CRITERIA.xhigh>
- `max`: <MAX_CRITERION>
```

## Errors

| Input | Result |
|---|---|
| `effort` outside the five values, through the wire | Schema validation error (ArkType) |
| `effort` outside the five values, through an internal or stale call | Tool error: `<label> has an invalid \`effort\` value "<v>". Use one of "low", "medium", "high", "xhigh", "max".` |
| Ceiling below the model's lowest supported level | Spawn fails: `<provider>/<id> has no supported thinking effort at or below task.maxEffort=<ceiling>` (no change) |

## Function

```ts
resolveTaskEffortLevel(model: Model | undefined, effort: TaskEffort, maxEffort?: Effort): Effort | undefined
```

- Returns `undefined` when the model has no controllable effort.
- Returns the mapped level (data-model.md), clamped by `maxEffort`.
- Throws `RangeError` for a ceiling below the model's floor.
