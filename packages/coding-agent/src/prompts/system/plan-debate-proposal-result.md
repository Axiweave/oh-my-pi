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
Revise the same canonical plan.
Submit the changed plan through `xd://propose`.
{{/if}}
{{#if reviewing}}
The independent reviewer is already reviewing a plan revision.
Do not request human approval.
Wait for the owning proposal result or use `ask` for a user decision.
{{/if}}
{{#if failed}}
The independent plan review failed: {{error}}
Plan mode remains active.
Fix a relevant plan issue if one exists, then submit the plan again.
Use `ask` if the failure needs a user decision.
{{/if}}
