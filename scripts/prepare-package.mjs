#!/usr/bin/env node
/**
 * Copy the shared files a published package needs into it, just before
 * `npm pack` / `npm publish`.
 *
 * Runs as each package's `prepack` script, from inside that package's folder.
 *
 * Why not keep a copy in each package? Because two copies of a README drift:
 * the npm page ends up describing last month's flags. The repository root is
 * the single source; this puts it where npm looks for it.
 *
 * - LICENSE goes into every package. MIT requires the notice to ship with the
 *   code, and npm only includes a LICENSE that is inside the package folder.
 * - The root README goes into the CLI package, which is the one people
 *   install. Relative links like `docs/ARCHITECTURE.md` work on GitHub but
 *   are dead on npmjs.com, so they are rewritten to absolute GitHub URLs.
 *
 * The copies are gitignored. The originals at the root are what you edit.
 */
import { copyFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_URL = 'https://github.com/MeAkib/ng-census/blob/main';

const packageDir = process.cwd();
const repoRoot = resolve(packageDir, '..', '..');
const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));

copyFileSync(join(repoRoot, 'LICENSE'), join(packageDir, 'LICENSE'));

// Only the CLI takes the root README. Core has its own short one, committed in
// its folder, because it is a library with a different audience.
if (pkg.name === 'ng-census') {
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8').replace(
    /\]\((?!https?:|#|mailto:)([^)\s]+)\)/g,
    (_match, target) => `](${REPO_URL}/${target.replace(/^\.\//, '')})`,
  );
  writeFileSync(join(packageDir, 'README.md'), readme);
}

if (!existsSync(join(packageDir, 'README.md'))) {
  console.error(`prepare-package: ${pkg.name} has no README.md — the npm page would be blank.`);
  process.exit(1);
}

console.error(`prepare-package: ${pkg.name} ready (LICENSE${pkg.name === 'ng-census' ? ', README' : ''})`);
