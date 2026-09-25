# Cyber mode

Cyber mode restricts cyber work to an operator-approved model allowlist. It applies that allowlist to every model resolution. It does not bypass provider safety restrictions.

## Declaring the allowlist

```yaml
cyberModels:
  - anthropic/claude-sonnet-4-5
  - openai/gpt-5.1
cyberMode: true
```

`cyberModels` is an ordered list of model selectors: `provider/model-id`, or a role alias such as `@slow`. `cyberMode` is the startup value for the first session of a process.

Enabling and session adoption resolve the current declaration. Other live edits do not replace the installed allowlist until the next enable or adoption.

## Enabling and disabling

Toggle the mode with the `/cyber` slash command or `Alt+Shift+X`:

```text
/cyber            # toggle the current session state
/cyber on         # enable for this session
/cyber off        # restore the configured role resolution
/cyber on project # enable and persist it as the startup value for this project
```

- Enabling is fail-closed. An allowlist in which nothing resolves refuses the switch and names the reason, so the session never reports protection it does not have.
- When the active model is outside the list, enabling moves the session inside it and reports the move.
- Disabling restores the configured role resolution and leaves the active model in place.
- The `global` and `project` forms write `cyberMode` as the startup value. Plain `on`/`off` changes only the session.
- Enable and status output list every allowed model identity, plus the active model.

## Role resolution

While the mode is on, every role resolves inside the list:

- A role chain keeps its configured fallback order with the entries outside the list removed.
- Filtered chains use concrete provider/model identities. A smaller model catalog cannot retarget them to an excluded provider or fuzzy match.
- A chain with no cyber-capable entry resolves to the first declared allowlist entry that is available.
- Startup warnings and live notices name each changed role and its selected model. Each role/model pair appears once per transcript.
- Notices distinguish filtered chains from substitutions. They also report active-model replacements.
- An unavailable primary never resolves to a fuzzy sibling.
- If an excluded launch model has no approved replacement, launch leaves the active model unset and reports why.

## Switch refusal

The guard sits on the session model setters, so every direct switch is checked:
`/switch <model>`, the model picker's role assignment, and `Ctrl+P` cycling when
the cycle order names one model. A switch to a model outside the list is refused
and the refusal names cyber mode as the reason, so the operator learns the way
through is to turn cyber mode off.

The guard reads the protection installed on the configuration state, not the
session's own flag. Protection belongs to that state, so a session that shares it
stays constrained while any session's protection is installed, even when its own
state is off and its indicator is therefore hidden. An explicit switch-off clears
whatever installed the protection, so the way out of the refusal always works.

A subagent inherits the protection of the configuration state it was created
from, and its settings snapshot keeps the configured role chains. Releasing
protection inside the subagent therefore restores those chains instead of the
already-filtered ones.

A path that re-points a role chain, rather than naming one model, is filtered
instead of refused: `modelProfiles` bundles, the role entries a cycle walks, plan
mode, and the `--model` flag at launch. Each one lands inside the list, so the
refusal never has to fire, and the reports name the model each role landed on.

Automatic recovery uses the same membership rule. It skips excluded fallback
entries and continues to allowed entries, including entries reached through
excluded nodes. If no allowed candidate remains, normal exhaustion handling
applies. Recovery never uses an excluded model to escape an error.

Background advisor, eval completion, tiny-task, judgment, memory, and compaction
selection also obey installed protection. So do automatic context promotion,
vision-model selection for an image question or a text-only attachment, and the
sharpshooter extraction selector, which is a plain configuration value rather
than a role. A retained callback re-checks protection before it dispatches, so a
protection change made while a request waited for credentials still stops that
request.

## Lifecycle

The state is recorded on the transcript beside the active model, so it follows the session:

- `--resume`, `/resume`, and a session switch read it back, even when `cyberMode` in the configuration says otherwise.
- `/clear` keeps the current state.
- `/new` and `/delete` revalidate the inherited state against the current declaration.
- `/fork`, side-answer branches, branch selection, and tree navigation restore and revalidate the destination state.
- An empty or unresolved declaration disables an inherited on state and produces a warning. Branch adoption records the degraded off state.
- Revalidation preserves protection owned by configuration or another session.
- Recovery model changes also record the session's current state.
- A resumed session whose persisted model the allowlist has since dropped moves inside the list, the same way a launch does.
- Resumed active-model substitutions reach startup warnings before the UI subscribes to runtime notices.
- A failed session switch restores the outgoing state, protection, and notice history. It does not publish notices from the failed switch.
- Reloading the same transcript preserves notice history. A new transcript starts its own notice history.

## Noninteractive diagnostics

Text, JSON, RPC, and ACP startup write cyber warnings to stderr before the first model call.
Standard output stays available for responses and protocol frames.
ACP waits until the requested session is ready before it reports startup warnings.
It discards temporary-session role and model warnings, but retains applicable configuration warnings.
Load, resume, and fork report each applicable startup warning once.
Later session activity still reports cyber warning notices.

SDK callers still receive startup diagnostics through `session.configWarnings` and `modelFallbackMessage`.
The CLI consumes these fields without changing them.

## Indicator

The `cyber` status-line segment marks the mode. It is in the default layout, selectable in a custom one through `statusLine.leftSegments` / `statusLine.rightSegments`, and rendered in the `claude3` footer.
