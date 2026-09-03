Plan approved.
{{#if contextPreserved}}

- History usable; the plan below authoritative if it conflicts with earlier exploration.
  {{/if}}

<instruction>
Full plan inlined below; durable copy at `{{planFilePath}}` (identical content).
Execute plan step-by-step with full tool access; MUST verify each step before next.
NEVER re-read `{{planFilePath}}` while the inline plan is intact; the path is for subagent handoff and recovery only.
{{#has tools "todo"}}
Before execution: initialize todo tracking with `todo`.
After each completed step: immediately update `todo`.
If `todo` fails: fix payload; retry before continuing.
{{/has}}
</instruction>

{{#if implReview}}
<instruction>
This plan came from debate mode; an independent reviewer must accept the finished implementation.
After completing every step and its verification, write the plan slug as plain text to `xd://propose` to submit the implementation for review.
The reviewer returns blocking findings: verify each against the repository, fix the code, resubmit.
After the round cap the review escalates to the user.
NEVER declare the task complete before reviewer consensus or escalation.
</instruction>
{{/if}}

<plan path="{{planFilePath}}">
{{planContent}}
</plan>
<critical>
Inline plan compressed, expired, or unrecoverable: NEVER stop; read `{{planFilePath}}`.
Read failure: report exact path and error; NEVER guess.
MUST continue until complete.
</critical>
