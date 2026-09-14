# Angular Static Analysis Tool — Master Plan

**Status:** v3 (consolidated)
**Date:** 2026-09-13
**Working name:** `ng-census` (see Naming, section 10)

Companion documents:
- `RULES.md` — full rule catalog for components, routes, services
- `PRODUCT.md` — AI-era rationale, MCP server design, OSS/paid split

---

## 1. What this tool is

A static analysis CLI for Angular codebases. It reads TypeScript classes and
Angular templates, counts specific measurable facts, and reports them as
numbers and source locations.

**It is deterministic.** Same input always produces same output. No LLM inside.
This is the entire value proposition — see `PRODUCT.md` section 1.

### What it is not

- Not a runtime health check
- Not a linter replacement (ESLint is per-file; this is project-wide)
- Not a code fixer (Angular schematics do migrations better)
- Not a scoring system (see invariant I2)

---

## 2. Scope for v1

**One entity at a time.** The tool reads a component's `.ts` file and its
template. Nothing else.

**Hard rule:** if a rule needs to open a second file, it is not v1.

This single constraint removes dependency graphs, DI resolution, and NgModule
scope analysis — where most of the difficulty in Angular tooling lives.

### Expansion tiers (see section 8)

| Tier | Needs | Cost | Contains |
|---|---|---|---|
| 1 | Same architecture as v1 | Small | Components, routes, services |
| 2 | One declaration-collecting pass | Medium | Symbol table cross-checks |
| 3 | Full reference resolution | Large | Dead code, cycles, layer rules |

Tiers 1 and 2 deliver most of the value. Tier 3 can wait a long time.

---

## 3. Technical stack

| Decision | Choice | Reason |
|---|---|---|
| TS parsing | `ts-morph` | Simpler API over TypeScript compiler |
| Template parsing | `parseTemplate()` from `@angular/compiler` | Real Angular AST, not regex |
| Bundled compiler | `@angular/compiler` ^22 | New parser reads old syntax fine |
| MCP | `@modelcontextprotocol/sdk` | Official SDK |
| Output | JSON, DB-shaped from day one | Dashboard later costs nothing |

### Angular version support

Verified against `angular.dev/reference/releases` on 2026-09-13:

| Version | Status | Released | LTS ends |
|---|---|---|---|
| v22 | Active | 2026-06-03 | 2028-06 |
| v21 | LTS | 2025-11-19 | 2027-06 |
| v20 | LTS | 2025-05-28 | 2026-11-28 |

v2–v19 are no longer supported by Angular.

**Our support policy:**

```
Full support:  Angular 20, 21, 22
Best effort:   Angular 17, 18, 19  (warn, but run)
Refused:       Angular 16 and below (warn loudly, still run)
```

Support v17–v19 anyway even though Angular does not — real codebases lag, and a
tool that refuses to run is a tool nobody tries. That argument covers v17 as
well, which is why `MIN_SUPPORTED` is 17 and not 18.

Nothing is ever hard-refused. Below `MIN_SUPPORTED` the run still completes and
prints a loud warning, because a number with a caveat is more useful than an
error message. The support level is one function, `supportLevel()`, and the
reporter switches on it rather than re-deriving the policy — an earlier version
re-derived it and printed nothing at all for majors 17 to 19, the exact range
the policy promises a warning for.

**Release cadence note:** from v22 onward Angular moved to a 12-month major
cycle (previously 6 months), with 4–6 minors each. v23 is expected around
June 2027. This means the capability matrix needs updating roughly once a year.

### Why bundle the newest compiler

The template parser is backwards compatible. A v22 parser reads v17 templates
fine. Failure only goes the other way — an old parser cannot read syntax
invented after it. So bundling v22 covers every supported version.

Project-local compiler loading is optional, deferred until v23 ships syntax we
have not caught up with.

---

## 4. Invariants

These four cannot be retrofitted. Get them right before storing any data.

### I1 — Store raw observations, not conclusions

```json
// YES
{ "standaloneFlag": "absent", "angularMajor": 22 }

// NO
{ "isStandalone": false }
```

If the interpretation rule turns out wrong, fix one function and all history
becomes correct. If the conclusion was stored, old data stays wrong forever.

**The v19 boundary is the proof case.** From v19, standalone is the default, so
`standalone: true` is usually *absent* from decorators on v20/21/22. Counting
`standalone: true` reports 0% standalone on every modern codebase.

### I2 — `null` is not `0`

A v17 project has no Signal Forms. Report `null`. Reporting `0` makes the
dashboard show a failing score for something that was impossible.

Charts must skip `null`, never plot it as zero.

### I3 — `core` never imports from `report`

The analyzer returns data. Reporters format it. This is what makes the CLI,
the MCP server, the CI gate, and the future dashboard all free additions.

### I4 — Entity shape is generic from day one

```json
{
  "entities": [
    { "kind": "component", "id": "...", "metrics": {}, "findings": [] },
    { "kind": "route",     "id": "...", "metrics": {}, "findings": [] },
    { "kind": "service",   "id": "...", "metrics": {}, "findings": [] }
  ]
}
```

Not a top-level `components` key. Adding routes and services later then costs
no migration. Dashboard queries filter by `kind`, which is clean SQL.

Metrics shapes stay **separate per kind**, reusing common keys only where they
genuinely mean the same thing (`injectedDeps`, `classLoc`). Do not force a
route into a component-shaped object.

---

## 5. Findings, not just counts

Every rule emits a `Finding` with a source location. Counts derive from findings.

```ts
interface Finding {
  rule: string;      // "legacy-control-flow"
  file: string;
  line: number;
  col: number;
  detail?: string;   // "*ngIf"
}

metrics.legacyControlFlow =
  findings.filter(f => f.rule === 'legacy-control-flow').length;
```

Cheap to add — both parsers already carry positions. Template AST nodes have
`sourceSpan.start` with `offset`/`line`/`col`; `ts-morph` nodes have
`getStart()` and `getStartLineNumber()`.

One walk, three consumers:

- **Counts** feed trends and the dashboard
- **Findings** feed agents, editors, and PR comments
- **Both** come from a single pass

---

## 6. Output shape

```json
{
  "run": {
    "id": "uuid",
    "commit": "a1b2c3d",
    "branch": "main",
    "timestamp": "2026-09-13T10:00:00Z",
    "toolVersion": "0.1.0",
    "angularVersion": "22.1.5",
    "angularMajor": 22,
    "compilerSource": "bundled",
    "unknownNodeTypes": [],
    "dynamicRoutes": 0
  },
  "entities": [
    {
      "kind": "component",
      "id": "src/app/orders/order-list.component.ts::OrderListComponent",
      "filePath": "src/app/orders/order-list.component.ts",
      "className": "OrderListComponent",
      "selector": "app-order-list",
      "templateResolved": true,
      "metrics": {
        "injectedDeps": 11,
        "inputs": 4,
        "outputs": 2,
        "subscribeCalls": 3,
        "signalApiCalls": 0,
        "publicMethods": 14,
        "classLoc": 268,
        "changeDetectionFlag": "absent",
        "standaloneFlag": "absent",
        "templateKind": "external",
        "templateLoc": 214,
        "templateMaxDepth": 7,
        "bindingCount": 63,
        "methodCallsInTemplate": 8,
        "asyncPipes": 0,
        "legacyControlFlow": 8,
        "modernControlFlow": 0,
        "deferBlocks": 0,
        "loopsWithoutTrack": 2,
        "innerHtmlBindings": 0
      },
      "findings": [
        { "rule": "legacy-control-flow", "file": "...html", "line": 14, "col": 5, "detail": "*ngIf" }
      ]
    }
  ]
}
```

**`id` is the join key across runs.** Repo-relative path + class name. Keep it a
separate stored field, never derived implicitly at query time — that is what
allows rename detection to be added later without touching stored data.

File renames break the trend line for that entity. Accepted in v1.

---

## 7. Project structure

```
packages/
  core/                      # OSS — no I/O, no formatting
    src/
      discover.ts            # find @Component / @Injectable / route arrays
      version.ts             # detect version + capability matrix
      rules/
        class.ts
        decorator.ts
        template.ts
        route.ts             # v1.1
        service.ts           # v1.2
        index.ts             # runs all, returns Entity[]
      types.ts
  cli/                       # OSS
    src/
      commands/analyze.ts
      commands/baseline.ts
      commands/check.ts
      commands/repo-map.ts
      report/terminal.ts
      report/json.ts
  mcp/                       # OSS
    src/server.ts
fixtures/
  <case-name>/
    component.ts
    component.html
    project.json             # optional: { "angularMajor": 19 }
    expected.json
tests/
  fixtures.spec.ts
  integration.spec.ts
```

---

## 8. Build order

Each step ends with a working tool. Never leave a broken half-step overnight.

### v1 — Components

| Step | Work | Done when |
|---|---|---|
| 1 | Walking skeleton: find `@Component`, print count | Runs on a real repo |
| 2 | Version detection + capability matrix | Prints correct Angular version |
| 3 | Class + decorator rules | Metrics have real numbers |
| 4 | Template resolve + parse + unknown-node counter | Templates load, no crash |
| 5 | Template rules | All counters filled |
| 6 | **`Finding` with line/col on every rule** | Findings array populated |
| 7 | Terminal report + `--json` | Output matches section 6 |
| 8 | `baseline` + `check` commands | CI gate works, exits 1 on regression |

**Step 2 comes before rules, not after** — rules depend on the capability matrix.

**Step 8 is where the tool becomes genuinely useful** rather than merely
interesting. Get there before anything else.

### v1.1+ — Expansion

| Version | Work | Tier |
|---|---|---|
| v1.1 | Route rules | 1 |
| v1.2 | Service rules | 1 |
| v1.3 | `repo-map` command | — |
| v1.4 | MCP server | — |
| v1.5 | Symbol table cross-checks | 2 |
| v2 | Full graph, dead code, cycles | 3 |

**Routes before services** — the findings are more concrete. "This route is
eagerly loaded" is something a developer acts on immediately. "This service uses
constructor DI" is a style point.

### Protecting the fast path

Graph analysis (tier 3) will break the 10-second budget on large repos. Split
the commands when it arrives:

```
analyze          fast, single-file rules only   (default)
analyze --deep   includes graph rules
```

The CI gate and MCP server use the fast path. Nobody waits.

Design tier 3 as two passes to preserve incremental caching:

```
Pass 1 (per file, cacheable):  extract declarations + references
Pass 2 (in memory, fast):      resolve references against the table
```

Merging the passes would make every MCP call re-analyze the whole project,
making the agent loop too slow to use.

---

## 9. Commands

| Command | Purpose |
|---|---|
| `analyze` | Terminal summary |
| `analyze --json` | Full run object to stdout |
| `baseline > .census-baseline.json` | Snapshot current state |
| `check --baseline <file>` | Compare, report regressions, exit 1 |
| `repo-map` | Compact one-line-per-entity output for agents |

### Flags

| Flag | Purpose |
|---|---|
| `--top N` | Rows in "needs attention" |
| `--filter <path>` | Scope to one folder |
| `--json` | Machine output |
| `--strict` | Exit non-zero on unknown template nodes |
| `--hash-paths` | Replace paths with stable hashes (privacy) |

### Terminal output target

```
Angular 22.1.5 · 147 components · 2.1s

  OnPush              38%  ████░░░░░░
  Standalone          64%  ██████░░░░
  Modern control flow 12%  █░░░░░░░░░

Needs attention
  order-list           deps 11  tpl 214  calls 8
  dashboard-page       deps  9  tpl 187  calls 5
  report-builder       deps  9  tpl 156  calls 3

  --json for full output
```

Three summary percentages plus worst offenders. Everything else behind `--json`.

### Drift check output

```
✗ order-list        legacy control flow  0 → 4
✗ user-profile      injected deps        3 → 8
✓ 145 components unchanged or improved

2 regressions. Exit 1.
```

Regressions only. This is what catches AI-generated legacy code — a human
reviewer will not notice a generated component used `*ngIf`.

---

## 10. Naming

Current working name `ng-census`. Two concerns with the original `ng-health`:

1. **"health" is crowded** — in the Node ecosystem it means runtime health
   check endpoints or dependency security scores. Neither is this tool.
2. **"health" promises a score** — which invariant I2 and the anti-gaming rules
   deliberately avoid. The name would create an expectation the design refuses.

"Census" describes counting a population and recording facts about each member,
with no judgment implied.

**Before publishing:**

- `npm view ng-census` to confirm availability
- Buy the domain (~$10) before announcing anything
- Consider `ngx-` prefix if worried about looking semi-official
- For any commercial phase, the `ng-` prefix carries trademark risk — Google
  tolerates it for free OSS, a paid product is a different situation.
  Not legal advice; worth a real check.

---

## 11. Testing

### Fixtures (main strategy)

One folder per case. Table-driven test walks the directory, runs the analyzer,
deep-equals `expected.json`.

Starting ten cases:

1. Minimal component, all zero
2. Inline template
3. External template
4. `changeDetection: OnPush` explicit
5. `standalone` absent, project on v22
6. `standalone` absent, project on v18
7. Constructor DI only
8. `inject()` only
9. Both DI styles mixed
10. Nested loops without track

**Cases 5 and 6 are the critical pair.** Same source, different version,
different expected output. If both pass, version handling works.

### Integration test

Run against one real open-source Angular repo. Assert only three things:

- It finishes
- Entity count > 0
- `unknownNodeTypes` is empty

This catches parser crashes on real-world syntax, which is the failure that
will actually happen.

### Do not test

Terminal output formatting. It will change constantly. Test the JSON.

---

## 12. Definition of done — v1

- [x] Runs on a real repo without crashing — verified on Angular Components
- [x] Under 10s for ~150 components — 753 components in 2.2s
- [x] All fixtures pass, including the version pair — 46 tests
- [x] `--json` matches the documented shape
- [x] Every rule emits findings with line/col
- [x] `check` exits 1 on regression
- [x] `angularVersion` and `compilerSource` recorded in run object
- [x] Unsupported metrics are `null`, not `0`
- [~] No rule reads a second file — **amended.** A component's own template is
      read. That is the component, not a reference to another entity: nothing
      follows an import or resolves a selector, so analysis stays parallelisable
      and cacheable by mtime. The constraint the rule was protecting holds; its
      wording did not survive contact with step 4. See `RULES.md`,
      "Template resolution".
- [x] `entities` array with `kind`, not a `components` key

### Learned while building

Three things the plan did not anticipate, each found by running on a real repo:

1. **Build output must be excluded by default.** A compiled library re-emits
   every component under `dist/`, so the first real run counted the codebase
   exactly twice. Now skipped by default, along with `out-tsc`, `.angular`,
   `coverage`, `.nx`, and `bazel-out`.

2. **`repo-map` needs a default cap.** The full map for 1522 entities was 314KB
   — enough to evict whatever the agent was reading. Capped at 200 rows, ranked
   by legacy weight so a truncated map still names the right files.

3. **A new entity cannot regress, but it is still drift.** The baseline diff in
   section 9 only compares entities present in both runs, so a freshly generated
   component full of `*ngIf` would pass the gate for being new. `check` reports
   new-entity debt as its own category.

---

## 13. Risks

| Risk | Handling |
|---|---|
| tsconfig path aliases in monorepos | Test on a monorepo early, not at the end |
| Component with missing template | `templateResolved: false`, metrics `null`, do not crash |
| `ts-morph` TypeScript older than project needs | Check TS range at `angular.dev/reference/versions`, pin accordingly |
| New Angular syntax after v23 (~June 2027) | Unknown-node counter warns; annual matrix update |
| Signal read vs method call in template | Documented heuristic, imperfect in v1 (see `RULES.md`) |
| Routes built dynamically at runtime | Report `dynamicRoutes` count so partial coverage is visible |

---

## 14. Annual maintenance (~1 hour)

When a new Angular major ships:

1. Add version to the capability matrix
2. **Check whether any default flipped** — highest risk item, this is what
   broke standalone counting at v19
3. Run on a sample project, inspect `unknownNodeTypes`
4. Add detection for new APIs worth tracking
5. Add a fixture folder for the version

With the 12-month cadence, this is once a year.

---

## 15. Items to verify before coding

Flagged because my knowledge is partial or may be outdated:

| Item | Where to check |
|---|---|
| Class-based guard deprecation/removal version | Angular deprecation guide |
| Exact Signal Forms API names (v22) | `angular.dev` API reference |
| Current official schematic command names | `angular.dev/reference/migrations` |
| `@modelcontextprotocol/sdk` current major + API shape | SDK docs |
| Required TypeScript range for v22 | `angular.dev/reference/versions` |
| `ts-morph` version bundling a compatible TS | npm |

---

## 16. First action

Build steps 1–8. Then **stop and use it yourself on a real Angular repo for two
weeks** before building anything else.

You will learn which rules actually matter and which are noise. That
information changes the MCP design, the dashboard design, and what you charge
for — and it cannot be obtained any other way.
