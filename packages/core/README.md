# @ng-census/core

The engine behind [ng-census](https://www.npmjs.com/package/ng-census). Use it
to build your own tools on the same analysis — a CI bot, an editor extension,
an MCP server.

**Just want to analyze a project?** Use the CLI: `npx ng-census analyze`.

```ts
import { analyzeProject } from '@ng-census/core';

const { run, entities } = await analyzeProject({ projectRoot: '/path/to/app' });

for (const component of entities) {
  console.log(component.id, component.metrics.legacyControlFlow);
  for (const f of component.findings) {
    console.log(`  ${f.rule} ${f.file}:${f.line}:${f.col}`);
  }
}
```

It reads files and returns data. It never prints, formats or exits.

Before storing the output, know two rules:

- **Raw values, not conclusions.** `standaloneFlag: "absent"` is what the
  decorator said. Whether that means standalone depends on
  `run.angularMajor` — from Angular 19, it does.
- **`null` is not `0`.** `null` means "could not be measured here". Skip it in
  charts; never plot it as zero.

Every metric is defined in
[RULES.md](https://github.com/MeAkib/ng-census/blob/main/RULES.md). Early
release (0.x): a change to what a metric means is marked as breaking in the
[changelog](https://github.com/MeAkib/ng-census/blob/main/CHANGELOG.md).

MIT
