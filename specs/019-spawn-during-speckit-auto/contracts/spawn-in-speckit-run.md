# Contract: `/spawn` With Speckit-Auto Mode On

## Command

| Run state when the user types `/spawn <request>` | Result |
|---|---|
| Mode on, no run (waiting) | The spawn runs. |
| Run active, between turns | The spawn runs. The run's next start waits for the spawn turn. |
| Run active, judge in flight | The spawn runs. The judge goes on and decides on the phase reply. |
| Run active, phase turn running | The kickoff waits for that turn, as a follow-up. The judge reads the phase's last reply from before the kickoff. |
| Run holding (any kind) | The spawn runs. The hold and its reason stay. |
| Run paused | The spawn runs. The run stays paused. |

The other `/spawn` refusals do not change. They are: outside zmx, `--api-key`, a guided interview, and another `/spawn` running.

## Run invariants for a spawn turn

For every row above, these hold after the spawn turn ends, whether the spawn succeeds, is declined, or fails:

1. The saved run state (phase, hold, paused, answering, round counts, turnOpen) equals the state before the kickoff.
2. The judge reads no message of the spawn turn.
3. The run does not decide again on a reply that it already decided.
4. The run's own start (a phase command, an answer, a continue, or a remediation) does not start while `/spawn` sends its kickoff or while the spawn run runs.
5. After a reload, the restored run checks the same phase reply as the live run.
