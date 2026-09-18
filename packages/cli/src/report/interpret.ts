import type { AnalysisResult, ComponentEntity, Entity } from '@ng-census/core';
import { capabilities } from '@ng-census/core';

/**
 * Turning raw observations into statements.
 *
 * Everything here answers a question the analyzer deliberately refused to
 * answer. `core` stores `standaloneFlag: "absent"` because that is what it
 * saw; deciding whether absence *means* standalone needs the Angular version,
 * and that decision belongs at read time (invariant I1). If it turns out to be
 * wrong, this file is the only thing that has to change and every past run
 * becomes correct.
 *
 * It lives apart from any one reporter so the terminal summary and the HTML
 * report cannot drift into disagreeing about what "64% standalone" means. Two
 * reporters giving two answers from one run would undo the whole point of a
 * deterministic tool.
 */

export function isComponent(entity: Entity): entity is ComponentEntity {
  return entity.kind === 'component';
}

export function componentsOf(result: AnalysisResult): ComponentEntity[] {
  return result.entities.filter(isComponent);
}

/**
 * Interpret the raw standalone flag.
 *
 * From v19 standalone is the default, so an absent flag means standalone.
 * Before v19 absence meant the opposite. This is the single most important
 * reason the flag is stored raw rather than as a boolean: read "absent" as
 * "not standalone" and every modern codebase reports 0%.
 */
export function isStandalone(entity: ComponentEntity, major: number | null): boolean {
  const flag = entity.metrics.standaloneFlag;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return major !== null && capabilities(major).standaloneByDefault;
}

/** OnPush is never a default, so absence always means Default. */
export function isOnPush(entity: ComponentEntity): boolean {
  return entity.metrics.changeDetectionFlag === 'OnPush';
}

export function usesModernDi(entity: ComponentEntity): boolean {
  return !entity.findings.some((f) => f.rule === 'constructor-di');
}

/**
 * The migration burndown: modern blocks as a share of all control flow.
 *
 * Measured over blocks, not components, because that is what the migration
 * actually converts. A component with one `@if` and nine `*ngIf` is 10% done,
 * not 100%.
 *
 * Returns null when no component had a readable template, or when the
 * project's Angular predates @-blocks. Showing 0% there would report a project
 * as failing at something it could not attempt.
 */
export function modernControlFlowRatio(components: readonly ComponentEntity[]): number | null {
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

export function percentage(
  items: readonly ComponentEntity[],
  predicate: (c: ComponentEntity) => boolean,
): number {
  if (items.length === 0) return 0;
  return items.filter(predicate).length / items.length;
}

/**
 * Ranking weight for the attention list.
 *
 * This orders rows for human reading. It is deliberately never shown as a
 * number and never stored, so that nobody can be asked to improve it. Raw
 * counters are the product; this is only a sort key.
 */
export function attentionWeight(entity: ComponentEntity): number {
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

/** The short name a person recognises: `order-list`, not the whole path. */
export function displayName(entity: ComponentEntity): string {
  const file = entity.filePath.split('/').pop() ?? entity.filePath;
  return file.replace(/\.component\.ts$/, '').replace(/\.ts$/, '');
}

/** Sum a metric across components, skipping nulls. Null if none were measurable. */
export function sumMetric(
  components: readonly ComponentEntity[],
  pick: (c: ComponentEntity) => number | null,
): number | null {
  let total = 0;
  let measurable = false;

  for (const component of components) {
    const value = pick(component);
    if (value === null) continue;
    measurable = true;
    total += value;
  }

  return measurable ? total : null;
}
