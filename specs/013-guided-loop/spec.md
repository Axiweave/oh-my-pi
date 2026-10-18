# Feature Specification: Guided Loop Setup

**Feature Branch**: `013-guided-loop`

**Created**: 2026-10-18

**Status**: Draft

**Input**: User description: "guided loop — like guided goal but for loop" (from `TODOs.org`). `/guided-goal` asks the user questions in the chat, one at a time, until the goal is clear, and then turns goal mode on. This feature does the same for loop mode.

## Clarifications

### Session 2026-10-18

- Q: How does the confirmed setup reach loop mode? → A: The agent calls a loop-start tool with the confirmed prompt, limit, interval, and condition. OMP turns loop mode on and starts the first run. This is the same pattern as `goal create` for `/guided-goal`.
- Q: Must the interview insist on a stop rule? → A: No. When the user gives no count, time limit, or condition, the agent warns once that the loop runs until a bare `/loop`. Then the user may confirm the open-ended loop.
- Q: When the agent calls the loop-start tool, must OMP ask the user to confirm the `/loop` line in a yes/no dialog before loop mode turns on? → A: Yes. The tool shows the `/loop` line in a yes/no dialog. Loop mode turns on only on yes. On no, the tool tells the agent that the user declined, and the interview goes on. The chat needs no separate confirmation step.
- Q: Does the agent turn the user's answers into a detailed prompt, or does it repeat the user's own words exactly? → A: The agent writes a self-contained prompt from the answers. The prompt says what to check, what to do, and what to report on each run. The full prompt shows in the confirmation dialog.
- Q: If loop mode is already on, or paused, when the user runs `/guided-loop`, must OMP refuse, or must the interview start and replace the current loop after yes? → A: The interview starts. The current loop pauses during the interview. On yes, the new setup replaces the current loop. On no, or when the interview ends without yes, the current loop stays paused.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Set up a loop through a short interview (Priority: P1)

A user wants a repeating task but does not know the `/loop` syntax, or does not know which stop rule to use. The user types `/guided-loop` with a rough idea, for example `/guided-loop keep checking the deploy`. The agent asks one short question at a time in the chat. It asks what to repeat, how often, and when to stop. When all the parts are clear, the agent sends the final setup to OMP. OMP shows the setup as one `/loop` line in a yes/no dialog. When the user chooses yes, loop mode turns on with that setup, and the first run starts.

**Why this priority**: This is the full request. Without it the user must learn the count, duration, `every`, `--while`, and `--until` forms before the first loop.

**Independent Test**: Run `/guided-loop check CI`. Answer the questions. Choose yes in the confirmation dialog. Check that loop mode is on with the prompt, interval, limit, and condition from the answers, and that the first run starts.

**Acceptance Scenarios**:

1. **Given** loop mode is off, **When** the user runs `/guided-loop <rough idea>`, **Then** the agent asks one question in the chat and does no other work in that turn.
2. **Given** an interview is in progress, **When** the user answers, **Then** the agent asks the next question about a part that is still missing, or sends the final setup to OMP when no part is missing.
3. **Given** the agent sent the final setup, **When** the confirmation dialog shows the `/loop` line and the user chooses yes, **Then** loop mode turns on with exactly that prompt, limit, interval, and condition, and the first run starts at once.
4. **Given** loop mode is on after the interview, **When** the user looks at the status line and the loop confirmation message, **Then** they show the same setup that the user confirmed.
5. **Given** loop mode is off, **When** the user runs `/guided-loop` with no text, **Then** the agent first asks what the user wants to repeat.
6. **Given** the confirmation dialog shows the `/loop` line, **When** the user chooses no or closes the dialog, **Then** no new loop starts, the agent learns that the user declined, and the interview goes on.

---

### User Story 2 - Learn the command for next time (Priority: P2)

A user who finished the interview wants to set up the same loop again later without the interview.

**Why this priority**: The interview is slow compared with one command. Showing the equal `/loop` command teaches the syntax at no extra cost.

**Independent Test**: Finish an interview. Copy the `/loop` command line that OMP leaves in the transcript. Turn loop mode off. Run the copied command. Check that the loop has the same setup.

**Acceptance Scenarios**:

1. **Given** the user chose yes in the confirmation dialog, **When** loop mode turns on, **Then** the transcript shows the setup as one valid `/loop` command line that the user can copy.
2. **Given** a `/loop` command line from a finished interview, **When** the user runs it later, **Then** loop mode gets the same prompt, limit, interval, and condition as the interview gave.

---

### User Story 3 - Leave the interview (Priority: P3)

A user starts the interview and then changes their mind.

**Why this priority**: A user must never get a loop that they did not confirm.

**Independent Test**: Start `/guided-loop`, answer one question, and then say "never mind". Check that no new loop starts. Repeat with a loop already running, and check that the old loop stays paused with its old setup.

**Acceptance Scenarios**:

1. **Given** an interview is in progress, **When** the user declines or asks the agent to stop, **Then** no new loop starts and the agent stops asking questions.
2. **Given** an interview is in progress, **When** the user sends a short answer such as `c` or `.`, **Then** OMP sends it as an answer, not as a continue shortcut.
3. **Given** an interview is in progress, **When** the user starts other work and the agent uses tools for it, **Then** the interview ends and no new loop starts.
4. **Given** a loop was on when the interview started, **When** the user answers a question, **Then** the answer does not become the prompt of the old loop, and no run of the old loop starts.

### Edge Cases

- Loop mode is already on when the user runs `/guided-loop`. The current loop pauses, and the interview starts. On yes, the new setup replaces the current loop, as `/loop` with arguments does. Otherwise the current loop stays paused, and the user can resume it by sending a prompt or turn it off with a bare `/loop`.
- Loop mode is paused when the user runs `/guided-loop`. The loop stays paused, and the rest is the same as the case above.
- Speckit-auto mode is on. OMP refuses with the same message that `/loop` shows.
- A guided-loop interview is in progress when the user runs `/guided-loop` again. A new kickoff starts, and the interview stays in progress.
- A guided-goal interview is in progress. OMP refuses with "Finish the guided goal interview first."
- A turn is running when the user types `/guided-loop`. The interview starts after that turn, in the same way as `/guided-goal`.
- The user gives a stop condition as a shell command. The agent puts it in the setup as a `--while` or `--until` command and does not run it during the interview.
- The user's answers give a setup that `/loop` cannot parse, for example `every 1.5h`. The agent asks again for that part. Loop mode never turns on with an invalid setup.
- The user asks for a repeat with no stop rule (count, time limit, or condition). The agent warns once that the loop runs until a bare `/loop` and uses tokens on each run. If the user still confirms, the loop has no stop rule.
- The agent calls the loop-start tool with a setup that `/loop` cannot parse. The tool returns the parse error to the agent, no new loop starts, and the interview goes on.
- The agent calls the loop-start tool outside an interview. The tool is not available there, so the call cannot happen.
- The session has no interactive UI, for example a print-mode or RPC run. `/guided-loop` is available only in the interactive TUI, so no interview starts and the `loop` tool is never offered.
- The session switches, or OMP restarts, during the interview. The interview ends, and no new loop starts.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: OMP MUST provide a `/guided-loop [rough idea]` command. It MUST appear in the command list and in autocomplete with a short description.
- **FR-002**: `/guided-loop` MUST start an interview in the normal chat. The agent asks exactly one question in each reply and does no other work while it interviews. The kickoff prompt carries this rule, so only the manual quickstart check covers it.
- **FR-003**: The interview MUST settle these parts before the setup is final: the prompt to repeat, how often it repeats (after each turn, or a fixed interval), and the stop rule (a count, a time limit, a `--while` / `--until` condition, or none).
- **FR-003a**: When the user gives no stop rule, the agent MUST warn once that the loop runs until a bare `/loop`. After that warning, the user MAY confirm the loop with no stop rule.
- **FR-004**: The interview MUST keep every constraint and stop rule that the user states.
- **FR-004a**: The agent MUST write the repeated prompt as a self-contained instruction from the user's answers. The prompt MUST say what to check, what to do, and what to report on each run. It MUST NOT depend on the interview chat to make sense. The confirmation dialog MUST show the full prompt.
- **FR-005**: Before loop mode turns on, OMP MUST show the final setup as one `/loop` command line in a yes/no confirmation dialog. Loop mode MUST turn on only when the user chooses yes. The agent does not need a separate confirmation step in the chat.
- **FR-006**: When the setup is final, the agent MUST call a loop-start tool (tool name `loop`) with the prompt, limit, interval, and condition. The tool MUST reject a setup that `/loop` cannot parse, before it shows the dialog. When the user chooses yes, the tool MUST turn loop mode on with that setup, and the first run MUST start at once. When the user chooses no or closes the dialog, no new loop MUST start, and the tool MUST tell the agent that the user declined.
- **FR-006a**: The loop-start tool MUST be available to the agent only while a guided-loop interview runs. The interview ends when the tool turns loop mode on.
- **FR-007**: A loop set up through the interview MUST behave exactly as the same `/loop` command typed by hand.
- **FR-008**: The setup MUST use only what `/loop` accepts today: a count or time limit, `every <duration>`, `--while` / `--until`, and a prompt. The interview MUST NOT ask about settings that the `/loop` command line does not set.
- **FR-009**: While the interview runs, short replies such as `c` and `.` MUST go to the agent as answers.
- **FR-010**: The interview MUST end without a new loop when the user declines, when the agent uses tools other than the loop-start tool, when the user types `/loop`, when the session switches, or when the kickoff fails.
- **FR-011**: `/guided-loop` MUST refuse to start while a guided-goal interview runs, or while a mode other than loop mode that `/loop` refuses today is on. The refusal messages MUST match the existing `/loop` and `/guided-goal` messages.
- **FR-011a**: When loop mode is on or paused, `/guided-loop` MUST start the interview and leave the current loop paused while the interview runs. No run of the current loop MUST start during the interview. On yes, the new setup MUST replace the current loop, with the same replace rules as `/loop` with arguments. When the interview ends without yes, the current loop MUST stay paused with its old setup.
- **FR-012**: While a guided-loop interview runs, `/guided-goal` and `/speckit-auto-mode` MUST refuse with "Finish the guided loop interview first."
- **FR-013**: The IDE status MUST show `needs-input` while the agent waits for an interview answer, as it does for `/guided-goal`.
- **FR-014**: The changelog MUST describe `/guided-loop`.

### Key Entities

- **Loop setup**: the prompt, the optional count or time limit, the optional interval, and the optional `--while` / `--until` condition. It is the same data that one `/loop` command line holds.
- **Interview**: the conversation from `/guided-loop` until the user confirms or the interview ends. It has one state: in progress or not.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user who has never used `/loop` can set up a loop with an interval and a stop rule in at most 6 questions. This depends on the model, so only the manual quickstart check covers it.
- **SC-002**: In 100% of finished interviews, the running loop has the exact prompt, limit, interval, and condition that the user confirmed.
- **SC-003**: Loop mode never turns on unless the user chooses yes in the confirmation dialog. This holds even when the agent calls the loop-start tool before the interview is complete.
- **SC-004**: In 100% of finished interviews, the shown `/loop` command line gives the same setup when the user types it later.
- **SC-005**: All current `/loop` and `/guided-goal` tests pass with no change to the behavior that they check. Field renames and new refusal cases are allowed.

## Assumptions

- The interview reuses the `/guided-goal` pattern: a hidden kickoff message, the agent's questions as normal chat replies, and the user's answers in the normal input box.
- The `/loop` grammar does not change. The interview only fills in the parts of a `/loop` command line.
- The `loop.mode` setting (prompt, compact, or reset) stays a setting. The interview does not ask about it.
- The agent may propose values from the project, for example a test command for `--until`, but the user decides.
- The interview is not saved. If OMP restarts during the interview, the user starts it again.
- No new setting is needed.
