# @marianmeres/cron

[![NPM](https://img.shields.io/npm/v/@marianmeres/cron)](https://www.npmjs.com/package/@marianmeres/cron)
[![JSR](https://jsr.io/badges/@marianmeres/cron)](https://jsr.io/@marianmeres/cron)
[![License](https://img.shields.io/npm/l/@marianmeres/cron)](LICENSE)

PostgreSQL-backed recurring cron job scheduler. Concurrent workers via
`FOR UPDATE SKIP LOCKED`, drift-safe scheduling, real transactions on `pg.Pool`,
per-claim lease tokens (so stale-recovered jobs cannot clobber fresh
results), retries with capped exponential backoff, per-attempt timeouts with
`AbortSignal` cancellation, IANA timezone-aware schedules, project-scoped
isolation, and an optional task registry for UI-driven job management.

## Installation

```bash
# npm / Node.js
npm install @marianmeres/cron

# Deno (JSR)
deno add @marianmeres/cron
```

## Usage

```typescript
import { Cron } from "@marianmeres/cron";
import pg from "pg";

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const cron = new Cron({ db });

// Register a job (creates/updates DB row on each call)
await cron.register("daily-report", "0 8 * * *", async (job) => {
  await generateReport(job.payload);
  return { sent: true };
});

// Start polling (2 concurrent workers)
await cron.start(2);

// Subscribe to completion events
cron.onDone("daily-report", (job) => {
  console.log(`Report done, next run: ${job.next_run_at}`);
});

cron.onError("daily-report", (job) => {
  console.error(`Report failed: ${job.last_run_status}`);
});

// Graceful shutdown (returns within drainTimeoutMs even if a handler hangs)
process.on("SIGTERM", () => cron.stop({ drainTimeoutMs: 30_000 }));
```

### Project scoping

One deployment can manage jobs for multiple isolated projects. Use `forProject()` to
get a lightweight project-scoped view (`CronProjectScope`) that shares the parent's
processor pool. A single `start()` call processes all projects.

```typescript
import { Cron, CronProjectScope } from "@marianmeres/cron";

const cron = new Cron({ db });

// Create project-scoped views (no lifecycle methods — start/stop stay on parent)
const projA: CronProjectScope = cron.forProject("project-a");
const projB: CronProjectScope = cron.forProject("project-b");

// Same job name, completely isolated schedules/payloads/handlers
await projA.register("send-report", "0 9 * * *", handlerA);
await projB.register("send-report", "0 18 * * *", handlerB);

// One pool processes ALL projects
await cron.start(2);

// Queries are also scoped
const jobsA = await projA.fetchAll(); // only project-a jobs
const jobsB = await projB.fetchAll(); // only project-b jobs
```

When `projectId` is omitted (i.e. `new Cron({ db })`), it defaults to `"_default"` —
single-project usage works exactly as before.

### Retries, timeouts, and cancellation

```typescript
await cron.register(
  "flaky-api",
  "*/5 * * * *",
  async (job, signal) => {
    // The signal aborts on per-attempt timeout AND on cron.stop().
    // Pass it through to anything cancellable (fetch, child processes, etc.).
    return await fetch(url, { signal });
  },
  {
    max_attempts: 3,                // retry up to 3 times per cycle
    max_attempt_duration_ms: 10000, // kill after 10s
    backoff_strategy: "exp",        // exponential backoff (clamped at 5 min)
  }
);
```

### Timezones

Cron expressions are evaluated in the host's local timezone by default. Pass an
IANA timezone per job to evaluate in that zone — handles DST transitions
correctly (spring-forward gaps are skipped, fall-back overlaps fire once):

```typescript
await cron.register(
  "europe-morning-report",
  "0 9 * * 1-5",
  handler,
  { timezone: "Europe/Prague" }
);
```

### Concurrent workers (multiple processes)

Multiple `Cron` instances sharing the same PostgreSQL database safely co-exist —
`FOR UPDATE SKIP LOCKED` ensures each job claim is exclusive. Per-claim
**lease tokens** additionally guarantee that a stale-recovered worker (one
whose process froze long enough to be reset by `cleanup()`) cannot
overwrite a fresh execution's result.

```typescript
// In each process / dyno:
const cron = new Cron({ db, autoCleanup: true });
await cron.register("job", "* * * * *", handler);
await cron.start(1);
```

### Maintenance

Stuck `running` jobs (process crashes mid-execution) are recovered by
`cleanup()`. Wire it up in one of two ways:

```typescript
// Option A — built-in timer (recommended)
const cron = new Cron({
  db,
  autoCleanup: { intervalMs: 60_000, maxAllowedRunDurationMinutes: 5 },
});

// Option B — call manually
setInterval(() => cron.cleanup(5), 60_000);

// Run-log retention (the run log grows fast for tight schedules):
setInterval(() => cron.pruneRunLog(60 * 24 * 30), 60 * 60 * 1000); // keep 30 days
```

### Task registry

The task registry is an optional layer for UI-driven job management. It provides a
catalog of known task types with handlers and JSON Schema payload validation — so a
UI can list available tasks, render dynamic parameter forms, and validate user input
before creating cron jobs.

```typescript
import { createTaskRegistry, syncRegistryToCron, Cron, CronProjectScope } from "@marianmeres/cron";

// 1. Define the catalog of things your system can do
const registry = createTaskRegistry();

registry.define("send-report", {
  description: "Send a report to recipients",
  paramsSchema: {
    type: "object",
    properties: {
      recipients: { type: "array", items: { type: "string" } },
      format: { type: "string", enum: ["pdf", "csv"] },
    },
    required: ["recipients"],
  },
  handler: async (job) => {
    const { recipients, format } = job.payload;
    await sendReport(recipients, format);
    return { sent: recipients.length };
  },
});

registry.define("cleanup-uploads", {
  description: "Remove expired uploads",
  handler: async () => {
    const count = await removeExpiredUploads();
    return { removed: count };
  },
});

// 2. List available task types (for API/UI — handlers are omitted)
const tasks = registry.list();

// 3. Validate user-provided payload before creating a job
const result = await registry.validate("send-report", {
  recipients: ["alice@example.com"],
  format: "pdf",
});

// 4. Wire handlers to a project scope. Returns:
//    - synced: handlers wired
//    - orphans: DB jobs with no matching registry entry
//    - removedHandlers: in-memory handlers no longer in the registry (auto-removed)
const cron = new Cron({ db });
const myProject = cron.forProject("my-project");
const { synced, orphans, removedHandlers } = await syncRegistryToCron(myProject, registry);

await cron.start(2);
```

`syncRegistryToCron` accepts both a `Cron` instance and a `CronProjectScope`. When
passed a project scope, the registry's handlers are bound to that specific project —
so the same task type definitions can serve multiple projects, each with its own
schedules and payloads, while sharing one processor pool.

> **Note:** Schema validation requires `@marianmeres/modelize` as a dependency
> (uses AJV internally). Install it alongside this package if you use `paramsSchema`.

### Cron expression format

Standard 5-field notation: `minute hour day-of-month month day-of-week`

Supports wildcards (`*`), ranges (`1-5`), lists (`1,3,5`), and step values
(`*/15`, `2-10/3`). Day-of-month and day-of-week follow POSIX/Vixie cron
semantics: when both are restricted (neither is `*`), they are **OR**-ed.

```
"* * * * *"        — every minute
"0 2 * * *"        — daily at 02:00
"*/15 * * * *"     — every 15 minutes
"0 9 * * 1-5"      — weekdays at 09:00
"0 0 1 * *"        — first day of each month
"0 9 15 * 1-5"     — 9am on the 15th OR any weekday at 9am
```

Impossible date combinations (e.g. `0 0 31 2 *` — Feb 31) are rejected at parse time.

### Migrating from earlier versions

`Cron.migrate()` is idempotent and brings any prior schema (v1 with no
`project_id`, or v2 without `lease_token` / `timezone` / CHECK constraints)
up to current:

```typescript
await Cron.migrate(db);
// or with a table prefix:
await Cron.migrate(db, "myschema.");
```

It adds missing columns (`project_id`, `lease_token`, `timezone`), adjusts
indexes, and adds CHECK constraints. Safe to call multiple times.

## Breaking changes vs 1.x

- **`CronJob.lease_token` and `CronJob.timezone` columns added.** Existing
  rows are backfilled to `NULL`; run `Cron.migrate(db)` once on upgrade.
- **`stop()` now defaults to a 30 s drain cap.** Previously it waited
  forever. Pass `stop({ drainTimeoutMs: 0 })` to restore the old
  behaviour.
- **DoM/DoW expressions where both are restricted now match either
  field** (POSIX semantics), instead of requiring both. If you were
  relying on the previous AND behaviour you need to rephrase the
  expression.
- **Impossible date combinations** (e.g. `0 0 31 2 *`) now throw at
  parse time.
- **`cleanup()` and `pruneRunLog()` return `number`** (rows affected)
  instead of `void`.
- **`syncRegistryToCron` result type** gained `removedHandlers: string[]`.

## API

See [API.md](API.md) for full API reference.

## License

[MIT](LICENSE)
