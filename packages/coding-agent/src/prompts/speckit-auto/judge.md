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
Blocking examples:
- "Should the cache be per user or global?"
- "Q1: Which auth method? A) OAuth B) API key"
- "Do you want to proceed with implementation anyway? (yes/no)"
- "I need the staging database URL to run the migration tests."
- "T12 fails because the API returns 403. How should I handle it?"

## completed
This message ends the /speckit.{{phase}} step of a spec-kit workflow. Answer yes if the message reports that the step finished its work, with no error, no failed step, and no early stop. A stop only to ask the user a question is not an error. Auxiliary work left undone, such as uncommitted changes, is not an early stop.
{{blocking}}

## waits
This message ends the /speckit.{{phase}} step of a spec-kit workflow. Answer yes if the message has a blocking question or waits for a blocking action from the user. Answer no if every question and offer in it is auxiliary, even when it ends with a question mark.{{#when phase "==" "analyze"}} The closing offer to suggest remediation edits is auxiliary.{{/when}}
{{blocking}}

## routine
This message ends the /speckit.{{phase}} step of a spec-kit workflow. Answer yes only if the message has exactly one blocking question, that question asks permission to proceed with the agent's own recommendation, it needs no new scope or requirement decision, and the message reports no error or failed step. Do not count auxiliary questions. An auxiliary question is never routine. A question that asks the user to choose between options, or to decide what the feature covers, is a scope decision. Answer no when the message has no blocking question.
{{blocking}}

## ready
This message ends the /speckit.{{phase}} step of a spec-kit workflow. Answer yes if the report recommends /speckit.plan or finds no critical ambiguity, and no high-impact item is left unasked.

## fixed
This message ends a user turn in the /speckit.analyze step of a spec-kit workflow. The state field `request` is the user's text that started the turn. Answer yes only if `request` asks the agent to fix findings from the analyze report, and the message reports that the agent changed the feature documents to fix them, with no open question and no error.

## offers
This message ends the /speckit.analyze step of a spec-kit workflow. Answer yes only if every blocking question in the message asks leave for the agent to make fixes that the analyze report itself recommends, as edits to the feature documents (spec.md, plan.md, tasks.md, quickstart.md, and the like), for example "Do you want me to write the edits for I1 and C1?" or "Reply `fix I1-I3` and I will make these edits." Answer no if a question asks the user to choose between options, to make a scope or requirement decision, or to give input that only the user has. Answer no if the message says that some edits change behavior and asks for approval, for example "Edits 2 and 6 change behavior. Reply `apply all` or list the numbers.": that is an approval gate. Answer no if the user must pick which edits to make, or if a question asks whether to also apply edits beyond the report's recommendations, for example "Should I also apply the edits to the contracts?"
{{blocking}}

## converge
This is the /speckit.converge step of a spec-kit workflow. The state field `report` holds the agent text of the whole step turn, in order. Converge compares the implementation with spec.md, plan.md, and tasks.md. If it finds gaps, it appends new tasks to tasks.md for the next implement pass. Pick the outcome that the report states. Read the meaning, not the words: the report can use any heading, wording, emoji, or markdown.
- complete: the report says that the implementation meets the spec, plan, and tasks, or that it found no gap, and it added no task to tasks.md. A zero findings count, an accepted difference that gets no task, or an offer to commit, push, review, or open a pull request does not change this.
- added: the report says that it appended or added one or more tasks to tasks.md for remaining gaps, for example under a "Convergence" phase, so another implement pass must do them.
- none: the report states neither outcome or states both, stops early, reports an error, asks a blocking question, or is about other work, such as a commit.
