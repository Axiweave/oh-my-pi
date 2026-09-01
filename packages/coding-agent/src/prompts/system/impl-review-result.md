{{#if consensus}}
The independent reviewer accepted the implementation in round {{round}}.
The review contract is settled.
Report completion to the user.
{{/if}}
{{#if changesRequested}}
The independent reviewer requested changes in round {{round}}.

Summary: {{summary}}

Blocking findings:
{{#each findings}}
- `{{id}}` — {{title}}
  - Problem: {{problem}}
  - Required change: {{requiredChange}}
  - Evidence:
  {{#each evidence}}
    - `{{path}}`{{#if startLine}}:{{startLine}}{{#if endLine}}-{{endLine}}{{/if}}{{/if}} — {{explanation}}
  {{/each}}
{{/each}}

Verify each finding against the repository.
Fix the code.
Resubmit the implementation through `xd://propose`.
{{/if}}
{{#if deadlocked}}
The implementation review escalated to the user after {{round}} rounds.

Summary: {{summary}}

Unresolved findings:
{{#each findings}}
- `{{id}}` — {{title}}
  - Problem: {{problem}}
  - Required change: {{requiredChange}}
  - Evidence:
  {{#each evidence}}
    - `{{path}}`{{#if startLine}}:{{startLine}}{{#if endLine}}-{{endLine}}{{/if}}{{/if}} — {{explanation}}
  {{/each}}
{{/each}}

Report the unresolved findings and your own assessment to the user.
Never resubmit.
{{/if}}
{{#if reviewing}}
The independent reviewer is already reviewing this implementation.
Wait for the owning proposal result or use `ask` for a user decision.
{{/if}}
{{#if failed}}
The implementation review failed: {{error}}
Fix a relevant issue if one exists, then resubmit through `xd://propose`.
Use `ask` if the failure needs a user decision.
{{/if}}
{{#if planMismatch}}
The approved plan at `{{planFilePath}}` changed or is missing.
The review only ever runs against the approved plan bytes.
Restore the exact approved plan at `{{planFilePath}}`, then resubmit through `xd://propose`.
{{/if}}
