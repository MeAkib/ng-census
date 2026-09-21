import type { AnalysisResult, ComponentEntity, Finding } from '@ng-census/core';
import { LTS_END_DATES, TOOL_VERSION } from '@ng-census/core';
import {
  attentionWeight,
  componentsOf,
  displayName,
  isOnPush,
  isStandalone,
  modernControlFlowRatio,
  percentage,
  sumMetric,
  usesModernDi,
} from './interpret.js';

/**
 * The HTML report.
 *
 * One self-contained file: no scripts, no fonts, no network. It has to open
 * from a file:// path on a laptop with no internet, survive being emailed, and
 * print. That rules out a framework, and a framework would not have helped —
 * the page never changes after it is written.
 *
 * The terminal summary says *that* something is worth looking at. The JSON
 * says *where*, in a form no one reads. This is the middle: enough to act on
 * and enough to show someone.
 *
 * Two rules from PRODUCT.md shape how it looks, and both are worth stating
 * because they read as missing features until you know why:
 *
 * **No score, anywhere.** Not a grade, not a total, not a letter. The moment a
 * single number exists someone is asked to raise it, and raising a number is
 * always easier than fixing anything.
 *
 * **Meters are not coloured by how good the number is.** A red bar at 38%
 * OnPush asserts that 38% is failing — a judgement this tool does not make.
 * Every meter uses one neutral accent and states its own number. The status
 * palette is reserved for the one fact here that is external and dated: the
 * Angular LTS deadline.
 */

/** Findings listed per rule before the list is cut short. */
const MAX_FINDINGS_PER_RULE = 150;

/** Rows in the attention table. */
const ATTENTION_ROWS = 15;

/**
 * Rules whose counts are the migration burndown, in reading order, with the
 * modern form each one converts to. Anything not here is reported elsewhere;
 * this table is what a migration actually burns down.
 */
const BURNDOWN_RULES: ReadonlyArray<{ rule: string; label: string; modern: string }> = [
  { rule: 'legacy-control-flow', label: 'Legacy control flow', modern: '@if / @for / @switch' },
  { rule: 'constructor-di', label: 'Constructor injection', modern: 'inject()' },
  { rule: 'decorator-input', label: '@Input() decorator', modern: 'input()' },
  { rule: 'decorator-output', label: '@Output() decorator', modern: 'output()' },
  { rule: 'ngmodule-component', label: 'Declared standalone: false', modern: 'standalone' },
  { rule: 'manual-subscribe', label: 'Manual .subscribe()', modern: 'async pipe or toSignal()' },
  { rule: 'destroy-subject', label: 'ngOnDestroy teardown Subject', modern: 'takeUntilDestroyed()' },
  { rule: 'behaviorsubject-state', label: 'BehaviorSubject as state', modern: 'signal()' },
  { rule: 'missing-onpush', label: 'No OnPush and no signals', modern: 'OnPush, zoneless-ready' },
  { rule: 'empty-lifecycle-hook', label: 'Empty lifecycle hook', modern: 'delete it' },
  { rule: 'empty-constructor', label: 'Empty constructor', modern: 'delete it' },
  { rule: 'loop-without-track', label: '*ngFor without trackBy', modern: '@for with track' },
  { rule: 'loop-tracked-by-index', label: '@for tracked by $index', modern: 'track by identity' },
  { rule: 'method-call-in-template', label: 'Method call in a binding', modern: 'a signal or a field' },
  { rule: 'inner-html-binding', label: '[innerHTML] binding', modern: 'a sanitized alternative' },
];

export function renderHtml(result: AnalysisResult, projectRoot: string): string {
  const components = componentsOf(result);
  const major = result.run.angularMajor;

  const title = `ng-census · ${lastSegment(projectRoot)}`;

  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLES}</style>`,
    `</head>`,
    `<body>`,
    `<main>`,
    renderHeader(result, projectRoot, components),
    components.length === 0 ? renderEmpty(result) : renderBody(result, components, major),
    renderFooter(result),
    `</main>`,
    `</body>`,
    `</html>`,
    ``,
  ].join('\n');
}

function renderBody(
  result: AnalysisResult,
  components: ComponentEntity[],
  major: number | null,
): string {
  return [
    renderHero(components, major),
    renderDeadline(result),
    renderBurndown(components),
    renderAttention(components, major),
    renderByFolder(components, major),
    renderFindings(components),
  ].join('\n');
}

// ---------------------------------------------------------------- header ---

function renderHeader(
  result: AnalysisResult,
  projectRoot: string,
  components: ComponentEntity[],
): string {
  const { run } = result;
  const facts = [
    run.angularVersion ? `Angular ${escapeHtml(run.angularVersion)}` : 'Angular version unknown',
    run.scope ? escapeHtml(run.scope) : null,
    `${components.length} ${plural(components.length, 'component', 'components')}`,
    `${run.filesAnalyzed} ${plural(run.filesAnalyzed, 'file', 'files')} read`,
  ].filter((fact): fact is string => fact !== null);

  return [
    `<header>`,
    `<p class="eyebrow">ng-census report</p>`,
    `<h1>${escapeHtml(lastSegment(projectRoot))}</h1>`,
    `<p class="facts">${facts.join(' · ')}</p>`,
    `<p class="muted">${escapeHtml(formatDate(run.timestamp))}${
      run.commit ? ` · commit ${escapeHtml(run.commit.slice(0, 7))}` : ''
    }${run.branch ? ` · ${escapeHtml(run.branch)}` : ''}</p>`,
    run.angularMajorSource === 'assumed' ? renderAssumedVersionNote(run.capabilityMajor) : '',
    `</header>`,
  ].join('\n');
}

function renderAssumedVersionNote(assumed: number): string {
  return note(
    'warning',
    'The Angular version could not be detected',
    `Version-gated numbers were computed as if this project were on Angular ${assumed}. ` +
      `Run npm install in the project so @angular/core can be read, then run the report again.`,
  );
}

// ------------------------------------------------------------------ hero ---

/**
 * One hero figure, and only one.
 *
 * The migration burndown is the number this tool exists to produce, so it gets
 * the large type. The other three are stat tiles beside it, not competitors.
 */
function renderHero(components: ComponentEntity[], major: number | null): string {
  const controlFlow = modernControlFlowRatio(components);

  const hero =
    controlFlow === null
      ? `<p class="hero-value">${components.length}</p>
         <p class="hero-label">components measured</p>
         <p class="hero-note">No control flow blocks were found to compare, so there is no
         migration ratio yet.</p>`
      : `<p class="hero-value">${formatPercent(controlFlow)}</p>
         <p class="hero-label">of control flow is modern</p>
         <p class="hero-note">Counted over blocks, not components. A component with one
         <code>@if</code> and nine <code>*ngIf</code> is 10% done, not 100%.</p>
         ${meter(controlFlow)}`;

  const tiles = [
    tile('OnPush', percentage(components, isOnPush), components, isOnPush),
    tile(
      'Standalone',
      percentage(components, (c) => isStandalone(c, major)),
      components,
      (c) => isStandalone(c, major),
    ),
    tile('inject() only', percentage(components, usesModernDi), components, usesModernDi),
  ].join('\n');

  return [
    `<section class="hero">`,
    `<div class="hero-figure">${hero}</div>`,
    `<div class="tiles">${tiles}</div>`,
    `</section>`,
  ].join('\n');
}

function tile(
  label: string,
  ratio: number,
  components: ComponentEntity[],
  predicate: (c: ComponentEntity) => boolean,
): string {
  const count = components.filter(predicate).length;
  return [
    `<div class="tile">`,
    `<p class="tile-label">${escapeHtml(label)}</p>`,
    `<p class="tile-value">${formatPercent(ratio)}</p>`,
    meter(ratio),
    `<p class="tile-sub">${count} of ${components.length}</p>`,
    `</div>`,
  ].join('\n');
}

/**
 * A meter, in one neutral accent.
 *
 * Deliberately not coloured by value. See the note at the top of this file:
 * a red bar asserts that the number is failing, and this tool does not decide
 * what a good number is.
 */
function meter(ratio: number): string {
  const percent = Math.round(ratio * 100);
  return (
    `<div class="meter" role="img" aria-label="${percent} percent">` +
    `<div class="meter-fill" style="width:${percent}%"></div></div>`
  );
}

// -------------------------------------------------------------- deadline ---

/**
 * The migration deadline.
 *
 * The one place the status palette is used, because it is the one fact on the
 * page that is external, dated and not a judgement: Angular's published LTS
 * end date. Everything else here is a count.
 */
function renderDeadline(result: AnalysisResult): string {
  const major = result.run.angularMajor;
  if (major === null) return '';

  const ends = LTS_END_DATES[major];
  if (!ends) return '';

  const days = daysUntil(ends);
  if (days === null) return '';

  if (days < 0) {
    return note(
      'critical',
      `Angular ${major} support ended on ${ends}`,
      'Security fixes have stopped for this major version.',
    );
  }

  const months = Math.round(days / 30);
  const level = days < 180 ? 'serious' : 'good';

  return note(
    level,
    `Angular ${major} support ends ${ends}`,
    `${days} days away, about ${months} ${plural(months, 'month', 'months')}. ` +
      `This date is published by the Angular team, not calculated here.`,
  );
}

// ------------------------------------------------------------- burndown ---

function renderBurndown(components: ComponentEntity[]): string {
  const counts = countFindingsByRule(components);

  const rows = BURNDOWN_RULES.map(({ rule, label, modern }) => {
    const entry = counts.get(rule);
    if (!entry || entry.total === 0) return '';
    return (
      `<tr><th scope="row">${escapeHtml(label)}</th>` +
      `<td class="num">${entry.total}</td>` +
      `<td class="num">${entry.files.size}</td>` +
      `<td class="modern"><code>${escapeHtml(modern)}</code></td></tr>`
    );
  }).join('\n');

  if (rows.trim() === '') {
    return section(
      'What is left to migrate',
      `<p class="clean">Nothing from the legacy catalogue was found. ` +
        `Every rule in <code>RULES.md</code> section 2 came back empty.</p>`,
    );
  }

  const trackable = sumMetric(components, (c) => c.metrics.legacyControlFlow);

  return section(
    'What is left to migrate',
    [
      `<p class="lede">Every row is a count of real occurrences with a file and a line behind
       it, listed in full further down. There is no total and no score: these are separate
       decisions, and adding them together would only invite someone to be asked to lower
       the sum.</p>`,
      `<table>`,
      `<thead><tr><th scope="col">Pattern</th><th scope="col" class="num">Occurrences</th>`,
      `<th scope="col" class="num">Files</th><th scope="col">Modern form</th></tr></thead>`,
      `<tbody>${rows}</tbody>`,
      `</table>`,
      trackable === null
        ? ''
        : `<p class="muted">Angular ships schematics for several of these, and they do the
           migration better than any edit by hand. What a schematic cannot tell you is how
           much is left, or whether new legacy code arrived after it ran.</p>`,
    ].join('\n'),
  );
}

// ------------------------------------------------------------ attention ---

function renderAttention(components: ComponentEntity[], major: number | null): string {
  const ranked = [...components]
    .sort((a, b) => attentionWeight(b) - attentionWeight(a))
    .slice(0, ATTENTION_ROWS);

  const rows = ranked
    .map((c) => {
      const m = c.metrics;
      return (
        `<tr>` +
        `<th scope="row"><span class="name">${escapeHtml(displayName(c))}</span>` +
        `<span class="path">${escapeHtml(c.filePath)}</span></th>` +
        `<td class="num">${cell(m.injectedDeps)}</td>` +
        `<td class="num">${cell(m.classLoc)}</td>` +
        `<td class="num">${cell(m.templateLoc)}</td>` +
        `<td class="num">${cell(m.legacyControlFlow)}</td>` +
        `<td class="num">${cell(m.subscribeCalls)}</td>` +
        `<td>${isOnPush(c) ? 'OnPush' : '—'}</td>` +
        `<td>${isStandalone(c, major) ? 'yes' : 'no'}</td>` +
        `</tr>`
      );
    })
    .join('\n');

  return section(
    'Worth opening first',
    [
      `<p class="lede">Ordered by a rough weight over dependencies, size, subscriptions and
       legacy blocks. The weight is never shown as a number and never stored, so that nobody
       can be asked to improve it — it only decides the order of these rows.</p>`,
      `<table>`,
      `<thead><tr><th scope="col">Component</th><th scope="col" class="num">Deps</th>`,
      `<th scope="col" class="num">Class</th><th scope="col" class="num">Template</th>`,
      `<th scope="col" class="num">Legacy</th><th scope="col" class="num">Subs</th>`,
      `<th scope="col">Change detection</th><th scope="col">Standalone</th></tr></thead>`,
      `<tbody>${rows}</tbody>`,
      `</table>`,
      `<p class="muted">A dash means the metric could not be measured — usually a template
       that failed to open. It never means zero.</p>`,
    ].join('\n'),
  );
}

// -------------------------------------------------------------- folders ---

/**
 * Progress per top-level folder.
 *
 * In a multi-project workspace this is the per-application view without
 * needing four separate runs. Aggregated to a folder, never to a person:
 * per-developer attribution turns a diagnostic into surveillance, and the
 * moment that view exists engineers stop trusting the numbers.
 */
function renderByFolder(components: ComponentEntity[], major: number | null): string {
  const groups = new Map<string, ComponentEntity[]>();

  for (const component of components) {
    const parts = component.filePath.split('/');
    const key = parts.length > 2 ? parts.slice(0, 2).join('/') : (parts[0] ?? '.');
    const bucket = groups.get(key);
    if (bucket) bucket.push(component);
    else groups.set(key, [component]);
  }

  if (groups.size < 2) return '';

  const rows = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([folder, group]) => {
      const controlFlow = modernControlFlowRatio(group);
      return (
        `<tr><th scope="row"><code>${escapeHtml(folder)}</code></th>` +
        `<td class="num">${group.length}</td>` +
        `<td class="num">${controlFlow === null ? '—' : formatPercent(controlFlow)}</td>` +
        `<td class="num">${formatPercent(percentage(group, isOnPush))}</td>` +
        `<td class="num">${formatPercent(percentage(group, (c) => isStandalone(c, major)))}</td>` +
        `</tr>`
      );
    })
    .join('\n');

  return section(
    'By folder',
    [
      `<table>`,
      `<thead><tr><th scope="col">Folder</th><th scope="col" class="num">Components</th>`,
      `<th scope="col" class="num">Modern control flow</th>`,
      `<th scope="col" class="num">OnPush</th><th scope="col" class="num">Standalone</th></tr></thead>`,
      `<tbody>${rows}</tbody>`,
      `</table>`,
    ].join('\n'),
  );
}

// ------------------------------------------------------------- findings ---

function renderFindings(components: ComponentEntity[]): string {
  const byRule = new Map<string, Finding[]>();

  for (const component of components) {
    for (const finding of component.findings) {
      const bucket = byRule.get(finding.rule);
      if (bucket) bucket.push(finding);
      else byRule.set(finding.rule, [finding]);
    }
  }

  if (byRule.size === 0) return '';

  const blocks = [...byRule.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([rule, findings], index) => {
      const shown = findings.slice(0, MAX_FINDINGS_PER_RULE);
      const hidden = findings.length - shown.length;

      const items = shown
        .map(
          (f) =>
            `<li><code>${escapeHtml(f.file)}:${f.line}:${f.col}</code>` +
            (f.detail ? ` <span class="detail">${escapeHtml(f.detail)}</span>` : '') +
            `</li>`,
        )
        .join('\n');

      return [
        // The largest group opens by default. A page of closed rows looks
        // like an index rather than a work list, and the reader has to guess
        // that clicking does anything.
        index === 0 ? `<details open>` : `<details>`,
        `<summary><code>${escapeHtml(rule)}</code>`,
        `<span class="count">${findings.length}</span></summary>`,
        `<ul class="findings">${items}</ul>`,
        hidden > 0
          ? `<p class="muted">and ${hidden} more — run with <code>--out</code> for the full JSON.</p>`
          : '',
        `</details>`,
      ].join('\n');
    })
    .join('\n');

  return section(
    'Every finding',
    [
      `<p class="lede">Each one has a file, a line and a column, so an editor or an agent can
       go straight to it. Select a rule to see where it occurs.</p>`,
      blocks,
    ].join('\n'),
  );
}

// ---------------------------------------------------------------- empty ---

function renderEmpty(result: AnalysisResult): string {
  const { filesScanned, filesAnalyzed } = result.run;

  if (filesScanned === 0) {
    return section(
      'No files were read',
      `<p class="lede">Nothing was read, so this report says nothing about your components.
       Check that the path is the project root. These folders are skipped:
       <code>node_modules</code>, <code>dist</code>, <code>out-tsc</code>,
       <code>coverage</code>, <code>.angular</code>, <code>.nx</code>,
       <code>bazel-out</code>, and anything beginning with a dot.</p>`,
    );
  }

  if (filesAnalyzed === 0) {
    return section(
      'Everything was filtered out',
      `<p class="lede">${filesScanned} files were found, then a filter removed all of them.
       Check <code>--filter</code> and any <code>.ng-censusrc</code> in the project.</p>`,
    );
  }

  return section(
    'No components found',
    `<p class="lede">${filesAnalyzed} files were read and none declared
     <code>@Component</code>.</p>`,
  );
}

// --------------------------------------------------------------- footer ---

function renderFooter(result: AnalysisResult): string {
  return [
    `<footer>`,
    `<p>Produced by ng-census ${escapeHtml(TOOL_VERSION)} from a single run. The same
     codebase always produces the same numbers — there is no model and no sampling
     anywhere in the tool.</p>`,
    `<p>A dash means a metric could not be measured on this Angular version, or that a
     template could not be read. It never means zero.</p>`,
    `<p>Every metric is defined exactly in <code>RULES.md</code>. Run
     <code>ng-census check</code> in CI to fail a build when any of these gets worse.</p>`,
    `<p class="muted">Run id ${escapeHtml(result.run.id)}</p>`,
    `</footer>`,
  ].join('\n');
}

// ----------------------------------------------------------- small bits ---

function section(heading: string, body: string): string {
  return `<section><h2>${escapeHtml(heading)}</h2>\n${body}\n</section>`;
}

function note(level: 'good' | 'warning' | 'serious' | 'critical', heading: string, body: string): string {
  // The label carries the meaning; the colour only reinforces it. A status
  // colour never speaks alone.
  return [
    `<aside class="note note-${level}">`,
    `<p class="note-heading">${escapeHtml(heading)}</p>`,
    `<p>${escapeHtml(body)}</p>`,
    `</aside>`,
  ].join('\n');
}

function countFindingsByRule(
  components: readonly ComponentEntity[],
): Map<string, { total: number; files: Set<string> }> {
  const counts = new Map<string, { total: number; files: Set<string> }>();

  for (const component of components) {
    for (const finding of component.findings) {
      const entry = counts.get(finding.rule) ?? { total: 0, files: new Set<string>() };
      entry.total += 1;
      entry.files.add(finding.file);
      counts.set(finding.rule, entry);
    }
  }

  return counts;
}

function cell(value: number | null): string {
  return value === null ? '—' : String(value);
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function lastSegment(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function daysUntil(isoDate: string): number | null {
  const target = new Date(`${isoDate}T00:00:00Z`).getTime();
  if (Number.isNaN(target)) return null;
  return Math.round((target - Date.now()) / 86_400_000);
}

/**
 * Escape text that came from the analyzed codebase.
 *
 * File paths, class names and finding details are all attacker-adjacent: they
 * come from whatever is in the repository. A component named
 * `<img onerror=...>` must not become markup in a file someone opens in a
 * browser. Everything interpolated into this page goes through here.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLES = `
:root {
  color-scheme: light;
  --page: #f9f9f7;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --muted: #898781;
  --line: #e1e0d9;
  --accent: #2a78d6;
  --track: #dce8f7;
  --good: #0ca30c;
  --warning: #fab219;
  --serious: #ec835a;
  --critical: #d03b3b;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --page: #0d0d0d;
    --surface: #1a1a19;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --muted: #898781;
    --line: #2c2c2a;
    --accent: #3987e5;
    --track: #24303d;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0 16px;
  background: var(--page);
  color: var(--ink);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
main { max-width: 68rem; margin: 0 auto; padding-block: 40px 64px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
h1 { font-size: 1.9rem; margin: 4px 0 8px; letter-spacing: -0.02em; }
h2 { font-size: 1.15rem; margin: 0 0 12px; letter-spacing: -0.01em; }
p { margin: 0 0 10px; }
.eyebrow { color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.72rem; margin: 0; }
.facts { color: var(--ink-2); margin: 0 0 2px; }
.muted { color: var(--muted); font-size: 0.86rem; }
.lede { color: var(--ink-2); max-width: 60ch; }
.clean { color: var(--ink-2); }
header { border-bottom: 1px solid var(--line); padding-bottom: 24px; margin-bottom: 28px; }
section { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 20px; margin-bottom: 20px; }
.hero { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 28px; align-items: start; }
.hero-value { font-size: 3.6rem; line-height: 1; font-weight: 650; margin: 0 0 4px; letter-spacing: -0.03em; }
.hero-label { font-size: 1.05rem; color: var(--ink-2); margin: 0 0 10px; }
.hero-note { color: var(--muted); font-size: 0.86rem; max-width: 40ch; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 14px; }
.tile { border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
.tile-label { color: var(--ink-2); font-size: 0.82rem; margin: 0 0 2px; }
.tile-value { font-size: 1.6rem; font-weight: 640; margin: 0 0 8px; letter-spacing: -0.02em; }
.tile-sub { color: var(--muted); font-size: 0.78rem; margin: 6px 0 0; font-variant-numeric: tabular-nums; }
.meter { height: 6px; background: var(--track); border-radius: 3px; overflow: hidden; }
.meter-fill { height: 100%; background: var(--accent); border-radius: 3px; }
.hero .meter { margin-top: 14px; max-width: 24rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
thead th { text-align: left; font-weight: 600; color: var(--ink-2); border-bottom: 1px solid var(--line); padding: 8px 10px; white-space: nowrap; }
tbody th { text-align: left; font-weight: 500; padding: 8px 10px; border-bottom: 1px solid var(--line); }
td { padding: 8px 10px; border-bottom: 1px solid var(--line); color: var(--ink-2); }
tbody tr:last-child th, tbody tr:last-child td { border-bottom: none; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.modern code { color: var(--ink-2); }
.name { display: block; }
.path { display: block; color: var(--muted); font-size: 0.76rem; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.note { border: 1px solid var(--line); border-left: 4px solid var(--muted); border-radius: 6px; padding: 12px 14px; margin: 16px 0 0; background: var(--surface); }
.note p { margin: 0; color: var(--ink-2); font-size: 0.88rem; }
.note-heading { font-weight: 600; color: var(--ink) !important; margin-bottom: 2px !important; }
.note-good { border-left-color: var(--good); }
.note-warning { border-left-color: var(--warning); }
.note-serious { border-left-color: var(--serious); }
.note-critical { border-left-color: var(--critical); }
details { border-top: 1px solid var(--line); padding: 10px 0; }
details:first-of-type { border-top: none; }
summary { cursor: pointer; font-weight: 500; display: flex; align-items: baseline; gap: 10px; }
summary .count { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 0.85rem; }
.findings { list-style: none; margin: 10px 0 0; padding: 0; columns: 2; column-gap: 28px; }
.findings li { font-size: 0.82rem; color: var(--ink-2); break-inside: avoid; margin-bottom: 3px; }
.findings .detail { color: var(--muted); }
footer { color: var(--muted); font-size: 0.84rem; border-top: 1px solid var(--line); padding-top: 20px; }
footer p { max-width: 70ch; }
@media (max-width: 720px) {
  .hero { grid-template-columns: 1fr; gap: 20px; }
  .findings { columns: 1; }
  /* Scroll rather than squeeze. A column crushed to two words per line is
     harder to read than one the reader swipes to. */
  section > table { display: block; overflow-x: auto; }
  section > table tbody, section > table thead { display: table; min-width: 34rem; width: 100%; }
  .path { word-break: break-all; }
}
@media print {
  body { background: #fff; }
  section { break-inside: avoid; border-color: #ccc; }
  details { display: block; }
  details > ul { display: block !important; }
}
`;
