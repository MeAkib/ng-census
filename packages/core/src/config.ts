import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Optional project configuration.
 *
 * Deliberately narrow. It can change *what is looked at* — which folders, which
 * files — and nothing else.
 *
 * It cannot switch individual rules on or off, which is the obvious next
 * feature and the wrong one. A baseline recorded with a rule disabled is not
 * comparable to one recorded with it enabled, and nothing in the file would
 * tell you which you were looking at. The moment a config flag can silence a
 * counter, "we improved" and "we stopped measuring" produce the same chart.
 *
 * Scope changes have the same hazard but are visible: the entity simply is not
 * in the run, so it shows up as a removed entity rather than as an improvement.
 */
export interface CensusConfig {
  /** Restrict analysis to paths containing this substring. */
  filter?: string | undefined;
  /** Path fragments to skip. Matched against repo-relative, forward-slashed paths. */
  exclude?: string[] | undefined;
}

const CONFIG_FILES = ['.ng-censusrc', '.ng-censusrc.json'];
const PACKAGE_JSON_KEY = 'ngCensus';

/**
 * Load config from `.ng-censusrc`, `.ng-censusrc.json`, or a `ngCensus` key in
 * package.json, in that order. A malformed file is ignored rather than fatal:
 * failing a CI run over a stray comma in an optional file is a poor trade.
 */
export function loadConfig(projectRoot: string): CensusConfig {
  for (const name of CONFIG_FILES) {
    const parsed = readJson(join(projectRoot, name));
    if (parsed) return normalize(parsed);
  }

  const pkg = readJson(join(projectRoot, 'package.json'));
  const embedded = pkg?.[PACKAGE_JSON_KEY];
  if (embedded && typeof embedded === 'object') {
    return normalize(embedded as Record<string, unknown>);
  }

  return {};
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function normalize(raw: Record<string, unknown>): CensusConfig {
  const exclude = Array.isArray(raw['exclude'])
    ? raw['exclude'].filter((v): v is string => typeof v === 'string')
    : undefined;

  return {
    filter: typeof raw['filter'] === 'string' ? raw['filter'] : undefined,
    exclude: exclude && exclude.length > 0 ? exclude : undefined,
  };
}
