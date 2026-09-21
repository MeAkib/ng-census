# Usage guide

Everything the README leaves out. For what each metric means exactly, see
[RULES.md](../RULES.md); when something goes wrong, see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Commands

```bash
ng-census analyze  [path]   # terminal summary
ng-census report   [path]   # self-contained HTML report
ng-census baseline [path]   # snapshot the current state
ng-census check    [path]   # compare with the snapshot, exit 1 on regression
ng-census repo-map [path]   # one line per component, for coding agents
ng-census projects [path]   # list the projects in angular.json
```

`path` defaults to the current directory, and must be the project root — the
folder with `package.json` and `angular.json`.

| Option | Does |
|---|---|
| `--project <name>` | One project from `angular.json` |
| `--out <file>` | Write to a file: HTML for `report`, JSON for `analyze`, snapshot for `baseline` |
| `--json` | Print the full run object to stdout, for pipes |
| `--filter <text>` | Only paths containing this text |
| `--top <n>` | Rows in the attention list (default 5; `repo-map` 200) |
| `--baseline <file>` | Snapshot to compare against (default `.census-baseline.json`) |
| `--strict` | Exit 1 if the template parser met syntax it does not know |

Exit codes: `0` success, `1` regression or run error, `2` bad usage.

## The CI gate

```bash
ng-census baseline                 # once; commit .census-baseline.json
ng-census check                    # in every pipeline run
```

It fails the build for exactly two reasons:

1. **A file that already existed got worse** on a legacy pattern — more
   `*ngIf`, a lost `OnPush`, a new manual `.subscribe()`.
2. **A new file arrived carrying a legacy pattern** — which is how AI-written
   code shows up. A reviewer will not notice that a generated component used
   `*ngIf`; the gate will.

```
  ✗ order-list             legacy control flow      0 → 2
  ✗ order-list             change detection         OnPush → absent

  New since baseline, already carrying legacy patterns:
  ✗ agent-made             legacy control flow      2
  ✗ agent-made             standalone               false

  2 regressions. Exit 1.
```

It does **not** fail on ordinary work: adding a component, injecting a
dependency, or a class growing. Dependency counts and template method calls
are reported but never gated — the first because a metric used as a target
gets gamed instead of fixed, the second because its detection is a documented
heuristic, and a false positive in CI is a wall with no door.

Pin the version in CI (`npx ng-census@0.1.0 check`) so a rule change in a
later release cannot change your build without you choosing it.

Refresh the snapshot on purpose, never automatically — a baseline that
regenerates itself records whatever happened and can never fail:

```bash
ng-census baseline && git add .census-baseline.json
```

## Multi-project workspaces

```bash
ng-census projects                             # billing  projects/billing [application]
ng-census report   --project billing
ng-census baseline --project billing --out billing.baseline.json
ng-census check    --project billing --baseline billing.baseline.json
```

Component ids stay relative to the workspace root, so a scoped run and a full
run describe the same component by the same id. You can add `--project` to an
existing CI command without restarting your history.

A baseline records its scope, and `check` refuses to compare across scopes.
Otherwise a baseline of one application, checked against the whole
workspace, would report every other application as newly added.

## The HTML report

```bash
ng-census report                    # writes census-report.html
ng-census report --out review.html
```

One file, no scripts, no fonts, no network: it opens offline, survives being
emailed, and prints. It leads with the migration progress, then the components
worth opening first, a per-folder breakdown, and every finding with its line.

It has no score and no red or green meters on purpose. A single number gets
someone asked to raise it, and a red bar at 38% OnPush asserts that 38% is
failing — a judgement this tool does not make. Colour marks one thing only:
the Angular support deadline, which is a published date, not an opinion.

## Raw data

```bash
ng-census analyze --out census.json            # a real workspace is megabytes
ng-census analyze --json | jq '.entities[0]'
```

`null` in the output means "could not be measured here" — an Angular version
without the feature, or a template that failed to open. It never means `0`.

## For coding agents

```bash
ng-census repo-map
```

```
orders/order-list    deps:2 in:2 tpl:11 legacy:0 modern:2 onpush:yes
legacy/order-table   deps:9 in:4 tpl:214 legacy:8 modern:0 onpush:no
```

One dense line per component, the files most worth opening first. Capped at
200 rows, because a map that does not fit in an agent's context pushes out the
code it was reading.

## Configuration

Optional: `.ng-censusrc`, `.ng-censusrc.json`, or an `ngCensus` key in
`package.json`.

```json
{
  "exclude": ["src/legacy-vendor/", "e2e/"],
  "filter": "src/app"
}
```

Configuration changes **what is looked at**, nothing else. There is no way to
turn a rule off: a baseline taken with a rule disabled cannot be compared with
one taken with it on, and "we improved" and "we stopped measuring" would draw
the same chart.

Always skipped: `node_modules`, `dist`, `out-tsc`, `coverage`, `.angular`,
`.nx`, `bazel-out`, folders starting with a dot, `*.spec.ts`, `*.d.ts`.

## Angular versions

| Version | Status |
|---|---|
| 20, 21, 22 | Full support |
| 17, 18, 19 | Runs, with a warning |
| 16 and below | Runs, with a loud warning; results unreliable |

The version is read from the analyzed project's `node_modules/@angular/core`,
falling back to its `package.json`.

## What it does not do

- **Migrate code.** Angular's own schematics do that better. ng-census tells
  you how much is left, and catches new legacy code added after a migration.
- **Score your codebase.** There is no single number to raise.
- **Use AI.** The same code always gives the same numbers, which is what makes
  a trend over months, and a CI gate, trustworthy.
