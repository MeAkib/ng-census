import type { AnalysisResult, Entity, EntityMetrics } from './types.js';

/**
 * Baseline capture and drift comparison.
 *
 * This is the CI gate. It answers one question: did anything get worse since
 * the last snapshot? Not "is this codebase good" — that is a judgement, and a
 * judgement cannot be a build step. "Worse than yesterday" is a fact.
 *
 * Pure data in, pure data out. Nothing here formats or exits; the CLI does
 * that, so the same comparison can back a PR bot and an MCP tool unchanged.
 */

export const BASELINE_VERSION = 1;

export interface BaselineEntity {
  id: string;
  kind: string;
  filePath: string;
  className: string;
  metrics: Record<string, unknown>;
}

export interface Baseline {
  baselineVersion: number;
  createdAt: string;
  toolVersion: string;
  commit: string | null;
  angularMajor: number | null;
  /**
   * The scope the baseline was taken with, or null for the whole project.
   *
   * Without it, a baseline of one application compared against a run over the
   * whole workspace reports every other application as a brand-new entity —
   * a wall of false debt that looks exactly like real drift.
   */
  scope: string | null;
  entities: BaselineEntity[];
}

/**
 * Which way is better, per metric.
 *
 * This list is short on purpose, and shrinking it was a deliberate decision.
 * Three tests must all pass before a metric belongs here:
 *
 * 1. **Exact.** No heuristic. A developer who sees the failure must be able to
 *    fix it. `methodCallsInTemplate` fails this: its signal-versus-method
 *    detection is documented as imperfect in RULES.md, and a false positive in
 *    a build gate is a wall with no door.
 * 2. **Not a target.** PRODUCT.md section 8 and RULES.md section 8 both warn
 *    that an agent told to reduce injected dependencies will hide nine
 *    services behind one facade. A CI gate is the strongest possible form of
 *    "here is a target", so `injectedDeps` must never be in this list. It is
 *    still reported, still charted, still in the attention list — just not a
 *    thing the build fails on.
 * 3. **Only moves when someone makes it worse.** Size metrics fail this: a
 *    component legitimately grows.
 *
 * "higher-is-better" metrics were removed for the third reason. Deleting a
 * dead `@if` block lowers `modernControlFlow`, and replacing an `async` pipe
 * with a signal lowers `asyncPipes`; both are improvements that a gate would
 * have called regressions. Progress is already visible in the legacy counters
 * going down.
 */
export type Direction = 'lower-is-better' | 'higher-is-better';

export const GUARDED_METRICS: Readonly<Record<string, Direction>> = {
  legacyControlFlow: 'lower-is-better',
  loopsWithoutTrack: 'lower-is-better',
  loopsTrackedByIndex: 'lower-is-better',
  innerHtmlBindings: 'lower-is-better',
  subscribeCalls: 'lower-is-better',
};

/**
 * What counts as debt on an entity that did not exist at the last baseline.
 *
 * This is deliberately *not* the guarded list. A new entity is compared
 * against nothing, so every non-zero counter would read as a failure — and a
 * gate that fails on `injectedDeps: 1` fails on every component anyone adds,
 * including a textbook-modern one that uses `inject()` exactly as intended.
 * That is not drift, it is a working codebase, and a gate that cannot tell the
 * difference gets deleted in a week.
 *
 * So only patterns from the legacy catalogue in RULES.md section 2 qualify:
 * things that are wrong on arrival in new code, whatever the rest of the
 * codebase looks like.
 */
const DEBT_METRICS: readonly string[] = [
  'legacyControlFlow',
  'loopsWithoutTrack',
  'loopsTrackedByIndex',
  'innerHtmlBindings',
  'subscribeCalls',
];

/** Raw decorator flags where one value is unambiguously a step backwards. */
const GUARDED_FLAGS: Readonly<Record<string, { good: string; label: string }>> = {
  changeDetectionFlag: { good: 'OnPush', label: 'change detection' },
  standaloneFlag: { good: 'true', label: 'standalone' },
};

/**
 * Flag values that are debt on a brand-new entity.
 *
 * Only an *explicit* backwards choice counts. `absent` is the normal state of
 * modern code — from v19 standalone is the default, and OnPush is never a
 * default — so treating absence as debt would fail every new component and
 * repeat the mistake this list exists to avoid.
 */
const DEBT_FLAGS: Readonly<Record<string, { bad: string; label: string }>> = {
  standaloneFlag: { bad: 'false', label: 'standalone' },
  changeDetectionFlag: { bad: 'Default', label: 'change detection' },
};

/** Human-readable names, so CI output does not make people read camelCase. */
export const METRIC_LABELS: Readonly<Record<string, string>> = {
  legacyControlFlow: 'legacy control flow',
  loopsWithoutTrack: 'loops without track',
  loopsTrackedByIndex: 'loops tracked by index',
  innerHtmlBindings: 'innerHTML bindings',
  methodCallsInTemplate: 'method calls in template',
  subscribeCalls: 'manual subscribes',
  injectedDeps: 'injected deps',
  modernControlFlow: 'modern control flow',
  asyncPipes: 'async pipes',
  signalApiCalls: 'signal API calls',
};

export function createBaseline(result: AnalysisResult): Baseline {
  return {
    baselineVersion: BASELINE_VERSION,
    createdAt: result.run.timestamp,
    toolVersion: result.run.toolVersion,
    commit: result.run.commit,
    angularMajor: result.run.angularMajor,
    scope: result.run.scope,
    entities: result.entities
      .map((entity) => ({
        id: entity.id,
        kind: entity.kind,
        filePath: entity.filePath,
        className: entity.className,
        // Copied, not referenced. Aliasing the live metrics object would mean
        // that anything mutating the result afterwards silently rewrites the
        // baseline too, and a comparison against it could never report a
        // change. Metric values are primitives, so a shallow copy is enough.
        metrics: { ...(entity.metrics as unknown as Record<string, unknown>) },
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export interface MetricChange {
  entityId: string;
  displayName: string;
  metric: string;
  label: string;
  from: number | string;
  to: number | string;
}

export interface NewEntityDebt {
  entityId: string;
  displayName: string;
  metric: string;
  label: string;
  /** A count for a metric, or the offending value for a raw flag. */
  value: number | string;
}

export interface DriftReport {
  regressions: MetricChange[];
  improvements: MetricChange[];
  /**
   * Legacy patterns arriving in entities that did not exist at baseline.
   *
   * Tracked separately because a brand-new component cannot "regress" — it has
   * nothing to be compared against — yet a newly generated component full of
   * *ngIf is precisely the drift this tool exists to catch. Without this
   * category the gate would pass every AI-written file on the grounds that it
   * is new.
   */
  newEntityDebt: NewEntityDebt[];
  addedEntities: string[];
  removedEntities: string[];
  unchangedCount: number;
  comparedCount: number;
}

export function compareToBaseline(baseline: Baseline, result: AnalysisResult): DriftReport {
  const previous = new Map(baseline.entities.map((e) => [e.id, e]));
  const regressions: MetricChange[] = [];
  const improvements: MetricChange[] = [];
  const newEntityDebt: NewEntityDebt[] = [];
  const addedEntities: string[] = [];
  let unchangedCount = 0;
  let comparedCount = 0;

  for (const entity of result.entities) {
    const before = previous.get(entity.id);

    if (!before) {
      addedEntities.push(entity.id);
      newEntityDebt.push(...debtOf(entity));
      continue;
    }

    previous.delete(entity.id);
    comparedCount += 1;

    const changes = diffEntity(before, entity);
    if (changes.regressions.length === 0) unchangedCount += 1;
    regressions.push(...changes.regressions);
    improvements.push(...changes.improvements);
  }

  return {
    regressions,
    improvements,
    newEntityDebt,
    addedEntities: addedEntities.sort(),
    removedEntities: [...previous.keys()].sort(),
    unchangedCount,
    comparedCount,
  };
}

function diffEntity(
  before: BaselineEntity,
  after: Entity,
): { regressions: MetricChange[]; improvements: MetricChange[] } {
  const regressions: MetricChange[] = [];
  const improvements: MetricChange[] = [];
  const now = after.metrics as unknown as Record<string, unknown>;

  for (const [metric, direction] of Object.entries(GUARDED_METRICS)) {
    const from = before.metrics[metric];
    const to = now[metric];

    // Invariant I2 in practice. A metric that was null and is now a number
    // was not measurable before — usually because the baseline predates the
    // rule. That is new information, not a regression, and treating null as
    // zero here would flag every component the first time a rule ships.
    if (typeof from !== 'number' || typeof to !== 'number') continue;
    if (from === to) continue;

    const worse = direction === 'lower-is-better' ? to > from : to < from;
    const change: MetricChange = {
      entityId: after.id,
      displayName: displayName(after.filePath, after.className),
      metric,
      label: METRIC_LABELS[metric] ?? metric,
      from,
      to,
    };

    if (worse) regressions.push(change);
    else improvements.push(change);
  }

  for (const [flag, { good, label }] of Object.entries(GUARDED_FLAGS)) {
    const from = before.metrics[flag];
    const to = now[flag];
    if (typeof from !== 'string' || typeof to !== 'string') continue;
    if (from === to) continue;

    const change: MetricChange = {
      entityId: after.id,
      displayName: displayName(after.filePath, after.className),
      metric: flag,
      label,
      from,
      to,
    };

    if (from === good && to !== good) regressions.push(change);
    else if (to === good) improvements.push(change);
  }

  return { regressions, improvements };
}

/** Legacy patterns an entity arrives with. Only ever counted for new entities. */
function debtOf(entity: Entity): NewEntityDebt[] {
  const metrics = entity.metrics as unknown as Record<string, unknown>;
  const debt: NewEntityDebt[] = [];

  for (const metric of DEBT_METRICS) {
    const value = metrics[metric];
    if (typeof value !== 'number' || value === 0) continue;

    debt.push({
      entityId: entity.id,
      displayName: displayName(entity.filePath, entity.className),
      metric,
      label: METRIC_LABELS[metric] ?? metric,
      value,
    });
  }

  for (const [flag, { bad, label }] of Object.entries(DEBT_FLAGS)) {
    if (metrics[flag] !== bad) continue;

    debt.push({
      entityId: entity.id,
      displayName: displayName(entity.filePath, entity.className),
      metric: flag,
      label,
      value: bad,
    });
  }

  return debt;
}

function displayName(filePath: string, className: string): string {
  const file = filePath.split('/').pop();
  if (!file) return className;
  return file.replace(/\.component\.ts$/, '').replace(/\.ts$/, '');
}

/** Validate an unknown parsed JSON blob before trusting it as a baseline. */
export function isBaseline(value: unknown): value is Baseline {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['baselineVersion'] === 'number' && Array.isArray(candidate['entities'])
  );
}

export type { EntityMetrics };
