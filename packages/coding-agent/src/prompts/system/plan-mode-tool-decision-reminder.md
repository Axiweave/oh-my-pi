<system-reminder>
{{#if debate}}
Debate plan mode needs another decision.

You MUST choose exactly one next action now:
1. Verify reviewer findings, revise the canonical plan, and resubmit changed bytes to `xd://propose`, OR
2. Call `{{askToolName}}` when a blocking finding requires a user decision
{{else}}
Plan mode turn ended without a required tool call.

You MUST choose exactly one next action now:
1. Call `{{askToolName}}` to gather required clarification, OR
2. Write the plan slug/title (`<slug>`, matching `local://<slug>-plan.md`) as plain text to `xd://propose` with `{{writeToolName}}` to finish planning and request approval
{{/if}}

You NEVER output plain text in this turn.
</system-reminder>
