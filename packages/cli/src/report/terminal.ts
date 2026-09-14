import type { AnalysisResult, ComponentEntity, Entity } from '@ng-census/core';
import {
  LTS_END_DATES,
  MIN_FULL_SUPPORT,
  MIN_SUPPORTED,
  capabilities,
  supportLevel,
} from '@ng-census/core';

/**
 * Terminal formatting.
 *
 * All interpretation of raw flags happens here, at read time, using the run's
 * angularMajor. The analyzer stored what it saw; this decides what it meant.
 */

const BAR_WIDTH = 10;

export function renderTerminal(result: AnalysisResult, topN: number): string {
  const lines: string[] = [];
  const components = result.entities.filter(isComponent);

  lines.push('', renderHeader(result), '');

  const warning = renderVersionWarning(result);
  if (warning) lines.push(warning, '');

  if (components.length === 0) {
    lines.push(...renderNothingFound(result), '');
    return lines.join('\n');
  }

  lines.push(...renderSummary(components, result.run.angularMajor));
  lines.push('');
  lines.push(...renderNeedsAttention(components, topN));
  lines.push('');
  lines.push('  --json for full output');
  lines.push('');

  return lines.join('\n');
}

function renderHeader(result: AnalysisResult): string {
  const { run, entities } = result;
  const version = run.angularVersion ?? 'unknown version';
  const count = entities.filter(isComponent).length;
  const seconds = (run.durationMs / 1000).toFixed(1);

  // The scope belongs in the header, not a footnote. A run over one
  // application of four looks exactly like a run over a small workspace, and
  // the difference changes what every percentage below means.
  const scope = run.scope ? ` · ${run.scope}` : '';

  return `Angular ${version}${scope} · ${count} component${count === 1 ? '' : 's'} · ${seconds}s`;
}

/**
 * Warn when results may be unreliable.
 *
 * Driven by `supportLevel()` rather than by re-deriving the policy here. The
 * previous version compared against `MIN_SUPPORTED` directly and silently said
 * nothing at all for majors 17, 18 and 19 — the exact versions the support
 * policy promises a warning for.
 */
function renderVersionWarning(result: AnalysisResult): string | null {
  const { angularMajor, capabilityMajor, angularMajorSource } = result.run;

  if (angularMajor === null || angularMajorSource === 'assumed') {
    return [
      '  ⚠ Could not detect the Angular version.',
      `    Version-gated metrics were computed as if this were Angular ${capabilityMajor},`,
      '    so some numbers may be wrong. Run from the project root, or install',
      '    dependencies so @angular/core can be read.',
    ].join('\n');
  }

  switch (supportLevel(angularMajor)) {
    case 'unsupported':
      return `  ⚠ Angular ${angularMajor} is below the minimum supported version (${MIN_SUPPORTED}). Results are unreliable.`;

    case 'best-effort':
      return (
        `  ⚠ Angular ${angularMajor} is supported on a best-effort basis ` +
        `(fully supported: ${MIN_FULL_SUPPORT} and above).`
      );

    default: {
      const ltsEnd = LTS_END_DATES[angularMajor];
      if (ltsEnd && new Date(ltsEnd) > new Date()) {
        return `  ℹ Angular ${angularMajor} support ends ${ltsEnd}.`;
      }
      return null;
    }
  }
}

/**
 * What to say when the run produced nothing.
 *
 * "No components found" on its own is not an answer — it reads the same
 * whether the project has no components, the filter excluded them all, or the
 * file search never matched a single file. Each of those needs a different
 * next step from the reader, so the file counts come first and the advice
 * follows from them.
 */
function renderNothingFound(result: AnalysisResult): string[] {
  const { filesScanned, filesAnalyzed } = result.run;

  if (filesScanned === 0) {
    return [
      '  No TypeScript files were found at all.',
      '',
      '  Nothing was read, so this says nothing about your components.',
      '  Check that the path is the project root, and that these are not',
      '  where your source lives: dist, out-tsc, .angular, coverage, .nx,',
      '  bazel-out. Folders whose name begins with a dot are also skipped.',
    ];
  }

  if (filesAnalyzed === 0) {
    return [
      `  Read ${filesScanned} TypeScript file(s), then excluded all of them.`,
      '',
      '  --filter or the exclude list in your config removed everything.',
      '  Widen the filter, or drop it to see the whole project.',
    ];
  }

  return [
    `  No components found in ${filesAnalyzed} TypeScript file(s).`,
    '',
    '  The files were read and none declared @Component. If you expected',
    '  some, check that you pointed at the right project root.',
  ];
}

function renderSummary(components: ComponentEntity[], major: number | null): string[] {
  const onPush = percentage(components, (c) => isOnPush(c, major));
  const standalone = percentage(components, (c) => isStandalone(c, major));
  const constructorFree = percentage(components, (c) => usesModernDi(c));

  const lines = [
    `  OnPush              ${formatPercent(onPush)}  ${bar(onPush)}`,
    `  Standalone          ${formatPercent(standalone)}  ${bar(standalone)}`,
    `  inject() only       ${formatPercent(constructorFree)}  ${bar(constructorFree)}`,
  ];

  const controlFlow = modernControlFlowRatio(components);
  if (controlFlow !== null) {
    lines.push(
      `  Modern control flow ${formatPercent(controlFlow)}  ${bar(controlFlow)}`,
    );
  }

  return lines;
}

/**
 * The migration burndown: modern blocks as a share of all control flow.
 *
 * Measured over blocks, not components, because that is what the migration
 * actually converts. A component with one `@if` and nine `*ngIf` is 10% done,
 * not 100%.
 *
 * Returns null when no component had a readable template, or when the project's
 * Angular predates @-blocks. Printing 0% there would report a project as
 * failing at something it could not attempt.
 */
function modernControlFlowRatio(components: ComponentEntity[]): number | null {
  let modern = 0;
  let legacy = 0;
  let measurable = false;

  for (const c of components) {
    const m = c.metrics.modernControlFlow;
    const l = c.metrics.legacyControlFlow;
    if (m === null && l === null) continue;
    measurable = true;
    modern += m ?? 0;
    legacy += l ?? 0;
  }

  if (!measurable) return null;
  const total = modern + legacy;
  if (total === 0) return null;
  return modern / total;
}

/**
 * Interpret the raw standalone flag.
 *
 * From v19 standalone is the default, so an absent flag means standalone.
 * Before v19 absence meant the opposite. This is the single most important
 * reason the flag is stored raw rather than as a boolean.
 */
function isStandalone(entity: ComponentEntity, major: number | null): boolean {
  const flag = entity.metrics.standaloneFlag;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return major !== null && capabilities(major).standaloneByDefault;
}

/** OnPush is never a default, so absence always means Default. */
function isOnPush(entity: ComponentEntity, _major: number | null): boolean {
  return entity.metrics.changeDetectionFlag === 'OnPush';
}

function usesModernDi(entity: ComponentEntity): boolean {
  return !entity.findings.some((f) => f.rule === 'constructor-di');
}

function renderNeedsAttention(components: ComponentEntity[], topN: number): string[] {
  const ranked = [...components].sort((a, b) => weight(b) - weight(a)).slice(0, topN);
  if (ranked.length === 0) return [];

  const nameWidth = Math.max(...ranked.map((c) => displayName(c).length), 4);

  const rows = ranked.map((c) => {
    const name = displayName(c).padEnd(nameWidth);
    const deps = cell(c.metrics.injectedDeps, 2);
    const tpl = cell(c.metrics.templateLoc, 4);
    const legacy = cell(c.metrics.legacyControlFlow, 2);
    const calls = cell(c.metrics.methodCallsInTemplate, 2);
    return `  ${name}  deps ${deps}  tpl ${tpl}  legacy ${legacy}  calls ${calls}`;
  });

  return ['Needs attention', ...rows];
}

/**
 * Ranking weight for the attention list.
 *
 * This orders rows for human reading. It is deliberately not exported, not
 * stored, and never shown as a number, so that nobody can be asked to improve
 * it. Raw counters are the product; this is only a sort key.
 */
function weight(entity: ComponentEntity): number {
  const { injectedDeps, classLoc, subscribeCalls, legacyControlFlow, methodCallsInTemplate } =
    entity.metrics;
  return (
    (injectedDeps ?? 0) * 3 +
    (classLoc ?? 0) / 20 +
    (subscribeCalls ?? 0) * 2 +
    (legacyControlFlow ?? 0) * 2 +
    (methodCallsInTemplate ?? 0)
  );
}

/** `-` for an unmeasured metric. A padded `0` would read as a real count. */
function cell(value: number | null, width: number): string {
  return (value === null ? '-' : String(value)).padStart(width);
}

function displayName(entity: ComponentEntity): string {
  const file = entity.filePath.split('/').pop() ?? entity.filePath;
  return file.replace(/\.component\.ts$/, '').replace(/\.ts$/, '');
}

function percentage(items: ComponentEntity[], predicate: (c: ComponentEntity) => boolean): number {
  if (items.length === 0) return 0;
  return items.filter(predicate).length / items.length;
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`.padStart(4);
}

function bar(ratio: number): string {
  const filled = Math.round(ratio * BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

function isComponent(entity: Entity): entity is ComponentEntity {
  return entity.kind === 'component';
}
