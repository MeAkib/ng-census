# ng-census

Count what is actually in your Angular codebase.

**Status: v1 complete for components.** Class, decorator, and template metrics
work, every rule in the component catalogue emits a finding with a line and
column, and `check` gates CI on regressions. Routes, services and the MCP
server are not built yet.

## Why

AI coding agents learned Angular mostly from code written before 2023. Left
alone they write `*ngIf`, constructor injection, `@Input()` decorators, and
NgModules, because that is what dominates their training data.

The result is a codebase that can drift *backwards* while shipping quickly.
Each pull request looks fine on its own. Six months later the migration you
finished has quietly half-undone itself, and no single review caught it.

This tool measures that drift. It produces the same numbers every time, so you
can compare last quarter to this one.

## Install

Not published yet. To run from source:

```bash
git clone <repo>
cd ng-census
npm install
npm run build
node packages/cli/dist/bin.js analyze /path/to/your/angular/app
```

## Usage

```bash
ng-census analyze                   # current directory
ng-census analyze ./apps/web        # a specific path
ng-census analyze --filter orders   # only paths containing "orders"
ng-census analyze --top 10          # longer attention list
ng-census analyze --out census.json # write the full run object to a file

ng-census baseline                  # snapshot to .census-baseline.json
ng-census check                     # compare, exit 1 on regression
ng-census repo-map                  # one line per entity, for agents
ng-census projects                  # list the projects in the workspace
```

### Multi-project workspaces

A workspace with four applications produces four sets of numbers that nobody
owns together. `--project` scopes a run to one of them, by name from
`angular.json`:

```bash
ng-census projects                            # billing  projects/billing [application]
ng-census analyze  --project billing
ng-census baseline --project billing --out billing.baseline.json
ng-census check    --project billing --baseline billing.baseline.json
```

Entity ids stay relative to the workspace root, not to the project, so a run
over one application and a run over everything describe the same component by
the same id. Scoping changes what is measured, never what anything is called —
which means you can add `--project` to an existing CI command without
restarting your history.

A baseline records the scope it was taken with, and `check` refuses to compare
across scopes. Otherwise a baseline of one application, checked against the
whole workspace, reports every other application as newly added — a wall of
false drift whose cause is invisible in the output.

### Getting the full data out

`--json` prints the whole run object to stdout, which is right for a pipe and
unreadable in a terminal: a real workspace is megabytes of it. Use `--out` to
put it in a file instead.

```bash
ng-census analyze --out census.json            # write the file
ng-census analyze --json | jq '.entities[0]'   # pipe it somewhere
```

`--out` writes relative to where you are standing, not to the project being
analyzed, so pass a path if you want it elsewhere.

### In CI

```yaml
- run: npx ng-census check
```

Commit `.census-baseline.json`. The gate fails the build when a component gets
worse, or when a new component arrives already carrying legacy patterns — which
is what catches AI-generated code, since a human reviewer will not notice that
a generated component used `*ngIf`.

**What the gate will not do is fail on ordinary work.** Adding a component,
injecting a dependency, or growing a class are not regressions. Only two things
fail the build: a measured legacy pattern that got worse in a file that already
existed, and a brand-new file that arrives carrying one. Dependency counts and
template method calls are reported but never gated — the first because a metric
used as a target gets gamed rather than fixed, the second because its detection
is a documented heuristic and a false positive in CI is a wall with no door.

Refresh the snapshot deliberately, never automatically:

```bash
ng-census baseline && git add .census-baseline.json
```

### Drift output

```
  ✗ order-list             legacy control flow      0 → 2
  ✗ order-list             change detection         OnPush → absent

  New since baseline, already carrying legacy patterns:
  ✗ agent-made             legacy control flow      2
  ✗ agent-made             loops without track      1
  ✗ agent-made             standalone               false

  ✓ 4 unchanged or improved

  5 regressions. Exit 1.
```

### For agents

`repo-map` prints one dense line per component, ranked so the files most worth
opening come first. `-` means the metric could not be measured; it is never
printed as `0`.

```
orders/order-list    deps:2 in:2 tpl:11 legacy:0 modern:2 onpush:yes
legacy/order-table   deps:9 in:4 tpl:214 legacy:8 modern:0 onpush:no
```

Output is capped at 200 rows by default — a map an agent cannot fit in its
context is worse than no map, because it evicts the code the agent was reading.
Use `--top N` to change that.

## Configuration

Optional. `.ng-censusrc`, `.ng-censusrc.json`, or an `ngCensus` key in
`package.json`:

```json
{
  "exclude": ["src/legacy-vendor/", "e2e/"],
  "filter": "src/app"
}
```

Config can change **what is looked at** and nothing else. There is deliberately
no way to switch an individual rule off: a baseline recorded with a rule
disabled is not comparable to one recorded with it enabled, and nothing in the
file would tell you which you were reading. The moment a flag can silence a
counter, "we improved" and "we stopped measuring" draw the same chart.

Build output (`dist/`, `out-tsc/`, `.angular/`, `coverage/`, `.nx/`,
`bazel-out/`) is skipped by default.

## Example output

```
Angular 22.1.6 · 147 components · 2.1s

  ℹ Angular 22 support ends 2028-06-30.

  OnPush               38%  ████░░░░░░
  Standalone           64%  ██████░░░░
  inject() only        71%  ███████░░░
  Modern control flow  12%  █░░░░░░░░░

Needs attention
  order-list       deps 11  tpl  214  legacy  8  calls  8
  dashboard-page   deps  9  tpl  187  legacy  6  calls  5
  report-builder   deps  9  tpl  156  legacy  4  calls  3

  --json for full output
```

There is no total, no grade and no score. Each column is a count you can act
on, and `-` means the metric could not be measured — never `0`.

## Supported Angular versions

| Version | Status |
|---|---|
| 20, 21, 22 | Full support |
| 17, 18, 19 | Runs, with a warning |
| 16 and below | Runs, with a loud warning. Results are unreliable |

Nothing is refused outright. A number with a caveat on it is more useful than
an error message, and real codebases lag behind Angular's own support window.

The version is read from the target project's `node_modules/@angular/core`,
falling back to its `package.json`. It is not inferred from ours.

## What it does not do

- **It does not migrate code.** Angular's own schematics do that better. This
  measures how much is left, and catches new legacy code added afterwards.
- **It does not score your codebase.** There is no single number. A score
  invites someone to be asked to raise it, and raising a score is easier than
  fixing anything.
- **It does not use an LLM.** Determinism is the point. An LLM can tell you a
  component is too big; it cannot give you the same number twice.

## Status

| Step | Status |
|---|---|
| 1. Component discovery | Done |
| 2. Version detection + capability matrix | Done |
| 3. Class and decorator rules | Done |
| 4. Template resolution and parsing | Done |
| 5. Template rules | Done |
| 6. Findings on every rule | Done |
| 7. Terminal + `--json` | Done |
| 8. `baseline` and `check` CI gate | Done |

Component rules from the catalogue in `RULES.md` section 2, all emitting
findings with a line and column: `legacy-control-flow`, `constructor-di`,
`decorator-input`, `decorator-output`, `manual-subscribe`, `ngmodule-component`,
`missing-onpush`, `destroy-subject`, `behaviorsubject-state`,
`method-call-in-template`, `loop-without-track`, `loop-tracked-by-index`,
`inner-html-binding`.

Next, in order: **use it on a real repo for two weeks** (`PLAN.md` section 16),
then route rules, service rules, and the MCP server.

Not built: routes, services, the MCP server, and anything cross-file.

## Documentation

| Document | What it is for |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How the code fits together. Read this first |
| [`docs/ADDING-A-RULE.md`](docs/ADDING-A-RULE.md) | A complete worked example, start to finish |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | Every message that is not a result, and what to do |
| [`RULES.md`](RULES.md) | The exact definition of every metric |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Design rules a change must not break |
| [`PLAN.md`](PLAN.md) | What is built, what is next, and why |
| [`PRODUCT.md`](PRODUCT.md) | Why the tool exists and where it is going |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed |

## Development

```bash
npm install     # once
npm run build   # compile packages and tests
npm test        # build, then run the suite
npm run census  # run the CLI from source: npm run census -- analyze ./app
```

The suite runs in about two seconds. If you are about to change a rule, read
[`docs/ADDING-A-RULE.md`](docs/ADDING-A-RULE.md) — it is a walkthrough, not a
reference.

Two scripts help while working on the analyzer:

```bash
node tools/print-template-ast.mjs '<div *ngIf="x">hi</div>'   # see the AST
node tools/why-no-files.mjs /path/to/a/workspace              # debug discovery
```

See `CONTRIBUTING.md` for design rules. The important one: store raw
observations, never conclusions.

## Licence

MIT
