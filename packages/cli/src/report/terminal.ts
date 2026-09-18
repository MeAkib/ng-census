import type { AnalysisResult, ComponentEntity } from '@ng-census/core';
import { LTS_END_DATES, MIN_FULL_SUPPORT, MIN_SUPPORTED, supportLevel } from '@ng-census/core';
import {
  attentionWeight,
  componentsOf,
  displayName,
  isOnPush,
  isStandalone,
  modernControlFlowRatio,
  percentage,
  usesModernDi,
} from './interpret.js';

/**
 * Terminal formatting.
 *
 * The analyzer stored what it saw; deciding what it meant happens at read
 * time. Those decisions live in `interpret.ts`, shared with the HTML report,
 * so two reporters can never give two different answers from the same run.
 *
 * Three percentages and the worst offenders. Everything else is behind
 * `--out` or `--json`: a terminal summary that scrolls is a summary nobody
 * reads.
 */

const BAR_WIDTH = 10;

export function renderTerminal(result: AnalysisResult, topN: number): string {
  const lines: string[] = [];
  const components = componentsOf(result);

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
  lines.push('  --out report.html for the full report, --json for the raw data');
  lines.push('');

  return lines.join('\n');
}

function renderHeader(result: AnalysisResult): string {
  const { run } = result;
  const version = run.angularVersion ?? 'unknown version';
  const count = componentsOf(result).length;
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
 * Driven by `supportLevel()` rather than by re-deriving the policy here. An
 * earlier version compared against `MIN_SUPPORTED` directly and silently said
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
  const onPush = percentage(components, isOnPush);
  const standalone = percentage(components, (c) => isStandalone(c, major));
  const constructorFree = percentage(components, usesModernDi);

  const lines = [
    `  OnPush              ${formatPercent(onPush)}  ${bar(onPush)}`,
    `  Standalone          ${formatPercent(standalone)}  ${bar(standalone)}`,
    `  inject() only       ${formatPercent(constructorFree)}  ${bar(constructorFree)}`,
  ];

  const controlFlow = modernControlFlowRatio(components);
  if (controlFlow !== null) {
    lines.push(`  Modern control flow ${formatPercent(controlFlow)}  ${bar(controlFlow)}`);
  }

  return lines;
}

function renderNeedsAttention(components: ComponentEntity[], topN: number): string[] {
  const ranked = [...components]
    .sort((a, b) => attentionWeight(b) - attentionWeight(a))
    .slice(0, topN);
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

/** `-` for an unmeasured metric. A padded `0` would read as a real count. */
function cell(value: number | null, width: number): string {
  return (value === null ? '-' : String(value)).padStart(width);
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`.padStart(4);
}

function bar(ratio: number): string {
  const filled = Math.round(ratio * BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}
