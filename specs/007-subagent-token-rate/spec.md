# Feature Specification: Subagent Generation Rate in the Subagents HUD

**Feature Branch**: `007-subagent-token-rate`

**Created**: 2026-10-01

**Status**: Draft

**Input**: User description: "ok follow you suggest; [Image #1: the working-row readout, a throughput symbol followed by `32.5 tok/s`] use the same symbol btw based on symbol setting"

## Clarifications

### Session 2026-10-01

- Q: Which places should show subagent rates in this feature? → A: The Subagents block only. The "waiting on N jobs" rows and the status line stay as they are.
- Q: What should a subagent row show between its model requests, for example while it runs a tool? → A: The last reading, dimmed, until the next request streams.
- Q: Should each subagent row include the `tok/s` unit text after the number? → A: No. Rows show the symbol and the number only. The header shows the full `tok/s` readout.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See each running subagent's generation rate (Priority: P1)

A user starts two or more subagents. The main agent waits on them, so the main working row shows no live rate. The user looks at the pinned "Subagents" block. Each row that belongs to a subagent that streams output now shows that subagent's live generation rate. Between model requests, for example while the subagent runs a tool, the row keeps the last reading in a dimmed style. The user does not need to focus each subagent to see whether it makes progress.

**Why this priority**: This is the gap the user reported. Today the only way to see a subagent's rate is to focus that subagent, one at a time.

**Independent Test**: Turn on the Generation Rate setting. Start two subagents that stream output. Look at the Subagents block without focusing either one. Each row shows its own rate, and the block redraws the rate at least once each second while the subagent streams.

**Acceptance Scenarios**:

1. **Given** the Generation Rate setting is on and a subagent streams output, **When** the Subagents block shows that subagent's row, **Then** the row shows the throughput symbol and that subagent's rate with one decimal place and no unit text, for example `⚡ 32.5` with the Unicode preset.
2. **Given** a row shows a rate, **When** the description text is too long for the terminal width, **Then** the description gets shorter and the rate stays fully visible.
3. **Given** a subagent has a last reading and does not stream output now (it runs a tool, or it waits), **When** its row shows, **Then** the row shows that last reading in a dimmed style.
4. **Given** the dimmed last reading shows, **When** the subagent starts to stream again, **Then** the row shows the live rate in the normal style.
5. **Given** the Generation Rate setting is off, **When** subagents stream output, **Then** no row and no header shows a rate.

---

### User Story 2 - See the total rate of all subagents (Priority: P2)

A user runs many subagents. The Subagents block shows only a few rows and collapses the rest into "… N more". The block header shows the sum of the rates of all streaming subagents, so the user sees the total work in progress, also for agents in hidden rows.

**Why this priority**: The per-row rate (Story 1) already answers most questions. The total helps when the list collapses or when many agents run.

**Independent Test**: Start more subagents than the collapsed block shows. Make sure that the header shows one total, and that the total includes the agents in hidden rows.

**Acceptance Scenarios**:

1. **Given** two or more subagents stream output, **When** the Subagents block shows, **Then** the header shows the throughput symbol, the sum of their live rates, and the unit text, for example `⚡ 142.6 tok/s` with the Unicode preset.
2. **Given** no subagent streams output now (rows show only dimmed last readings or no rate), **When** the Subagents block shows, **Then** the header shows no rate.
3. **Given** the block collapses some rows into "… N more", **When** hidden subagents stream output, **Then** the header total includes their rates.

---

### User Story 3 - The rate uses the same symbol as the working row (Priority: P2)

The user has a symbol preset (Unicode, Nerd Font, or ASCII). The subagent rates use the same throughput symbol as the working-row rate readout. When the user changes the symbol preset, the subagent rates change symbol together with the working row.

**Why this priority**: The user asked for this directly. One meaning must use one symbol in all places.

**Independent Test**: Change the symbol preset to each of its three values. For each value, compare the symbol in front of a subagent rate with the symbol in the working-row readout. They are the same.

**Acceptance Scenarios**:

1. **Given** any symbol preset, **When** a subagent row or the header shows a rate, **Then** the symbol in front of the rate is the same symbol that the working-row readout uses for that preset.
2. **Given** the user changes the symbol preset, **When** the Subagents block shows next, **Then** the rates use the new preset's symbol.

---

### Edge Cases

- A subagent starts and has not yet produced enough output to measure a rate. Its row shows no rate until a value is available. There is no last reading to show dimmed.
- A subagent finishes, fails, or is cancelled. Its row leaves the block as it does today. Its rate does not stay in the header total.
- The terminal is very narrow. The rate stays visible before the description, and the row gets shorter at the end. If there is no space for the rate, the row omits the rate. The row does not show a partial number.
- A subagent is parked to disk or revived. A parked agent releases its session, so it has no meter in memory. Its row shows no rate. After a revive, the row shows a rate again when the meter has a value.
- Some subagents stream and others run tools. The streaming rows show live rates. The other rows show dimmed last readings. The header total includes only the live rates.
- A subagent has its own subagents. Only rows that the block already shows get a rate. The header total includes only the agents that the block lists.
- The main agent streams while subagents also stream. The working row shows the main agent's rate as today. The header shows only the subagent total.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Each Subagents block row MUST show the subagent's live generation rate while that subagent streams output.
- **FR-002**: A row MUST show the throughput symbol, then the value with one decimal place, with no unit text (for example `⚡ 32.5` with the Unicode preset). The header MUST show the throughput symbol, the value with one decimal place, and `tok/s` (for example `⚡ 142.6 tok/s`), as in the working-row readout.
- **FR-003**: The row MUST put the rate after the agent name and role badge and before the description, so the description gets shorter first.
- **FR-004**: When a subagent does not stream output now, its row MUST show its last reading in a dimmed style. When the subagent has no last reading, its row MUST NOT show a rate.
- **FR-005**: The Subagents block header MUST show the sum of the live rates of all streaming subagents that the block lists, including agents in collapsed rows. Dimmed last readings MUST NOT count in the sum.
- **FR-006**: The header MUST NOT show a rate when no listed subagent streams output.
- **FR-007**: The rate symbol MUST be the same throughput symbol that the working-row readout uses, and it MUST follow the active symbol preset (Unicode, Nerd Font, ASCII).
- **FR-008**: The existing Generation Rate setting MUST control all rates in the Subagents block. The feature MUST NOT add a new setting.
- **FR-009**: While at least one listed subagent streams output, the shown rates MUST update at least once per second, also when no other event changes the block.
- **FR-010**: When no listed subagent streams output, the block MUST NOT redraw only to update rates. Dimmed last readings do not change, so they need no redraw.
- **FR-011**: The rate value for a subagent MUST be the same value that the working row shows when the user focuses that subagent.

### Key Entities

- **Subagent generation rate**: The live output speed of one subagent, in tokens per second. It is live only while that subagent streams output.
- **Last reading**: The most recent generation rate of a subagent that does not stream now. Rows show it dimmed. The header total does not include it.
- **Subagent total rate**: The sum of the generation rates of all streaming subagents that the Subagents block lists.
- **Throughput symbol**: The symbol in front of every generation-rate readout. The active symbol preset selects it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can see the generation rate of every streaming subagent in the Subagents block without a focus change: 0 focus actions, compared with 1 focus action for each subagent today.
- **SC-002**: For each of the 3 symbol presets, the subagent rate symbol is the same as the working-row rate symbol in 100% of checks.
- **SC-003**: While a subagent streams output, the block recomputes and redraws its rate at least once in each 1-second interval, also when no other event changes the block. The value itself may stay the same when the throughput is steady.
- **SC-004**: Within 1 second after a subagent stops streaming, its row shows the dimmed last reading and the header total no longer includes its rate.
- **SC-005**: At terminal widths of 60 columns and more, every row with a rate shows the full rate value.
- **SC-006**: When the Generation Rate setting is off, the Subagents block looks the same as before this feature.

## Assumptions

- Scope is the Subagents block only: per-row rates and the header total. The rates on the "waiting on N jobs" rows and a status-line total that includes task subagents are out of scope (confirmed in Clarifications). They can be separate features.
- The existing Generation Rate setting (off by default) is the only switch. A user who wants subagent rates turns it on.
- Each subagent already measures its own live rate, the same way the main session does. This feature only shows that value.
- The value for each row uses one decimal place, as in the working row.
- The existing symbol preset setting already defines a throughput symbol for each preset: `⚡` (Unicode), a gauge glyph (Nerd Font), and `tok/s:` (ASCII). No new symbol is necessary. With the ASCII preset, a row reads `tok/s: 32.5`, so the unit stays readable without extra text.
