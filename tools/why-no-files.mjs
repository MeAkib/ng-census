#!/usr/bin/env node
/**
 * Diagnose "No TypeScript files were found at all".
 *
 * Bisects the analyzer's file search: adds a known file directly, then tries
 * progressively wider glob patterns, so the exact step that returns nothing is
 * visible.
 *
 * Prints counts, timings and at most three paths. It never reads file contents.
 *
 *   node tools/why-no-files.mjs /path/to/your/angular/workspace
 */
import { Project } from 'ts-morph';
import { readdirSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const root = resolve(process.argv[2] ?? process.cwd());
const EXCLUDED = ['node_modules', 'dist', 'out-tsc', 'coverage', '.angular', '.nx', 'bazel-out'];

console.log('root            ', JSON.stringify(root));
console.log('cwd             ', JSON.stringify(process.cwd()));
console.log('platform        ', process.platform, '| node', process.version);
if (existsSync(root)) {
  console.log('is symlink      ', lstatSync(root).isSymbolicLink());
  console.log('realpath equal  ', realpathSync(root) === root);
}

// --- a plain walk, to get a known-good example file ---
const found = [];
function walk(dir, depth) {
  if (depth > 12 || found.length > 200) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (EXCLUDED.includes(entry.name)) continue;
      walk(full, depth + 1);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }
}
walk(root, 0);

const example = found[0];
console.log('');
console.log('--- plain walk ---');
console.log('example file    ', example ? JSON.stringify(example.slice(root.length + 1)) : '(none)');
if (!example) {
  console.log('No .ts file to test with. Stopping.');
  process.exit(0);
}

function newProject() {
  return new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: {},
  });
}

// --- 1. can ts-morph open one known file at all? ---
console.log('');
console.log('--- direct file add (no globbing) ---');
try {
  const project = newProject();
  project.addSourceFileAtPath(example);
  const classes = project.getSourceFiles()[0]?.getClasses().length ?? 0;
  console.log('added directly   ok, classes in it:', classes);
} catch (error) {
  console.log('added directly   ERROR:', error instanceof Error ? error.message : String(error));
}

// --- 2. glob patterns, narrowest first ---
function tryGlob(pattern, label) {
  const project = newProject();
  const started = Date.now();
  try {
    project.addSourceFilesAtPaths(pattern);
    const n = project.getSourceFiles().length;
    console.log(String(n).padStart(6), `${Date.now() - started}ms`.padStart(8), ' ', label);
    return n;
  } catch (error) {
    console.log('  ERR'.padStart(6), `${Date.now() - started}ms`.padStart(8), ' ', label,
      '->', error instanceof Error ? error.message : String(error));
    return 0;
  }
}

const exampleDir = dirname(example);
console.log('');
console.log('--- glob patterns, narrowest first ---');
console.log(' files     time   pattern');
tryGlob(example, 'the example file, as a literal path');
tryGlob(join(exampleDir, '*.ts'), `${exampleDir.slice(root.length + 1)}/*.ts`);
tryGlob(join(exampleDir, '**/*.ts'), `${exampleDir.slice(root.length + 1)}/**/*.ts`);
tryGlob(join(root, 'projects/**/*.ts'), 'projects/**/*.ts');
tryGlob(join(root, 'src/**/*.ts'), 'src/**/*.ts');
tryGlob(`${root}/**/*.ts`, 'root/**/*.ts  (string concat)');
tryGlob(join(root, '**/*.ts'), 'root/**/*.ts  (path.join)  <- the analyzer uses this');
tryGlob([join(root, '**/*.ts'), `!${join(root, '**/node_modules/**')}`], 'root/**/*.ts + !node_modules');
