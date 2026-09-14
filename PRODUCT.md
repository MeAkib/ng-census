# Product Plan — AI Era, MCP, OSS/Paid Split

Companion to `PLAN.md` and `RULES.md`.

---

## 1. Why this is valuable in the AI era

### 1.1 The problem, stated precisely

AI models are trained mostly on Angular code written before 2023. Agents
therefore default to `*ngIf`, constructor injection, `@Input()` decorators, and
NgModules — those patterns dominate their training data.

**Result: an AI-assisted team can move backwards on modernization while shipping
quickly.** Each PR looks fine alone. Over six months the codebase drifts toward
older patterns, and nobody notices because no single review catches it.

This is an Angular-specific problem, it exists right now, and static analysis is
the only thing that can see it.

### 1.2 Why static analysis, not an LLM

| | Human review | Asking an LLM | This tool |
|---|---|---|---|
| Catches one bad PR | Sometimes | Yes | Yes |
| Catches slow drift over 6 months | No | No | **Yes** |
| Same answer twice | No | No | **Yes** |
| Compares 147 components consistently | No | No | **Yes** |

The last two rows are the entire point. **Determinism is the product.**

An LLM can already look at one component and say "this is too big." What it
cannot do is give the same number twice, compare a whole project consistently,
or produce a trend line over six months.

### 1.3 The three shifts that make this valuable now

**1. Volume changed the economics.** When humans wrote 10 components a week, a
person could review them. When agents write 100, nobody can. Automated
measurement stops being a nice extra.

**2. Agents need a map.** An agent cannot read a 147-component repo. The
`repo-map` output is ~3KB and tells it which files to open. This is a genuinely
good use of data the tool already produces.

**3. Agents need a deterministic critic.** Agent writes code → tool returns
`legacy-control-flow at line 14` → agent fixes it. The agent cannot argue with
a line number.

### 1.4 The hard rule

**No LLM inside the tool.** Not for explanations, not for scoring, not for
anything.

The moment output is non-deterministic, trends become meaningless and the CI
gate becomes unusable. Keep the tool boring and numeric. The agent consuming the
output is the smart part.

---

## 2. MCP server

### 2.1 Dependencies — the complete list

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.x",
    "@angular/compiler": "^22.0.0",
    "ts-morph": "^27.0.0"
  }
}
```

That is all. **No network, no database, no auth, no hosting.**

The MCP server is a thin wrapper over `core`. Verify the current SDK major
version before pinning — it moves.

### 2.2 Cost: zero

"Server" in MCP means a **process**, not a machine. It runs as a subprocess on
the developer's own computer. The agent host starts it, talks over
stdin/stdout, and kills it.

No hosting, no uptime, no bandwidth. Publishing to npm is also free.

### 2.3 How it works

```
Agent  ──JSON-RPC over stdio──►  MCP server process
                                      │
                                      ▼
                                 core analyzer
                                      │
                                      ▼
                              project files (read-only)
```

Registration in the host config:

```json
{
  "mcpServers": {
    "ng-census": {
      "command": "npx",
      "args": ["-y", "@brand/mcp", "--project", "."]
    }
  }
}
```

### 2.4 Tools exposed

| Tool | Input | Output |
|---|---|---|
| `repo_map` | — | One line per entity, ~3KB |
| `analyze_component` | `path` | Metrics + findings |
| `find_components` | `rule`, `limit` | Entities matching a rule |
| `check_drift` | — | Regressions vs baseline |

`repo_map` output format:

```
orders/order-list    deps:11 in:4 tpl:214 legacy:8 modern:0 onpush:no
shared/user-avatar   deps:1  in:2 tpl:18  legacy:0 modern:2 onpush:yes
```

### 2.5 Sketch

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { analyzeProject, analyzeOne } from '@brand/core';

const server = new McpServer({ name: 'ng-census', version: '0.1.0' });

server.tool(
  'analyze_component',
  { path: z.string() },
  async ({ path }) => {
    const result = await analyzeOne(path);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);

await server.connect(new StdioServerTransport());
```

Verify the exact registration signature from SDK docs — it has changed across
versions.

### 2.6 Three implementation rules

**Never write to stdout.** Stdout is the JSON-RPC channel. A stray
`console.log` corrupts the protocol and kills the connection. All logging goes
to stderr. This is the most common MCP bug.

**Cache the analysis.** A fresh full-project parse per call is far too slow.
Analyze once, cache by file mtime, re-analyze only changed files. This is why
tier-3 graph analysis must stay two-pass (see `PLAN.md` section 8).

**Read-only.** The server never writes to the project. Also worth stating in the
README as a security property.

### 2.7 Two warnings

**Agents game targets literally.** Never put metrics in an agent's instructions
as a goal to maximize. See `RULES.md` section 8.

**Keep MCP output small.** `repo_map` for 500 entities could blow the context
window. `--top` and `--filter` must work on the MCP tools too.

---

## 3. OSS / paid split

### 3.1 The dividing line

**A single run is free forever. History and team coordination are paid.**

| Free / OSS (MIT) | Paid / hosted |
|---|---|
| CLI: `analyze`, `baseline`, `check`, `repo-map` | Trends over time |
| The whole analyzer engine | Team dashboard |
| All rules | PR bot comments |
| MCP server | Weekly digest email |
| JSON output | Slack alerts |
| Local baseline file | Cross-repo comparison |
| Unlimited local use | Rename-aware entity IDs |

### 3.2 Never cripple the CLI

Nx never crippled the local build. Storybook is free, Chromatic is paid.
Renovate is free, hosted is paid.

If the CLI is limited, developers never try it, and adoption is the only path
to paid.

### 3.3 Why this split is natural, not artificial

A single run has almost no commercial value — a developer gets it free forever
with one `npx` command.

What they cannot get free is **history**. Six months of data, tied to commits,
across a team. That genuinely requires a server, so the paid tier is not an
invented restriction — it is the only place the feature can exist.

It also gets more valuable the longer they pay, which is the right shape for a
subscription.

---

## 4. Converting OSS users to paid

The conversion happens in a specific order. Each step follows naturally from
the previous one.

### Step 1 — They run the CLI

Free, zero friction, `npx`. They see that `order-list` is bad.

### Step 2 — They add `check` to CI

Free. Now it runs on every PR.

**This is the critical step.** The tool is now in their workflow, not their
memory. A dashboard people must remember to open gets abandoned. A CI gate does
not.

### Step 3 — They hit the local baseline's limits

This is the conversion moment, and it arrives on its own:

- The baseline file causes merge conflicts on every PR
- Two teammates regenerate it and overwrite each other
- Somebody asks "were we better or worse last quarter?" — one file cannot answer
- A folder rename resets all their history

**None of these are artificial.** They are real consequences of storing history
in a git file.

### Step 4 — They connect the repo

Same CLI, one flag: `check --token=...`. History moves server-side, baseline
conflicts disappear, trends become possible.

### Design note

Keep the local baseline **genuinely good**. Do not sabotage it. The limits above
appear naturally without help, and a crippled free tier makes people distrust
you.

---

## 5. What makes paid users stay

**The failure mode to fear:** dashboard gets built, demoed, then never opened
again. This happens to most internal metrics tooling. For a subscription it is
fatal — if nobody logs in, they cancel.

So the paid tier must **push**, not wait:

| Mechanism | When |
|---|---|
| PR comment | Every pull request |
| Weekly email | "modern control flow: 34% → 31%" |
| Slack alert | Threshold crossed |
| Migration deadline | "v20 LTS ends 2026-11-28, you are 61% done" |

**Build notifications first, dashboard second.** The dashboard is where people
go *after* a notification tells them something happened. This is the opposite of
what feels natural.

### The strongest single feature

The migration deadline row. Angular LTS end dates are real, public, and dated:

| Version | LTS ends |
|---|---|
| v20 | 2026-11-28 |
| v21 | 2027-06 |
| v22 | 2028-06 |

"You are on v20, LTS ends November 2026, here is your progress and projected
finish date" is a **compliance problem with a deadline**, not a quality opinion.
Far easier to justify than any score.

It also has almost no gaming surface — you cannot fake having converted
`*ngIf` to `@if`.

---

## 6. What the market comparison teaches

| Tool | Sells | ROI type |
|---|---|---|
| Nx Cloud | CI time saved | **Hard** — measurable in money |
| Chromatic | A required review step before merge | **Workflow** — cannot merge without it |
| Nest Devtools | Information about your code | **Soft** — nice to know |

Hard ROI and workflow necessity convert to subscriptions. Information alone
converts poorly — a dashboard is the first thing cut when budgets tighten.
Nobody cancels their CI cache. People cancel dashboards constantly.

**Note:** Nest Devtools is the closest existing product to this one — it parses
a codebase, builds a graph, shows a dashboard, sold as a subscription. It is
*not* Nest's main revenue; courses and support carry that business. Worth
sitting with.

### How to move out of the third row

**Become a workflow gate.** Not "here is a dashboard" but "this PR cannot merge
because it made the worst component worse." This is why the PR comment comes
before the dashboard.

**Attach to a deadline.** Migration tracking has a natural one (section 5).

Both use data v1 already produces. No different tool needed — just a different
framing of what is sold.

---

## 7. Architecture rules for the paid side

**Never transmit source code.** Only numbers. Enterprise Angular shops — banks,
insurance, government — are the buyers, and their security teams will block
anything else. State this on the landing page as a selling point.

**Offer `--hash-paths`.** The JSON still contains file paths and class names.
Some companies object to that too. A stable hash preserves trends without
revealing structure.

**Keep the entity ID a separate stored field.** Never derive it implicitly from
the path at query time. Then rename detection can be added later without
touching stored data. Rename-aware IDs are a good paid feature precisely
because they need server-side history.

---

## 8. Never do this

**No per-developer attribution.** No "complexity increase by author." The
instant that view exists, the tool is understood as surveillance, engineers stop
trusting it, and a useful diagnostic becomes a political weapon. Aggregate to
module or team only.

**No composite score as headline.** Someone will be asked to raise it, and
raising a score is easier than fixing anything. Keep the dashboard on specific
counters tied to specific decisions.

**No score stored in the database.** Store raw counters; compute scores in the
query layer. The moment weights are tuned, every historical data point becomes
incomparable and trend lines become garbage.

---

## 9. Data model for the future dashboard

Two tables to start:

```sql
runs(
  id, commit, branch, timestamp,
  tool_version, angular_version, angular_major, compiler_source
)

entity_metrics(
  run_id, entity_id, kind, file_path, class_name,
  <counter columns>
)
```

Aggregate queries give the charts directly:

- Percentage of components on OnPush over time
- Count of entities exceeding a dependency threshold
- Modern vs legacy control flow ratio — the migration burndown
- Per-entity detail: when a metric regressed, at which commit

### Four rules that keep history usable

1. **Never rewrite old rows.** Ever.
2. **Adding a metric is free.** Old runs get `null`. No migration.
3. **Changing a metric's meaning requires a new key.** Do not redefine
   `templateLoc` — add `templateLocV2`. A renamed key is visible; a silently
   redefined key is a lie in the chart.
4. **Record discontinuities.** Keep a small `(metric_key, tool_version, note)`
   table. When a chart crosses one, draw a marker. This is how you answer "why
   did the number jump in March?"

---

## 10. Costs

### v1 — zero

```
npm packages        free
GitHub repo         free
GitHub Actions      free for public repos
npm publishing      free
MCP server          free (runs locally)
```

Plus ~$10 for the domain, which is worth buying early — the moment a project
gets attention, the matching domain gets taken.

### Paid phase — starts only when someone else's computer must remember something

| Item | Rough cost |
|---|---|
| Database | Free tier, then ~$5–20/mo |
| API hosting | Free tier, then ~$5–20/mo |
| Email sending | Free tier usually enough at first |

"Free tier" appears three times. For the first year with a handful of test
users, most managed platforms cover this at zero. Check current prices when the
time comes.

**The real cost is time, not money.** The risk is building all ten steps plus a
dashboard before finding out which rules people care about.

---

## 11. Licence and contributions

MIT for the OSS packages.

**Add `CONTRIBUTING.md` with a CLA before the repo is public.** Without one,
relicensing or commercially using contributed code may be impossible later.

This is the single item here that is genuinely hard to fix after twenty people
have contributed. Nx and Nest both use a CLA.

Not legal advice — worth a real check before publishing.

---

## 12. Sequencing

| Phase | Build | Why |
|---|---|---|
| 1 | CLI steps 1–8 (`PLAN.md`) | Get to the CI gate |
| 2 | **Use it yourself for 2 weeks** | Learn which rules matter |
| 3 | `repo-map` + MCP server | Agent integration, still free |
| 4 | Routes, then services | Expand coverage |
| 5 | PR comment bot | First paid feature — a push mechanism |
| 6 | History storage + trends | Second paid feature |
| 7 | Dashboard | Last, not first |

Phase 2 is not optional. It is the cheapest information available and it
changes everything after it.
