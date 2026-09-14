#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BASELINE_VERSION,
  TOOL_VERSION,
  analyzeProject,
  compareToBaseline,
  createBaseline,
  isBaseline,
  loadConfig,
  readWorkspaceProjects,
} from '@ng-census/core';
import type { AnalysisResult, WorkspaceProject } from '@ng-census/core';
import { renderTerminal } from './report/terminal.js';
import { renderDrift } from './report/drift.js';
import { DEFAULT_REPO_MAP_ROWS, renderRepoMap } from './report/repo-map.js';

/**
 * CLI entry point.
 *
 * Only this layer touches stdout. The analyzer returns data; reporters turn it
 * into text. Keeping the boundary strict is what will let the same engine back
 * the MCP server, where a stray console.log would corrupt the JSON-RPC stream.
 */

const DEFAULT_BASELINE = '.census-baseline.json';
const DEFAULT_ATTENTION_ROWS = 5;

const USAGE = `
ng-census ${TOOL_VERSION}
Take a census of your Angular application.

Usage
  ng-census analyze  [path] [options]   Terminal summary
  ng-census baseline [path] [options]   Snapshot current state to a file
  ng-census check    [path] [options]   Compare against a baseline, exit 1 on regression
  ng-census repo-map [path] [options]   One line per entity, for agents
  ng-census projects [path]             List the projects in an Angular workspace

Options
  --project <name>   Analyze one project from angular.json
  --out <file>       Write the result to a file as JSON instead of the terminal
  --json             Print the full run object as JSON to stdout
  --filter <str>     Only analyze paths containing <str>
  --top <n>          Rows in the attention list (default 5; repo-map default 200)
  --baseline <file>  Baseline path (default ${DEFAULT_BASELINE})
  --strict           Exit non-zero if the template parser met unknown nodes
  --version          Print version
  --help             Print this message

Examples
  ng-census projects .
  ng-census analyze . --project billing-solution
  ng-census analyze . --out census.json
  ng-census baseline . --project billing-solution --out billing.baseline.json

Exit codes
  0  success, no regressions
  1  regressions found, or a run-level error
  2  bad usage
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      filter: { type: 'string' },
      // No default. Each command has its own fallback, and a default here
      // would make "was --top given?" unanswerable.
      top: { type: 'string' },
      baseline: { type: 'string' },
      out: { type: 'string' },
      project: { type: 'string' },
      strict: { type: 'boolean', default: false },
      version: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.version) {
    process.stdout.write(`${TOOL_VERSION}\n`);
    return 0;
  }

  const [command = 'analyze', pathArg, ...extraPaths] = positionals;

  // One path, or none. Silently analysing the first of several is how a
  // copy-pasted example with the placeholder left in reports "0 components"
  // for a project that is fine.
  if (extraPaths.length > 0) {
    process.stderr.write(
      `ng-census: expected one path, got ${extraPaths.length + 1}:\n` +
        [pathArg, ...extraPaths].map((p) => `  ${p}\n`).join('') +
        `Analyze one project at a time, or scope a single one with --filter.\n`,
    );
    return 2;
  }

  if (values.help || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  const projectRoot = resolve(pathArg ?? process.cwd());

  // A path that does not exist must say so. Reporting zero components for it
  // looks exactly like a project with no components, and the difference is
  // the whole answer.
  const pathProblem = checkProjectRoot(projectRoot);
  if (pathProblem) {
    process.stderr.write(`ng-census: ${pathProblem}\n`);
    return 2;
  }

  const config = loadConfig(projectRoot);
  const filter = values.filter ?? config.filter;

  if (command === 'projects') {
    return listProjects(projectRoot);
  }

  // --project scopes the run to one application in a multi-project workspace.
  // Resolved here, once, so every command supports it the same way.
  let scope: string | undefined;
  if (values.project !== undefined) {
    const resolved = resolveProject(projectRoot, values.project);
    if (typeof resolved !== 'object') return resolved;
    scope = resolved.root;
  }

  switch (command) {
    case 'analyze': {
      const result = await run(projectRoot, filter, config.exclude, scope);

      // A full run object for a real workspace is megabytes of JSON. Printing
      // that into a terminal is not a result anybody can read, so --out writes
      // it where it can be opened, diffed and committed.
      if (values.out) {
        const target = resolve(values.out);
        writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
        process.stderr.write(
          `Wrote ${target} (${count(result.entities.length, 'entity', 'entities')}, ` +
            `${count(result.run.filesAnalyzed, 'file', 'files')} analyzed)\n`,
        );
      } else if (values.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        process.stdout.write(renderTerminal(result, parsePositiveInt(values.top, DEFAULT_ATTENTION_ROWS)));
      }

      return strictExit(result, values.strict);
    }

    case 'baseline': {
      const result = await run(projectRoot, filter, config.exclude, scope);
      const target = resolve(values.out ?? values.baseline ?? DEFAULT_BASELINE);
      const baseline = createBaseline(result);
      writeFileSync(target, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
      process.stderr.write(
        `Baseline written to ${target} (${count(baseline.entities.length, 'entity', 'entities')}` +
          `${scope ? `, scoped to ${scope}` : ''})\n`,
      );
      return strictExit(result, values.strict);
    }

    case 'check': {
      const baselinePath = resolve(values.baseline ?? DEFAULT_BASELINE);
      const baseline = readBaseline(baselinePath);
      if (!baseline) {
        process.stderr.write(
          `ng-census: no usable baseline at ${baselinePath}\n` +
            `Create one with: ng-census baseline\n`,
        );
        return 1;
      }

      // A baseline from another format version cannot be compared field by
      // field. Saying so is better than silently comparing the parts that
      // happen to line up and calling the rest unchanged.
      if (baseline.baselineVersion !== BASELINE_VERSION) {
        process.stderr.write(
          `ng-census: baseline at ${baselinePath} is format v${baseline.baselineVersion}, ` +
            `this tool writes v${BASELINE_VERSION}.\n` +
            `Regenerate it with: ng-census baseline\n`,
        );
        return 1;
      }

      // Comparing a baseline of one application against a run over the whole
      // workspace reports every other application as newly added. That reads
      // as a flood of drift, and the cause is invisible in the output.
      const baselineScope = baseline.scope ?? null;
      if (baselineScope !== (scope ?? null)) {
        process.stderr.write(
          `ng-census: scope mismatch.\n` +
            `  baseline covers: ${baselineScope ?? 'the whole project'}\n` +
            `  this run covers: ${scope ?? 'the whole project'}\n` +
            `Run check with the same --project as baseline, or take a new baseline.\n`,
        );
        return 2;
      }

      const result = await run(projectRoot, filter, config.exclude, scope);
      const report = compareToBaseline(baseline, result);

      if (values.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(renderDrift(report));
      }

      const regressed = report.regressions.length + report.newEntityDebt.length;
      if (regressed > 0) return 1;
      return strictExit(result, values.strict);
    }

    case 'repo-map': {
      const result = await run(projectRoot, filter, config.exclude, scope);
      process.stdout.write(
        renderRepoMap(result, parsePositiveInt(values.top, DEFAULT_REPO_MAP_ROWS)),
      );
      return strictExit(result, values.strict);
    }

    default: {
      process.stderr.write(`Unknown command: ${command}\n${USAGE}`);
      return 2;
    }
  }
}

function run(
  projectRoot: string,
  filter: string | undefined,
  exclude: string[] | undefined,
  scope: string | undefined,
) {
  return analyzeProject({ projectRoot, filter, exclude, scope });
}

/**
 * Resolve `--project <name>` against the workspace file.
 *
 * Returns the project, or an exit code. An unknown name prints the names that
 * do exist: in a workspace of four applications, "which one did you mean" is a
 * question the tool can answer itself.
 */
function resolveProject(projectRoot: string, name: string): WorkspaceProject | number {
  const projects = readWorkspaceProjects(projectRoot);

  if (projects.length === 0) {
    process.stderr.write(
      `ng-census: no angular.json with projects found at ${projectRoot}\n` +
        `--project needs an Angular workspace. Use --filter <path> instead.\n`,
    );
    return 2;
  }

  const match = projects.find((project) => project.name === name);
  if (!match) {
    process.stderr.write(
      `ng-census: no project named "${name}" in this workspace.\n` +
        `Available:\n` +
        projects.map((p) => `  ${p.name}  (${p.root || '.'})\n`).join(''),
    );
    return 2;
  }

  return match;
}

/** `ng-census projects` — what can be passed to --project. */
function listProjects(projectRoot: string): number {
  const projects = readWorkspaceProjects(projectRoot);

  if (projects.length === 0) {
    process.stderr.write(
      `ng-census: no angular.json with projects found at ${projectRoot}\n`,
    );
    return 2;
  }

  const width = Math.max(...projects.map((p) => p.name.length));
  for (const project of projects) {
    const kind = project.projectType ? ` [${project.projectType}]` : '';
    process.stdout.write(`${project.name.padEnd(width)}  ${project.root || '.'}${kind}\n`);
  }

  return 0;
}

/**
 * Unknown template nodes mean the project uses syntax this tool predates, so
 * some counters are undercounts. Visible as a warning always; a failure only
 * when the user asked for that with --strict.
 */
function strictExit(result: AnalysisResult, strict: boolean | undefined): number {
  const unknown = result.run.unknownNodeTypes;
  if (unknown.length === 0) return 0;

  process.stderr.write(
    `⚠ ${unknown.length} unknown template node type(s): ${unknown.join(', ')}\n` +
      `  Tool may be older than this project's Angular version.\n`,
  );
  return strict ? 1 : 0;
}

/** Why this path cannot be a project root, or null if it is fine. */
function checkProjectRoot(projectRoot: string): string | null {
  if (!existsSync(projectRoot)) {
    return `no such path: ${projectRoot}`;
  }
  if (!statSync(projectRoot).isDirectory()) {
    return `not a directory: ${projectRoot}\nPoint at the project root, not at a file.`;
  }
  return null;
}

function readBaseline(path: string) {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isBaseline(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** "1 entity", "3 entities". A tool that says "1 entities" looks unfinished. */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ng-census: ${message}\n`);
    process.exitCode = 1;
  });
