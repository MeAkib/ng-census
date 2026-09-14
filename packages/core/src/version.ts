import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Angular version detection and the capability matrix.
 *
 * Every version-gated rule keys off the major returned here. Getting this
 * wrong silently corrupts every metric in the run, so detection is explicit
 * about *where* the answer came from.
 */

/** Oldest major the analyzer will run against at all. */
export const MIN_SUPPORTED = 17;

/** Below this we run, but warn that results may be unreliable. */
export const MIN_FULL_SUPPORT = 20;

/** Major of the @angular/compiler we bundle for template parsing. */
export const BUNDLED_COMPILER_MAJOR = 22;

/**
 * Angular LTS end dates, for the migration-deadline report.
 * Source: angular.dev/reference/releases, checked 2026-09-13.
 * Re-check when a new major ships.
 */
export const LTS_END_DATES: Readonly<Record<number, string>> = {
  20: '2026-11-28',
  21: '2027-06-30',
  22: '2028-06-30',
};

export interface Capabilities {
  signals: boolean;
  takeUntilDestroyed: boolean;
  controlFlowBlocks: boolean;
  deferBlocks: boolean;
  signalInputs: boolean;
  letSyntax: boolean;
  standaloneByDefault: boolean;
  signalForms: boolean;
}

/**
 * What the given Angular major supports.
 *
 * A rule that measures something unavailable on this version must report
 * `null`, not `0`. Zero says "we looked and found none"; null says "this
 * could not exist here".
 */
export function capabilities(major: number): Capabilities {
  return {
    signals: major >= 16,
    takeUntilDestroyed: major >= 16,
    controlFlowBlocks: major >= 17, // @if / @for / @switch
    deferBlocks: major >= 17,
    signalInputs: major >= 17, // input() / output()
    letSyntax: major >= 18, // @let
    standaloneByDefault: major >= 19,
    signalForms: major >= 22,
  };
}

export type SupportLevel = 'full' | 'best-effort' | 'unsupported' | 'unknown';

export function supportLevel(major: number | null): SupportLevel {
  if (major === null) return 'unknown';
  if (major >= MIN_FULL_SUPPORT) return 'full';
  if (major >= MIN_SUPPORTED) return 'best-effort';
  return 'unsupported';
}

export interface VersionInfo {
  version: string | null;
  major: number | null;
  /** How the version was determined, for debugging odd results. */
  source: 'node_modules' | 'package.json' | 'none';
  support: SupportLevel;
}

/**
 * Read the Angular version from the *target project*, never from our own
 * dependency tree.
 *
 * node_modules is preferred over package.json because a range like "^20.0.0"
 * says what was asked for, while the installed package says what is actually
 * being compiled.
 */
export function detectAngularVersion(projectRoot: string): VersionInfo {
  const installed = readInstalledVersion(projectRoot);
  if (installed) {
    return finish(installed, 'node_modules');
  }

  const declared = readDeclaredVersion(projectRoot);
  if (declared) {
    return finish(declared, 'package.json');
  }

  return { version: null, major: null, source: 'none', support: 'unknown' };
}

function finish(version: string, source: 'node_modules' | 'package.json'): VersionInfo {
  const major = parseMajor(version);
  return { version, major, source, support: supportLevel(major) };
}

function readInstalledVersion(projectRoot: string): string | null {
  const pkgPath = join(projectRoot, 'node_modules', '@angular', 'core', 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

function readDeclaredVersion(projectRoot: string): string | null {
  const pkgPath = join(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return pkg.dependencies?.['@angular/core'] ?? pkg.devDependencies?.['@angular/core'] ?? null;
  } catch {
    return null;
  }
}

/**
 * Pull the major out of anything npm might have written: "22.1.6",
 * "^20.0.0", "~21.2.0", ">=19.0.0 <20.0.0", "20.x".
 *
 * Returns null rather than guessing for values with no usable number,
 * such as "latest" or a git URL.
 */
export function parseMajor(raw: string): number | null {
  const match = /(\d+)/.exec(raw);
  if (!match?.[1]) return null;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) ? n : null;
}
