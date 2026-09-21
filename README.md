# ng-census

**Find the old Angular patterns in your codebase, and stop new ones getting in.**

AI coding tools learned Angular mostly from code written before 2023. So they
still write `*ngIf`, constructor injection, `@Input()` and NgModules. Every
pull request looks fine on its own — and six months later the migration you
finished has quietly half-undone itself.

ng-census counts those patterns, shows where they are, and fails CI when new
ones arrive. Same code in, same numbers out: no AI inside, no score.

```bash
npx ng-census analyze
```

```
Angular 20.3.26 · 147 components · 2.1s

  ℹ Angular 20 support ends 2026-11-28.

  OnPush               38%  ████░░░░░░
  Standalone           64%  ██████░░░░
  inject() only        71%  ███████░░░
  Modern control flow  12%  █░░░░░░░░░

Needs attention
  order-list       deps 11  tpl  214  legacy  8  calls  8
  dashboard-page   deps  9  tpl  187  legacy  6  calls  5
```

## Quick start

```bash
npx ng-census report                  # an HTML report you can open and share
npx ng-census report --project admin  # one app from a multi-project workspace
```

Add the gate to CI:

```bash
npx ng-census baseline                # once, then commit .census-baseline.json
npx ng-census check                   # in your pipeline: exit 1 on new legacy code
```

The gate fails when a file gets worse, or when a **new** file arrives with an
old pattern. Adding components, dependencies or code is never a failure.

## What it finds

| Old pattern | Modern form |
|---|---|
| `*ngIf`, `*ngFor`, `[ngSwitch]` | `@if`, `@for`, `@switch` |
| Constructor injection | `inject()` |
| `@Input()`, `@Output()` | `input()`, `output()` |
| `standalone: false` | standalone components |
| Manual `.subscribe()`, `BehaviorSubject` state, `ngOnDestroy` teardown | `async` pipe, `signal()`, `takeUntilDestroyed()` |
| `*ngFor` without `trackBy`, `@for` tracked by `$index` | tracking by identity |
| Empty `ngOnInit() {}` and `constructor() {}` | delete them |
| No `OnPush` and no signals | `OnPush` |

Also: method calls in bindings and `[innerHTML]`. Every finding has a file,
line and column. Exact definitions: [RULES.md](RULES.md).

## Requirements

Node 22+. Angular 20–22 fully supported; 17–19 run with a warning. It brings
its own copy of the Angular compiler, so it never touches your project's.

> **Early release (0.x).** Rules may still change before 1.0. Pin the version
> in CI — `npx ng-census@0.1.0 check` — and read the
> [changelog](CHANGELOG.md) before upgrading.

## Learn more

- [Usage guide](docs/USAGE.md) — every command and option, the CI gate, workspaces, configuration
- [Troubleshooting](docs/TROUBLESHOOTING.md) — "0 components", version warnings, scope errors
- [Rules](RULES.md) — what each number means, exactly
- [Contributing](CONTRIBUTING.md) · [Architecture](docs/ARCHITECTURE.md) · [Adding a rule](docs/ADDING-A-RULE.md)

## Licence

MIT
