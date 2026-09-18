# Adding a rule

A complete worked example, start to finish. Follow it once and the next rule
takes ten minutes.

We will add **`legacy-ngclass`**: counting `[ngClass]` and `[ngStyle]`, which
modern Angular writes as `[class]` and `[style]`. It is a real gap in the
catalogue, it is small, and it touches every part of the system.

Before you start, read the five design rules in `CONTRIBUTING.md`. They are
short, and two of them are easy to break by accident.

---

## Step 0 — Write the definition first

Not the code. The definition.

> `legacyNgClass` counts `[ngClass]` and `[ngStyle]` bindings in a template.
> Each binding counts once. The static forms `class="a b"` and `style="..."`
> are not counted — they are not legacy, they are just HTML.

If two people could reasonably disagree about what the number should be, you
are not ready to write the code. This is the step people skip, and it is the
one that costs a week later when the number turns out to mean two things.

Put the definition in `RULES.md` now, in section 1.3.

---

## Step 1 — Look at the AST

You cannot write a template rule without seeing what the parser produces.

```bash
node tools/print-template-ast.mjs '<div [ngClass]="c" [style.color]="x">hi</div>'
```

```
Element
  inputs=[BoundAttribute:ngClass, BoundAttribute:style.color]
  Text
```

Now you know exactly what to match: a `BoundAttribute` whose `name` is
`ngClass` or `ngStyle`, found in an element's `inputs`.

---

## Step 2 — Add the metric to the contract

`packages/core/src/types.ts`, in `ComponentMetrics`:

```ts
  legacyControlFlow: number | null;
  legacyNgClass: number | null;      // <- new
  modernControlFlow: number | null;
```

Type it `number | null`, always. `null` is how the output says "this could not
be measured here" — a template that failed to parse, or an Angular version too
old for the feature. See invariant I2 in `docs/ARCHITECTURE.md`.

Adding a field is free. Old runs simply have no value for it, and a chart
skips them. You never have to migrate stored data to add a metric.

---

## Step 3 — Does it need a version gate?

Ask: could this metric exist on every Angular version the tool supports?

`[ngClass]` has existed since Angular 2, so the answer is yes, and there is
nothing to gate. Skip to step 4.

If the answer had been no — say the rule counted `@defer` blocks, which need
v17 — you would add a flag to `capabilities()` in `version.ts` and return
`null` below that version:

```ts
deferBlocks: caps.deferBlocks ? counts.deferBlocks : null,
```

Returning `0` instead would report the project as failing at something it
could not attempt.

---

## Step 4 — Implement it

`packages/core/src/rules/template.ts`.

First, the thing being matched, near the other constants at the top:

```ts
/**
 * Legacy class and style directives.
 *
 * `[class]` and `[style]` do the same job natively and are what modern
 * Angular writes. Both are single bindings, so each counts once.
 */
const LEGACY_CLASS_BINDINGS = new Set(['ngClass', 'ngStyle']);
```

Add a counter to the `counts` object:

```ts
  const counts = {
    elementCount: 0,
    legacyNgClass: 0,        // <- new
    ...
  };
```

Then the rule itself. `countLegacyElementBinding` already walks an element's
inputs, so this goes next to it:

```ts
  function countLegacyClassBinding(node: Record<string, unknown>): void {
    const inputs = (node['inputs'] as Record<string, unknown>[] | undefined) ?? [];

    for (const input of inputs) {
      const name = String(input['name']);
      if (!LEGACY_CLASS_BINDINGS.has(name)) continue;

      counts.legacyNgClass += 1;
      findings.push({
        rule: 'legacy-ngclass',
        ...atSpan(input['sourceSpan'] as { start: { line: number; col: number } }),
        detail: `[${name}]`,
      });
    }
  }
```

Two things to copy exactly:

- **Every rule emits a `Finding` with a line and a column.** A count tells
  someone there is a problem; a finding tells them where it is. Agents and
  editors use findings, and the counts are derived from them.
- **`atSpan` converts the template position into a file position.** For an
  inline template that means a line in the `.ts` file, not line 1 of a string
  nobody can navigate to.

Call it from the `Element` case in `walk`:

```ts
        case 'Element': {
          counts.elementCount += 1;
          maxDepth = Math.max(maxDepth, depth);
          walkBindings(node);
          countLegacyElementBinding(node);
          countLegacyClassBinding(node);      // <- new
          walk((node['children'] as unknown[]) ?? [], depth + 1);
          break;
        }
```

And return it at the bottom, plus in `TemplateRuleResult`:

```ts
    legacyNgClass: counts.legacyNgClass,
```

---

## Step 5 — Wire it through the analyzer

`packages/core/src/analyze.ts`. Three places, all mechanical — TypeScript will
name each one if you miss it:

1. `UNMEASURED_TEMPLATE` — add `legacyNgClass: null`. This is what an
   unreadable template reports.
2. `TemplateMetricSlice` — add `'legacyNgClass'` to the list of keys.
3. `buildComponentEntity` and `readTemplate` — copy the value across.

If you forget number 1, a component with a missing template reports `undefined`
instead of `null`, and the difference will not show up until it reaches a
database.

---

## Step 6 — Add a fixture

Fixtures are small Angular projects under `fixtures/`. Use `v22-rules` for a
new component rule.

Create a new file, `fixtures/v22-rules/src/app/ng-class.component.ts`:

```ts
import { Component } from '@angular/core';

@Component({
  selector: 'app-ng-class',
  template: `
    <div [ngClass]="classes" [ngStyle]="styles">two legacy bindings</div>
    <div [class]="classes" [style.color]="colour">two modern ones</div>
  `,
})
export class NgClassComponent {
  classes = 'a b';
  styles = { color: 'red' };
  colour = 'red';
}
```

Put both forms in it. A fixture that only contains what the rule matches
cannot catch a rule that matches too much.

---

## Step 7 — Assert the exact number

`tests/analyzer.test.ts`:

```ts
  test('counts ngClass and ngStyle, but not their modern replacements', async () => {
    const { entities } = await analyzeProject({ projectRoot: RULES });
    const m = metricsOf(entities, 'NgClassComponent');

    // [ngClass] and [ngStyle]. [class] and [style.color] are not legacy.
    assert.equal(m.legacyNgClass, 2);
  });
```

Assert an exact number, never `> 0`. `> 0` passes when the rule counts twice
as much as it should, which is the bug you are most likely to write.

Then:

```bash
npm test
```

---

## Step 8 — Decide whether it gates CI

Open `packages/core/src/baseline.ts` and read the comment above
`GUARDED_METRICS`. A metric may fail someone's build only if it passes three
tests:

1. **Exact.** No heuristic. A developer who sees the failure must be able to
   fix it.
2. **Not a target.** An agent told to lower the number must not be able to
   make the code worse while doing so.
3. **Only moves when someone makes it worse.** A component legitimately grows;
   growth is not a regression.

`legacyNgClass` passes all three, so add it:

```ts
export const GUARDED_METRICS: Readonly<Record<string, Direction>> = {
  legacyControlFlow: 'lower-is-better',
  legacyNgClass: 'lower-is-better',      // <- new
  ...
};
```

Also add a label in `METRIC_LABELS` so CI output reads `legacy ngClass` rather
than `legacyNgClass`, and consider `DEBT_METRICS` — the shorter list applied
to files that did not exist at the last baseline.

**If in doubt, leave it out.** A metric that reports is useful. A metric that
fails builds it should not fail is deleted by the team within a week, along
with the rest of the tool.

---

## Step 9 — Put it in the report

A rule nobody sees is a rule nobody acts on. Findings appear in the HTML report
automatically — they are grouped by rule id with no configuration. The
**migration table** is the curated part, and it needs a row:

`packages/cli/src/report/html.ts`, in `BURNDOWN_RULES`:

```ts
  { rule: 'legacy-ngclass', label: 'ngClass / ngStyle', modern: '[class] / [style]' },
```

`label` is what a reader sees, `modern` is what they should write instead. Both
are prose, not code identifiers — this table is the one part of the output
aimed at someone who has not read `RULES.md`.

Leave it out if the rule is not part of a migration. Rows with a count of zero
are dropped automatically, so an empty rule costs nothing.

## Step 10 — Finish the documentation

- `RULES.md` — the exact definition from step 0, in the rule table
- `RULES.md` section 2 — add it to the legacy catalogue with its modern form
- `README.md` — add the rule id to the list of component rules

A rule with no written definition is a number two people will read
differently.

---

## The checklist

```
[ ] Definition written in RULES.md, before any code
[ ] Metric added to types.ts as `number | null`
[ ] Version-gated in version.ts, if the feature has a minimum version
[ ] Implemented, emitting a Finding with line and column
[ ] Added to UNMEASURED_TEMPLATE, so an unreadable template reports null
[ ] Fixture containing both what it matches and what it must not
[ ] Test asserting an exact number
[ ] Decided, deliberately, whether it gates CI
[ ] Added to BURNDOWN_RULES in html.ts, if it is part of a migration
[ ] README and RULES.md updated
[ ] npm test passes
```

---

## Adding a class rule instead

Same shape, different file: `packages/core/src/rules/class.ts` walks the
TypeScript class with `ts-morph` instead of the template AST.

The one trap: `classDecl.getProperties()` returns properties only. Accessors
are separate — `getGetAccessors()` and `getSetAccessors()` — and forgetting
them is how `@Input() set value(v) {}` went uncounted for a while. If your rule
reads class members, walk all three.
