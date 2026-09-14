# Troubleshooting

Every message the tool can give you that is not a result, and what to do about
it.

---

## "No TypeScript files were found at all"

Nothing was read, so the run says nothing about your components.

1. **Check the path.** It should be the folder containing `package.json` and
   `angular.json`, not the `src` folder inside it.
2. **Check for a folder name collision.** These are skipped by default:
   `node_modules`, `dist`, `out-tsc`, `coverage`, `.angular`, `.nx`,
   `bazel-out`. So are folders whose name starts with a dot. If your source
   lives in one of these, rename it or the tool will never see it.
3. **Check for symlinks.** The walk does not follow them, because a link
   pointing at a parent folder is an infinite loop and a link pointing outside
   the project reports entities under paths that are not in your repo.

Still stuck? Run the diagnostic:

```bash
node tools/why-no-files.mjs /path/to/your/workspace
```

It compares a plain filesystem walk against what the analyzer sees and prints
where they disagree.

---

## "Read N TypeScript file(s), then excluded all of them"

The files were found, then filtered away. Two things can do that:

- a `--filter` on the command line
- an `exclude` or `filter` in `.ng-censusrc`, `.ng-censusrc.json`, or an
  `ngCensus` key in `package.json`

Drop the filter to see the whole project.

---

## "No components found in N TypeScript file(s)"

The files really were read and none declared `@Component`. If you expected
some, you are probably pointed at a library of services, or at the wrong
project in a workspace. Try:

```bash
ng-census projects .
```

---

## "Could not detect the Angular version"

The version is read from the target project's
`node_modules/@angular/core/package.json`, falling back to its `package.json`.
It is never taken from ng-census's own dependencies.

Run `npm install` in the project you are analyzing.

The run still completes. Version-gated metrics are computed as if the project
were on the newest supported release, and the run object records
`angularMajorSource: "assumed"` so the guess is visible later. It is a guess
though — some numbers may be wrong.

---

## "Angular N is supported on a best-effort basis"

Full support is Angular 20 and above. Angular 17, 18 and 19 run with this
warning: the rules still work, but they get less testing.

Angular 16 and below warn more loudly and the results are unreliable. Nothing
is ever refused outright — a number with a caveat is more useful than an error
message.

---

## "scope mismatch"

```
ng-census: scope mismatch.
  baseline covers: projects/billing
  this run covers: the whole project
```

A baseline taken with `--project billing` describes one application. Comparing
it against a run over the whole workspace would report every *other*
application as newly added — a wall of drift with no visible cause.

Use the same `--project` for `baseline` and `check`, or take a new baseline.

---

## "baseline at ... is format vN, this tool writes vM"

The baseline file was written by a different version of the tool and its
fields no longer line up. Regenerate it:

```bash
ng-census baseline
```

---

## "expected one path, got 2"

Only one project per run. This usually means a copy-pasted example still had
`/path/to/your/angular/app` in it.

To scope a run, use `--project <name>` or `--filter <substring>`.

---

## "N unknown template node type(s)"

Angular's template syntax has something this tool's parser does not recognise,
so some counts are undercounts. It almost always means the project's Angular
is newer than the bundled compiler.

It is a warning by default and a failure under `--strict`. Fixing it means
adding the node type to the walk in `packages/core/src/rules/template.ts` —
see `docs/ADDING-A-RULE.md`.

---

## The CI gate fails and you think it should not

Read the failing line. There are two kinds.

**A regression** — a file that existed at the baseline got worse:

```
✗ order-list    legacy control flow    0 → 4
```

**New-entity debt** — a file that did not exist at the baseline arrived
carrying a legacy pattern:

```
New since baseline, already carrying legacy patterns:
✗ agent-made    legacy control flow    2
```

Only a short list of metrics can do either. Dependency counts, class size and
template method calls are reported but **never** gate the build. If the gate
fails on something else, that is a bug — please report it.

To accept the current state as the new normal, take a fresh baseline
deliberately and commit it:

```bash
ng-census baseline && git add .census-baseline.json
```

Never do that automatically in CI. A baseline that regenerates itself records
whatever happened and can never fail.

---

## `--json` floods the terminal

Use `--out` instead. `--json` is for pipes.

```bash
ng-census analyze --out census.json
ng-census analyze --json | jq '.entities[0]'
```

---

## `ng-census: command not found`

The package is not published yet. Either run it through npm from the repo:

```bash
npm run census -- analyze /path/to/app
```

or link it once, after which `ng-census` works anywhere:

```bash
cd packages/cli && npm link
```

Undo that with `npm unlink -g ng-census`.
