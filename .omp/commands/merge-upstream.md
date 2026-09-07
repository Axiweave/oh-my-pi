# Merge Upstream Release

Merge the latest published stable release from `can1357/oh-my-pi` into this fork's `main` branch.
Invocation authorizes a local merge commit after verification. Do not push.

## 1. Prepare

1. Read `AGENTS.md`, every entry in `UPSTREAM_DIVERGENCES.md`, and `README.md` under Install.
2. Inspect the current branch, working tree, index, and remote URLs.
3. Identify the upstream remote by its URL, not its name.
4. If the branch is not `main`, stop and ask before switching branches.
5. If tracked changes or an unfinished Git operation exist, stop and ask how to preserve them.
6. Leave unrelated untracked files, including `TODOs.org`, untouched.

Never reset, discard, automatically stash, or commit unrelated user work.

## 2. Select the Release

1. Query the latest published release:

   ```bash
   gh release view --repo can1357/oh-my-pi --json tagName,publishedAt,isPrerelease,url
   ```

2. Require a stable release, not a prerelease or a tag selected only by local sorting.
3. Fetch the exact tag with `git fetch <upstream> tag <tag>`.
4. If the local tag conflicts with upstream, stop and report the mismatch instead of forcing replacement.
5. If the tag is already an ancestor of `HEAD`, report that the release is already merged and stop.
6. Record the pre-merge commit and inspect incoming commits and changed paths from the merge base.

## 3. Merge

1. Run `git merge --no-ff --no-commit <tag>`.
2. If conflicts occur, read the `resolving-merge-conflicts` skill before resolving them.
3. Preserve the fork decisions while integrating upstream changes.
4. Inspect automatic merges in fork-specific paths as carefully as explicit conflicts.
5. Verify every divergence against the merged source and upstream.
6. Retire an entry only when upstream adopts its behavior or the user explicitly retires the decision.

Split independent divergence reviews between subagents when useful. Keep shared-file edits and final verification under one owner.
Subagents must skip builds, formatters, linters, and tests during concurrent edits.

## 4. Verify

1. Read the current runtime and toolchain requirements from `package.json` and `rust-toolchain.toml`.
2. Check executable resolution before the build.
3. If another Rust installation hides rustup, prepend rustup's bin directory to `PATH` for these commands only.
4. Follow the source setup procedure in `README.md`, including `bun run setup`.
5. Run `bun check` with the same toolchain environment.
6. Run the relevant upstream regression tests and the checks named by every divergence entry.
7. Use the existing test runner or separate processes for suites that need isolation.
8. Verify the installed launcher target, release version, and `omp --smoke-test` as specified in `README.md`.

The test runner's command `cwd` is repository-relative. Use `.` for root-level test paths, not an absolute directory.
Diagnose failed checks before repeating them. Do not replace this fork with upstream binaries or suppress failures.
If a required check remains blocked, leave the merge uncommitted and report the exact blocker.

## 5. Complete

1. Update the reviewed release and date in `UPSTREAM_DIVERGENCES.md` after verification succeeds.
2. Remove temporary verification scripts.
3. Inspect generated changes and the staging scope before committing.
4. Stage only merge resolutions and the divergence record, alongside the changes Git staged for the merge.
5. Create the merge commit with `git commit -m "Merge tag '<tag>'"`.
6. Report the release, commit, conflict outcome, verification results, and any warnings.
7. State that unrelated user files remain untouched and that the merge was not pushed.
