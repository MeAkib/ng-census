import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reading the Angular workspace file.
 *
 * A multi-project workspace holds several applications and libraries under one
 * root, and a team usually wants numbers for one of them at a time — "how is
 * billing doing" is a question someone owns, "how is the workspace doing" is
 * not.
 *
 * This reads `angular.json` only. It never runs the Angular CLI, and a
 * workspace file it cannot understand is reported as absent rather than
 * throwing: scoping is a convenience, and the whole-workspace run still works.
 */

export interface WorkspaceProject {
  name: string;
  /** Directory of the project, relative to the workspace root. */
  root: string;
  /** Where the source lives, when the workspace says so. */
  sourceRoot: string | null;
  /** `"application"` or `"library"`, when declared. */
  projectType: string | null;
}

const WORKSPACE_FILES = ['angular.json', 'workspace.json'];

/**
 * Every project declared in the workspace file.
 *
 * Returns an empty array when there is no workspace file, or when it declares
 * no projects. The caller decides whether that is worth mentioning — for a
 * single-project repo it is perfectly normal.
 */
export function readWorkspaceProjects(workspaceRoot: string): WorkspaceProject[] {
  for (const name of WORKSPACE_FILES) {
    const path = join(workspaceRoot, name);
    if (!existsSync(path)) continue;

    const parsed = readJson(path);
    const projects = parsed?.['projects'];
    if (!projects || typeof projects !== 'object') continue;

    return Object.entries(projects as Record<string, unknown>)
      .map(([projectName, config]) => toProject(projectName, config))
      .filter((project): project is WorkspaceProject => project !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  return [];
}

/** One project by name, or undefined. Names are matched exactly. */
export function findWorkspaceProject(
  workspaceRoot: string,
  name: string,
): WorkspaceProject | undefined {
  return readWorkspaceProjects(workspaceRoot).find((project) => project.name === name);
}

function toProject(name: string, config: unknown): WorkspaceProject | null {
  if (!config || typeof config !== 'object') return null;
  const record = config as Record<string, unknown>;

  const root = typeof record['root'] === 'string' ? record['root'] : null;
  const sourceRoot = typeof record['sourceRoot'] === 'string' ? record['sourceRoot'] : null;

  // A project with neither cannot be scoped to a directory. The root of a
  // single-project workspace is "", which is a legitimate value meaning the
  // workspace root itself — so only null is rejected here, never empty.
  const directory = root ?? (sourceRoot === null ? null : dirnameOf(sourceRoot));
  if (directory === null) return null;

  return {
    name,
    root: directory,
    sourceRoot,
    projectType: typeof record['projectType'] === 'string' ? record['projectType'] : null,
  };
}

/** The parent of a workspace-relative path, using forward slashes throughout. */
function dirnameOf(path: string): string {
  const cut = path.replace(/\/+$/, '').lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    // angular.json is JSON with comments in some workspaces. Stripping them is
    // more useful than refusing to read the file.
    const raw = stripJsonComments(readFileSync(path, 'utf8'));
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Remove `//` and block comments, leaving anything inside a string alone.
 *
 * Small on purpose. It only has to survive the comments a generated
 * `angular.json` contains, and a file it gets wrong is reported as absent.
 */
function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }

    if (char === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 1;
      continue;
    }

    out += char;
  }

  return out;
}
