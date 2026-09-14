import type { AnalysisResult, ComponentEntity, Entity } from '@ng-census/core';

/**
 * One line per entity, for an agent.
 *
 * An agent cannot read a 147-component repo, but it can read 147 lines and
 * decide which three files to open. Density is the whole point: every field is
 * abbreviated, and nothing is printed that an agent would not branch on.
 */
export const DEFAULT_REPO_MAP_ROWS = 200;

export function renderRepoMap(result: AnalysisResult, top: number): string {
  const components = result.entities.filter(isComponent);
  const ranked = rank(components);
  const rows = ranked.slice(0, top);
  const omitted = ranked.length - rows.length;

  if (rows.length === 0) return '';

  const width = Math.max(...rows.map((c) => shortId(c).length), 1);

  // A map an agent cannot fit in its context is worse than no map: it evicts
  // the code the agent was reading. Rows are ranked by legacy weight first, so
  // a truncated map still names the files most worth opening.
  const footer =
    omitted > 0
      ? `\n# ${omitted} more entities not shown. --top ${ranked.length} for all.\n`
      : '';

  return (
    rows
      .map((c) => {
        const m = c.metrics;
        return [
          shortId(c).padEnd(width),
          `deps:${n(m.injectedDeps)}`,
          `in:${n(m.inputs)}`,
          `tpl:${n(m.templateLoc)}`,
          `legacy:${n(m.legacyControlFlow)}`,
          `modern:${n(m.modernControlFlow)}`,
          `onpush:${m.changeDetectionFlag === 'OnPush' ? 'yes' : 'no'}`,
        ].join(' ');
      })
      .join('\n') +
    '\n' +
    footer
  );
}

/** `null` prints as `-`, never as 0. The distinction survives into agent output. */
function n(value: number | null): string {
  return value === null ? '-' : String(value);
}

function shortId(entity: ComponentEntity): string {
  return entity.filePath
    .replace(/^src\/app\//, '')
    .replace(/\.component\.ts$/, '')
    .replace(/\.ts$/, '');
}

function rank(components: ComponentEntity[]): ComponentEntity[] {
  return [...components].sort(
    (a, b) => legacyWeight(b) - legacyWeight(a) || a.id.localeCompare(b.id),
  );
}

function legacyWeight(entity: ComponentEntity): number {
  const m = entity.metrics;
  return (m.legacyControlFlow ?? 0) + (m.subscribeCalls ?? 0) + (m.injectedDeps ?? 0);
}

function isComponent(entity: Entity): entity is ComponentEntity {
  return entity.kind === 'component';
}
