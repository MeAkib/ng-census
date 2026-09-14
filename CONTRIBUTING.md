# Contributing

Thanks for your interest in ng-census.

## New here? Read these three things

1. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the code fits
   together. Ten minutes, and it will save you an afternoon.
2. The design rules below. They are not style preferences; breaking one
   corrupts stored history in a way no migration can repair.
3. [`docs/ADDING-A-RULE.md`](docs/ADDING-A-RULE.md) when you are ready to
   write something — a complete worked example rather than a reference.

Getting set up:

```bash
npm install
npm test
```

If the tests pass, you have everything you need. There is no database, no
service to run and no API key.

## Contributor Licence Agreement

**Before your first pull request can be merged, you need to sign the CLA.**

By submitting a contribution you agree that:

1. You wrote the contribution yourself, or have the right to submit it.
2. You grant the project maintainers a perpetual, worldwide, non-exclusive,
   royalty-free licence to use, modify, sublicense, and distribute your
   contribution, including as part of a commercial offering.
3. You retain copyright of your contribution.

This is standard practice for projects with both an open-source core and a
commercial component. It exists so the licence can be adjusted later without
tracking down every past contributor. Nx and NestJS both do the same thing.

If you are contributing on behalf of an employer, make sure you have their
permission.

> **Note:** this text has not yet been reviewed by a lawyer. Get it reviewed
> before the repository becomes public.

## Before you open a pull request

### Run the tests

```bash
npm test
```

All tests must pass. The suite is fast — under two seconds.

CI runs them on Linux and macOS, on Node 22 and Node 24. That matrix is not
padding: file discovery once returned zero files on macOS with Node 24 while
every test passed on Linux, and the tool reported "0 components" for a healthy
2485-file workspace. A suite that only ever runs on one platform proves less
than it looks like it does.

### The version pair test is not optional

`tests/analyzer.test.ts` contains a suite called "the version pair". It
analyzes the *same source file* under Angular 18 and Angular 22 and asserts
that the raw flag is identical while the recorded major differs.

If you change anything in `discover.ts` or `version.ts`, that suite is the one
that catches the mistake. Do not weaken it to make a change pass.

## Design rules

These are not style preferences. Breaking them causes data corruption that
cannot be repaired after the fact.

### Store raw observations, not conclusions

```ts
// yes
{ standaloneFlag: 'absent', angularMajor: 22 }

// no
{ isStandalone: false }
```

If the interpretation rule turns out to be wrong, a raw observation can be
reinterpreted. A stored conclusion is wrong forever.

### `null` is not `0`

A metric that cannot exist on the project's Angular version reports `null`.
`0` means "we measured and found none". Confusing the two makes charts show
failures for things that were never possible.

### `core` never imports from a reporter

The analyzer returns data. The CLI formats it. This separation is what lets
the same engine back the CLI, the CI gate, and the MCP server.

If you find yourself wanting to `console.log` inside `core`, that is the rule
telling you the code belongs in a reporter.

### No rule opens a second file

Single-file analysis is what keeps the tool parallelizable and cacheable by
mtime. Cross-file rules are planned, but they go in a separate pass with its
own architecture. See `PLAN.md` section 8.

### No LLM inside the tool

Determinism is the product. Non-deterministic output makes trend lines
meaningless and the CI gate unusable.

### A metric may only gate CI if it passes three tests

The comparison in `baseline.ts` decides whose build fails. A metric belongs in
`GUARDED_METRICS` only if all three are true:

1. **Exact.** No heuristic. Someone who sees the failure must be able to fix
   it. A false positive in a build gate is a wall with no door.
2. **Not a target.** An agent told to lower the number must not be able to
   make the code worse while doing so. This is why `injectedDeps` is reported
   but never gated: the easy way to reduce it is to hide nine services behind
   one facade.
3. **Only moves when someone makes it worse.** A component legitimately grows,
   and deleting a dead `@if` block legitimately lowers the modern control flow
   count.

If in doubt, leave it out. A metric that reports is useful. A metric that
fails builds it should not fail gets the whole tool deleted.

## Adding a rule

[`docs/ADDING-A-RULE.md`](docs/ADDING-A-RULE.md) walks through a real one
end to end, with the checklist at the bottom.

The short version:

1. Write the exact definition in `RULES.md` **before** any code
2. Add the metric to the relevant interface in `types.ts`, as `number | null`
3. Implement it in `rules/`, emitting a `Finding` with line and column
4. Gate it in `version.ts` if it depends on an Angular version
5. Add a fixture containing both what it matches and what it must not
6. Add a test asserting the exact count, never `> 0`
7. Decide deliberately whether it gates CI

If two people could reasonably disagree about what the number should be, the
definition is not finished.

## What not to add

**Per-developer attribution.** No "complexity by author". The moment that view
exists, the tool becomes surveillance, engineers stop trusting it, and a useful
diagnostic turns into a political weapon.

**A composite quality score.** Someone will be asked to raise it, and raising a
score is always easier than fixing anything.
