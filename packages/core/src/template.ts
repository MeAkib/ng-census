import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { parseTemplate } from '@angular/compiler';
import type { ParsedTemplate } from '@angular/compiler';

/**
 * Template resolution and parsing.
 *
 * Reading a component's own template is the one place v1 opens a second file.
 * That is not a violation of the single-file rule: the template is part of the
 * component, not a reference to another entity. Nothing here follows an import
 * or resolves a selector.
 */

/** Where a template's text came from, and how to report positions inside it. */
export interface ResolvedTemplate {
  source: string;
  /** Repo-relative path findings should be reported against. */
  file: string;
  /**
   * Line number in `file` that template line 1 corresponds to.
   *
   * For an external template this is 1. For an inline template it is the line
   * the literal starts on, so findings point into the .ts file at the right
   * place rather than at line 1 of a string nobody can navigate to.
   */
  lineOffset: number;
}

export type TemplateResolution =
  | { ok: true; template: ResolvedTemplate }
  | { ok: false; reason: 'missing' | 'unreadable' | 'not-declared' };

export interface TemplateSourceSpec {
  templateKind: 'inline' | 'external' | 'missing';
  inlineTemplate: string | undefined;
  inlineTemplateLine: number | undefined;
  templateUrl: string | undefined;
}

/**
 * Find the component's template.
 *
 * A component whose template cannot be read is reported with
 * `templateResolved: false` and null template metrics. It must never crash the
 * run: a missing .html file is a normal state in a repo mid-refactor, and one
 * of them must not cost you the other 146 components' numbers.
 */
export function resolveTemplate(
  spec: TemplateSourceSpec,
  componentFile: string,
  projectRoot: string,
): TemplateResolution {
  if (spec.templateKind === 'inline' && spec.inlineTemplate !== undefined) {
    return {
      ok: true,
      template: {
        source: spec.inlineTemplate,
        file: componentFile,
        lineOffset: spec.inlineTemplateLine ?? 1,
      },
    };
  }

  if (spec.templateKind === 'external' && spec.templateUrl !== undefined) {
    const absoluteComponent = join(projectRoot, componentFile);
    const absoluteTemplate = join(dirname(absoluteComponent), spec.templateUrl);

    if (!existsSync(absoluteTemplate)) return { ok: false, reason: 'missing' };

    try {
      return {
        ok: true,
        template: {
          source: readFileSync(absoluteTemplate, 'utf8'),
          file: relative(projectRoot, absoluteTemplate).split(sep).join('/'),
          lineOffset: 1,
        },
      };
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
  }

  return { ok: false, reason: 'not-declared' };
}

export interface ParseOutcome {
  parsed: ParsedTemplate | null;
  /** Parser diagnostics. A template with errors still yields a partial AST. */
  errors: string[];
}

/**
 * Parse with the bundled compiler.
 *
 * `preserveWhitespaces` is on so `templateLoc` measures the file as written
 * rather than as optimised. `preserveLineEndings` keeps offsets aligned with
 * the source we measure against.
 */
export function parse(template: ResolvedTemplate): ParseOutcome {
  try {
    const parsed = parseTemplate(template.source, template.file, {
      preserveWhitespaces: true,
      preserveLineEndings: true,
    });
    return { parsed, errors: (parsed.errors ?? []).map((e) => e.msg) };
  } catch (error) {
    // A hard throw means syntax the bundled compiler cannot read at all,
    // which usually means the project is newer than this tool.
    return { parsed: null, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * Maps a character offset to a 1-based line and column.
 *
 * Template AST nodes carry line/col directly, but expression nodes inside
 * bindings carry only absolute offsets. Findings are worth little without a
 * navigable position, so both get resolved through here.
 */
export class LineIndex {
  private readonly lineStarts: number[];

  constructor(private readonly source: string) {
    this.lineStarts = [0];
    for (let i = 0; i < source.length; i++) {
      if (source[i] === '\n') this.lineStarts.push(i + 1);
    }
  }

  at(offset: number): { line: number; col: number } {
    const clamped = Math.max(0, Math.min(offset, this.source.length));

    // Binary search for the last line that starts at or before this offset.
    // A linear scan would be simpler, but this runs once per finding on every
    // template in the project, so it is worth the six extra lines.
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((this.lineStarts[mid] ?? 0) <= clamped) low = mid;
      else high = mid - 1;
    }

    return { line: low + 1, col: clamped - (this.lineStarts[low] ?? 0) + 1 };
  }

  /** Non-empty lines, per the `templateLoc` definition in RULES.md. */
  countNonEmptyLines(): number {
    return this.source.split('\n').filter((line) => line.trim().length > 0).length;
  }
}
