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

State line. Each line names the role and the model that reviews use now:

- On and active: `Review plan mode on: reviews use the plan model <plan selector>, not the reviewer model`
- On, no plan model: `Review plan mode on, but no plan model resolves. Reviews keep the reviewer model <reviewer selector>.`
- Off: `Review plan mode off: reviews use the reviewer model <reviewer selector>, not the plan model`

Autocomplete description: the state line, so the `/` menu says what the
command changes. After `on` or `off`, completion offers `global` and `project`,
each with the config file it writes.
