Sort each question or offer in the message as blocking or auxiliary. Test: if the workflow went on and nobody answered, would a later spec-kit step be wrong, blocked, or built on a guess? Yes means blocking. No means auxiliary.
Blocking: a scope or requirement decision, a choice between options, an ambiguity the step asks the user to resolve, an approval gate that the step itself defines, input that only the user has (credentials, access, data), or an error that the user must fix.
Auxiliary: an offer or question about work that no spec-kit step needs, such as commit, push, merge, branch, pull request, release, deploy, cleanup, a walkthrough, or optional extra polish or tests. A status note about that work, and an offer to run a later /speckit command or to go on to the next step, are also auxiliary: the workflow runs the next step on its own. To ignore an auxiliary item loses nothing.
Auxiliary examples:
- "Nothing is committed yet, and you are still on main. When you ask, I will commit with the smart-commit skill and leave TODOs.org unstaged."
- "Want me to commit these changes and open a pull request?"
- "Should I push the branch now?"
- "I can also add tests for the edge cases if you like."
- "Let me know if you want a walkthrough of the changes."
- "Run /speckit.analyze next, or say go."
- "Shall I run /speckit.implement now?"
Blocking examples:
- "Should the cache be per user or global?"
- "Q1: Which auth method? A) OAuth B) API key"
- "Do you want to proceed with implementation anyway? (yes/no)"
- "I need the staging database URL to run the migration tests."
- "T12 fails because the API returns 403. How should I handle it?"

## next
This message ends the /speckit.{{phase}} step of a spec-kit workflow. Pick the next step of the workflow.
The state field `message` is the end of the step's last reply. The field `earlier`, when present, holds the step's earlier replies in the same turn: the step can print its report there and end with a short summary. Read both.
The field `evidence` holds hints that text patterns found. A pattern can be wrong, so read the messages and use a hint only to check what you read:
- `analyze`: the CRITICAL and HIGH counts from the analyze findings table, or `unreadable` when the patterns found no findings report.
- `errorCue`: true when a line such as `ERROR:` or `T012 failed` was found. Zero counts such as "0 failed" do not count.
- `reportCue`: true when the step's own completion report was found, such as "Created tasks.md with 24 tasks".
- `readyCue`: clarify only. True when clarify reported no critical ambiguity or recommended /speckit.plan, with no blocking Deferred item.
- `closingOffers`: closing sentences that offer to run another /speckit command or to suggest remediation edits.
When the field `request` is present, the user typed it to start this turn instead of a /speckit command. `answers: true` means that `request` replies to the step's own question, so the reply goes on with the step. Otherwise `request` can be a side request, such as a commit or a question about the code. Then pick a step that goes on only if the reply also finishes the step's own work.
{{blocking}}

## advance
{{#when phase "==" "clarify"}}Clarify finished: its report says that the spec is ready for planning (no critical ambiguity, or it recommends /speckit.plan), and no high-impact item is left unasked. Items deferred to planning and low-impact Outstanding items do not block.{{/when}}{{#when phase "==" "analyze"}}Analyze printed its findings report, the report has no CRITICAL finding, and no blocking question remains. HIGH and lower findings do not block.{{/when}}{{#when phase "==" "remediation"}}The fix round changed the feature documents, reports that it finished, and asks no blocking question.{{/when}}{{#when phase "==" "specify"}}Specify wrote spec.md and asks no blocking question.{{/when}}{{#when phase "==" "plan"}}Plan wrote plan.md and asks no blocking question.{{/when}}{{#when phase "==" "tasks"}}Tasks wrote tasks.md and asks no blocking question.{{/when}}{{#when phase "==" "implement"}}Implement finished every task, with no failed task and no blocking question.{{/when}} The message reports no error, no failed step, and no early stop. Auxiliary offers, including an offer to run the next /speckit command, do not count.

## proceed
The message has exactly one blocking question. That question asks permission to proceed with the agent's own recommendation, such as the implement checklist gate "Do you want to proceed with implementation anyway? (yes/no)". It needs no new scope or requirement decision, and the message reports no error. A question that asks the user to choose between options, or to decide what the feature covers, is not this. An offer to run another /speckit command is not this: it is auxiliary.

## remediate
The analyze report has at least one CRITICAL finding, or every blocking question asks leave for the agent to make fixes that the report itself recommends, as edits to the feature documents (spec.md, plan.md, tasks.md, quickstart.md, and the like), for example "Would you like me to suggest concrete fixes for the top 5 issues?" or "Reply `fix I1-I3` and I will make these edits." Pick this also when one fix may need a user decision later: the fix round asks the user and stops at that fix. Do not pick this when, before any fix can start, the message makes the user decide: choose between options, give input that only the user has, pick which fixes to make ("confirm all, or name the ones to apply"), or approve fixes that the message says change behavior, scope, order, or what ships. Such a gate is `ask`, for example "Edits 2 and 6 change behavior. Reply `apply all` or list the numbers.".

## recheck
`request` asks the agent to fix findings from the analyze report, and the message reports that the agent changed the feature documents to fix them, with no open question and no error. Analyze must run again to check the fixes.

## complete
The converge report says that the implementation meets the spec, plan, and tasks, or that it found no gap, and it added no task to tasks.md. A zero findings count, an accepted difference that gets no task, or an offer to commit, push, review, or open a pull request does not change this. Read the meaning, not the words: the report can use any heading, wording, emoji, or markdown.

## added
The converge report says that it appended or added one or more tasks to tasks.md for remaining gaps, for example under a "Convergence" phase, so another implement pass must do them.

## ask
The message has a blocking question, or it waits for a blocking action from the user, and no step above fits. A question that makes the user pick which fixes to make, or approve fixes that change behavior, scope, order, or what ships, is always this, even when the report has a CRITICAL finding.

## error
The message reports an error, a failed step, or an early stop that the user must fix. A stop only to ask a question is not an error. Auxiliary work left undone, such as uncommitted changes, is not an early stop.

## unclear
The messages do not show the step's outcome: the step stops before its work is done without a question, the reply is about other work (for example a commit after `request`), or the messages state conflicting outcomes.
