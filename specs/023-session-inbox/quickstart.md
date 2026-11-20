# Quickstart: validate the Session Inbox

## Prerequisites

1. Build the local source with `bun run setup` from the repo root.
2. Make sure `zmx` is on `PATH`. It is needed only for the parent-link checks.
3. Keep `inbox.enabled: true`. It is the default, and `~/.omp/agent/config.yml` also lists it.

## 1. Automated checks

Run these commands from `packages/coding-agent`:

```sh
bun test test/ipc/private-registry.test.ts test/collab/registry.test.ts
bun test test/inbox/
bun test test/master-mode-guard.test.ts test/settings-gated-tools-live.test.ts
```

These outcomes must hold:

- **Collab registry:** the existing collab tests still pass after the helper move (research R1).
- **Transport and discovery:**
  - A wrong token is refused.
  - A dead entry is pruned.
  - A foreign `.json` in the inbox directory never deletes collab files.
  - Listing does not show the caller.
- **Reply tracking:**
  - Two requests that enter one turn get one reply each.
  - An idle request owns its own run.
  - `/new` reports `aborted`.
  - A reply over 16 KiB is cut and has `truncated`.
- **Notification routing:**
  - A `nit` sent to an idle target makes a card and starts no turn.
  - A `concern` sent to an idle target starts a turn.
  - A notification after a remote interrupt stays a card.
- **Dialogs:** a request that comes in while an `ask` dialog is open does not close the dialog (research R3).
- **Tool gating:**
  - The tool is absent in a subagent, in RPC mode and with `inbox.enabled: false`.
  - The master-mode guard allows `session_inbox`.

Then run the repo checks:

```sh
bun check
omp --smoke-test
```

## 2. End-to-end check with two sessions (no zmx link)

1. Start session A in one terminal: `omp`.
2. Start session B in a second terminal: `omp`.
3. In A, type `list the sessions you can reach with session_inbox`.
   - **Expected:** B shows as `omp-<pid>` with its cwd, branch and `idle`.
4. In A, type `send B the request "reply with the word PONG"`.
   - **Expected in B:** a `«A-name» ›` card shows, and B answers.
   - **Expected in A:** the tool result says `Delivered`, and A's turn ends. Within 2 s after B's turn ends, A gets `Reply from omp-<pid> …: completed` with `PONG`, and A starts a turn on it.
5. In A, type `send B a nit notification "FYI: the API now returns items"`.
   - **Expected:** B shows an advisor card with A as the source. B starts no turn, and A gets no reply.
6. Give B a long task, for example `count to 200 slowly with bash sleep 1`. Then in A, type `interrupt B`.
   - **Expected:** B stops and shows `<A-name> interrupted`. A gets `Interrupted …`.

## 3. Master and child check (zmx)

1. Run `zmx attach smoke-master omp --master`, and detach with `ctrl+\`.
2. Run `zmx send smoke-master $'start a child session that waits for instructions\r'`.
3. Run `zmx history smoke-master | tail -40`.
   - **Expected:** a child named `cci-omp-…` exists.
4. Run `zmx send smoke-master $'ask the child for its working directory\r'`.
   - **Expected in the history:** the master sends a request, the master's turn ends, and the reply then starts a new master turn that states the child's directory. The master's `list` marks the child `started-by-you`.
5. In the child window, type `tell the master you are blocked on a design choice`.
   - **Expected:** the master gets the request with the child as the sender.

**Cleanup:** run `zmx kill smoke-master <child>`.
