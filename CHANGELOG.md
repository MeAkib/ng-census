# Changelog

Notable changes, newest first. Dates are the day the work landed, not a
release — nothing is published yet.

The format follows [Keep a Changelog](https://keepachangelog.com/). Versions
follow [semantic versioning](https://semver.org/), with one project-specific
rule: **a change to what a metric means is breaking**, even though the code
still compiles. A renamed or redefined metric key makes every stored baseline
incomparable, and a chart that silently changes meaning is worse than one that
breaks.

## [Unreleased]

### Added

- `analyze`, `baseline`, `check` and `repo-map` commands, covering steps 1–8
  of the build plan.
- Component rules: class metrics, decorator flags stored raw, and template
  metrics from Angular's own parser.
- Legacy pattern catalogue for components: `legacy-control-flow`,
  `constructor-di`, `decorator-input`, `decorator-output`, `manual-subscribe`,
  `ngmodule-component`, `missing-onpush`, `destroy-subject`,
  `behaviorsubject-state`, `method-call-in-template`, `loop-without-track`,
  `loop-tracked-by-index`, `inner-html-binding`. Every one emits a finding
  with a line and column.
- `--project <name>` scopes a run to one application from `angular.json`, and
  `ng-census projects` lists the names. Entity ids stay relative to the
  workspace root, so scoped and whole-workspace runs describe the same
  component by the same id.
- `--out <file>` writes the run object to a file. `--json` remains for pipes.
- A baseline records the scope it was taken with, and `check` refuses to
  compare across scopes.
- The run object records `filesScanned`, `filesAnalyzed`,
  `angularMajorSource` and `capabilityMajor`, so a stored run can always be
  interpreted.
- CI across Linux and macOS on Node 22 and 24, plus a dogfooding step that
  runs `check` against a committed fixture baseline.
- `docs/ARCHITECTURE.md`, `docs/ADDING-A-RULE.md`, `docs/TROUBLESHOOTING.md`,
  and `tools/` for exploring template ASTs and debugging file discovery.

### Fixed

- **Discovery returned zero files on macOS with Node 24.** File discovery
  passed glob patterns to the TypeScript wrapper's own file search, which
  returned nothing for every pattern — including a literal absolute path —
  while opening the same path directly worked. A healthy 2485-file workspace
  reported "0 components". Discovery now walks the filesystem directly, skips
  excluded folders during the walk rather than after, and does not follow
  symlinks.
- **The CI gate failed on every newly added component.** New entities were
  checked against every "lower is better" metric, so a component using
  `inject()` once was reported as arriving with legacy debt. New entities are
  now checked against a short list of catalogue patterns.
- **`injectedDeps` and `methodCallsInTemplate` no longer gate the build.** The
  first is a metric an agent games by hiding services behind a facade; the
  second rests on a documented heuristic, and a false positive in CI is a wall
  with no door. Both are still reported.
- **Migrating `*ngIf` to `@if` moved metrics that measure shape.** A desugared
  structural directive added a nesting level and counted its microsyntax as
  bindings, so a migration that changed nothing structural showed templates
  getting flatter. Bindings and method calls on such an element were also
  counted twice, because the AST copies them onto the wrapper node.
- **`*ngSwitchCase` was counted while `@case` was not**, scoring a three-case
  switch as 4 legacy against 1 modern. Branches now emit findings without
  being counted.
- **`@Input()` written as a setter was not counted.** Accessors are walked
  alongside properties now.
- **`classLoc` included the decorator and the whole inline template**, so an
  inline template was counted twice, once as class size and once as template
  size.
- `[innerHtml]` in lowercase is counted; `repo-map --top=N` is respected;
  Angular 17–19 print the best-effort warning the support policy promises; an
  undetected Angular version says which major it assumed.
- The CLI rejects a path that does not exist, and more than one path, instead
  of reporting an empty project.

### Changed

- Support policy: Angular 17, 18 and 19 run with a warning. Nothing is refused
  outright — a number with a caveat is more useful than an error message.
- `classLoc` now measures the class body. Any baseline taken before this is
  not comparable.
