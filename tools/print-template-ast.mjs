#!/usr/bin/env node
/**
 * Print the AST of an Angular template.
 *
 * You cannot write a template rule without seeing what the parser produces,
 * and the node names are not guessable. This prints the tree, the bindings on
 * each node, and each node's position.
 *
 *   node tools/print-template-ast.mjs '<div *ngIf="x">{{ y }}</div>'
 *   node tools/print-template-ast.mjs --file src/app/thing.component.html
 *
 * The names printed here are exactly the strings the `switch` in
 * packages/core/src/rules/template.ts matches on.
 */
import { parseTemplate } from '@angular/compiler';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
let source;

if (args[0] === '--file') {
  if (!args[1]) {
    console.error('usage: node tools/print-template-ast.mjs --file <path>');
    process.exit(2);
  }
  source = readFileSync(args[1], 'utf8');
} else if (args.length > 0) {
  source = args.join(' ');
} else {
  console.error('usage: node tools/print-template-ast.mjs \'<div *ngIf="x">hi</div>\'');
  console.error('       node tools/print-template-ast.mjs --file path/to/template.html');
  process.exit(2);
}

const parsed = parseTemplate(source, 'template.html', {
  preserveWhitespaces: true,
  preserveLineEndings: true,
});

if (parsed.errors?.length) {
  console.log('Parse errors:');
  for (const error of parsed.errors) console.log('  ', error.msg);
  console.log('');
}

/** The lists of bindings a node can carry, and what is in them. */
function bindingsOf(node) {
  const parts = [];
  for (const key of ['inputs', 'outputs', 'attributes', 'templateAttrs']) {
    const list = node[key];
    if (!Array.isArray(list) || list.length === 0) continue;
    const items = list.map((b) => `${b.constructor.name}:${b.name}`).join(', ');
    parts.push(`${key}=[${items}]`);
  }
  return parts.join(' ');
}

/** Child lists differ per node type: blocks use branches, cases, children. */
function childrenOf(node) {
  const children = [];
  for (const key of ['children', 'branches', 'cases']) {
    if (Array.isArray(node[key])) children.push(...node[key]);
  }
  for (const key of ['empty', 'placeholder', 'loading', 'error']) {
    if (node[key]) children.push(node[key]);
  }
  return children;
}

function print(nodes, depth) {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;

    const name = node.constructor.name;
    const line = node.sourceSpan?.start?.line;
    const where = line === undefined ? '' : `  (line ${line + 1})`;
    const bindings = bindingsOf(node);

    console.log(`${'  '.repeat(depth)}${name}${bindings ? '  ' + bindings : ''}${where}`);
    print(childrenOf(node), depth + 1);
  }
}

print(parsed.nodes, 0);
