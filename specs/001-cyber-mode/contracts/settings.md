# Contract: Cyber Mode Settings

Two new keys in the settings registry
(`packages/coding-agent/src/config/settings-schema.ts`). Both follow the
existing registry shape and read from every configuration layer.

## `cyberModels`

The ordered allowlist of models that upstream providers will not block for
security work.

```yaml
# ~/.omp/agent/config.yml, or a project's .omp/config.yml
cyberModels:
  - anthropic/claude-sonnet-5
  - openai/gpt-5
```

| Property | Value |
|---|---|
| Type | Ordered list of model selectors |
| Default | Empty list |
| Layers | Global, project, config overlay, runtime override |
| Ordering | Significant. The first entry that resolves is the primary cyber model |

**Selector grammar**: identical to a role value entry. Aliases (`@slow`), globs,
and thinking suffixes (`:high`) are accepted and resolved through the same
resolver the roles use. There is deliberately no second grammar to learn.

**Validation** (reported as startup warnings, never as hard failures):
- A value that is not a list of strings is reported and ignored.
- A duplicate entry is reported.
- An entry matching no available model is reported.

**Empty list**: cyber mode cannot be enabled. This is a refusal, not a warning
that is then ignored, because enabling without an allowlist would report
protection the session does not have. See `contracts/slash-command.md`.

## `cyberMode`

The startup value for the first session of a process.

```yaml
cyberMode: true
```

| Property | Value |
|---|---|
| Type | Boolean |
| Default | `false` |
| Layers | Global, project, config overlay, runtime override |

**Scope rule**: this field names where a process *starts*, not what every session
becomes. A resumed session, `/new`, a delete transition, and a session switch all
follow the recorded session state instead
(`contracts/session-entry.md`). This is the same precedence the `modelProfile`
field uses, so the two behave alike.

**Launch override**: deliberately out of scope. There is no `--cyber` /
`--no-cyber` flag. The runtime switch covers a one-off change, and the startup
value covers where a process begins, so a flag would add four CLI surfaces for a
convenience the request did not name.

**Sharing rule**: the protection is installed on the configuration state a
session runs against, which is the same state the model profile's runtime role
layer occupies. Sessions that share that state share one protection (FR-029).
Installing protection is always allowed, and an implicit clear removes only what
the same session installed, so a nested session inherits its parent's protection
and cannot drop it (FR-030).

**Install ordering**: startup installs the overlay as soon as a model catalogue
exists, and before any role is resolved. The helper takes the available-model set,
because resolving the allowlist needs it. This is required, not merely tidy:
`createAgentSession` reads `settings.getModelRole("default")` at `sdk.ts:1565` and
resolves the launch model at `:1583`, roughly 2300 lines before it constructs
`AgentSession` at `:3920`. So install at `sdk.ts:1425`, right after the
`modelRegistry` that starts at `sdk.ts:1383`, and in the CLI at `main.ts:1754`,
right after the registry it builds at `:1744`. The initial `model_change` entry is
written at `sdk.ts:3836`,
before the session exists, and it records the cyber state in effect. Installing
from the session constructor would be too late, and a `cyberMode: true` start with
no explicit model would resolve unfiltered.

A bounded CLI boundary follows from this and is accepted: `main.ts` reads roles at
`:1275` and `:1321` before the registry exists at `:1744`, so those reads cannot be
filtered. They cannot change which model the session runs, because the startup
model is resolved later at `sdk.ts:1581` through the filtered settings.

`Settings` itself holds configuration only, so it cannot resolve an allowlist. The
filter is derived inside `#rebuildMerged()` from the stored allowlist, which is
why installation needs no roles once it has the catalogue.

**Install owner**: a config-driven install is owned by the configuration, and a
runtime toggle-on is owned by the session that performed it. A config-owned
install is cleared by an explicit operator switch-off, never by implicit
adoption (FR-030).

## Defaults registration

Per the repository rule in `.omp/AGENTS.md`, both keys MUST also be written with
their default values into `~/.omp/agent/config.yml` so the operator can discover
them:

```yaml
cyberModels: []
cyberMode: false
```

## Errors

| Condition | Behavior |
|---|---|
| `cyberMode: true` and `cyberModels` empty | Startup warning; the session starts with cyber mode off |
| `cyberMode: true` and no allowlist entry resolves | Startup warning; the session starts with cyber mode off |
| An allowlist entry matches no available model | Startup warning; the entry is skipped and the rest apply |
| Duplicate allowlist entries | Startup warning; the duplicate is ignored |
