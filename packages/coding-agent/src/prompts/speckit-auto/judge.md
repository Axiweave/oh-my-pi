## completed
This message ends the /speckit.{{phase}} step of a spec-kit workflow. Answer yes if the message reports that the step finished its work, with no error, no failed step, and no early stop. A stop only to ask the user a question is not an error.

## waits
This message ends the /speckit.{{phase}} step of a spec-kit workflow. Answer yes if the message ends with a question for the user or waits for an answer from the user.{{#when phase "==" "analyze"}} The closing offer to suggest remediation edits is not a question.{{/when}}

## routine
This message ends the /speckit.{{phase}} step of a spec-kit workflow. Answer yes only if the message has exactly one open question, that question asks permission to proceed with the agent's own recommendation, it needs no new scope or requirement decision, and the message reports no error or failed step. Answer no when the message has no open question.

## ready
This message ends the /speckit.{{phase}} step of a spec-kit workflow. Answer yes if the report recommends /speckit.plan or finds no critical ambiguity, and no high-impact item is left unasked.

## fixed
This message ends a user turn in the /speckit.analyze step of a spec-kit workflow. The state field `request` is the user's text that started the turn. Answer yes only if `request` asks the agent to fix findings from the analyze report, and the message reports that the agent changed the feature documents to fix them, with no open question and no error.
