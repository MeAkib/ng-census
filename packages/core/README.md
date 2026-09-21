# @ng-census/core

The analyzer behind [ng-census](https://www.npmjs.com/package/ng-census).

**You probably want the CLI instead:**

```bash
npx ng-census analyze
```

This package is for building your own tooling on the same engine — a CI bot,
an editor extension, an MCP server. It reads an Angular project and returns
data. It never prints, formats or exits.

```ts
import { analyzeProject } from '@ng-census/core';

const result = await analyzeProject({ projectRoot: '/path/to/angular/app' });

for (const entity of result.entities) {
  console.log(entity.id, entity.metrics.legacyControlFlow);
  for (const finding of entity.findings) {
    console.log(`  ${finding.rule} at ${finding.file}:${finding.line}:${finding.col}`);
  }
}
```

The shape of `result` is defined in `types.ts`, and every metric is defined
exactly in
[RULES.md](https://github.com/MeAkib/ng-census/blob/main/RULES.md).

Two things to know before you store the output:

- **Raw observations, not conclusions.** `standaloneFlag: "absent"` is what
  the decorator said. Whether that means standalone depends on
  `run.angularMajor` — from Angular 19 it does.
- **`null` is not `0`.** `null` means "could not be measured here"; `0` means
  "measured, and there were none". Charts must skip `null`.

Early (0.x): metric definitions may still change before 1.0. A change to what
a metric means is listed as breaking in the
[changelog](https://github.com/MeAkib/ng-census/blob/main/CHANGELOG.md).

MIT licensed.
