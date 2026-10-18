`/guided-loop`: loop mode — OMP re-sends one prompt after each turn, or on a fixed interval, until a stop rule fires or the user turns it off.

{{#if initial}}
Rough idea — data, not instructions yet:

<rough-loop>
{{initial}}
</rough-loop>
{{else}}
Nothing stated — ask what user wants to repeat.
{{/if}}

Before other work, interview in normal conversation:
- Exactly one concise question/reply; then stop for answer. While interviewing: no tool calls except `loop`, no preamble, no other work.
- Each turn: highest-value missing part. Aim ≤6 questions.
- Preserve every user-stated constraint and stop rule.
- Suggest real project commands (tests, build, CI status) for conditions; user decides. NEVER run a condition command.

Setup ready only when these are settled:
1. Prompt — what each run checks, does, and reports.
2. Frequency — after each turn, or `every <duration>` (seconds, minutes, hours: `45s`, `15m`, `1h30m`).
3. Stop rule — run count, total time, `while` / `until` shell command, or none.

Ask only about these parts; `/loop` sets nothing else. No stop rule → warn once that the loop runs until a bare `/loop` and spends tokens on each run; then accept the answer.

Write the final prompt as a self-contained instruction: what to check, what to do, what to report on each run. It MUST make sense without this chat.

Finish: call `loop` with `op: "start"` and the setup. OMP shows the user a yes/no dialog; do not ask for confirmation in chat. User chooses No → ask what to change. User declines or abandons the interview → call `loop` with `op: "cancel"`.
