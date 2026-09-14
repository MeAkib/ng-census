import type { ParsedTemplate } from '@angular/compiler';
import type { Finding } from '../types.js';
import type { Capabilities } from '../version.js';
import { LineIndex, type ResolvedTemplate } from '../template.js';

/**
 * Rules that read the template AST.
 *
 * The walk is written by hand rather than with the compiler's visitor so that
 * an unrecognised node type lands in a `default` branch and is counted, not
 * silently dropped. A silent undercount is the worst possible failure here:
 * the number still looks plausible, so nobody investigates.
 *
 * **Reading this file for the first time?** Run
 * `node tools/print-template-ast.mjs '<div *ngIf="x">hi</div>'` first. The
 * node names in the `switch` below are exactly what that prints, and they are
 * not guessable: `*ngIf` becomes a `Template` node wrapping the element,
 * while `@if` becomes an `IfBlock` with `IfBlockBranch` children.
 *
 * Nodes are typed as `Record<string, unknown>` rather than with Angular's own
 * types on purpose. The shape of the AST is not part of Angular's public API
 * and changes between majors; matching on names keeps a new node type from
 * becoming a compile error, and the `default` branch turns it into a visible
 * warning instead of a silent undercount.
 *
 * One idea runs through the whole file: **a legacy pattern and its modern
 * replacement must produce the same numbers for everything except the
 * migration counters.** If converting `*ngIf` to `@if` also moved
 * `templateMaxDepth` or `bindingCount`, every trend line would show motion
 * that no developer caused, and a dashboard nobody trusts is worse than none.
 */

export interface TemplateRuleResult {
  templateLoc: number;
  templateMaxDepth: number;
  elementCount: number;
  bindingCount: number;
  methodCallsInTemplate: number;
  asyncPipes: number;
  legacyControlFlow: number;
  modernControlFlow: number | null;
  deferBlocks: number | null;
  loopsWithoutTrack: number;
  loopsTrackedByIndex: number | null;
  innerHtmlBindings: number;
  findings: Finding[];
  unknownNodeTypes: string[];
}

/**
 * Structural directives that desugar into a Template node.
 *
 * Only the primary attribute is listed. `*ngFor="let x of xs"` produces
 * `ngFor` plus `ngForOf`, and counting both would double every loop.
 */
const LEGACY_STRUCTURAL = new Set(['ngIf', 'ngFor', 'ngSwitchCase', 'ngSwitchDefault']);

/**
 * Structural directives that are branches of an enclosing block, not blocks of
 * their own.
 *
 * `*ngSwitchCase` is the counterpart of `@case`, and `@case` is not counted as
 * modern control flow — only the enclosing `@switch` is. So these emit a
 * finding (an agent still needs to know where they are) without adding to
 * `legacyControlFlow`. Otherwise a switch with three cases would score 4
 * legacy against 1 modern, and the migration ratio would read as barely
 * started on a project that had already converted half its switches.
 */
const LEGACY_BRANCHES = new Set(['ngSwitchCase', 'ngSwitchDefault']);

/**
 * Deliberately absent: `*ngTemplateOutlet` and `*ngPlural`.
 *
 * Both are structural directives, but neither has an @-block replacement, so
 * counting them would inflate a burndown that can never reach zero. This
 * metric measures migration progress; a pattern with nowhere to migrate to is
 * not part of it.
 */

/** `[ngSwitch]` binds to a real element, so it is found among inputs. */
const LEGACY_ELEMENT_BINDINGS = new Set(['ngSwitch']);

export function analyzeTemplate(
  parsed: ParsedTemplate,
  template: ResolvedTemplate,
  caps: Capabilities,
  signalFields: ReadonlySet<string>,
): TemplateRuleResult {
  const index = new LineIndex(template.source);
  const findings: Finding[] = [];
  const unknown = new Set<string>();

  const counts = {
    elementCount: 0,
    bindingCount: 0,
    methodCallsInTemplate: 0,
    asyncPipes: 0,
    legacyControlFlow: 0,
    modernControlFlow: 0,
    deferBlocks: 0,
    loopsWithoutTrack: 0,
    loopsTrackedByIndex: 0,
  };
  let maxDepth = 0;

  /** Translate a position in the template into a position in the reported file. */
  const inFile = (line: number, col: number) => ({
    file: template.file,
    line: line + template.lineOffset - 1,
    col,
  });

  const atSpan = (span: { start: { line: number; col: number } }) =>
    inFile(span.start.line + 1, span.start.col + 1);

  const atOffset = (offset: number) => {
    const { line, col } = index.at(offset);
    return inFile(line, col);
  };

  /** Walk a binding's expression AST for pipes and method calls. */
  function walkExpression(ast: unknown): void {
    if (ast === null || typeof ast !== 'object') return;
    const node = ast as Record<string, unknown>;
    const kind = node['constructor'] ? (node.constructor as { name: string }).name : '';

    if (kind === 'BindingPipe') {
      if (node['name'] === 'async') {
        counts.asyncPipes += 1;
      }
    }

    if (kind === 'Call') {
      const receiver = node['receiver'] as Record<string, unknown> | undefined;
      const name = typeof receiver?.['name'] === 'string' ? (receiver['name'] as string) : undefined;

      // A signal read looks exactly like a method call. `user()` is fine;
      // `getUser()` re-runs on every change detection cycle. The only thing
      // separating them without type information is whether the class declared
      // the field with signal()/computed()/input(). Documented as imperfect in
      // RULES.md, and it is: a signal passed in from elsewhere is miscounted.
      // That imprecision is why this metric reports but never gates — see the
      // note on GUARDED_METRICS in baseline.ts.
      if (name !== undefined && !signalFields.has(name)) {
        counts.methodCallsInTemplate += 1;
        const span = node['sourceSpan'] as { start: number } | undefined;
        findings.push({
          rule: 'method-call-in-template',
          ...atOffset(span?.start ?? 0),
          detail: `${name}()`,
        });
      }
    }

    // Every property name an expression node might hold a child under. There
    // is no common interface to walk, so the list is explicit. If a rule ever
    // misses a call inside some new expression form, a missing name here is
    // the first place to look.
    for (const key of ['ast', 'exp', 'expressions', 'args', 'receiver', 'left', 'right', 'condition', 'trueExp', 'falseExp', 'expression', 'obj', 'key', 'value']) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(walkExpression);
      else if (child && typeof child === 'object') walkExpression(child);
    }
  }

  /**
   * Visit one list of bindings.
   *
   * `countAsBindings` is false for the microsyntax of a desugared structural
   * directive: `*ngFor="let x of xs"` produces `ngForOf` and `ngForTrackBy`
   * BoundAttributes that the author never wrote as bindings, and `@for` has no
   * equivalent. The expressions inside are still walked, so `*ngIf="getUser()"`
   * is still caught as a method call.
   */
  function visitBindingList(list: unknown, countAsBindings: boolean): void {
    if (!Array.isArray(list)) return;

    for (const binding of list as Record<string, unknown>[]) {
      const kind = (binding.constructor as { name: string }).name;
      if (countAsBindings && (kind === 'BoundAttribute' || kind === 'BoundEvent')) {
        counts.bindingCount += 1;
      }

      if (kind === 'BoundAttribute' && isInnerHtml(binding['name'])) {
        findings.push({
          rule: 'inner-html-binding',
          ...atSpan(binding['sourceSpan'] as { start: { line: number; col: number } }),
        });
      }

      // Only `value` is walked, never a BoundEvent's `handler`. Calling a
      // method from (click) is what event handlers are for. The rule exists
      // to catch calls that re-run on every change detection cycle, and an
      // event handler does not. Counting them would make the metric noise.
      if (binding['value']) walkExpression(binding['value']);
    }
  }

  function walkBindings(node: Record<string, unknown>): void {
    for (const key of ['inputs', 'outputs', 'attributes', 'templateAttrs']) {
      visitBindingList(node[key], true);
    }
  }

  function walk(nodes: readonly unknown[], depth: number): void {
    for (const raw of nodes) {
      if (raw === null || typeof raw !== 'object') continue;
      const node = raw as Record<string, unknown>;
      const kind = (node.constructor as { name: string }).name;

      switch (kind) {
        case 'Element': {
          counts.elementCount += 1;
          maxDepth = Math.max(maxDepth, depth);
          walkBindings(node);
          countLegacyElementBinding(node);
          walk((node['children'] as unknown[]) ?? [], depth + 1);
          break;
        }

        case 'Template': {
          if (isDesugaredDirective(node)) {
            // A wrapper the author never wrote. It adds no level and no
            // bindings, exactly like the `@if` / `@for` block that replaces
            // it. Its `inputs` and `outputs` are copies of the host element's
            // and are counted there, so walking them here would double every
            // binding and every method call on a `*ngFor` row.
            visitBindingList(node['templateAttrs'], false);
            countLegacyStructural(node);
            walk((node['children'] as unknown[]) ?? [], depth);
          } else {
            // A real <ng-template>: an element the author wrote.
            maxDepth = Math.max(maxDepth, depth);
            walkBindings(node);
            walk((node['children'] as unknown[]) ?? [], depth + 1);
          }
          break;
        }

        case 'BoundText': {
          counts.bindingCount += 1;
          walkExpression(node['value']);
          break;
        }

        case 'Text':
        case 'TextAttribute':
        case 'Comment':
        case 'Icu':
          break;

        case 'IfBlock': {
          counts.modernControlFlow += 1;
          walk((node['branches'] as unknown[]) ?? [], depth);
          break;
        }

        case 'IfBlockBranch': {
          if (node['expression']) walkExpression(node['expression']);
          walk((node['children'] as unknown[]) ?? [], depth);
          break;
        }

        case 'SwitchBlock': {
          counts.modernControlFlow += 1;
          if (node['expression']) walkExpression(node['expression']);
          walk((node['cases'] as unknown[]) ?? [], depth);
          break;
        }

        case 'SwitchBlockCase': {
          if (node['expression']) walkExpression(node['expression']);
          walk((node['children'] as unknown[]) ?? [], depth);
          break;
        }

        case 'ForLoopBlock': {
          counts.modernControlFlow += 1;
          countTrackExpression(node);
          if (node['expression']) walkExpression(node['expression']);
          walk((node['children'] as unknown[]) ?? [], depth);
          if (node['empty']) walk([node['empty']], depth);
          break;
        }

        case 'ForLoopBlockEmpty':
        case 'DeferredBlockPlaceholder':
        case 'DeferredBlockLoading':
        case 'DeferredBlockError':
        case 'Content': {
          walk((node['children'] as unknown[]) ?? [], depth);
          break;
        }

        case 'DeferredBlock': {
          counts.deferBlocks += 1;
          walk((node['children'] as unknown[]) ?? [], depth);
          for (const key of ['placeholder', 'loading', 'error']) {
            if (node[key]) walk([node[key]], depth);
          }
          break;
        }

        case 'LetDeclaration': {
          if (node['value']) walkExpression(node['value']);
          break;
        }

        case 'UnknownBlock': {
          unknown.add(String(node['name'] ?? 'UnknownBlock'));
          break;
        }

        default: {
          // Never throw. A tool older than the project it is reading should
          // degrade into a visible warning, not a stack trace.
          unknown.add(kind);
          break;
        }
      }
    }
  }

  /**
   * True for a Template the compiler generated from a `*directive`.
   *
   * A hand-written `<ng-template>` has no `templateAttrs`; a desugared one
   * always does. Any `*directive` counts, including a project's own, because
   * the duplicated inputs and the extra nesting level are a property of the
   * desugaring, not of which directive was used.
   */
  function isDesugaredDirective(node: Record<string, unknown>): boolean {
    const attrs = node['templateAttrs'];
    return Array.isArray(attrs) && attrs.length > 0;
  }

  function countLegacyStructural(node: Record<string, unknown>): void {
    const attrs = (node['templateAttrs'] as Record<string, unknown>[] | undefined) ?? [];
    const primary = attrs.find((a) => LEGACY_STRUCTURAL.has(String(a['name'])));
    if (!primary) return;

    const name = String(primary['name']);
    const span = primary['sourceSpan'] as { start: { line: number; col: number } };

    // A branch is reported but not counted — see LEGACY_BRANCHES.
    if (!LEGACY_BRANCHES.has(name)) counts.legacyControlFlow += 1;

    findings.push({
      rule: 'legacy-control-flow',
      ...atSpan(span),
      detail: `*${name}`,
    });

    if (name === 'ngFor' && !attrs.some((a) => a['name'] === 'ngForTrackBy')) {
      counts.loopsWithoutTrack += 1;
      findings.push({
        rule: 'loop-without-track',
        ...atSpan(span),
        detail: '*ngFor without trackBy',
      });
    }
  }

  function countLegacyElementBinding(node: Record<string, unknown>): void {
    const inputs = (node['inputs'] as Record<string, unknown>[] | undefined) ?? [];
    for (const input of inputs) {
      if (!LEGACY_ELEMENT_BINDINGS.has(String(input['name']))) continue;
      counts.legacyControlFlow += 1;
      findings.push({
        rule: 'legacy-control-flow',
        ...atSpan(input['sourceSpan'] as { start: { line: number; col: number } }),
        detail: `[${String(input['name'])}]`,
      });
    }
  }

  /**
   * `@for` always has a track expression — the compiler requires one — so
   * `loopsWithoutTrack` cannot catch it. Tracking by `$index` is the real
   * problem: it defeats identity tracking exactly when the list reorders,
   * which is when tracking mattered. Counted separately so the two are never
   * confused in a trend line.
   */
  function countTrackExpression(node: Record<string, unknown>): void {
    const trackBy = node['trackBy'] as { source?: string } | undefined;
    const source = trackBy?.source?.trim();
    if (source !== '$index') return;

    counts.loopsTrackedByIndex += 1;
    findings.push({
      rule: 'loop-tracked-by-index',
      ...atSpan(node['sourceSpan'] as { start: { line: number; col: number } }),
      detail: 'track $index',
    });
  }

  walk(parsed.nodes, 1);

  return {
    templateLoc: index.countNonEmptyLines(),
    templateMaxDepth: maxDepth,
    elementCount: counts.elementCount,
    bindingCount: counts.bindingCount,
    methodCallsInTemplate: counts.methodCallsInTemplate,
    asyncPipes: counts.asyncPipes,
    legacyControlFlow: counts.legacyControlFlow,
    modernControlFlow: caps.controlFlowBlocks ? counts.modernControlFlow : null,
    deferBlocks: caps.deferBlocks ? counts.deferBlocks : null,
    loopsWithoutTrack: counts.loopsWithoutTrack,
    loopsTrackedByIndex: caps.controlFlowBlocks ? counts.loopsTrackedByIndex : null,
    innerHtmlBindings: findings.filter((f) => f.rule === 'inner-html-binding').length,
    findings,
    unknownNodeTypes: [...unknown].sort(),
  };
}

/** `[innerHTML]` and `[innerHtml]` are the same binding to Angular. */
function isInnerHtml(name: unknown): boolean {
  return typeof name === 'string' && name.toLowerCase() === 'innerhtml';
}
