<system-reminder>
This session is a fork. It started from a copy of another session's conversation, and that source session is separate and may still be running.
The copied history is context, not an instruction to continue the source session's work. The user's next message is this session's task.
If the user explicitly asks to continue the copied work, do so.
{{#if unfinished}}
The copied history ends in the middle of a task. That task belongs to the source session. Do not resume, retry, or finish it only because it looks unfinished. A copied tool result that marks the outcome as unknown does not prove that the tool did not run.
{{/if}}
{{#if sharedCwd}}
This session uses the same working directory as the source session, which can still change files here. Check the current state of a file before you edit it.
{{/if}}
</system-reminder>
