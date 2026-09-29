# Quickstart: validate the review plan-model switch

## Prerequisites

1. Build the checkout: `PATH="$HOME/.cargo/bin:$PATH" bun run setup`.
2. Use a profile whose `reviewer` and `plan` come from different providers.
   Example: `modelProfile: opus` in `~/.omp/agent/config.yml`
   (plan `anthropic/claude-opus-5.5:xhigh`, reviewer `openai-codex/gpt-6-sol:high`).

## Automated checks

```sh
cd packages/coding-agent
bun test test/review-plan-switch.test.ts test/review-plan-switch-session.test.ts \
  test/status-line-review-plan.test.ts test/slash-commands/review-plan.test.ts
bun check   # from the repository root
```

The property list that these tests must prove is in
[research.md D9](./research.md#d9--what-the-tests-must-prove).

## Manual scenarios

| # | Steps | Expected |
|---|---|---|
| 1 | Start `omp`. Run `/review-plan status`. | `off`. No `Review:Plan` indicator. |
| 2 | Run `/review-plan on`. | The state line names `anthropic/claude-opus-5.5:xhigh`. The indicator appears in the same render. |
| 3 | Run `/review` on a small diff. | The reviewer task runs on the plan model. The task card shows the model. |
| 4 | Start a debate plan (`plan.keybindingWorkflow: debate`). | `plan-reviewer` runs on the plan model. |
| 5 | Switch profile to `astra`. Run `/review`. | The reviewer runs on `openai-codex/gpt-6-astra:max`. |
| 6 | Run `/new`, then `/clear`. | The indicator stays visible. |
| 7 | Quit and run `omp --resume` on the session. | The switch is on. |
| 8 | Quit and start a fresh `omp`. | The switch is off (session-only). |
| 9 | Run `/review-plan on global`. Start a fresh `omp`. | The switch is on. `reviewUsesPlan: true` is in the global config. |
| 10 | Set `task.agentModelOverrides.reviewer: openai-codex/gpt-6-sol`. Switch on. Run `/review`. | The reviewer still runs on the plan model (FR-008). |
| 11 | Switch off. Run `/review`. | The reviewer runs on `openai-codex/gpt-6-sol:high`. |
| 12 | Use a profile without `plan` and remove the global `plan`. Run `/review-plan on`. | The notice says that reviews keep the reviewer. No indicator. |

For the `claude3` footer check, set `composerStyle.footerMode: claude3` and
repeat scenario 2.
