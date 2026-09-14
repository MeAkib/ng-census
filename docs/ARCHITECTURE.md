# Architecture

How the code is arranged, and why. Read this before changing anything; it is
shorter than the code.

If you only remember one sentence: **the analyzer produces numbers, the
reporters turn numbers into text, and the two never mix.**

---

## 1. The shape

Two packages.

```
packages/core   the analyzer.  Reads files, returns data. Never prints.
packages/cli    the commands.  Takes data, prints text. Never analyzes.
```

The split is not tidiness. `core` is the engine, and everything else is a
consumer of it: the CLI today, an MCP server for coding agents later, a CI bot
after that, a dashboard after that. Each of those is a new way to *format* the
same data. If formatting logic leaks into `core`, every one of them has to
fork the engine instead.

There is a hard version of this rule: **`core` never writes to stdout.** Not
even a debug `console.log`. An MCP server talks JSON-RPC over stdout, so one
stray line of logging corrupts the protocol and kills the connection. That bug
is famous and very hard to find, so the rule is absolute rather than
case-by-case.

---

## 2. One run, step by step

This is the whole program. Every command follows the same path and differs
only in what it does with the result.

```
  ng-census analyze ./my-app --project billing
            |
            v
  1. bin.ts           read the arguments, decide the command
            |
            v
  2. config.ts        load .ng-censusrc, if there is one
            |
            v
  3. workspace.ts     --project billing  ->  "projects/billing"
            |
            v
  4. version.ts       read the project's Angular version -> 20
            |                and turn it into a capability matrix
            v
  5. analyze.ts       walk the folders, find .ts files
            |
            +--> 6. discover.ts      which classes have @Component?
            |
            +--> 7. rules/class.ts   read the class body
            |
            +--> 8. template.ts      find and parse the template
            |
            +--> 9. rules/template.ts read the template AST
            |
            v
  10. an AnalysisResult:  { run: {...}, entities: [...] }
            |
            v
  11. report/terminal.ts  turn it into the text you see
```

Steps 5 to 9 repeat once per file. Steps 1, 2, 3, 4 happen once.

### What each step is for

**1. `packages/cli/src/bin.ts`** — the only file that reads `process.argv` or
writes to stdout. Every command lives here as one `case` in a switch.

**2. `packages/core/src/config.ts`** — optional per-project settings. It can
change *what is looked at* and nothing else. There is deliberately no way to
switch a rule off: a baseline recorded with a rule disabled is not comparable
to one recorded with it enabled, and nothing in the file would tell you which
one you were reading.

**3. `packages/core/src/workspace.ts`** — reads `angular.json` so `--project
billing` can become the folder `projects/billing`. It never runs the Angular
CLI.

**4. `packages/core/src/version.ts`** — reads the Angular version from the
*target project*, never from our own dependencies, and converts the major into
a `Capabilities` object: can this version have `@if` blocks? signal inputs?
Signal Forms? Rules ask the capability matrix, never the version number
directly.

**5. `packages/core/src/analyze.ts`** — the conductor. Walks the folder tree,
reads each file, and calls the other pieces in order. It also builds the `run`
object that says what the numbers mean: which Angular version, which scope,
how many files were read.

**6. `packages/core/src/discover.ts`** — finds `@Component` classes and reads
the decorator. It records what it *sees* (`standalone: false`, `absent`,
`OnPush`), never what it means.

**7. `packages/core/src/rules/class.ts`** — everything measurable in the class
body: injected dependencies, inputs, outputs, subscribes, class size.

**8. `packages/core/src/template.ts`** — finds the template (inline or a
`.html` file) and parses it with Angular's own parser. Also holds `LineIndex`,
which turns a character position into a line and column.

**9. `packages/core/src/rules/template.ts`** — walks the parsed template and
counts what is in it: `*ngIf` versus `@if`, bindings, nesting depth,
`[innerHTML]`.

**10. `packages/core/src/types.ts`** — the output contract. If you are trying
to understand the data, start here, not at the code that produces it.

**11. `packages/cli/src/report/`** — three reporters over the same data:
`terminal.ts` for humans, `repo-map.ts` for coding agents, `drift.ts` for CI.
All interpretation of raw flags happens here, at read time.

---

## 3. The four invariants

These cannot be added later. Breaking one corrupts stored history in a way no
migration can repair, because the information needed to repair it was never
written down.

### I1 — Store what you saw, not what you concluded

```ts
{ standaloneFlag: 'absent', angularMajor: 22 }   // yes
{ isStandalone: false }                          // no
```

Here is why it matters. From Angular 19, standalone became the default, so
`standalone: true` is normally *absent* from a modern component's decorator.
Read "absent" as "not standalone" and every up-to-date codebase reports 0%
standalone.

The interpretation lives in `report/terminal.ts` (`isStandalone`). If it turns
out to be wrong, you fix one function and all past runs become correct. Had
the conclusion been stored, every old run would be wrong forever.

This applies to the tool's own guesses too. When the Angular version cannot be
detected, `analyze.ts` assumes the newest supported major — and records
`angularMajorSource: "assumed"` and `capabilityMajor` so the assumption is
visible in the stored run, not only in the terminal.

### I2 — `null` is not `0`

`null` means "this could not exist here". `0` means "we looked and found
none".

An Angular 16 project cannot have `@defer` blocks, so `deferBlocks` is `null`,
not `0`. Reporting `0` would show the project failing at something it could
not attempt. A component whose template could not be read gets `null` for
every template metric — reporting `0` would quietly improve the numbers of
every component whose file we failed to open.

Charts must skip `null`. The drift comparison skips any metric that is `null`
on either side.

### I3 — `core` never imports from a reporter

See section 1.

### I4 — Entities are generic

```ts
{ entities: [ { kind: 'component', ... } ] }   // yes
{ components: [ ... ] }                        // no
```

Routes and services arrive in later versions. With a `kind` field they cost no
migration; with a `components` key at the top level, every stored run would
have to be rewritten.

---

## 4. Findings and counts

Every rule emits a `Finding` — a rule id, a file, a line, a column. Counts are
derived by filtering findings:

```ts
metrics.legacyControlFlow = findings.filter(f => f.rule === 'legacy-control-flow').length;
```

One walk, three audiences:

- **counts** feed trends and the CI gate
- **findings** feed agents, editors and PR comments
- both come from the same pass, so they can never disagree

---

## 5. Two decisions that look odd until explained

### Discovery walks the filesystem by hand

`analyze.ts` has its own `collectSourceFiles()` instead of using a glob
library.

The first version passed glob patterns to the TypeScript wrapper's own file
search. On macOS with Node 24 that search returned **zero files for every
pattern**, including a literal absolute path with no wildcards, while opening
the same path directly worked. The tool reported "0 components" for a healthy
2485-file workspace.

File discovery is the one step where an empty result looks exactly like a
correct answer, so it must not depend on a component whose behaviour varies by
platform. Walking by hand also lets excluded folders be skipped *during* the
walk — the glob had to enumerate all of `node_modules` before discarding it.

### The template AST is walked as untyped objects

`rules/template.ts` treats nodes as `Record<string, unknown>` and switches on
`node.constructor.name` rather than using Angular's visitor.

A visitor calls a method per known node type. When Angular adds a new one, a
visitor silently ignores it and the count comes out slightly low — and a
plausible-looking wrong number is the worst failure this tool can have,
because nobody investigates it. The hand-written walk has a `default` branch
that records the unknown type in `run.unknownNodeTypes`, so the undercount
becomes a visible warning instead.

---

## 6. Where to look when you are lost

| Question | File |
|---|---|
| What does the output look like? | `packages/core/src/types.ts` |
| What does each metric mean, exactly? | `RULES.md` |
| How is a component found? | `packages/core/src/discover.ts` |
| Where do I add a class metric? | `packages/core/src/rules/class.ts` |
| Where do I add a template metric? | `packages/core/src/rules/template.ts` |
| Why does the CI gate fail on this? | `packages/core/src/baseline.ts` |
| What does the terminal print? | `packages/cli/src/report/terminal.ts` |
| How do I add a whole rule? | `docs/ADDING-A-RULE.md` |
| It found no components | `docs/TROUBLESHOOTING.md` |

## 7. Tools for exploring

```bash
node tools/print-template-ast.mjs '<div *ngIf="x">hi</div>'
node tools/why-no-files.mjs /path/to/some/workspace
```

The first prints the template AST, which is what you need before writing a
template rule. The second explains why a project produced no files. See
`tools/README.md`.
