# Contract: `/review-plan`

```text
/review-plan [on|off|status] [global|project]
```

| Input | Effect | Output |
|---|---|---|
| `/review-plan` | Toggle for the session | State line |
| `/review-plan on` / `off` | Set for the session | State line |
| `/review-plan on global` | Set, and save `reviewUsesPlan: true` to `~/.omp/agent/config.yml` | State line + `Saved to global config` |
| `/review-plan off project` | Set, and save `reviewUsesPlan: false` to `.omp/config.yml` | State line + `Saved to project config` |
| `/review-plan status` | No change | State line |
| Anything else | No change | `Usage: /review-plan [on\|off\|status] [global\|project]` |

State line:

- On and active: `Review plan mode on: reviews use <plan selector>`
- On, no plan model: `Review plan mode on, but no plan model resolves. Reviews keep <reviewer selector>.`
- Off: `Review plan mode off: reviews use <reviewer selector>`

Autocomplete description: `Review plan: on` or `Review plan: off`. After `on`
or `off`, completion offers `global` and `project`.
