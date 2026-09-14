# Rule Catalog

Companion to `PLAN.md`. Every rule needs an exact definition, or tests cannot be
written and two people will disagree about the number.

Every rule emits a `Finding` with `file`, `line`, `col`. Counts are derived.

---

## 1. Component rules (v1)

### 1.1 Class rules

| id | Counts | Detection |
|---|---|---|
| `injectedDeps` | Constructor params + `inject()` calls | Sum both |
| `inputs` | `@Input()` + `input()` + `input.required()` + `model()` | Sum. See accessors below |
| `outputs` | `@Output()` + `output()` | Sum |
| `subscribeCalls` | `.subscribe(` occurrences | Call expression text ends in `subscribe` |
| `signalApiCalls` | `signal` `computed` `effect` `linkedSignal` `toSignal` | Count call sites |
| `lifecycleHooks` | Implemented hooks | Method name in known list |
| `publicMethods` | Not `private`/`protected` | Exclude lifecycle hooks |
| `classLoc` | Lines in class body | Opening brace to closing brace. See below |

#### Inputs and outputs declared as accessors

`@Input() set value(v) {}` is a `SetAccessorDeclaration`, not a
`PropertyDeclaration`. Walking only properties misses it — and reports zero
inputs for the oldest input style there is, which flatters the burndown of
exactly the code this tool exists to find.

Properties, get accessors and set accessors are all walked. A decorated
get/set pair counts **once**, by property name.

#### `classLoc` measures the body, not the declaration

From the class body's opening brace to its closing brace.

A class declaration node *starts at its decorator*, so measuring the
declaration folds the whole `@Component({...})` block into the number. For an
inline template that counts the template twice — once in `classLoc` and once in
`templateLoc` — and pushes inline-template components up the attention list for
a reason that has nothing to do with their class.

### 1.2 Decorator rules — raw values only

Per invariant I1, store what was seen, not what it means.

| id | Possible values |
|---|---|
| `changeDetectionFlag` | `"OnPush"` \| `"Default"` \| `"absent"` |
| `standaloneFlag` | `"true"` \| `"false"` \| `"absent"` |
| `templateKind` | `"inline"` \| `"external"` \| `"missing"` |

`isOnPush` and `isStandalone` are computed later at query time, using
`angularMajor`.

**Implementation note:** `changeDetection: ChangeDetectionStrategy.OnPush`
arrives as a property-access expression, not a literal. Match on the identifier
text, not on a string value.

### 1.3 Template rules

| id | Counts | Note |
|---|---|---|
| `templateLoc` | Non-empty lines | Trim first |
| `templateMaxDepth` | Deepest element nesting | Root elements are depth 1 |
| `elementCount` | All elements | |
| `bindingCount` | `BoundAttribute` + `BoundEvent` + `BoundText` | |
| `methodCallsInTemplate` | Call expressions in bindings | See heuristic below |
| `asyncPipes` | `async` pipe uses | |
| `legacyControlFlow` | `*ngIf` `*ngFor` `*ngSwitch` | |
| `modernControlFlow` | `@if` `@for` `@switch` | Requires v17 |
| `deferBlocks` | `@defer` | Requires v17 |
| `loopsWithoutTrack` | `*ngFor` without `trackBy` | See note below |
| `loopsTrackedByIndex` | `@for (... ; track $index)` | Requires v17 |
| `innerHtmlBindings` | `[innerHTML]` | Security signal |

#### `legacyControlFlow` — exact membership

Counts the primary attribute only: `*ngFor="let x of xs"` desugars to `ngFor`
plus `ngForOf`, and counting both double-counts every loop.

Members: `*ngIf`, `*ngFor`, and the `[ngSwitch]` binding, which attaches to a
real element rather than desugaring into a `Template` node and so is found
among that element's inputs.

`*ngSwitchCase` and `*ngSwitchDefault` emit a finding but are **not counted**.
They are branches of a switch, and the modern counter does not count `@case` or
`@default` either — only the enclosing `@switch`. Counting the branches would
score a three-case switch as 4 legacy against 1 modern, and a project halfway
through its switch migration would read as barely started.

**Not members:** `*ngTemplateOutlet` and `*ngPlural`. Both are structural
directives, but neither has an `@`-block replacement. Including them would
inflate a burndown that could never reach zero. This metric measures migration
progress; a pattern with nowhere to migrate to is not part of it.

#### `loopsWithoutTrack` and `loopsTrackedByIndex` are two different rules

`@for` **always** has a track expression — the compiler rejects one without —
so an absence rule can never fire on it. `loopsWithoutTrack` is therefore an
`*ngFor`-only measure.

The equivalent `@for` defect is `track $index`, which defeats identity tracking
at exactly the moment it mattered: when the list reorders. It gets its own
counter so the two never merge into one number whose meaning depends on which
syntax the file happened to use.

#### `methodCallsInTemplate` heuristic

This one needs care and will look like a bug later, so document it in code.

`user()` reading a signal is **fine**. `getUser()` calling a method is the
**problem** — it re-runs on every change detection cycle.

**v1 approach:** if the called name matches a field declared with
`signal` / `computed` / `input`, skip it. Otherwise count it.

Imperfect. Accepted for v1. A signal received from elsewhere — a parameter, or
a field assigned rather than initialised, such as `readonly user =
inject(Store).user` — is miscounted as a method call.

**This is why `methodCallsInTemplate` is reported but never gated.** An
imprecise metric is fine on a dashboard, where a human reads it in context. In
a build gate a false positive is a wall with no door: the developer cannot make
the number go down without deleting correct code.

**Event handlers are excluded.** `(click)="save()"` is not counted. The rule
exists to catch calls that re-run on every change detection cycle, and an event
handler runs only when the event fires. Counting handlers would swamp the
metric with the one case that is always correct. Concretely: only a binding's
`value` is walked, never a `BoundEvent`'s `handler`.

#### Template AST node types to handle

`Element`, `Template`, `BoundAttribute`, `BoundEvent`, `BoundText`,
`Interpolation`, `IfBlock`, `ForLoopBlock`, `SwitchBlock`, `DeferredBlock`,
`LetDeclaration`.

**Unknown node handling** — never throw:

```ts
default:
  unknownNodeTypes.add(node.constructor.name);
```

Output:

```
⚠ 2 unknown template node types: SignalFormBlock, OtherBlock
  Tool may be older than this project's Angular version.
```

Turns a crash into a warning, and a silent undercount into a visible one.
`--strict` makes it fail for CI.

### Template resolution

Reading a component's own template is the one place v1 opens a second file.
That is not a breach of the single-file rule: the template *is* the component,
not a reference to another entity. Nothing follows an import or resolves a
selector.

| Situation | Result |
|---|---|
| `template:` inline | Parsed. Findings report the `.ts` file, at the literal's real line |
| `templateUrl:` resolving to a file | Parsed. Findings report the `.html` file |
| `templateUrl:` pointing at a missing file | `templateResolved: false`, all template metrics `null` |
| Template present but unparseable | `templateResolved: false`, all template metrics `null` |

Never `0` for an unread template. Zero would claim the template was read and
found empty, which silently improves the numbers of every component whose
template failed to open.

---

## 2. Legacy pattern catalog (the AI-drift rules)

The most valuable set. Each detects a pattern an AI writes out of habit because
it dominates pre-2023 training data.

| Rule | Detects | Modern form | Entity |
|---|---|---|---|
| `legacy-control-flow` | `*ngIf` `*ngFor` `*ngSwitch` | `@if` `@for` `@switch` | component |
| `constructor-di` | DI via constructor params | `inject()` | component, service |
| `decorator-input` | `@Input()` `@Output()` | `input()` `output()` | component |
| `ngmodule-component` | `standalone: false` | standalone | component |
| `manual-subscribe` | `.subscribe()` in class | `async` pipe or `toSignal` | component, service |
| `destroy-subject` | `ngOnDestroy` + `Subject` teardown | `takeUntilDestroyed()` | component, service |
| `behaviorsubject-state` | `BehaviorSubject` field | `signal()` | component, service |
| `missing-onpush` | No OnPush, no signals | OnPush / zoneless-ready | component |
| `class-based-guard` | Guard as class | `CanActivateFn` | route |
| `class-based-resolver` | Resolver as class | `ResolveFn` | route |
| `eager-route` | `component:` in route config | `loadComponent:` | route |
| `ngmodule-lazy-load` | `loadChildren` returning a module | `loadComponent` | route |

### Honest limitation

Angular ships official migration schematics for several of these (control flow,
standalone, inject, signal inputs). **The tool's value is not doing the
migration** — the schematic does it better.

The value is two things schematics cannot do:

1. **Measuring how much is left** — the burndown
2. **Catching new legacy code added after the migration ran** — the drift check

Verify current schematic command names before writing docs.

---

## 3. Route rules (v1.1 — tier 1)

Route configs are plain TypeScript arrays. `ts-morph` reads them directly.
No new parser needed.

| id | Detects | Why it matters |
|---|---|---|
| `eager-route` | `component:` instead of `loadComponent:` | Bundle size |
| `ngmodule-lazy-load` | `loadChildren` returning a module | Should be `loadComponent` |
| `class-based-guard` | Guard as class, not `CanActivateFn` | Deprecated pattern |
| `class-based-resolver` | Resolver class, not `ResolveFn` | Same |
| `missing-title` | Route without `title` | Accessibility |
| `missing-wildcard` | No `**` route in config | Broken URLs |
| `routeDepth` | Nesting depth of children | Complexity |
| `routeCount` | Total routes in config | Size |
| `guardCount` | Guards attached | Complexity |

### Coverage limitation

Routes built dynamically at runtime cannot be analyzed statically. Report a
`dynamicRoutes` count in the run object so partial coverage is visible — same
principle as `unknownNodeTypes`.

### To verify

Class-based guards were deprecated around v15, but the exact removal version is
unconfirmed. Check the Angular deprecation guide before writing this rule's
message text.

---

## 4. Service rules (v1.2 — tier 1)

Single-file, mostly mechanical. Most existing class rules work unchanged —
`injectedDeps`, `publicMethods`, `classLoc` are the same code run on
`@Injectable` classes.

| id | Detects |
|---|---|
| `constructor-di` | Constructor params instead of `inject()` |
| `missing-provided-in` | `@Injectable()` with no `providedIn` |
| `subject-state` | `BehaviorSubject` field instead of `signal()` |
| `public-subject` | `Subject` exposed publicly |
| `getvalue-call` | `.getValue()` on a `BehaviorSubject` |
| `http-no-shareReplay` | Repeated identical HTTP call, no cache |
| `serviceLoc` | Class size |
| `publicMethods` | API surface size |
| `injectedDeps` | Dependency count |

---

## 5. Symbol table rules (v1.5 — tier 2)

One pass over the project collecting **declarations only**:

```ts
interface SymbolTable {
  components: Map<selector, filePath>;
  services:   Map<className, filePath>;
  routes:     Map<path, targetClassName>;
}
```

Unlocks cross-file rules without full reference resolution:

| id | Detects |
|---|---|
| `route-target-missing` | Route points to a component that does not exist |
| `unknown-injection` | Service injected by name that is not declared |
| `unknown-selector` | Selector used in a template but not declared |

Still one pass, still fast.

---

## 6. Graph rules (v2 — tier 3)

Listed to keep them out of earlier versions.

- Dead components, pipes, directives (declared but never used)
- Unused `@Input`/`@Output` members
- Unreachable routes
- Module and feature import cycles
- Layer boundary violations
- Deep imports bypassing barrels

Requires the two-pass architecture described in `PLAN.md` section 8.

---

## 7. Version gates

Return `null`, never `0`, when below the minimum.

```ts
export function capabilities(major: number) {
  return {
    signals:             major >= 16,
    takeUntilDestroyed:  major >= 16,
    controlFlowBlocks:   major >= 17,  // @if / @for / @switch
    deferBlocks:         major >= 17,
    signalInputs:        major >= 17,  // input() / output()
    letSyntax:           major >= 18,  // @let
    standaloneByDefault: major >= 19,
    signalForms:         major >= 22,  // stabilized in v22
  };
}

export const MIN_SUPPORTED = 17;
export const BUNDLED_COMPILER_MAJOR = 22;
```

| Rule | Min major | Below that |
|---|---|---|
| `signalApiCalls` | 16 | `null` |
| `modernControlFlow` | 17 | `null` |
| `deferBlocks` | 17 | `null` |
| Signal inputs inside `inputs` | 17 | Count decorators only |
| Signal Forms rules | 22 | `null` |

### Version detection

Read from the **target project**, not from our own dependencies:

```ts
const v = require('./node_modules/@angular/core/package.json').version;
```

Store `angularVersion`, `angularMajor`, and `compilerSource`
(`"bundled"` \| `"project-local"`) in the run object. When results look strange,
you need to know which parser produced them.

### To verify

Exact Signal Forms API names for v22. Search results confirmed Signal Forms,
asynchronous signals, and Angular Aria stabilized in v22, but the specific
symbol names are unconfirmed.

---

## 7.5 The drift gate

`check` compares a run against a baseline and reports **regressions only**.
A gate that also lists improvements buries the one line worth acting on.

### Guarded metrics

A metric has to pass three tests before the build may fail on it:

1. **Exact.** No heuristic. A developer who sees the failure must be able to fix
   it.
2. **Not a target.** Section 8 below is not advice the gate may ignore — a CI
   gate is the strongest possible way to hand an agent a target.
3. **Only moves when someone makes it worse.**

What passes:

| Metric | Direction |
|---|---|
| `legacyControlFlow`, `loopsWithoutTrack`, `loopsTrackedByIndex` | lower is better |
| `innerHtmlBindings`, `subscribeCalls` | lower is better |
| `changeDetectionFlag` | losing `OnPush` is a regression |
| `standaloneFlag` | losing `true` is a regression |

What is reported but **not** gated, and why:

| Metric | Why not |
|---|---|
| `injectedDeps` | Test 2. Told to lower it, an agent hides nine services behind one facade |
| `methodCallsInTemplate` | Test 1. The signal heuristic above is imperfect |
| `modernControlFlow`, `asyncPipes`, `signalApiCalls` | Test 3. Deleting a dead `@if`, or replacing an `async` pipe with a signal, lowers these — both are improvements |
| `elementCount`, `publicMethods`, `classLoc`, `templateLoc` | Test 3. A component legitimately grows, and gating growth teaches people to split files to beat the gate |

### Debt on a new entity

An entity that did not exist at the baseline cannot regress — it has nothing to
be compared against — yet a freshly generated component full of `*ngIf` is
precisely the drift this tool exists to catch. So new entities are checked
against a **separate, shorter list**: only patterns from the catalogue in
section 2, which are wrong on arrival whatever the rest of the codebase does.

`legacyControlFlow`, `loopsWithoutTrack`, `loopsTrackedByIndex`,
`innerHtmlBindings`, `subscribeCalls`, plus `standalone: false` and an explicit
`changeDetection: Default`.

**Not the guarded list.** Reusing it would fail the build on `injectedDeps: 1`
— on every component anyone adds, including a textbook-modern one that uses
`inject()` exactly as intended. Only an *explicit* backwards flag counts:
`absent` is the normal state of modern code, since standalone is the default
from v19 and OnPush never is.

### Three rules the comparison must keep

**1. `null` on either side is skipped.** A metric that was `null` and is now a
number was not measurable before, usually because the baseline predates the
rule. That is new information, not a regression. Treating `null` as `0` would
flag every component in the repo the first time a rule ships — the gate would
cry wolf exactly once, and then be switched off forever.

**2. New entities are reported separately.** A brand-new component cannot
regress; it has nothing to be compared against. But a freshly generated
component full of `*ngIf` is precisely the drift this tool exists to catch.
Without a `newEntityDebt` category the gate passes every AI-written file on the
grounds that it is new — which would defeat the entire product thesis in
`PRODUCT.md` section 1.

**3. The baseline copies metrics, never references them.** Aliasing the live
metrics object means anything mutating the result afterwards rewrites the
baseline too, and the comparison can never report a change.

---

## 8. Anti-gaming notes

Two rules that protect the catalog's usefulness.

**Never expose metrics as targets to an agent.** Told to "reduce injected
dependencies," an agent will hide nine services behind one facade — better
score, worse design. Agents optimize literally and instantly.

**Never attribute findings to individual developers.** No "complexity increase
by author." The moment that view exists, the tool is understood as surveillance,
engineers stop trusting it, and a diagnostic becomes a political weapon.
Aggregate to module or team only.

Keep all metrics descriptive, never prescriptive.
