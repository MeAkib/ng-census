# tools

Small scripts for working on ng-census itself. They are not part of the
published package and nothing in `packages/` imports them.

Run them from the repository root, so that `@angular/compiler` and `ts-morph`
resolve.

## `print-template-ast.mjs`

Prints the AST of an Angular template: node names, bindings, line numbers.

```bash
node tools/print-template-ast.mjs '<div *ngIf="x">{{ y }}</div>'
node tools/print-template-ast.mjs --file src/app/thing.component.html
```

Use it before writing a template rule. The node names it prints are exactly
the strings the `switch` in `packages/core/src/rules/template.ts` matches on,
and they are not guessable — `*ngIf` becomes a `Template` node wrapping the
element, while `@if` becomes an `IfBlock` with `IfBlockBranch` children.

## `why-no-files.mjs`

Explains why a project produced no files.

```bash
node tools/why-no-files.mjs /path/to/some/workspace
```

It compares a plain filesystem walk against what the analyzer's file search
sees, and tries glob patterns from narrowest to widest so the step that breaks
is visible. Written when discovery returned zero files on macOS with Node 24
while every test passed on Linux.

It prints counts, timings and at most three paths. It never prints file
contents, so it is safe to run against a private repository and paste the
output.
