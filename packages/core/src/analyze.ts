import { Project } from 'ts-morph';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { findComponents } from './discover.js';
import { analyzeClass } from './rules/class.js';
import { analyzeTemplate } from './rules/template.js';
import { parse, resolveTemplate } from './template.js';
import { BUNDLED_COMPILER_MAJOR, capabilities, detectAngularVersion } from './version.js';
import type {
  AnalysisResult,
  AngularMajorSource,
  ComponentEntity,
  ComponentMetrics,
  Entity,
  Finding,
  RunInfo,
} from './types.js';

/**
 * The analyzer entry point.
 *
 * `analyzeProject` is the one function worth reading first. It does four
 * things, in order:
 *
 *   1. work out which Angular version the project is on  (version.ts)
 *   2. find the .ts files worth reading                  (collectSourceFiles)
 *   3. for each one, find components and measure them    (discover.ts, rules/)
 *   4. wrap the results in a `run` object that says what the numbers mean
 *
 * This module returns data and never formats it. Nothing here imports from a
 * reporter, writes to stdout, or knows what a terminal is. That separation is
 * what makes the CLI, the CI gate, the MCP server, and a future dashboard all
 * consumers of one engine rather than four forks of it.
 */

export const TOOL_VERSION = '0.1.0';

/**
 * Directories skipped by default.
 *
 * Build output is the important one. A compiled Angular library re-emits every
 * component under dist/, so analysing it counts the whole codebase twice and
 * reports numbers for generated code nobody edits. This was caught by running
 * against a real library repo, where every component appeared in the output
 * exactly twice.
 */
export const DEFAULT_EXCLUDED_DIRS = [
  'node_modules',
  'dist',
  'out-tsc',
  'coverage',
  '.angular',
  '.nx',
  'bazel-out',
];

export interface AnalyzeOptions {
  /** Root of the Angular project being analyzed. */
  projectRoot: string;
  /** Restrict analysis to paths containing this substring. */
  filter?: string | undefined;
  /**
   * Walk only this directory, given relative to `projectRoot`.
   *
   * Entity ids stay relative to `projectRoot`, not to the scope, so a run over
   * one application and a run over the whole workspace describe the same
   * entity by the same id. Scoping changes what is measured, never what
   * anything is called.
   */
  scope?: string | undefined;
  /**
   * Explicit file paths to analyze, absolute or relative to `projectRoot`.
   *
   * Paths, not globs. Discovery walks the directory tree itself (see
   * `collectSourceFiles`), so there is no glob engine to hand a pattern to.
   */
  include?: string[] | undefined;
  /** Path fragments to skip, from config. Matched on the repo-relative path. */
  exclude?: string[] | undefined;
}

export async function analyzeProject(options: AnalyzeOptions): Promise<AnalysisResult> {
  const started = Date.now();
  const { projectRoot } = options;

  const versionInfo = detectAngularVersion(projectRoot);
  // Detection can fail — no node_modules, a CI checkout without install, a
  // path that is not a project root. Gating still needs a number, so the
  // newest supported major is assumed. What must never happen is assuming it
  // silently: `angularMajorSource` and `capabilityMajor` below say so in the
  // stored run, not only in the terminal.
  const capabilityMajor = versionInfo.major ?? BUNDLED_COMPILER_MAJOR;
  const angularMajorSource: AngularMajorSource =
    versionInfo.major === null || versionInfo.source === 'none' ? 'assumed' : versionInfo.source;
  const caps = capabilities(capabilityMajor);

  const project = createProject(projectRoot);
  const entities: Entity[] = [];
  const unknownNodeTypes = new Set<string>();

  const walkRoot = options.scope ? resolve(projectRoot, options.scope) : projectRoot;
  const candidates = options.include
    ? options.include.map((path) => resolve(projectRoot, path))
    : collectSourceFiles(walkRoot);
  let filesAnalyzed = 0;

  for (const absolute of candidates) {
    const filePath = toRepoRelative(projectRoot, absolute);

    if (options.filter && !filePath.includes(options.filter)) continue;
    if (options.exclude?.some((fragment) => filePath.includes(fragment))) continue;

    filesAnalyzed += 1;

    const text = readFileIfPossible(absolute);
    if (text === null) continue;

    // Cheap text check before parsing. Every decorator the discovery step can
    // match ends in "Component" — including the namespaced `@core.Component`
    // form — so a file without that word cannot contain one. On a workspace of
    // a few thousand files this skips parsing almost all of them.
    if (!text.includes('Component')) continue;

    const sourceFile = project.createSourceFile(absolute, text, { overwrite: true });

    for (const component of findComponents(sourceFile)) {
      entities.push(buildComponentEntity(component, filePath, projectRoot, caps, unknownNodeTypes));
    }

    // Metrics and findings are plain data by the time we get here, so the AST
    // can go. Holding a few thousand of them is how a tool that felt fine on a
    // sample project runs out of memory on a real monorepo.
    project.removeSourceFile(sourceFile);
  }

  entities.sort((a, b) => a.id.localeCompare(b.id));

  const run: RunInfo = {
    id: randomUUID(),
    commit: readGitValue(projectRoot, ['rev-parse', 'HEAD']),
    branch: readGitValue(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    timestamp: new Date().toISOString(),
    toolVersion: TOOL_VERSION,
    angularVersion: versionInfo.version,
    angularMajor: versionInfo.major,
    angularMajorSource,
    capabilityMajor,
    compilerSource: 'bundled',
    unknownNodeTypes: [...unknownNodeTypes].sort(),
    dynamicRoutes: 0,
    filesScanned: candidates.length,
    filesAnalyzed,
    scope: options.scope ?? null,
    durationMs: Date.now() - started,
  };

  return { run, entities };
}

function buildComponentEntity(
  component: ReturnType<typeof findComponents>[number],
  filePath: string,
  projectRoot: string,
  caps: ReturnType<typeof capabilities>,
  unknownNodeTypes: Set<string>,
): ComponentEntity {
  const classResult = analyzeClass(component.classDecl, filePath, caps);
  const template = readTemplate(component, filePath, projectRoot, caps, classResult.signalFields);

  for (const kind of template.unknownNodeTypes) unknownNodeTypes.add(kind);

  const metrics: ComponentMetrics = {
    injectedDeps: classResult.injectedDeps,
    inputs: classResult.inputs,
    outputs: classResult.outputs,
    subscribeCalls: classResult.subscribeCalls,
    signalApiCalls: classResult.signalApiCalls,
    lifecycleHooks: classResult.lifecycleHooks,
    emptyLifecycleHooks: classResult.emptyLifecycleHooks,
    emptyConstructors: classResult.emptyConstructors,
    publicMethods: classResult.publicMethods,
    classLoc: classResult.classLoc,

    changeDetectionFlag: component.changeDetectionFlag,
    standaloneFlag: component.standaloneFlag,
    templateKind: component.templateKind,

    // An unresolved template leaves every template metric null. Zero would
    // claim we read the template and found nothing in it, which would quietly
    // improve the numbers of every component whose template we failed to open.
    templateLoc: template.metrics.templateLoc,
    templateMaxDepth: template.metrics.templateMaxDepth,
    elementCount: template.metrics.elementCount,
    bindingCount: template.metrics.bindingCount,
    methodCallsInTemplate: template.metrics.methodCallsInTemplate,
    asyncPipes: template.metrics.asyncPipes,
    legacyControlFlow: template.metrics.legacyControlFlow,
    modernControlFlow: template.metrics.modernControlFlow,
    deferBlocks: template.metrics.deferBlocks,
    loopsWithoutTrack: template.metrics.loopsWithoutTrack,
    loopsTrackedByIndex: template.metrics.loopsTrackedByIndex,
    innerHtmlBindings: template.metrics.innerHtmlBindings,
  };

  return {
    kind: 'component',
    id: `${filePath}::${component.className}`,
    filePath,
    className: component.className,
    selector: component.selector,
    templateResolved: template.resolved,
    metrics,
    findings: [
      ...decoratorFindings(component, filePath, classResult),
      ...classResult.findings,
      ...template.findings,
    ],
  };
}

/**
 * Rules decided by the decorator, which need the class metrics as well.
 *
 * `missing-onpush` is the reason these live here rather than in discover.ts:
 * RULES.md defines it as "no OnPush *and* no signals", and only the class
 * rules know about the signals.
 */
function decoratorFindings(
  component: ReturnType<typeof findComponents>[number],
  filePath: string,
  classResult: ReturnType<typeof analyzeClass>,
): Finding[] {
  const findings: Finding[] = [];
  const at = {
    file: filePath,
    line: component.decoratorPosition.line,
    col: component.decoratorPosition.col,
  };

  if (component.standaloneFlag === 'false') {
    findings.push({ rule: 'ngmodule-component', ...at, detail: 'standalone: false' });
  }

  const usesSignals =
    (classResult.signalApiCalls ?? 0) > 0 || classResult.signalFields.length > 0;

  if (component.changeDetectionFlag !== 'OnPush' && !usesSignals) {
    findings.push({
      rule: 'missing-onpush',
      ...at,
      detail: `changeDetection ${component.changeDetectionFlag}`,
    });
  }

  return findings;
}

/** Null template metrics, used whenever the template could not be read. */
const UNMEASURED_TEMPLATE = {
  templateLoc: null,
  templateMaxDepth: null,
  elementCount: null,
  bindingCount: null,
  methodCallsInTemplate: null,
  asyncPipes: null,
  legacyControlFlow: null,
  modernControlFlow: null,
  deferBlocks: null,
  loopsWithoutTrack: null,
  loopsTrackedByIndex: null,
  innerHtmlBindings: null,
} as const;

interface TemplateOutcome {
  resolved: boolean;
  metrics: TemplateMetricSlice;
  findings: Finding[];
  unknownNodeTypes: string[];
}

type TemplateMetricSlice = Pick<
  ComponentMetrics,
  | 'templateLoc'
  | 'templateMaxDepth'
  | 'elementCount'
  | 'bindingCount'
  | 'methodCallsInTemplate'
  | 'asyncPipes'
  | 'legacyControlFlow'
  | 'modernControlFlow'
  | 'deferBlocks'
  | 'loopsWithoutTrack'
  | 'loopsTrackedByIndex'
  | 'innerHtmlBindings'
>;

/**
 * Resolve, parse, and measure one component's template.
 *
 * Every failure path here returns null metrics rather than throwing. One
 * component with a deleted .html file must not cost you the numbers for the
 * other 146.
 */
function readTemplate(
  component: ReturnType<typeof findComponents>[number],
  filePath: string,
  projectRoot: string,
  caps: ReturnType<typeof capabilities>,
  signalFields: string[],
): TemplateOutcome {
  const unresolved: TemplateOutcome = {
    resolved: false,
    metrics: UNMEASURED_TEMPLATE,
    findings: [],
    unknownNodeTypes: [],
  };

  const resolution = resolveTemplate(component, filePath, projectRoot);
  if (!resolution.ok) return unresolved;

  const { parsed } = parse(resolution.template);
  if (!parsed) return unresolved;

  const result = analyzeTemplate(parsed, resolution.template, caps, new Set(signalFields));

  return {
    resolved: true,
    metrics: {
      templateLoc: result.templateLoc,
      templateMaxDepth: result.templateMaxDepth,
      elementCount: result.elementCount,
      bindingCount: result.bindingCount,
      methodCallsInTemplate: result.methodCallsInTemplate,
      asyncPipes: result.asyncPipes,
      legacyControlFlow: result.legacyControlFlow,
      modernControlFlow: result.modernControlFlow,
      deferBlocks: result.deferBlocks,
      loopsWithoutTrack: result.loopsWithoutTrack,
      loopsTrackedByIndex: result.loopsTrackedByIndex,
      innerHtmlBindings: result.innerHtmlBindings,
    },
    findings: result.findings,
    unknownNodeTypes: result.unknownNodeTypes,
  };
}

function createProject(projectRoot: string): Project {
  const tsConfigPath = join(projectRoot, 'tsconfig.json');

  // Skipping file dependency resolution keeps us from pulling the whole
  // node_modules type graph into memory. Single-file rules never need it,
  // and loading it would cost far more than the entire analysis.
  //
  // The tsconfig is read for its compilerOptions only. Files are added by
  // `collectSourceFiles` below, never by the project itself.
  return new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    ...(existsSync(tsConfigPath) ? { tsConfigFilePath: tsConfigPath } : { compilerOptions: {} }),
  });
}

/** Deepest directory nesting the walk will follow. Well past any real repo. */
const MAX_WALK_DEPTH = 32;

/**
 * Find the TypeScript files worth analyzing.
 *
 * A hand-written walk, deliberately, rather than a glob.
 *
 * The first version passed glob patterns to the TypeScript wrapper's own file
 * search. That search returned **zero files** on macOS with Node 24 — for
 * every pattern, including a literal absolute path with no wildcards in it —
 * while opening the very same path directly worked. The tool reported "0
 * components" for a healthy 2485-file workspace and gave no hint why. File
 * discovery is the one step where a silent empty result is indistinguishable
 * from a correct answer, so it must not depend on a glob engine whose
 * behaviour varies by platform and runtime.
 *
 * Walking also lets excluded directories be skipped *during* the walk instead
 * of filtered afterwards. The glob had to enumerate all of node_modules before
 * throwing it away; this never opens it.
 *
 * Symbolic links are not followed. A link pointing at an ancestor turns the
 * walk into an infinite loop, and a link pointing outside the project would
 * report entities under paths that are not in this repo.
 */
export function collectSourceFiles(projectRoot: string): string[] {
  const excluded = new Set(DEFAULT_EXCLUDED_DIRS);
  const files: string[] = [];

  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // An unreadable directory is skipped, never fatal. One permission
      // problem must not cost the numbers for the rest of the repo.
      return;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (excluded.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
        visit(full, depth + 1);
      } else if (entry.isFile() && isAnalyzableFile(entry.name)) {
        files.push(full);
      }
    }
  };

  visit(projectRoot, 0);

  // Sorted so a run is reproducible: directory order is filesystem-dependent,
  // and two runs that disagree on entity order are two runs that cannot be
  // diffed.
  return files.sort();
}

/** Read a file, or null if it cannot be read. Never fatal. */
function readFileIfPossible(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function isAnalyzableFile(name: string): boolean {
  if (!name.endsWith('.ts')) return false;
  if (name.endsWith('.d.ts')) return false;
  if (name.endsWith('.spec.ts')) return false;
  return true;
}

/** Repo-relative, forward-slashed, so ids are stable across operating systems. */
function toRepoRelative(projectRoot: string, absolute: string): string {
  return relative(projectRoot, absolute).split(sep).join('/');
}

/**
 * Read a value from git, returning null outside a repository.
 *
 * Commit and branch are optional context: a run without them is still valid,
 * it just cannot be placed on a timeline later.
 */
function readGitValue(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}
