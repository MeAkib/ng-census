import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  TOOL_VERSION,
  analyzeProject,
  collectSourceFiles,
  findWorkspaceProject,
  readWorkspaceProjects,
  capabilities,
  compareToBaseline,
  createBaseline,
  detectAngularVersion,
  isBaseline,
  parseMajor,
  supportLevel,
} from '@ng-census/core';
import type { AnalysisResult, ComponentEntity, ComponentMetrics } from '@ng-census/core';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '..', '..', 'fixtures');
const V22 = join(FIXTURES, 'v22-project');
const RULES = join(FIXTURES, 'v22-rules');
const WORKSPACE = join(FIXTURES, 'workspace');
const V18 = join(FIXTURES, 'v18-project');
const V16 = join(FIXTURES, 'v16-project');

function componentNamed(entities: readonly unknown[], className: string): ComponentEntity {
  const match = (entities as ComponentEntity[]).find((e) => e.className === className);
  assert.ok(match, `expected to find component ${className}`);
  return match;
}

function metricsOf(entities: readonly unknown[], className: string): ComponentMetrics {
  return componentNamed(entities, className).metrics;
}

describe('version parsing', () => {
  test('reads a major from every range syntax npm produces', () => {
    assert.equal(parseMajor('22.1.6'), 22);
    assert.equal(parseMajor('^20.0.0'), 20);
    assert.equal(parseMajor('~21.2.0'), 21);
    assert.equal(parseMajor('>=19.0.0 <20.0.0'), 19);
    assert.equal(parseMajor('20.x'), 20);
  });

  test('returns null rather than guessing when there is no number', () => {
    assert.equal(parseMajor('latest'), null);
    assert.equal(parseMajor(''), null);
  });

  test('support level matches the documented policy', () => {
    assert.equal(supportLevel(22), 'full');
    assert.equal(supportLevel(20), 'full');
    assert.equal(supportLevel(18), 'best-effort');
    assert.equal(supportLevel(16), 'unsupported');
    assert.equal(supportLevel(null), 'unknown');
  });

  test('prefers the installed version over the declared range', () => {
    // package.json declares ^22.0.0, node_modules holds 22.1.6.
    // The installed one is what actually compiles, so it wins.
    const info = detectAngularVersion(V22);
    assert.equal(info.version, '22.1.6');
    assert.equal(info.source, 'node_modules');
  });
});

describe('capability matrix', () => {
  test('gates features at the right majors', () => {
    assert.equal(capabilities(16).controlFlowBlocks, false);
    assert.equal(capabilities(17).controlFlowBlocks, true);
    assert.equal(capabilities(18).standaloneByDefault, false);
    assert.equal(capabilities(19).standaloneByDefault, true);
    assert.equal(capabilities(21).signalForms, false);
    assert.equal(capabilities(22).signalForms, true);
  });
});

describe('the version pair', () => {
  // The most important test in the suite. Identical source bytes, two Angular
  // versions. If both runs agree, version handling is broken and every
  // standalone number the tool ever reports will be wrong.

  test('stores the raw flag identically in both projects', async () => {
    const v22 = await analyzeProject({ projectRoot: V22, filter: 'plain' });
    const v18 = await analyzeProject({ projectRoot: V18, filter: 'plain' });

    assert.equal(metricsOf(v22.entities, 'PlainComponent').standaloneFlag, 'absent');
    assert.equal(metricsOf(v18.entities, 'PlainComponent').standaloneFlag, 'absent');
  });

  test('records different majors, so the flag can be interpreted differently', async () => {
    const v22 = await analyzeProject({ projectRoot: V22, filter: 'plain' });
    const v18 = await analyzeProject({ projectRoot: V18, filter: 'plain' });

    assert.equal(v22.run.angularMajor, 22);
    assert.equal(v18.run.angularMajor, 18);
    assert.equal(capabilities(22).standaloneByDefault, true);
    assert.equal(capabilities(18).standaloneByDefault, false);
  });
});

describe('class rules', () => {
  test('counts inject() dependencies', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    const m = metricsOf(entities, 'OrderListComponent');
    assert.equal(m.injectedDeps, 2);
  });

  test('counts constructor dependencies', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    const m = metricsOf(entities, 'LegacyWidgetComponent');
    assert.equal(m.injectedDeps, 3);
  });

  test('counts signal inputs and outputs on a version that supports them', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    const m = metricsOf(entities, 'OrderListComponent');
    assert.equal(m.inputs, 2); // input.required() + input()
    assert.equal(m.outputs, 1);
  });

  test('counts decorator inputs and outputs', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    const m = metricsOf(entities, 'LegacyWidgetComponent');
    assert.equal(m.inputs, 2);
    assert.equal(m.outputs, 1);
  });

  test('counts manual subscribe calls', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    assert.equal(metricsOf(entities, 'LegacyWidgetComponent').subscribeCalls, 2);
    assert.equal(metricsOf(entities, 'OrderListComponent').subscribeCalls, 0);
  });

  test('excludes lifecycle hooks from the public API surface', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    // handle() and refresh() are public; ngOnInit and ngOnDestroy are not counted.
    assert.equal(metricsOf(entities, 'LegacyWidgetComponent').publicMethods, 2);
    assert.equal(metricsOf(entities, 'LegacyWidgetComponent').lifecycleHooks, 2);
  });

  test('excludes private methods from the public API surface', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    // select() is public, internalHelper() is private.
    assert.equal(metricsOf(entities, 'OrderListComponent').publicMethods, 1);
  });
});

describe('decorator rules store raw values', () => {
  test('reads OnPush through a property access expression', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    assert.equal(metricsOf(entities, 'OrderListComponent').changeDetectionFlag, 'OnPush');
  });

  test('distinguishes an explicit false from an absent flag', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    assert.equal(metricsOf(entities, 'LegacyWidgetComponent').standaloneFlag, 'false');
    assert.equal(metricsOf(entities, 'PlainComponent').standaloneFlag, 'absent');
  });

  test('records how the template was declared', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    assert.equal(metricsOf(entities, 'OrderListComponent').templateKind, 'external');
    assert.equal(metricsOf(entities, 'LegacyWidgetComponent').templateKind, 'inline');
  });
});

describe('output contract', () => {
  test('entities carry a kind discriminant, not a components key', async () => {
    const result = await analyzeProject({ projectRoot: V22 });
    assert.ok(Array.isArray(result.entities));
    assert.ok(result.entities.every((e) => e.kind === 'component'));
    assert.equal((result as unknown as Record<string, unknown>)['components'], undefined);
  });

  test('entity ids are repo-relative and forward-slashed', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    const entity = componentNamed(entities, 'OrderListComponent');
    assert.equal(entity.id, 'src/app/orders/order-list.component.ts::OrderListComponent');
    assert.ok(!entity.id.includes('\\'));
  });

  test('an unreadable template yields null metrics, never zero', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    const entity = componentNamed(entities, 'BrokenTemplateComponent');
    // templateUrl points at a file that does not exist. Zero would claim we
    // read the template and found nothing, quietly improving the numbers of
    // every component whose template failed to open.
    assert.equal(entity.templateResolved, false);
    assert.equal(entity.metrics.templateLoc, null);
    assert.equal(entity.metrics.legacyControlFlow, null);
    assert.equal(entity.metrics.elementCount, null);
  });

  test('one unreadable template does not take the run down with it', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    // The broken component sits in the same run as the good ones, which are
    // still fully measured.
    assert.ok(componentNamed(entities, 'OrderListComponent').templateResolved);
    assert.equal(metricsOf(entities, 'OrderListComponent').templateLoc, 11);
    assert.ok(entities.length >= 5);
  });

  test('findings carry a usable source location', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    const entity = componentNamed(entities, 'LegacyWidgetComponent');
    const finding = entity.findings.find((f) => f.rule === 'constructor-di');
    assert.ok(finding, 'expected a constructor-di finding');
    assert.ok(finding.line > 0);
    assert.ok(finding.col > 0);
    assert.ok(finding.file.endsWith('.ts'));
  });

  test('counts derive from findings', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    const entity = componentNamed(entities, 'LegacyWidgetComponent');
    const ctorFindings = entity.findings.filter((f) => f.rule === 'constructor-di').length;
    assert.equal(ctorFindings, 3);
  });

  test('entities are sorted, so runs are comparable', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    const ids = entities.map((e) => e.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));
  });
});

describe('robustness', () => {
  test('a project with no Angular installed does not crash', async () => {
    const result = await analyzeProject({ projectRoot: here });
    assert.ok(Array.isArray(result.entities));
    assert.equal(result.run.angularMajor, null);
  });
});

describe('template rules', () => {
  test('counts legacy blocks, not their branches', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    // *ngIf, *ngFor x2, [ngSwitch] = 4 blocks.
    //
    // *ngSwitchCase and *ngSwitchDefault are branches of the switch, and the
    // modern counter does not count @case or @default either — only the
    // enclosing @switch. Counting them here would score a three-case switch
    // as 4 legacy against 1 modern and make the migration ratio meaningless.
    const entity = componentNamed(entities, 'LegacyTemplateComponent');
    assert.equal(entity.metrics.legacyControlFlow, 4);

    // They are still reported, because an agent needs to know where they are.
    const branchFindings = entity.findings.filter(
      (f) => f.rule === 'legacy-control-flow' && f.detail?.startsWith('*ngSwitch'),
    );
    assert.equal(branchFindings.length, 2);
  });

  test('counts modern control flow separately from legacy', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    assert.equal(metricsOf(entities, 'LegacyTemplateComponent').modernControlFlow, 1);
    assert.equal(metricsOf(entities, 'OrderListComponent').modernControlFlow, 2);
  });

  test('only flags the *ngFor that lacks trackBy', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    // Two *ngFor loops in the fixture; one declares trackBy.
    assert.equal(metricsOf(entities, 'LegacyTemplateComponent').loopsWithoutTrack, 1);
  });

  test('counts @for tracked by index, which loopsWithoutTrack cannot see', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    // @for always has a track expression, so the absence rule never fires.
    // Tracking by $index is the real defect and needs its own counter.
    assert.equal(metricsOf(entities, 'LegacyTemplateComponent').loopsTrackedByIndex, 1);
  });

  test('counts async pipes and innerHTML bindings', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    const m = metricsOf(entities, 'LegacyTemplateComponent');
    assert.equal(m.asyncPipes, 1);
    assert.equal(m.innerHtmlBindings, 1);
  });

  test('measures shape: loc, depth, elements, bindings', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    const m = metricsOf(entities, 'OrderListComponent');
    assert.equal(m.templateLoc, 11);
    assert.equal(m.templateMaxDepth, 3);
    assert.equal(m.elementCount, 4);
    assert.equal(m.bindingCount, 2);
  });

  test('a signal read in a template is not a method call', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    // order-list's template calls visible(), which is a computed() field.
    assert.equal(metricsOf(entities, 'OrderListComponent').methodCallsInTemplate, 0);
  });

  test('a real method call in a binding is counted', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    // getLabel() appears in [title] and in an interpolation.
    assert.equal(metricsOf(entities, 'LegacyTemplateComponent').methodCallsInTemplate, 2);
  });

  test('a method call in an event handler is not counted', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    // order-list has (click)="select(order.id)". Calling a method from an
    // event handler is what handlers are for; it does not re-run on change
    // detection, so counting it would make the metric noise.
    assert.equal(metricsOf(entities, 'OrderListComponent').methodCallsInTemplate, 0);
  });

  test('template findings carry a position in the template file', async () => {
    const { entities } = await analyzeProject({ projectRoot: V22 });
    const entity = componentNamed(entities, 'LegacyTemplateComponent');
    const finding = entity.findings.find((f) => f.rule === 'legacy-control-flow');
    assert.ok(finding, 'expected a legacy-control-flow finding');
    assert.ok(finding.file.endsWith('.html'));
    assert.equal(finding.line, 1);
    assert.equal(finding.detail, '*ngIf');
  });

  test('an inline template reports findings against the .ts file', async () => {
    const { entities } = await analyzeProject({ projectRoot: V16 });
    const entity = componentNamed(entities, 'OldComponent');
    const finding = entity.findings.find((f) => f.rule === 'legacy-control-flow');
    assert.ok(finding, 'expected a legacy-control-flow finding');
    assert.ok(finding.file.endsWith('.ts'));
    // The template literal is on line 10 of the fixture, not line 1.
    assert.ok(finding.line > 1, `expected a real line number, got ${finding.line}`);
  });

  test('no unknown node types on templates the bundled compiler understands', async () => {
    const result = await analyzeProject({ projectRoot: V22 });
    assert.deepEqual(result.run.unknownNodeTypes, []);
  });
});

describe('version gating of template rules', () => {
  test('blocks that could not exist on v16 report null, not zero', async () => {
    const { entities } = await analyzeProject({ projectRoot: V16 });
    const m = metricsOf(entities, 'OldComponent');
    assert.equal(m.modernControlFlow, null);
    assert.equal(m.deferBlocks, null);
    assert.equal(m.loopsTrackedByIndex, null);
  });

  test('rules that did exist on v16 still report real numbers', async () => {
    const { entities } = await analyzeProject({ projectRoot: V16 });
    const m = metricsOf(entities, 'OldComponent');
    assert.equal(m.legacyControlFlow, 1);
    assert.equal(m.loopsWithoutTrack, 0); // measured, and genuinely none
  });
});

describe('the drift gate', () => {
  async function v22(): Promise<AnalysisResult> {
    return analyzeProject({ projectRoot: V22 });
  }

  test('a run compared against its own baseline reports nothing', async () => {
    const result = await v22();
    const report = compareToBaseline(createBaseline(result), result);
    assert.equal(report.regressions.length, 0);
    assert.equal(report.newEntityDebt.length, 0);
    assert.equal(report.addedEntities.length, 0);
    assert.equal(report.removedEntities.length, 0);
  });

  test('a metric moving the wrong way is a regression', async () => {
    const result = await v22();
    const baseline = createBaseline(result);
    const target = baseline.entities.find((e) => e.className === 'OrderListComponent');
    assert.ok(target);
    target.metrics['legacyControlFlow'] = 0;
    const live = result.entities.find((e) => e.className === 'OrderListComponent');
    assert.ok(live);
    (live.metrics as unknown as Record<string, unknown>)['legacyControlFlow'] = 4;

    const report = compareToBaseline(baseline, result);
    const found = report.regressions.find((r) => r.metric === 'legacyControlFlow');
    assert.ok(found, 'expected a legacyControlFlow regression');
    assert.equal(found.from, 0);
    assert.equal(found.to, 4);
  });

  test('a metric moving the right way is an improvement, not a regression', async () => {
    const result = await v22();
    const baseline = createBaseline(result);
    const target = baseline.entities.find((e) => e.className === 'LegacyTemplateComponent');
    assert.ok(target);
    // Baseline had more legacy control flow than the current run: someone
    // migrated part of the template.
    target.metrics['legacyControlFlow'] = 9;

    const report = compareToBaseline(baseline, result);
    assert.equal(report.regressions.length, 0);
    assert.ok(report.improvements.some((i) => i.metric === 'legacyControlFlow'));
  });

  test('removing code is never a regression', async () => {
    const result = await v22();
    const baseline = createBaseline(result);
    const target = baseline.entities.find((e) => e.className === 'OrderListComponent');
    assert.ok(target);
    // Deleting a dead @if block lowers modernControlFlow, and dropping an
    // async pipe for a signal lowers asyncPipes. Both are improvements. A
    // gate that called them regressions would punish cleaning up.
    target.metrics['modernControlFlow'] = 9;
    target.metrics['asyncPipes'] = 9;
    target.metrics['signalApiCalls'] = 9;

    const report = compareToBaseline(baseline, result);
    assert.equal(report.regressions.length, 0);
  });

  test('a dependency count going up does not fail the build', async () => {
    const result = await v22();
    const baseline = createBaseline(result);
    const target = baseline.entities.find((e) => e.className === 'OrderListComponent');
    assert.ok(target);
    target.metrics['injectedDeps'] = 0;

    // PRODUCT.md section 8: an agent told to reduce injected dependencies
    // hides nine services behind one facade. A CI gate is the strongest form
    // of "here is a target", so this metric is reported and never gated.
    const report = compareToBaseline(baseline, result);
    assert.equal(report.regressions.filter((r) => r.metric === 'injectedDeps').length, 0);
  });

  test('a new component with no legacy patterns passes the gate', async () => {
    const result = await v22();
    const baseline = createBaseline(result);
    // OrderList is modern: OnPush, inject(), signals, @for, no *ngIf.
    // It does inject two dependencies, which used to be reported as debt and
    // failed the build for every component anyone added.
    baseline.entities = baseline.entities.filter((e) => e.className !== 'OrderListComponent');

    const report = compareToBaseline(baseline, result);
    assert.ok(report.addedEntities.some((id) => id.includes('OrderListComponent')));
    assert.deepEqual(
      report.newEntityDebt.filter((d) => d.entityId.includes('OrderListComponent')),
      [],
    );
  });

  test('a new component declaring standalone: false is debt', async () => {
    const result = await analyzeProject({ projectRoot: RULES });
    const baseline = createBaseline(result);
    baseline.entities = baseline.entities.filter((e) => e.className !== 'OldStyleComponent');

    const report = compareToBaseline(baseline, result);
    assert.ok(report.newEntityDebt.some((d) => d.metric === 'standaloneFlag'));
  });

  test('losing OnPush is a regression', async () => {
    const result = await v22();
    const baseline = createBaseline(result);
    const target = baseline.entities.find((e) => e.className === 'LegacyWidgetComponent');
    assert.ok(target);
    target.metrics['changeDetectionFlag'] = 'OnPush';

    const report = compareToBaseline(baseline, result);
    assert.ok(report.regressions.some((r) => r.metric === 'changeDetectionFlag'));
  });

  test('a new entity arriving with legacy patterns fails the gate', async () => {
    const result = await v22();
    const baseline = createBaseline(result);
    // Drop the legacy component from the baseline so it reads as newly added.
    baseline.entities = baseline.entities.filter(
      (e) => e.className !== 'LegacyTemplateComponent',
    );

    const report = compareToBaseline(baseline, result);
    assert.equal(report.regressions.length, 0, 'a new entity cannot regress');
    assert.ok(
      report.newEntityDebt.some((d) => d.metric === 'legacyControlFlow'),
      'but its legacy debt must still be reported, or the gate passes every generated file',
    );
  });

  test('null on either side is skipped, so a new rule does not flag everything', async () => {
    const result = await v22();
    const baseline = createBaseline(result);
    // Simulate a baseline taken before the template rules existed.
    for (const entity of baseline.entities) {
      entity.metrics['legacyControlFlow'] = null;
      entity.metrics['loopsWithoutTrack'] = null;
    }

    const report = compareToBaseline(baseline, result);
    assert.equal(
      report.regressions.filter((r) => r.metric === 'legacyControlFlow').length,
      0,
    );
  });

  test('rejects a file that is not a baseline', () => {
    assert.equal(isBaseline(null), false);
    assert.equal(isBaseline({}), false);
    assert.equal(isBaseline({ baselineVersion: 1, entities: [] }), true);
  });
});

describe('the legacy pattern catalogue', () => {
  // RULES.md section 2. Each of these is a pattern an AI writes out of habit
  // because it dominates pre-2023 training data.

  async function rules(): Promise<AnalysisResult> {
    return analyzeProject({ projectRoot: RULES });
  }

  function rulesOf(entities: readonly unknown[], className: string): string[] {
    return [...new Set(componentNamed(entities, className).findings.map((f) => f.rule))];
  }

  test('counts an @Input() written as a setter', async () => {
    const { entities } = await rules();
    // A setter is a SetAccessorDeclaration, not a PropertyDeclaration. Walking
    // only properties reports zero inputs for the oldest input style there is.
    const m = metricsOf(entities, 'OldStyleComponent');
    assert.equal(m.inputs, 1);
    assert.equal(m.outputs, 1);
    assert.ok(rulesOf(entities, 'OldStyleComponent').includes('decorator-input'));
  });

  test('flags a component declared standalone: false', async () => {
    const { entities } = await rules();
    assert.ok(rulesOf(entities, 'OldStyleComponent').includes('ngmodule-component'));
  });

  test('flags a manual teardown Subject paired with ngOnDestroy', async () => {
    const { entities } = await rules();
    assert.ok(rulesOf(entities, 'OldStyleComponent').includes('destroy-subject'));
  });

  test('flags BehaviorSubject used as state', async () => {
    const { entities } = await rules();
    assert.ok(rulesOf(entities, 'OldStyleComponent').includes('behaviorsubject-state'));
  });

  test('flags a component with neither OnPush nor signals', async () => {
    const { entities } = await rules();
    assert.ok(rulesOf(entities, 'OldStyleComponent').includes('missing-onpush'));
    // InlineSize declares OnPush, so it is not flagged.
    assert.ok(!rulesOf(entities, 'InlineSizeComponent').includes('missing-onpush'));
  });

  test('counts innerHTML however it was spelled', async () => {
    const { entities } = await rules();
    // The fixture writes [innerHtml]. Angular treats both spellings the same,
    // and this is the security signal, so a miss matters.
    assert.equal(metricsOf(entities, 'OldStyleComponent').innerHtmlBindings, 1);
  });

  test('counts both DI styles in one class', async () => {
    const { entities } = await rules();
    assert.equal(metricsOf(entities, 'MixedDiComponent').injectedDeps, 2);
  });

  test('counts every untracked loop, including nested ones', async () => {
    const { entities } = await rules();
    const m = metricsOf(entities, 'NestedLoopsComponent');
    assert.equal(m.legacyControlFlow, 2);
    assert.equal(m.loopsWithoutTrack, 2);
  });
});

describe('legacy and modern shapes measure the same', () => {
  // The rule that protects every trend line: migrating a template must move
  // the migration counters and nothing else. If converting *ngIf to @if also
  // changed depth or binding counts, a dashboard would show motion no
  // developer caused.

  test('the same markup measures the same in both styles', async () => {
    const { entities } = await analyzeProject({ projectRoot: RULES });
    const legacy = metricsOf(entities, 'ParityLegacyComponent');
    const modern = metricsOf(entities, 'ParityModernComponent');

    assert.equal(legacy.templateMaxDepth, modern.templateMaxDepth);
    assert.equal(legacy.bindingCount, modern.bindingCount);
    assert.equal(legacy.elementCount, modern.elementCount);
    assert.equal(legacy.methodCallsInTemplate, modern.methodCallsInTemplate);

    // Only the migration counters differ. That is the whole point.
    assert.equal(legacy.legacyControlFlow, 1);
    assert.equal(modern.legacyControlFlow, 0);
    assert.equal(modern.modernControlFlow, 1);
  });
});

describe('class size', () => {
  test('classLoc measures the body, not the decorator', async () => {
    const { entities } = await analyzeProject({ projectRoot: RULES });
    const m = metricsOf(entities, 'InlineSizeComponent');
    // One field in the body. Measuring from the decorator would fold the
    // seven-line inline template into the class size, counting it twice —
    // once here and once in templateLoc.
    assert.equal(m.classLoc, 3);
    assert.ok((m.templateLoc ?? 0) > m.classLoc!);
  });
});

describe('the version a run was measured against', () => {
  test('records where the major came from', async () => {
    const result = await analyzeProject({ projectRoot: V22 });
    assert.equal(result.run.angularMajorSource, 'node_modules');
    assert.equal(result.run.capabilityMajor, 22);
    assert.equal(result.run.angularMajor, 22);
  });

  test('says so in the run when the version had to be assumed', async () => {
    const result = await analyzeProject({ projectRoot: here });
    // A stored run must never claim angularMajor: null while its version-gated
    // metrics were computed under an assumption nobody can see.
    assert.equal(result.run.angularMajor, null);
    assert.equal(result.run.angularMajorSource, 'assumed');
    assert.equal(result.run.capabilityMajor, 22);
  });
});

describe('what the run says it looked at', () => {
  // "0 components" reads the same whether a project has none, the filter
  // removed them all, or the file search matched nothing. Those need opposite
  // responses from the user, so the counts have to be in the run object.

  test('records files scanned and files analyzed', async () => {
    const result = await analyzeProject({ projectRoot: V22 });
    assert.ok(result.run.filesScanned > 0);
    assert.equal(result.run.filesAnalyzed, result.run.filesScanned);
  });

  test('a filter that matches nothing scans files but analyzes none', async () => {
    const result = await analyzeProject({ projectRoot: V22, filter: 'no-such-folder' });
    assert.ok(result.run.filesScanned > 0);
    assert.equal(result.run.filesAnalyzed, 0);
    assert.equal(result.entities.length, 0);
  });
});

describe('finding the files', () => {
  // Discovery is the one step where an empty result looks exactly like a
  // correct answer. It used to hand glob patterns to the TypeScript wrapper's
  // own file search, which returned zero files for every pattern on macOS with
  // Node 24 — including a literal absolute path — and reported "0 components"
  // for a healthy 2485-file workspace. It walks the tree itself now.

  test('finds the source files without a glob engine', () => {
    const files = collectSourceFiles(RULES);
    assert.ok(files.length > 0);
    assert.ok(files.every((f) => f.endsWith('.ts')));
    assert.ok(files.some((f) => f.endsWith('old-style.component.ts')));
  });

  test('never descends into build output or dependencies', () => {
    const files = collectSourceFiles(RULES);
    // out-tsc holds a real @Component. A compiled library re-emits every
    // component into build output, so counting it reports the codebase twice.
    assert.ok(!files.some((f) => f.includes('out-tsc')));
    assert.ok(!files.some((f) => f.includes('node_modules')));
  });

  test('skips declaration files and specs', () => {
    const files = collectSourceFiles(RULES);
    assert.ok(!files.some((f) => f.endsWith('.d.ts')));
    assert.ok(!files.some((f) => f.endsWith('.spec.ts')));
  });

  test('returns a stable order, so two runs are comparable', () => {
    const first = collectSourceFiles(RULES);
    const second = collectSourceFiles(RULES);
    assert.deepEqual(first, second);
    assert.deepEqual(first, [...first].sort());
  });

  test('a component in build output never reaches the run', async () => {
    const { entities } = await analyzeProject({ projectRoot: RULES });
    assert.ok(!entities.some((e) => e.className === 'LeakedComponent'));
    assert.ok(!entities.some((e) => e.className === 'SpecOnlyComponent'));
  });
});

describe('multi-project workspaces', () => {
  // Four applications under one root is the normal shape of a real Angular
  // workspace, and "how is billing doing" is a question someone owns. "How is
  // the workspace doing" usually is not.

  test('reads the projects out of angular.json', () => {
    const projects = readWorkspaceProjects(WORKSPACE);
    assert.deepEqual(
      projects.map((p) => p.name),
      ['billing', 'portal', 'ui-kit'],
    );
    assert.equal(projects[0]?.root, 'projects/billing');
    assert.equal(projects[2]?.projectType, 'library');
  });

  test('reads an angular.json that contains comments', () => {
    // Generated workspaces sometimes carry them, and refusing to read the file
    // would turn --project into a feature that works on some repos only.
    assert.ok(readWorkspaceProjects(WORKSPACE).length > 0);
  });

  test('reports no projects rather than throwing when there is no workspace file', () => {
    assert.deepEqual(readWorkspaceProjects(RULES), []);
    assert.equal(findWorkspaceProject(RULES, 'anything'), undefined);
  });

  test('a scoped run measures only that project', async () => {
    const all = await analyzeProject({ projectRoot: WORKSPACE });
    const scoped = await analyzeProject({ projectRoot: WORKSPACE, scope: 'projects/billing' });

    assert.equal(all.entities.length, 3);
    assert.equal(scoped.entities.length, 1);
    assert.equal(scoped.entities[0]?.className, 'InvoiceComponent');
  });

  test('the run says which scope it covered', async () => {
    const all = await analyzeProject({ projectRoot: WORKSPACE });
    const scoped = await analyzeProject({ projectRoot: WORKSPACE, scope: 'projects/portal' });

    assert.equal(all.run.scope, null);
    assert.equal(scoped.run.scope, 'projects/portal');
  });

  test('ids stay workspace-relative, so scoped and full runs agree', async () => {
    // Scoping changes what is measured, never what anything is called. If the
    // id moved, a baseline taken per project could never be compared with one
    // taken over the workspace, and history would restart on the day someone
    // added --project to their CI command.
    const all = await analyzeProject({ projectRoot: WORKSPACE });
    const scoped = await analyzeProject({ projectRoot: WORKSPACE, scope: 'projects/portal' });

    const ids = new Set(all.entities.map((e) => e.id));
    assert.ok(scoped.entities.every((e) => ids.has(e.id)));
    assert.equal(
      scoped.entities[0]?.id,
      'projects/portal/src/app/portal.component.ts::PortalComponent',
    );
  });

  test('a baseline records the scope it was taken with', async () => {
    const scoped = await analyzeProject({ projectRoot: WORKSPACE, scope: 'projects/billing' });
    assert.equal(createBaseline(scoped).scope, 'projects/billing');

    const all = await analyzeProject({ projectRoot: WORKSPACE });
    assert.equal(createBaseline(all).scope, null);
  });

  test('scoping does not walk the other projects', async () => {
    const scoped = await analyzeProject({ projectRoot: WORKSPACE, scope: 'projects/billing' });
    assert.equal(scoped.run.filesScanned, 1);
  });
});

describe('dead scaffolding', () => {
  // Older Angular CLI versions generated `constructor() {}` and an empty
  // `ngOnInit` in every component. It is all over the code AI tools learned
  // from, and agents still write it by habit.

  test('counts lifecycle hooks with no statements', async () => {
    const { entities } = await analyzeProject({ projectRoot: RULES });
    const entity = componentNamed(entities, 'ScaffoldComponent');

    // ngOnInit() {} and ngOnChanges() { // TODO } — the comment does not run.
    // ngOnDestroy has a statement, and refresh() is not a hook.
    assert.equal(entity.metrics.emptyLifecycleHooks, 2);
    assert.deepEqual(
      entity.findings.filter((f) => f.rule === 'empty-lifecycle-hook').map((f) => f.detail).sort(),
      ['ngOnChanges', 'ngOnInit'],
    );
  });

  test('empty hooks still count as implemented hooks', async () => {
    const { entities } = await analyzeProject({ projectRoot: RULES });
    // lifecycleHooks keeps its meaning. Excluding empty ones would silently
    // change a stored metric and break every existing baseline.
    assert.equal(metricsOf(entities, 'ScaffoldComponent').lifecycleHooks, 3);
  });

  test('counts a constructor with no parameters and no statements', async () => {
    const { entities } = await analyzeProject({ projectRoot: RULES });
    const entity = componentNamed(entities, 'ScaffoldComponent');
    assert.equal(entity.metrics.emptyConstructors, 1);
    const finding = entity.findings.find((f) => f.rule === 'empty-constructor');
    assert.ok(finding && finding.line > 0 && finding.col > 0);
  });

  test('a constructor that injects is not empty, even with an empty body', async () => {
    const { entities } = await analyzeProject({ projectRoot: RULES });
    // constructor(private readonly router: Router) {} — the parameters are
    // the injection. constructor-di reports it; this rule must not.
    assert.equal(metricsOf(entities, 'MixedDiComponent').emptyConstructors, 0);
  });

  test('does not guess about constructor() { super(); }', async () => {
    const { entities } = await analyzeProject({ projectRoot: RULES });
    // Redundant or not depends on the parent class. An inexact rule cannot be
    // allowed near a CI gate, so it is left alone.
    assert.equal(metricsOf(entities, 'SuperCallComponent').emptyConstructors, 0);
  });

  test('a new file arriving with empty hooks is debt', async () => {
    const result = await analyzeProject({ projectRoot: RULES });
    const baseline = createBaseline(result);
    baseline.entities = baseline.entities.filter((e) => e.className !== 'ScaffoldComponent');

    const report = compareToBaseline(baseline, result);
    const debt = report.newEntityDebt.filter((d) => d.entityId.includes('ScaffoldComponent'));
    assert.ok(debt.some((d) => d.metric === 'emptyLifecycleHooks' && d.value === 2));
    assert.ok(debt.some((d) => d.metric === 'emptyConstructors' && d.value === 1));
  });

  test('an existing file gaining an empty hook does not fail the build yet', async () => {
    const result = await analyzeProject({ projectRoot: RULES });
    const baseline = createBaseline(result);
    const target = baseline.entities.find((e) => e.className === 'ScaffoldComponent');
    assert.ok(target);
    target.metrics['emptyLifecycleHooks'] = 0;

    // New-file debt only, for now. An existing codebase may hold hundreds of
    // these, and gating on old scaffolding would get the gate switched off.
    const report = compareToBaseline(baseline, result);
    assert.equal(report.regressions.filter((r) => r.metric === 'emptyLifecycleHooks').length, 0);
  });
});

describe('release hygiene', () => {
  const root = join(here, '..', '..');
  const versionOf = (dir: string): string =>
    (JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as { version: string }).version;

  test('the version stored in every run is the published version', () => {
    // A stored run says which rule definitions produced its numbers through
    // this field. It used to be hardcoded, and would have gone stale on the
    // first version bump.
    assert.equal(TOOL_VERSION, versionOf('packages/core'));
  });

  test('core and cli are released in lockstep', () => {
    // The CLI pins core to an exact version. If these drift, `npm install
    // ng-census` pulls a core the CLI was never tested against.
    const cli = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')) as {
      version: string;
      dependencies: Record<string, string>;
    };
    assert.equal(cli.version, versionOf('packages/core'));
    assert.equal(cli.dependencies['@ng-census/core'], versionOf('packages/core'));
  });
});
