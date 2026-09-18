import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { analyzeProject } from '@ng-census/core';
import type { AnalysisResult } from '@ng-census/core';
import { renderHtml } from 'ng-census';

/**
 * The HTML report.
 *
 * Tested for the things that would be silently wrong: unescaped text from the
 * analyzed codebase, a number that disagrees with the terminal, and any
 * dependency on the network. Not tested: wording and layout, which change
 * constantly and whose tests would only ever be deleted.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '..', '..', 'fixtures');
const V22 = join(FIXTURES, 'v22-project');
const WORKSPACE = join(FIXTURES, 'workspace');

async function report(projectRoot: string): Promise<string> {
  return renderHtml(await analyzeProject({ projectRoot }), projectRoot);
}

describe('the HTML report', () => {
  test('is a complete, self-contained document', async () => {
    const html = await report(V22);

    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('</html>'));

    // It has to open from a file:// path on a laptop with no internet, and
    // survive being emailed. Nothing may be fetched.
    assert.equal(html.includes('http://'), false);
    assert.equal(html.includes('https://'), false);
    assert.equal(html.includes('<script'), false);
    assert.equal(html.includes('@import'), false);
  });

  test('leads with the migration burndown', async () => {
    const result = await analyzeProject({ projectRoot: V22 });
    const html = renderHtml(result, V22);

    assert.ok(html.includes('of control flow is modern'));
    assert.ok(html.includes('What is left to migrate'));
    assert.ok(html.includes('Worth opening first'));
  });

  test('shows no score, grade or total anywhere', async () => {
    const html = (await report(V22)).toLowerCase();

    // PRODUCT.md section 8: the moment a single number exists, someone is
    // asked to raise it, and raising a number is easier than fixing anything.
    assert.equal(html.includes('overall score'), false);
    assert.equal(html.includes('health score'), false);
    assert.equal(html.includes('grade'), false);
  });

  test('escapes text that came out of the analyzed codebase', async () => {
    const result = await analyzeProject({ projectRoot: V22 });
    const entity = result.entities[0];
    assert.ok(entity);

    // File paths and class names come from whatever is in the repository. A
    // component named like this must not become markup in a file somebody
    // opens in a browser.
    entity.filePath = 'src/app/<img src=x onerror=alert(1)>.component.ts';
    entity.findings.push({
      rule: 'legacy-control-flow',
      file: '"><script>alert(1)</script>',
      line: 1,
      col: 1,
      detail: '<b>not bold</b>',
    });

    const html = renderHtml(result, V22);

    assert.equal(html.includes('<img src=x'), false);
    assert.equal(html.includes('<script>alert'), false);
    assert.equal(html.includes('<b>not bold</b>'), false);
    assert.ok(html.includes('&lt;img src=x'));
    assert.ok(html.includes('&lt;b&gt;not bold'));
  });

  test('agrees with the analyzer about the counts', async () => {
    const result = await analyzeProject({ projectRoot: V22 });
    const html = renderHtml(result, V22);

    // Two reporters disagreeing about one run would undo the whole point of a
    // deterministic tool, so both read through interpret.ts.
    const legacy = result.entities
      .flatMap((e) => e.findings)
      .filter((f) => f.rule === 'legacy-control-flow').length;

    assert.ok(legacy > 0);
    assert.ok(html.includes(`<td class="num">${legacy}</td>`));
    assert.ok(html.includes(`${result.entities.length} components`));
  });

  test('never prints a missing metric as zero', async () => {
    const result = await analyzeProject({ projectRoot: V22 });
    const html = renderHtml(result, V22);

    // BrokenTemplateComponent has an unreadable template, so its template
    // metrics are null. An em dash says "not measured"; a 0 would claim we
    // looked.
    assert.ok(html.includes('It never means zero'));
    assert.ok(html.includes('—'));
  });

  test('breaks a workspace down by folder', async () => {
    const html = await report(WORKSPACE);

    assert.ok(html.includes('By folder'));
    assert.ok(html.includes('projects/billing'));
    assert.ok(html.includes('projects/portal'));
  });

  test('says which project a scoped run covered', async () => {
    const result = await analyzeProject({ projectRoot: WORKSPACE, scope: 'projects/billing' });
    const html = renderHtml(result, WORKSPACE);

    assert.ok(html.includes('projects/billing'));
    assert.equal(html.includes('By folder'), false);
  });

  test('explains an empty run instead of showing empty tables', async () => {
    const result: AnalysisResult = await analyzeProject({
      projectRoot: V22,
      filter: 'no-such-folder',
    });
    const html = renderHtml(result, V22);

    assert.equal(result.entities.length, 0);
    assert.ok(html.includes('Everything was filtered out'));
    assert.equal(html.includes('Worth opening first'), false);
  });

  test('warns in the report when the Angular version was assumed', async () => {
    const result = await analyzeProject({ projectRoot: here });
    const html = renderHtml(result, here);

    assert.equal(result.run.angularMajorSource, 'assumed');
    assert.ok(html.includes('could not be detected'));
  });
});
