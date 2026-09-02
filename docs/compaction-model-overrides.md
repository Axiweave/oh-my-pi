# Per-model compaction thresholds

`compaction.modelOverrides` sets a different compaction trigger for each model. The global keys `compaction.thresholdTokens`, `compaction.thresholdPercent`, and `compaction.reserveTokens` apply to every model that no override matches.

## Configuration

```yaml
compaction:
  thresholdTokens: 200000 # global fallback
  modelOverrides:
    openai/*:
      thresholdTokens: 250000
    anthropic/claude-sonnet-4-5:
      thresholdPercent: 60
```

Each key is a pattern. Each value is a threshold policy with any of `thresholdTokens`, `thresholdPercent`, and `reserveTokens`.

A key is matched against the canonical `provider/model-id` string, lowercased, with no thinking-level suffix and no `@route` suffix. The match is anchored at both ends. `*` is the only wildcard and spans any substring, including `/`. Every other character, including `.`, is literal. A key without `*` matches only the exact string.

| Key                  | Matches                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `openai/gpt-4o`      | That exact model.                                                                        |
| `openai/*`           | Every model of that provider.                                                            |
| `*/gpt-4o`           | That model id on every provider.                                                         |
| `*/gpt-5.6*`         | Every model id that starts with `gpt-5.6` on every provider (also `gpt-5.60`).           |
| `*gpt-5.6*`          | Every `provider/model-id` that contains `gpt-5.6` anywhere.                              |
| `*fable-5*`          | `claude-fable-5`, `claude-fable-5-1`, `claude-fable-5-1-20260601`, and so on.            |
| `*/claude-fable-5`   | `claude-fable-5` only, not `claude-fable-5-1`.                                           |
| `gpt-5.6`            | Nothing. There is no `/`, so no `provider/model-id` string equals it.                    |

Quote a YAML key that starts with `*`, for example `"*/gpt-4o":`. An unquoted leading `*` is a YAML alias and fails to parse.

## Resolution rules

1. An exact `provider/model-id` key wins over any wildcard.
2. When several wildcards match, the first one in declaration order wins.
3. A matching entry replaces the whole threshold policy. A key the entry omits uses its default (`-1` for `thresholdTokens` and `thresholdPercent`, unset for `reserveTokens`), not the global value.
4. Entries whose value is not an object, and numeric fields that are not finite, are ignored without a warning.

Rule 3 means an override with only `thresholdPercent: 60` is not shadowed by a global `thresholdTokens: 200000`. The model that matches it compacts at 60% of its context window.

## Which model is measured

The override resolves against the model whose context window the threshold measures:

- The main session resolves against the active session model.
- A subagent (`task`, `reviewer`, `plan-reviewer`, `impl-reviewer`) inherits `compaction.modelOverrides` from the parent and resolves against its own model.
- An advisor resolves against the advisor model. After a context promotion, the re-check resolves against the promoted model.
- The status-line context gauge and `/context` summary resolve against the session model, so the marker moves when you switch models.

`compaction.idleThresholdTokens` stays global. Idle compaction does not read `modelOverrides`.

## Precedence with other settings

`compaction.modelOverrides` follows the normal settings precedence: global `~/.omp/agent/config.yml`, then project `.omp/config.yml`, then an overlay passed with `--config`. Records deep-merge across layers. A project entry with the same key replaces the global entry for that key. Keys the project does not name keep their global entries.

## Related

- [compaction.md](./compaction.md) for the compaction pipeline and global defaults.
- [settings.md](./settings.md) for the full settings reference.
