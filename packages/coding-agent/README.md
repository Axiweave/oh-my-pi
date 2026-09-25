# @oh-my-pi/pi-coding-agent

Core implementation package for the `omp` coding agent in the `omp` monorepo.

For installation, setup, provider configuration, model roles, slash commands, and full CLI reference, see:
- [Monorepo README (local)](../../README.md)
- [Monorepo README (GitHub, this fork)](https://github.com/Axiweave/oh-my-pi#readme)

Package-specific references:
- [CHANGELOG](./CHANGELOG.md)
- [MCP configuration guide](../../docs/mcp-config.md)
- [MCP runtime lifecycle](../../docs/mcp-runtime-lifecycle.md)
- [MCP server/tool authoring](../../docs/mcp-server-tool-authoring.md)
- [DEVELOPMENT](./DEVELOPMENT.md)

## Move between worktrees

Use `/wtmove` in an interactive session to select an existing worktree of the current Git repository.
Type a branch or path substring to filter the list. Press Enter to select a destination, or Escape to cancel.

`/wtmove <path>` accepts absolute, relative, and home-relative worktree root paths, including paths with spaces.
Tab completion matches branch labels and paths without case sensitivity.
The list includes the primary checkout and worktrees outside `~/.omp/wt`, but excludes the current checkout and unavailable directories.

The picker keeps path details visible in narrow terminals.
Ambiguous whitespace and control characters use visible escapes, such as `\u0020` for repeated or trailing spaces.
Completion labels retain distinguishing path fragments across sibling groups. An ellipsis marks shared or omitted path text.
These display changes do not change the selected path. Completion quotes paths with trailing whitespace so the command preserves their identity.

The move keeps the active session identity, history, and artifacts. Use `/resume` from the destination to continue that session later.
It does not change branches, copy checkout changes, clean the source, or resume another saved session.
Invalid paths and paths inside a worktree rather than at its root produce an error without moving the session.
Finish or abort an active response before moving.

Use `/move` for any directory. Use `/wt` to create a new worktree and carry checkout changes into it.

## Memory backends

The agent supports three mutually-exclusive memory backends, selected via the `memory.backend` setting (Settings → Memory tab, or `~/.omp/config.yml`):

- `off` (default) — no memory subsystem runs.
- `local` — existing rollout-summarisation pipeline; writes `memory_summary.md` and consolidated artifacts under the agent dir.
- `hindsight` — talks to a [Hindsight](https://hindsight.vectorize.io) server (Cloud or self-hosted Docker), retains transcripts every Nth user turn, recalls memories on the first turn of a session, and exposes `retain`, `recall`, and `reflect`.

### Hindsight quickstart

1. Run a Hindsight server (Cloud or `docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest`).
2. Set `memory.backend = "hindsight"` and `hindsight.apiUrl = "http://localhost:8888"` (or your Cloud URL).
3. Optional environment overrides (env wins over settings):
   - `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN` — connection
   - `HINDSIGHT_BANK_ID`, `HINDSIGHT_DYNAMIC_BANK_ID`, `HINDSIGHT_AGENT_NAME` — bank addressing
   - `HINDSIGHT_AUTO_RECALL`, `HINDSIGHT_AUTO_RETAIN`, `HINDSIGHT_RETAIN_MODE` — lifecycle
   - `HINDSIGHT_RECALL_BUDGET`, `HINDSIGHT_RECALL_MAX_TOKENS` — recall sizing
   - `HINDSIGHT_BANK_MISSION`, `HINDSIGHT_DEBUG`

Switching backends mid-session immediately replaces the live backend, memory tools, listeners, and system-prompt context. Existing users with `memories.enabled = true|false` are migrated to `memory.backend = "local"|"off"` exactly once on first launch; afterward, `memory.backend` is the sole runtime selector.
