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
