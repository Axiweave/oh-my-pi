# Quickstart Validation: `/wtmove`

This guide validates `/wtmove`. The observed implementation results appear at the end.
See [the command contract](contracts/wtmove.md) and [the invariants](data-model.md).

## Prerequisites

- Use the repository's supported Bun version, Git, and built native addon.
- Use an interactive terminal and an omp provider configured for the session-history check.
- Run the commands from the oh-my-pi repository root unless a step specifies another directory.
- If dependencies or native binaries are absent, run `bun run setup` first.

## Disposable fixture

Run this setup in one shell. Keep its variables for the launch command.

```bash
OMP_SOURCE="$PWD"
WTMOVE_FIXTURE="$(mktemp -d)"
git init "$WTMOVE_FIXTURE/main"
git -C "$WTMOVE_FIXTURE/main" -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -m fixture
git -C "$WTMOVE_FIXTURE/main" worktree add -b FeatureOne "$WTMOVE_FIXTURE/feature one"
git -C "$WTMOVE_FIXTURE/main" worktree add --detach "$WTMOVE_FIXTURE/detached" HEAD
git init "$WTMOVE_FIXTURE/unrelated"
bun "$OMP_SOURCE/packages/coding-agent/src/cli.ts" --cwd "$WTMOVE_FIXTURE/main"
```

The destinations deliberately reside outside omp-managed worktree storage.
The setup changes only the disposable fixture, not this repository's branches.

## Selection and session preservation

1. Send a short message that contains a unique history marker.
2. Ask omp to create one session artifact containing that marker.
3. Enter `/wtmove` without arguments.
4. Confirm that the list shows `FeatureOne` and a detached destination with their full paths.
5. Confirm that the list excludes the current checkout.
6. Filter with `featureone` and select the path containing a space.
7. Confirm that the session directory changes and the earlier conversation remains visible.
8. Read the session artifact and confirm its contents remain unchanged.
9. Open `/wtmove` again and confirm that the primary checkout appears.
10. Cancel the picker and confirm that the current directory does not change.
11. Exit omp normally.
12. Restart omp in the selected destination and use `/resume` to find the same session.

Use `bun "$OMP_SOURCE/packages/coding-agent/src/cli.ts" --cwd "$WTMOVE_FIXTURE/feature one"` for the restart.
Compare the session identity, full prior message sequence, and artifact contents before and after the move.
Do not treat a message count alone as proof of preserved history.

## Completion and explicit paths

1. Enter `/wtmove ` and request completion with Tab.
2. Confirm that both branch-label and path substrings filter the same destination list.
3. Repeat with different letter case and confirm that the results remain the same.
4. Select a completion and confirm that it inserts a usable path, including paths with spaces.
5. Move using absolute and relative paths to registered roots.
6. Repeat with a home-relative path for a disposable worktree under your home directory.
7. Submit an unrelated checkout, an ordinary directory, and a worktree subdirectory.
8. Confirm that each invalid destination reports an error and preserves the session directory.
9. Submit the current checkout path and confirm an unchanged-session notice.

## Failure and compatibility checks

1. Open the picker and remove a destination from the disposable fixture in another terminal.
2. Confirm that selecting the stale destination reports failure without losing history.
3. Invoke `/wtmove` during an active response and confirm that the command rejects relocation.
4. Invoke `/wtmove` outside a repository and confirm an actionable error.
5. Use a repository with no other worktrees and confirm an empty-state message.
6. Give two destinations a shared filter substring and confirm that filtering never triggers a move.
7. Add tracked and untracked changes to both disposable checkouts.
8. Compare file contents and Git status before and after a successful move.
9. Confirm that another saved destination session remains unchanged.
10. Invoke `/move` without arguments and confirm that its directory picker still opens.
11. Use `/move` to select an ordinary directory and confirm that the session moves there.
12. Invoke `/wt` with a fresh branch name in the disposable repository.
13. Confirm that `/wt` still creates a worktree and carries changes according to its existing settings.

Exercise relocation failure through the repository's existing failure-injection test patterns, not by corrupting a real session.

## Automated validation

Run focused existing session-move, worktree, completion, and overlay test files named in [the plan](plan.md).
Add deterministic cases for registered-root validation and case-insensitive selection only where existing tests do not cover the behavior.
State the invariant before each new test. Include empty, single, multiple, unavailable, detached, and space-containing paths.
Use isolated temporary repositories and preserve the test seed if generated inputs are used.
Run the package type check after integration.

## Performance and evidence

Use 20 available local worktrees for the performance check.
Measure command invocation to visible list and input to visible filtered results. Each must complete within one second.
Record the host, worktree count, elapsed times, selected path, session identity, and before/after preservation results.
Capture the actual TUI selection and confirmation, not only unit-test output.

After validation, remove only the disposable fixture and any disposable session artifacts created for this guide.

## Observed results — 2026-09-24

### Automated checks

```bash
bun test packages/coding-agent/test/session-worktree-move.test.ts packages/tui/test/worktree-selector.test.ts packages/coding-agent/test/sdk-move-cwd.test.ts packages/coding-agent/test/git-linked-worktree.test.ts packages/coding-agent/test/acp-builtins.test.ts
bun run --cwd packages/coding-agent check:types
bun run --cwd packages/tui check:types
```

Result: 98 tests passed, zero failed, with 387 assertions. Both package type checks passed.
The new keyboard regression check failed before the fix and passed afterward.
The custom picker required an input handler because the custom-overlay path does not forward input through the existing selector controller.

The registered-root check covered empty, single, multiple, detached, missing, symlink, and space-containing destinations.
It also verified nested-cwd exclusion, rejected non-root paths, case-insensitive matching, unchanged Git refs, and unchanged file contents.

### Actual terminal checks

The source CLI ran on macOS arm64 with Bun 1.4.2 and isolated agent storage.
The fixture contained 20 destination worktrees outside omp-managed storage.

- The picker showed branch labels, detached state, and wrapped full paths.
- Mixed-case `fEaTuRe19` selected the twentieth destination.
- Down-arrow navigation also reached the twentieth destination without filtering.
- Tab completion inserted a full path containing a space, and Enter moved the session there.
- The primary checkout appeared after the session moved to a linked worktree.
- Absolute, relative, and home-relative symlink paths selected registered roots.
- A current-root path produced an unchanged-session notice.
- Unrelated, nested, and absent destinations produced errors without moving the session.
- A repository without other worktrees produced an empty-state message.
- A directory outside Git produced a repository error.
- Escape cancelled the picker and preserved the current checkout.
- `/move` still opened its directory picker and moved into ordinary directories.
- `/wt` still created a branch and worktree with dirty tracked content.
- With default source cleanup disabled, `/wt` retained that dirty content in the source checkout.

Measured command-to-screenshot time was 0.197 seconds for the initial picker and 0.184 seconds for filtering.
These measurements include tool transport and terminal rendering overhead, not only matching time.
Both measurements satisfy the one-second target for this local 20-worktree fixture.

### Session preservation and failures

A disposable smoke program used the real controller, AgentSession, SessionManager, and artifact storage.
Only UI callbacks and the model response used a minimal test host.
It verified identical session identity, all four persisted entries, artifact bytes, reopened history, and an unchanged separate destination session.
Both checkout HEADs, destination branch, and Git status remained unchanged.
No error or warning occurred during the successful move.

A separate disposable failure check passed eight scenarios with 57 assertions.
It covered streaming rejection, cancellation, no repository, injected discovery failure, removed destinations, current-root no-op, relocation failure, and cwd-application rollback.
The rollback scenario performed real forward and reverse session-file relocation.
Each rejection or failure retained the original session directory and session-file bytes, without a false success message.

The handler retains source-settings flush, the existing move gate, destination revalidation, protected relocation, cwd resource refresh, and todo reload.
It does not add a second session persistence path.

### Setup and cleanup

Existing Git and Docker ignore files already exclude dependencies, build output, logs, and environment secrets.
The root package is private. Published packages use explicit file allowlists, so no new ignore file was necessary.
The isolated terminal configuration disabled setup and update checks. No provider authorization was completed.
Disposable smoke programs, worktrees, agent storage, and the home-relative symlink fixture were removed after verification.
No implementation checklist marker was changed. The task checklist records completed implementation work separately.

## Convergence fix verification — 2026-09-24

T017–T021 are complete. The final focused run passed 102 tests with 403 assertions and zero failures.
Both package type checks and lint on the changed TypeScript files passed.

The exact-root checks used real registered worktrees with plain, trailing-space, and Unicode-space names.
Picker validation and quoted explicit paths returned the original roots without selecting their plain-space counterparts.
Removing a selected root produced an error even when its plain-name counterpart still existed.
Outside Git, both existing and missing explicit targets reported the repository requirement.

Rendering checks compare distinct path output rather than requiring one specific escape style.
They cover repeated spaces, trailing spaces, different Unicode spaces, literal marker characters, and controls versus literal escape text.
The 40-column checks confirm visible path details, keyboard selection, and cancellation.

Actual source-CLI checks used isolated agent storage and disposable detached worktrees:

- At 40 columns, the picker showed the full wrapped paths of two detached destinations under a long common prefix.
- Repeated-space and plain-space paths remained visibly distinct.
- The picker selected the trailing-space root, and live completion then excluded that exact root rather than its plain-name sibling.
- Completion displayed distinct `alpha` and `beta` suffixes for both long directory prefixes and long shared basenames.
- Accepting a long-prefix completion moved the session to the selected destination.
- Completion quoted a trailing-space root, and the submitted command moved to that exact root.
- A Unicode-space picker selection retained its identity and disappeared from the subsequent live destination list.

The display formatter uses visible escapes without changing selection values.
Typed path expansion preserves literal Unicode spaces. Picker selections bypass typed-argument parsing entirely.
No shared selector or `/move` behavior changed.
The terminal sessions and disposable fixture were removed after these checks.

## Mixed-prefix completion verification — 2026-09-24

T022 replaces the list-wide prefix calculation with per-destination suffix selection.
Labels retain short path context and extend left when another destination shares the same ending.
Exact insertion values, escaped display paths, and live-cwd discovery remain on their existing paths.

The regression uses real registered worktrees and the actual `Editor` with `CombinedAutocompleteProvider`.
It generates sibling paths with 0, 32, and 168 repeated prefix characters beside an unrelated destination.
The longest paths also have trailing spaces.
Before the fix, the editor hid `alpha` and `beta` behind identical prefixes.
After the fix, both names remain visible at 80 columns.
Keyboard completion also produces an explicit argument that resolves to the exact selected root.

The source CLI confirmed the unfiltered three-destination case at 80 columns.
All three labels remained distinct and showed the detached state.
Accepting the `alpha` completion moved the session to that root.
The next completion request excluded `alpha` and retained `beta`, which confirms live-cwd discovery.
The terminal session stopped, and all disposable fixtures were removed.

The final focused run passed 103 tests with 413 assertions and zero failures.
Both package type checks and lint on the two changed TypeScript files passed.

## Full-set completion verification — 2026-09-24

T023 replaces independent suffix selection with group-aware path compaction.
The formatter retains branching characters and removes shared runs within each group.
Literal ellipses use an escape so they cannot imitate the omission marker.
Full escaped paths and exact insertion values remain separate from these labels.

The actual-editor regression failed before the fix: four registered roots produced only two distinct selected rows at 80 columns.
After the fix, every selected row is distinct for sets of one, four, and twenty destinations.
The test also retains empty discovery and the earlier three-destination cases.
It verifies exact keyboard insertion across every destination, including after scrolling beyond the visible-row limit.
The generated paths cover repeated sibling groups, internal Unicode spaces, trailing ASCII spaces, literal ellipses, and supplementary Unicode characters.

The source CLI ran with twenty detached destinations across ten sibling groups at 80 columns.
The first viewport showed distinct `A…alpha`, `A…beta`, `B…alpha`, and `B…beta` labels with detached state.
Nineteen Down-arrow presses reached `J…beta`, and accepting that completion moved the session to its exact root.
The next completion request for `/J/` offered only the remaining `alpha` destination.
The terminal session stopped, and all disposable fixtures were removed.

The final focused run passed 103 tests with 469 assertions and zero failures.
Both package type checks and lint on the two changed TypeScript files passed.

### Native discovery correction (T024)

The native parser now preserves significant whitespace in `.git` and `commondir` path records.
It removes format delimiters and CR/LF terminators rather than trimming literal path characters.
The previously rejected metadata directory ending in U+00A0 now resolves correctly.

Both regression checks failed before the correction and passed afterward.
The Rust check compares metadata identity with Git across Unicode endings, ASCII spaces, LF, and CRLF.
It creates Unicode names before plain-name counterparts and checks identity again after those counterparts appear.
The addon check also verifies exact roots, quoted arguments, primary-checkout discovery, metadata paths, and HEAD resolution.

```bash
env PATH="$HOME/.cargo/bin:$PATH" cargo test -p pi-vcs git::
env PATH="$HOME/.cargo/bin:$PATH" bun scripts/bazel-natives.ts host
```

The native Git suite passed 62 tests, and the local build installed the rebuilt macOS arm64 addon.
The focused Bun suite passed 103 tests with 478 assertions and zero failures.
Both package type checks and lint on the changed TypeScript test passed.
The build reported an unrelated warning because this host lacks the SDK for Apple Foundation Models support.

Actual source-CLI checks confirmed quoted and picker moves into the U+00A0-ending root.
The picker from that checkout included the primary checkout and excluded the current root.
Plain, trailing-ASCII-space, and trailing-U+00A0 paths retained separate identities with all three present.
Checkout contents and HEADs remained unchanged across the `/wtmove` checks.
`/move` still accepted an ordinary directory, and `/wt` created its requested branch and an APFS-cloned worktree.
All terminal sessions stopped, and all disposable checkouts and isolated agent storage were removed.
