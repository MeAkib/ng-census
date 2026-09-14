/**
 * The output contract.
 *
 * Two invariants are encoded here and must not be relaxed:
 *
 * I1 - Store raw observations, not conclusions. Fields like `standaloneFlag`
 *      record what was literally seen in the source. Whether that *means*
 *      the component is standalone depends on the Angular version, and is
 *      computed at read time, never stored.
 *
 * I4 - Entities are generic, carrying a `kind` discriminant. There is no
 *      top-level `components` key, so adding routes and services later
 *      requires no migration of stored data.
 */

/** Which kind of thing was analyzed. Routes and services land in v1.1 / v1.2. */
export type EntityKind = 'component' | 'route' | 'service';

/**
 * A single observation with a source location.
 *
 * Counts are derived from findings by filtering on `rule`. Storing findings
 * rather than bare counts is what lets the same analysis pass feed trends,
 * editor squiggles, agent output, and PR comments.
 */
export interface Finding {
  /** Stable rule id, e.g. "legacy-control-flow". */
  rule: string;
  /** Repo-relative path to the file the finding is in. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  col: number;
  /** Optional specifics, e.g. which directive was matched. */
  detail?: string;
}

/**
 * Raw decorator observations.
 *
 * `"absent"` is a real, meaningful value and must never be collapsed into
 * `false`. From Angular v19 standalone became the default, so `standalone: true`
 * is normally *absent* from decorators in modern code. Treating absence as
 * false reports 0% standalone on every up-to-date codebase.
 */
export type ChangeDetectionFlag = 'OnPush' | 'Default' | 'absent';
export type StandaloneFlag = 'true' | 'false' | 'absent';
export type TemplateKind = 'inline' | 'external' | 'missing';

/**
 * Metrics for a component.
 *
 * `null` means "not measurable on this Angular version" and is distinct from
 * `0`, which means "measured, and there were none". Charts must skip `null`
 * rather than plotting it as zero.
 */
export interface ComponentMetrics {
  // --- class rules (step 3) ---
  injectedDeps: number | null;
  inputs: number | null;
  outputs: number | null;
  subscribeCalls: number | null;
  signalApiCalls: number | null;
  lifecycleHooks: number | null;
  publicMethods: number | null;
  classLoc: number | null;

  // --- decorator rules (step 3), raw values per I1 ---
  changeDetectionFlag: ChangeDetectionFlag;
  standaloneFlag: StandaloneFlag;
  templateKind: TemplateKind;

  // --- template rules (step 5) ---
  templateLoc: number | null;
  templateMaxDepth: number | null;
  elementCount: number | null;
  bindingCount: number | null;
  methodCallsInTemplate: number | null;
  asyncPipes: number | null;
  legacyControlFlow: number | null;
  modernControlFlow: number | null;
  deferBlocks: number | null;
  loopsWithoutTrack: number | null;
  /** `@for (... ; track $index)`. Null below v17, where @for cannot exist. */
  loopsTrackedByIndex: number | null;
  innerHtmlBindings: number | null;
}

/** Metrics shapes stay separate per kind. Routes are not component-shaped. */
export interface RouteMetrics {
  routeCount: number | null;
  routeDepth: number | null;
  guardCount: number | null;
  eagerRoutes: number | null;
  lazyRoutes: number | null;
}

export interface ServiceMetrics {
  injectedDeps: number | null;
  publicMethods: number | null;
  classLoc: number | null;
  subscribeCalls: number | null;
  signalApiCalls: number | null;
  providedInFlag: string;
}

export type EntityMetrics = ComponentMetrics | RouteMetrics | ServiceMetrics;

/** One analyzed thing. */
export interface Entity<M extends EntityMetrics = EntityMetrics> {
  kind: EntityKind;
  /**
   * Join key across runs: repo-relative path + "::" + class name.
   *
   * Stored as its own field rather than derived at query time, so that
   * rename-aware identity can be layered on later without rewriting history.
   */
  id: string;
  filePath: string;
  className: string;
  selector?: string | undefined;
  templateResolved?: boolean | undefined;
  metrics: M;
  findings: Finding[];
}

export type ComponentEntity = Entity<ComponentMetrics>;

/** Where the Angular compiler used for template parsing came from. */
export type CompilerSource = 'bundled' | 'project-local';

/** Where the Angular major came from, or that it had to be assumed. */
export type AngularMajorSource = 'node_modules' | 'package.json' | 'assumed';

/** Run-level context. Needed to interpret every metric in the run. */
export interface RunInfo {
  id: string;
  commit: string | null;
  branch: string | null;
  timestamp: string;
  toolVersion: string;
  /** Full version string read from the target project, e.g. "22.1.6". */
  angularVersion: string | null;
  /** Major only, as detected. Null when detection failed. */
  angularMajor: number | null;
  /**
   * How `angularMajor` was decided. `"assumed"` means nothing could be read
   * from the project.
   */
  angularMajorSource: AngularMajorSource;
  /**
   * The major that capability gating actually used.
   *
   * Equal to `angularMajor` whenever that is known. When it is not, the run
   * still has to gate on something, and this records what — without it, a
   * stored run says `angularMajor: null` while every version-gated metric in
   * it was computed under an assumption nobody can see. Invariant I1 applies
   * to the tool's own guesses too.
   */
  capabilityMajor: number;
  compilerSource: CompilerSource;
  /**
   * Template node types the parser produced but no rule understood.
   * Non-empty means the tool is probably older than the project's Angular.
   */
  unknownNodeTypes: string[];
  /** Routes that could not be read statically, so coverage is partial. */
  dynamicRoutes: number;
  /**
   * TypeScript files the file search matched.
   *
   * Without this, "0 components" is ambiguous — it looks the same whether the
   * project genuinely has none or the search read nothing at all. Those two
   * need opposite responses from the user, so the number has to be visible.
   */
  filesScanned: number;
  /** Of those, the files left after `--filter` and the exclude list. */
  filesAnalyzed: number;
  /**
   * The workspace-relative directory this run covered, or null for the whole
   * project.
   *
   * A run scoped to one application in a multi-project workspace is not
   * comparable to a run over all four, and nothing else in the output would
   * say which you are looking at.
   */
  scope: string | null;
  durationMs: number;
}

export interface AnalysisResult {
  run: RunInfo;
  entities: Entity[];
}
