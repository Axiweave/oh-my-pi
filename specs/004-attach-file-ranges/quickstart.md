# Quickstart: Validate Automatic File Range Attachments

## Status

Implementation and feature verification are complete. The repository-wide check remains blocked by unrelated formatting issues.

Inline single-line and finite-range mentions now attach selected saved text before the first conversation model request.

## Prerequisites

- Use Bun 1.4 or later, workspace dependencies, and the matching native addon.
- Use saved UTF-8 text files for range scenarios.
- Use configured model access only for the interactive CLI smoke.
- Keep deterministic regression tests independent of external model access.

If workspace prerequisites are missing, run the repository setup command from the repository root:

```sh
PATH="$HOME/.cargo/bin:$PATH" bun run setup
```

This command installs dependencies and builds project prerequisites. Do not upgrade the system toolchain for this feature.

## 1. Run attachment behavior checks

After implementation, run:

```sh
bun test /Users/fuyu0425/agents/oh-my-pi/packages/coding-agent/test/file-mentions.test.ts
bun test /Users/fuyu0425/agents/oh-my-pi/packages/coding-agent/test/session-messages.test.ts
```

Expected outcome: selected content matches source-line identities, existing attachments retain their behavior, and invalid selections attach no unintended source text.

Range tests must use the invariants in [data-model.md](data-model.md). Seeded cases must report seed `20260925` and the failing selection.

Include empty files, blank lines, first and final lines, clipped ends, final-newline variants, supported line endings, Unicode, and output limits.

## 2. Prove first-request delivery

Run the first-request session regression:

```sh
bun test /Users/fuyu0425/agents/oh-my-pi/packages/coding-agent/test/agent-session-file-mentions.test.ts
```

The regression must use real prompt preparation and model conversion. A deterministic provider handler captures the first model-bound messages by value.

Expected evidence:

- Selected line identities already appear in the first request.
- Identities outside the selection do not appear in that request's attachment.
- The original `@path:N-M` reference remains in the submitted prompt text.
- The run has zero tool executions and no read-tool result supplying the content.

Do not replace the attachment producer with a mock. A model response or post-turn message inspection alone does not prove pre-send attachment.

## 3. Exercise generated attachment content directly

Run this small probe after implementation. It uses a temporary saved file and the production extractor and generator.

```sh
bun -e '
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFileMentions, generateFileMentionMessages } from "/Users/fuyu0425/agents/oh-my-pi/packages/coding-agent/src/utils/file-mentions.ts";
const cwd = await mkdtemp(join(tmpdir(), "omp-range-smoke-"));
try {
  await Bun.write(join(cwd, "sample.txt"), "OUTSIDE_A\nSELECTED_B\nSELECTED_C\nOUTSIDE_D\n");
  const messages = await generateFileMentionMessages(extractFileMentions("Inspect @sample.txt:2-3"), cwd);
  const files = messages.flatMap(m => m.role === "fileMention" ? m.files : []);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "sample.txt:2-3");
  assert.equal(files[0].content, "SELECTED_B\nSELECTED_C");
  assert.equal(files[0].lineCount, 2);
  console.log(JSON.stringify(files[0], null, 2));
} finally {
  await rm(cwd, { recursive: true, force: true });
}
'
```

Expected content is exactly the two selected lines. This probe does not replace the first-request or visible-surface checks.

## 4. Observe the actual submitted attachment

Create a temporary fixture:

```sh
scratch="$(mktemp -d /tmp/omp-range-ui.XXXXXX)"
printf 'OUTSIDE_A\nSELECTED_B\nSELECTED_C\nOUTSIDE_D\nOUTSIDE_E\n' > "$scratch/sample.txt"
printf 'Inspect @%s/sample.txt:2-3\n' "$scratch"
```

Start the source CLI, rather than a possibly stale compiled binary:

```sh
bun /Users/fuyu0425/agents/oh-my-pi/packages/coding-agent/src/cli.ts --no-session --no-tools --no-lsp
```

1. Paste the printed `Inspect @.../sample.txt:2-3` text into the prompt.
2. Submit the prompt.
3. Observe the attachment row labeled with `sample.txt:2-3` and two selected lines.
4. Record the attachment display as smoke evidence.
5. Submit a new prompt with the same file and no suffix.
6. Confirm that ordinary whole-file attachment still appears.

Do not supply the mention as a standalone shell argument. That would test the separate launch-time file argument interface.

A model answer is not evidence of first-request contents. Use the provider-capture regression for that requirement.

After the CLI exits, remove only this guide's fixture:

```sh
rm "$scratch/sample.txt"
rmdir "$scratch"
```

## 5. Check boundaries and snapshot safety

Use the acceptance examples in [contracts/file-range-mentions.md](contracts/file-range-mentions.md).

Verify the following in the targeted regression results:

- Literal selector-shaped filenames take precedence.
- Invalid and unsupported selections do not attach whole-base-file content.
- A small range cannot bypass the 5 MiB source-file limit.
- A selected-output limit notice uses original source coordinates.
- Distinct selections remain distinct, including selections with the same clipped effective span.
- Hashline output retains the real source path and full-source snapshot.
- Seen-line provenance excludes notices and undisplayed source lines.

## 6. Complete repository checks

From the repository root, run the existing checks once after the implementation is complete:

```sh
bun run check
```

Report any environment failures separately from feature failures. Do not claim a check passed unless its result was observed.

## Acceptance evidence to retain

- Targeted behavior test results and printed seed.
- First-request content capture with no tool executions.
- Direct generated attachment output.
- Actual CLI attachment display.
- Snapshot and truncation boundary results.

## Observed implementation results

- Final targeted run: **61 passed, 0 failed, 586 assertions** across the three test files above.
- Generated range cases used seed `20260925` across LF, CRLF, CR, final-newline variants, blank lines, and Unicode.
- Before implementation, the finite-range and first-request checks produced 25 failures and 6 passes.
- Before single-line support, the mixed-mention checks produced 1 failure and 2 passes.
- The real session regression captured selected lines in the first conversation request with zero tool executions.
- Boundary checks passed for invalid selections, literal filenames, dangling links, inconclusive probes, unsupported sources, source size, and output limits.
- Hashline checks preserved full normalized snapshots and original line coordinates. Seen-line records excluded omitted rows and notices.

The direct production probe returned exactly this attachment while ignoring zero-bound and start-past-EOF selections:

```json
[{"path":"sample.txt:2-3","content":"SELECTED_B\nSELECTED_C","lineCount":2}]
```

The actual source CLI used an isolated local HTTP provider and disabled tools.
Its TUI showed `Read sample.txt:2-3 (2 lines)`.
The captured conversation payload contained only the two selected sentinels and no tools.
The CLI sent a separate title-generation request first. That request was not the conversation request.

A second source CLI run submitted whole-file, single-line, clipped-range, and repeated mentions together.
The TUI showed these three attachment rows:

```text
Read sample.txt (6 lines)
Read sample.txt:2 (1 lines)
Read sample.txt:4-5 (2 lines)
```

The captured conversation payload contained three attachments and zero tools.
The whole-file count retains existing final-newline behavior.
No external model service supplied these smoke responses.

### Code checks

Changed-file `oxlint` and `oxfmt --check` passed.
`bun run check:types` passed in `packages/coding-agent`.
The final targeted test command was:

```sh
bun test packages/coding-agent/test/file-mentions.test.ts packages/coding-agent/test/agent-session-file-mentions.test.ts packages/coding-agent/test/session-messages.test.ts
```

The repository-wide `PATH="$HOME/.cargo/bin:$PATH" bun run check` ran once and exited with code 1.
Its formatter reported these files, which this feature did not change:

- `packages/coding-agent/src/modes/controllers/selector-controller.ts`
- `packages/coding-agent/test/model-profile-picker.test.ts`

The check also reported five `unicorn(no-new-array)` warnings in `packages/tui/src/prompt/composer.ts`.
The formatter failure stopped workspace-wide type checks and interrupted Rust checks with SIGINT.
This result does not establish a clean repository check or a passing Rust check.
No unrelated files were reformatted.

### Completion

The source CLI smoke sessions stopped, and their disposable fixture directory was removed.
No `.specify/extensions.yml` file exists, so there are no configured post-implementation extension hooks.
The CLI reference and Unreleased changelog describe the verified behavior.
No model-content schema, rendering, configuration, or Emacs changes were necessary.
