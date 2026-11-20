# @marianmeres/cron

[![NPM](https://img.shields.io/npm/v/@marianmeres/cron)](https://www.npmjs.com/package/@marianmeres/cron)
[![License](https://img.shields.io/npm/l/@marianmeres/cron)](LICENSE)

PostgreSQL-backed recurring cron job scheduler. Concurrent workers via
`FOR UPDATE SKIP LOCKED`, drift-safe scheduling, real transactions (on a `pg.Pool`,
a `pg.Client` or a sqlkit `Driver`), per-claim lease tokens (so stale-recovered
jobs cannot clobber fresh results) kept alive by a heartbeat (so long-running jobs
are not mistaken for crashed ones), retries with capped exponential backoff,
per-attempt timeouts with `AbortSignal` cancellation, IANA timezone-aware
schedules, tenant-scoped isolation, and an optional task registry for UI-driven
job management.

## Installation

```bash
npm install @marianmeres/cron pg
```

cron takes the pool or client you build and does not depend on `pg` itself:
install the `pg` you build it with. It runs on Node 24.20+ or 26.6+ (what its
database layer, [`@marianmeres/sqlkit`](https://www.npmjs.com/package/@marianmeres/sqlkit),
asks for).

The package is published to npm only. Version 3.3.0 is the last one on JSR.
Upgrading from 3.x? See [Upgrading to 4.0](#upgrading-to-40).

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

### Tenant scoping

One deployment can manage jobs for multiple isolated tenants. Use `forTenant()` to
get a lightweight tenant-scoped view (`CronTenantScope`) that shares the parent's
processor pool. A single `start()` call processes all tenants.

```typescript
import { Cron, CronTenantScope } from "@marianmeres/cron";

const cron = new Cron({ db });

// Create tenant-scoped views (no lifecycle methods — start/stop stay on parent)
const tenantA: CronTenantScope = cron.forTenant("tenant-a");
const tenantB: CronTenantScope = cron.forTenant("tenant-b");

// Same job name, completely isolated schedules/payloads/handlers
await tenantA.register("send-report", "0 9 * * *", handlerA);
await tenantB.register("send-report", "0 18 * * *", handlerB);

// One pool processes ALL tenants
await cron.start(2);

// Queries are also scoped
const jobsA = await tenantA.fetchAll(); // only tenant-a jobs
const jobsB = await tenantB.fetchAll(); // only tenant-b jobs
```

When `tenantId` is omitted (i.e. `new Cron({ db })`), it defaults to `"_default"` —
single-tenant usage works exactly as before.

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

### Missed runs

A tick that could not run on time is **not** replayed later. After every run the
next slot is derived from the job's schedule, and if that slot is already in the
past the job resumes at the first future one:

- **The process was down** across several slots: the job runs once on startup
  (for the slot it was waiting on), then continues on schedule.
- **A run outlasted its own interval** (a 90 s handler on a per-minute job): the
  ticks it overran are skipped.
- **The job was disabled** while a slot came due: `enable()` resumes at the next
  slot. It does not fire immediately for the tick that passed.

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

Instances may boot at the same time on a database that has no cron tables yet:
creating the schema takes an advisory lock, so one creates it and the others
find it done.

`start()` rejects if the schema cannot be initialised — nothing is started in
that case, so handle the rejection the way you would any failed boot step.

### The database: a pool, a client or a driver

`db` takes a `pg.Pool` (the recommendation), a connected `pg.Client`, or a
[`@marianmeres/sqlkit`](https://www.npmjs.com/package/@marianmeres/sqlkit)
`Driver` of the `pg` dialect. Anything else is a `TypeError` from `new Cron()`.
`Cron.migrate()` takes the same.

```typescript
import { createPgDriver } from "@marianmeres/sqlkit/pg";

const driver = createPgDriver(new pg.Pool({ connectionString: process.env.DATABASE_URL }));
const cron = new Cron({ db: driver });
```

A single `pg.Client` (or a driver over one connection) works with several
processors, but it is one database session: every statement takes its turn on
it, so handlers overlap and their database work does not.

cron never closes what it is given: the pool, the client or the driver stays
yours to end. When you share a driver with your own code:

- **It carries your transactions.** A `cron.register()` called inside your
  `driver.transaction()` is part of it: the job exists only if you commit.
- **Make the first cron call of a process, and `start()`, outside any
  transaction.** An instance checks the schema once, on first use. Inside a
  transaction that then rolls back, on a database that had no cron tables yet,
  the schema is rolled back too, and the instance does not check again.
- **`dbRetry` cannot help inside your transaction**: after a failure Postgres
  has aborted it.
- **One pool, one driver.** If cron and another sqlkit-based library (such as
  `@marianmeres/steve`) use the same pool, build one `Driver` and pass it to
  both. Each library handed the raw pool builds a driver of its own, and two
  drivers on one pool each take the other's `error` listener for yours, so
  neither reports a dropped idle connection.

### Database errors, retry and health

A database call that fails rejects with a `SqlError` from `@marianmeres/sqlkit`,
as the subclass of its kind (`ConnectionError`, `DeadlockError`,
`UniqueViolationError`, …). Its `code` and `message` are node-postgres's, and the
original error is its `cause`. A programming mistake (no `db`, a driver of
another dialect, an option out of range) is a `TypeError`. See
[Errors](API.md#errors).

```typescript
const cron = new Cron({
  db,
  dbRetry: true, // or { maxRetries, initialDelayMs, maxDelayMs, backoffMultiplier }
  dbHealthCheck: { intervalMs: 30_000, timeoutMs: 2_000, onUnhealthy: alertOps },
});
```

- **`dbRetry`** runs a failed claim, or a failed write that records a run, again
  with exponential backoff, when the failure is transient: a lost or refused
  connection, a server starting up, shutting down or out of connections, a pool
  that timed out connecting, a deadlock, a serialization failure, a lock not
  granted in time. It goes by the kind of failure, not by a code found in the
  error's message; a constraint violation or a syntax error is never retried. `retryableErrors: ["…"]` retries exactly the
  codes you list instead.
- **`dbHealthCheck`** runs a `select 1` every `intervalMs` (default 30 s) from
  `start()` on. A check that has not answered within `timeoutMs` (default 5 s)
  is unhealthy. `onUnhealthy` / `onHealthy` fire when the state flips;
  `cron.getDbHealth()` returns the latest status and `cron.checkDbHealth()` runs
  one check now. A database that is down gives an unhealthy status, never a
  rejection.

### Maintenance

Stuck `running` jobs (process crashes mid-execution) are recovered by
`cleanup()`. A worker renews its claim every `heartbeatIntervalMs` (default
30 s) for as long as it is executing, so the threshold below means "no sign of
life for this long", not "ran for this long": a job may legitimately run for
hours without being handed to a second worker. Keep the threshold at three
heartbeats or more.

The flip side: a handler that hangs forever in a live process keeps its claim.
Give such jobs a `max_attempt_duration_ms`.

Wire `cleanup()` up in one of two ways:

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
import { createTaskRegistry, syncRegistryToCron, Cron, CronTenantScope } from "@marianmeres/cron";

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

// 4. Wire handlers to a tenant scope. Returns:
//    - synced: handlers wired
//    - orphans: DB jobs with no matching registry entry
//    - removedHandlers: in-memory handlers no longer in the registry (auto-removed)
const cron = new Cron({ db });
const myTenant = cron.forTenant("my-tenant");
const { synced, orphans, removedHandlers } = await syncRegistryToCron(myTenant, registry);

await cron.start(2);
```

`syncRegistryToCron` accepts both a `Cron` instance and a `CronTenantScope`. When
passed a tenant scope, the registry's handlers are bound to that specific tenant —
so the same task type definitions can serve multiple tenants, each with its own
schedules and payloads, while sharing one processor pool.

> **Note:** `paramsSchema` validation compiles the schema with AJV, via
> `@marianmeres/modelize`'s `/ajv` subpath. `ajv` is an **optional peer
> dependency** — npm does not install it for you, so run `npm install ajv` if you
> use `paramsSchema`.

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

`Cron.migrate()` is idempotent and brings any prior schema — including a legacy
install that still has the old `project_id` column, a v1 schema with no scope
column, or a v2 schema without `lease_token` / `timezone` / CHECK constraints —
up to current:

```typescript
await Cron.migrate(db);
// or with a table prefix:
await Cron.migrate(db, "myschema.");
```

It renames a legacy `project_id` column (and its indexes) to `tenant_id` **in
place**, preserving existing data; adds missing columns (`tenant_id`,
`lease_token`, `timezone`); adjusts indexes; and adds CHECK constraints. It also
repairs run-log rows that 3.2 and earlier stamped with the wrong `tenant_id`
(see below). Safe to call multiple times.

## Upgrading to 4.0

The public API is source-compatible: code written for 3.3 compiles unchanged.
Every method signature, the events, the `dbRetry` and `dbHealthCheck` option
shapes and the health status object stay as they were. The database schema is unchanged too; there is no
migration to run. It is a major release because of what changes underneath:
cron now runs every statement through
[`@marianmeres/sqlkit`](https://www.npmjs.com/package/@marianmeres/sqlkit), which
changes what a database error looks like, what is retried and how health is
checked; `pg` leaves the dependencies; and JSR publishing stops.

### Changed

- **A failed database call rejects with a sqlkit `SqlError`** (`ConnectionError`,
  `DeadlockError`, …). `code` and `message` are node-postgres's. The original
  error is `cause`: read fields such as `detail` or `severity` there.
- **`dbRetry` retries more.** Besides lost connections it now retries deadlocks,
  serialization failures, a lock not granted in time, a server shutting down or
  out of connections, a pool that timed out connecting, and a terminated
  connection. A code that appears only inside an error's message no longer
  counts. A `retryableErrors` list still replaces the
  default, matched as before (the code, or the code inside the message).
- **`dbRetry` values are checked.** A negative or fractional `maxRetries`, or a
  `backoffMultiplier` below 1, is a `TypeError` at the first database call
  `dbRetry` wraps. That call is the claim: the processors log the error as a
  claim error and claim nothing.
- **A health check is one `select 1`, and it times out.** A check that has not
  answered in 5 s is unhealthy (`dbHealthCheck.timeoutMs`). `latencyMs` is
  `null` on failure and may be a fraction of a millisecond on success. The
  warning logged on every failed check is gone; the logs and the
  `onUnhealthy` / `onHealthy` callbacks on a change of state stay. The monitor's
  timer no longer keeps the process alive.
- **cron listens to the pool's (or client's) `error` event.** An idle connection
  the server dropped is now a process warning. With no `error` listener of your
  own, it used to end the process.
- **cron checks a connection out with `pool.connect()` for every statement** and
  no longer calls `pool.query()`. A wrapper around `pool.query` that logs or
  measures does not see cron's statements.
- **A `db` that is not a pool, a client or a `pg` driver throws at
  construction**, from `new Cron()`, not at the first query.
- **`CronContext.db` is a sqlkit `Driver`.** The type is exported, but internal.
- **No new versions on JSR.** 3.3.0 is the last one there.
- **cron no longer depends on `pg`.** It never imported it at runtime: install
  the `pg` you build your pool with, as you already do. It depends on
  `@marianmeres/sqlkit` instead, which asks for Node 24.20+ or 26.6+.

### Fixed

- **Several instances starting at once on a database with no cron tables yet no
  longer fail**: creating the schema takes an advisory lock. A 3.x instance
  takes no lock, so this holds once every instance that may boot on a fresh
  database runs 4.0.
- **`Cron.migrate()` can be called again with a mixed-case `tablePrefix`.** The
  second call used to fail on a CHECK constraint that was already there.

### New

- **`db` accepts a sqlkit `Driver`** of the `pg` dialect, and so does
  `Cron.migrate()`. See [The database: a pool, a client or a driver](#the-database-a-pool-a-client-or-a-driver)
  for what sharing one with your own code means.
- **More than one processor on a single connection.** `start(n)` on a
  `pg.Client`, or on a driver over one connection, runs all `n` processors
  (3.3 ran one). Their statements take turns; their handlers overlap.
- **`dbHealthCheck.timeoutMs`**, and three exported types: `CronDb`,
  `DbRetryOptions` and `DbHealthStatus`.

## Behaviour changes since 3.2

No schema change. Running `Cron.migrate(db)` is optional and only repairs old
run-log rows (second bullet).

- **Fixed: a job's `timezone` was ignored after its first run.** Only the first
  `next_run_at` was computed in the job's zone; every later one used the host's.
  An affected job fires once more at its wrong time and is then scheduled
  correctly; re-register it with `forceNextRunRecalculate: true` to correct it
  at once.
- **Fixed: run-log rows were stamped with the Cron instance's tenant instead of
  the job's.** Tenant-scoped `healthPreview()` and `pruneRunLog()` therefore saw
  nothing (or everything, for the default tenant). New rows are correct;
  `Cron.migrate(db)` re-stamps the old ones.
- **Missed ticks are skipped, not replayed** — see [Missed runs](#missed-runs).
  Previously a job replayed every tick it had missed, back-to-back. `enable()`
  now resumes a paused job at its next slot.
- **`start()` rejects** when the schema cannot be initialised or a `stop()` is
  still draining. It used to log and resolve, leaving a silently dead scheduler.
- **`stop()` always leaves a restartable instance**, also after the drain cap
  was hit. Calling `stop()` twice after a capped drain no longer revives the
  abandoned processor.
- **Heartbeat** (new `heartbeatIntervalMs` option, default 30 s): a job running
  longer than the stale threshold is no longer re-claimed and run concurrently.
  `CronJob.last_run_at` is now "last sign of life" while a job is running.
- **Shutdown stops retries.** Remaining attempts of a failing job are abandoned
  once `stop()` is called; the cycle is recorded as failed.
- **`dbRetry` also covers the writes that record a run.** A failure to record a
  result is logged as such and is never counted as a handler failure.
- **A single `pg.Client` runs at most one processor.**
- **The SIGTERM listener is attached by `start()`** (not on first use) and is
  re-attached after a `stop()` / `start()` cycle.
- **`healthPreview()` returns real numbers** for `count` and
  `avg_duration_seconds` (they were strings at runtime, despite the types).

## Breaking changes in 3.2

- **npm only: `paramsSchema` validation now needs `ajv` installed.** It moved to
  `@marianmeres/modelize`'s `/ajv` subpath, where AJV is an optional peer
  dependency that npm does not auto-install — run `npm install ajv`. Deno/JSR
  resolves it transitively and is unaffected.

## Breaking changes vs 2.x

- **`project_id` renamed to `tenant_id` throughout.** The DB column, the
  `CronJob.tenant_id` / `CronRunLog.tenant_id` fields, the `CronOptions.tenantId`
  option, `Cron.forTenant()` (was `forProject()`), the `CronTenantScope`
  interface (was `CronProjectScope`), and the `DEFAULT_TENANT_ID` export (was
  `DEFAULT_PROJECT_ID`) all use the `tenant` naming now. Run `Cron.migrate(db)`
  once on upgrade — it renames the legacy `project_id` column and its indexes to
  `tenant_id` in place, preserving existing data.

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

## Development

Node LTS (`.node-version`), pnpm, Biome, `node:test`. The source is erasable-only
TypeScript that Node runs directly; `dist/` is built only for publishing to npm. The
tests need a PostgreSQL database: copy `.env.example` to `.env` and set the `TEST_PG_*`
credentials.

| Command                             | Does                                                        |
| ----------------------------------- | ----------------------------------------------------------- |
| `pnpm install`                      | installs the deps and the dev tooling                       |
| `pnpm test` / `pnpm run test:watch` | `node --test` over `tests/**/*.test.ts`, one file at a time |
| `pnpm run typecheck`                | `tsc --noEmit` over `src` and `tests`                       |
| `pnpm run lint` / `pnpm run format` | `biome check .` read-only / with `--write`                  |
| `pnpm run ci`                       | typecheck + lint + test, what CI runs                       |
| `pnpm run build`                    | `tsc -p tsconfig.build.json` → `dist/`                      |
| `pnpm run rp` / `pnpm run rpm`      | patch / minor release, then publish to npm                  |

## License

[MIT](LICENSE)
