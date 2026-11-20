# API

## Class: `Cron`

```typescript
const cron = new Cron(options: CronOptions);
```

### Constructor Options (`CronOptions`)

| Option                | Type                                                               | Default        | Description                                                                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db`                  | `CronDb` (`pg.Pool \| pg.Client \| Driver`)                        | required       | PostgreSQL connection: a `pg.Pool` (recommended), a connected `pg.Client`, or a sqlkit `Driver` of the `pg` dialect (see [`CronDb`](#crondb)). Anything else is a `TypeError` here. On a single connection every statement takes its turn (see `start()`). cron never ends it |
| `tenantId`            | `string`                                                           | `"_default"`   | Tenant scope identifier — isolates all jobs to this tenant                                                                                                                                                                                                                    |
| `tablePrefix`         | `string`                                                           | `""`           | Prefix for table names (e.g. `"myschema."`)                                                                                                                                                                                                                                   |
| `pollTimeoutMs`       | `number`                                                           | `1000`         | Poll interval when no jobs are due (ms)                                                                                                                                                                                                                                       |
| `gracefulSigterm`     | `boolean`                                                          | `true`         | Register SIGTERM handler for graceful shutdown. Attached by `start()`, detached by `stop()`                                                                                                                                                                                   |
| `logger`              | `Logger`                                                           | `clog("cron")` | Logger instance                                                                                                                                                                                                                                                               |
| `dbRetry`             | `DbRetryOptions \| boolean`                                        | —              | Retry transient DB errors with exponential backoff; `true` for the defaults (see [`DbRetryOptions`](#dbretryoptions)). Covers the claim query and the writes that record a run's outcome                                                                                      |
| `dbHealthCheck`       | `boolean \| { intervalMs?, timeoutMs?, onUnhealthy?, onHealthy? }` | —              | DB health monitoring, started by `start()`; `true` for the defaults (see [DB Health](#db-health))                                                                                                                                                                             |
| `heartbeatIntervalMs` | `number`                                                           | `30000`        | How often a worker renews the claim of the job it is executing (bumps `last_run_at`), so a long-running job is not treated as crashed. Keep it at a third of the stale threshold or less. `0` disables                                                                        |
| `autoCleanup`         | `boolean \| { intervalMs?, maxAllowedRunDurationMinutes? }`        | —              | Automatically `cleanup()` on a timer (`true` ≡ `{ intervalMs: 60_000, maxAllowedRunDurationMinutes: 5 }`)                                                                                                                                                                     |

**`dbHealthCheck` options:**

| Option        | Type                               | Default | Description                                                                                                 |
| ------------- | ---------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `intervalMs`  | `number`                           | `30000` | Time from one check's answer (or timeout) to the next check, so checks never overlap. `0` means the default |
| `timeoutMs`   | `number`                           | `5000`  | A check that has not answered by then is unhealthy. Its query is abandoned, not cancelled                   |
| `onUnhealthy` | `(status: DbHealthStatus) => void` | —       | Called when the database becomes unhealthy, including a first check that fails                              |
| `onHealthy`   | `(status: DbHealthStatus) => void` | —       | Called when the database recovers. A first check that is healthy is no change and calls nothing             |

A negative `intervalMs`, or a `timeoutMs` that is not above 0, is a `TypeError` from the constructor. The monitor logs on a change of state only, and its timer never keeps the process alive.

#### Tenant scoping

The `Cron` constructor accepts a `tenantId` for its own default scope (used by direct method calls like `cron.register()`). For multi-tenant setups, use `cron.forTenant()` to get lightweight tenant-scoped views that share the same processor pool.

Processors are **global** — a single `start()` call serves all tenants. The claim query has no `tenant_id` filter; handlers are resolved via composite keys.

```typescript
const cron = new Cron({ db });
const tenantA = cron.forTenant("tenant-a");
const tenantB = cron.forTenant("tenant-b");

await tenantA.register("report", "0 9 * * *", handlerA);
await tenantB.register("report", "0 18 * * *", handlerB);

await cron.start(2); // single pool processes all tenants
```

When `tenantId` is omitted, it defaults to `"_default"` (exported as `DEFAULT_TENANT_ID`). Single-tenant usage is unchanged.

---

### Lifecycle

#### `cron.start(processorsCount?: number): Promise<void>`

Initialises the schema (idempotent) and starts N polling workers. Processors are global — they claim any due job regardless of `tenant_id`. One `start()` call serves all tenants.

```typescript
await cron.start(2); // 2 concurrent workers (default)
```

The schema is created under an advisory lock, so several instances may start at once on a database that has no cron tables yet. The schema check runs once per instance, on first use (`start()` or the first management call): when `db` is a driver shared with your own code, make that first call outside any transaction of yours (see [`CronDb`](#crondb)). With `dbHealthCheck` set, `start()` also runs the first health check before it resolves.

**Rejects** if the schema cannot be initialised (with the database's [error](#errors)), or if a `stop()` is still draining. Nothing is started in either case.

With a single `pg.Client` as `db`, or a driver over one connection, every processor shares that one session: each statement takes its turn, so handlers overlap but database work does not. A `pg.Pool` is still the recommendation.

#### `cron.stop(options?: { drainTimeoutMs?: number }): Promise<void>`

Gracefully stops all workers. Aborts the per-execution `AbortSignal` so handlers that honour it can cancel their work.

`drainTimeoutMs` (default: **30 000 ms**) caps how long `stop()` waits for in-flight handlers to drain. Pass `0` to wait forever (legacy behaviour). When the cap is exceeded, in-flight job IDs are logged at error level and `stop()` returns; the orphaned executions continue in the background but cannot claim new work.

Once `stop()` has returned the instance can be `start()`-ed again — also after a capped drain.

A failing job's remaining retry attempts are abandoned on `stop()`; the cycle is recorded as failed.

#### `cron.resetHard(): Promise<void>`

Drops and recreates the schema tables. **Deletes all job data.** Intended for testing only.

#### `cron.uninstall(): Promise<void>`

Permanently removes all tables created by this package.

---

### Registration

#### `cron.register(name, expression, handler, options?): Promise<CronJob>`

Registers (or updates) a cron job. On first call creates the DB row; on subsequent calls updates expression/options but preserves `next_run_at` unless `forceNextRunRecalculate` is set.

The job is scoped to the instance's `tenantId`. The unique constraint is `(tenant_id, name)`.

Throws if `expression` is not a valid 5-field cron expression — including impossible date combinations like `0 0 31 2 *` (Feb 31).

**Parameters:**

- `name` (string) — Job identifier (unique within the tenant)
- `expression` (string) — 5-field cron expression
- `handler` (CronHandler) — Async function to execute
- `options` (CronRegisterOptions, optional)

**`CronRegisterOptions`:**

| Option                    | Type                  | Default  | Description                                                                                  |
| ------------------------- | --------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `payload`                 | `Record<string, any>` | `{}`     | Static data passed to handler as `job.payload`                                               |
| `enabled`                 | `boolean`             | `true`   | Whether job participates in polling                                                          |
| `max_attempts`            | `number`              | `1`      | Max retries within one execution cycle                                                       |
| `max_attempt_duration_ms` | `number`              | `0`      | Timeout per attempt (0 = disabled)                                                           |
| `backoff_strategy`        | `"none" \| "exp"`     | `"none"` | Delay between retries (exp is clamped, see below)                                            |
| `timezone`                | `string \| null`      | `null`   | IANA timezone for the cron expression (e.g. `"Europe/Prague"`); `null` means host local time |
| `forceNextRunRecalculate` | `boolean`             | `false`  | Recalculate `next_run_at` on upsert                                                          |

> **Backoff:** `"exp"` strategy doubles the delay each attempt (`2^n s`) and is clamped at **5 minutes**. Legacy unbounded growth is gone.

```typescript
const job = await cron.register("backup", "0 2 * * *", async (job, signal) => {
  await runBackup(job.payload.bucket, { signal });
  return { files: 42 };
}, {
  payload: { bucket: "my-bucket" },
  max_attempts: 3,
  max_attempt_duration_ms: 60_000,
  backoff_strategy: "exp",
  timezone: "Europe/Prague",
});
```

> **Missed runs:** after each run the next slot is derived from the job's schedule (in its `timezone`). If that slot is already in the past — the process was down, or the run outlasted its interval — the missed ticks are **skipped** and the job resumes at the first future slot. Nothing is replayed.

#### `cron.unregister(name: string): Promise<void>`

Hard-deletes a job and its run log from the database (scoped to tenant). Also removes the in-memory handler.

#### `cron.setHandler(name, handler): Cron`

Sets or replaces the in-memory handler without touching the database. Pass `null` or `undefined` to remove the handler. Chainable.

#### `cron.removeHandler(name): Cron`

Removes the in-memory handler. Chainable.

#### `cron.resetHandlers(): void`

Removes all registered in-memory handlers.

#### `cron.hasHandler(name): boolean`

Returns `true` if an in-memory handler is registered.

#### `cron.listHandlerNames(): string[]`

Returns the job names of all in-memory handlers in the current tenant.

---

### Enable / Disable

#### `cron.enable(name: string): Promise<CronJob>`

Enables a disabled job (scoped to tenant). Returns the updated row.

If the job's `next_run_at` passed while it was disabled, it is moved to the next slot — the job does not fire immediately for the tick it missed. Calling `enable()` on a job that is already enabled never changes its schedule.

#### `cron.disable(name: string): Promise<CronJob>`

Disables a job (scoped to tenant). Disabled jobs are skipped during polling. Returns the updated row.

---

### Querying

#### `cron.find(name: string): Promise<CronJob | null>`

Fetches a job by name within the current tenant. Returns `null` if not found.

#### `cron.fetchAll(options?): Promise<CronJob[]>`

Fetches all registered jobs for the current tenant.

**Options:**

- `enabled` (boolean) — Filter by enabled state
- `status` (`"idle" | "running"`) — Filter by status
- `limit` / `offset` (number) — Pagination

#### `cron.getRunHistory(name, options?): Promise<CronRunLog[]>`

Returns the execution log for a job, newest first.

**Options:**

- `limit` / `offset` (number) — Pagination
- `sinceMinutesAgo` (number) — Time window filter

---

### Maintenance

#### `cron.cleanup(maxAllowedRunDurationMinutes?: number): Promise<number>`

Resets stuck `running` jobs back to `idle` (crash recovery). Default threshold: 5 minutes. Returns the number of rows recovered.

A job is stuck when its worker has shown no sign of life — claim or heartbeat (`heartbeatIntervalMs`) — for longer than the threshold. The threshold is therefore not a cap on run time: a live worker keeps its claim however long the job takes, and only a dead one loses it. Keep the threshold at three heartbeats or more. A handler that hangs in a live process keeps its claim too — bound it with `max_attempt_duration_ms`.

When recovering a stuck row, the row's `lease_token` is cleared. If the original (still-alive) worker later writes a result, its `WHERE id = $ AND lease_token = $` predicate fails — preventing it from clobbering whatever fresh execution has happened in the meantime.

**Global vs scoped cleanup:**

- Called on `Cron` instance: recovers **all** stuck jobs globally (no `tenant_id` filter).
- Called on `CronTenantScope` (via `forTenant()`): recovers only that tenant's stuck jobs.

#### `cron.pruneRunLog(olderThanMinutes: number): Promise<number>`

Deletes run-log rows older than the threshold. Returns the number of rows deleted. Same global / scoped split as `cleanup()`.

```typescript
// Keep 30 days of history
await cron.pruneRunLog(60 * 24 * 30);
```

#### `cron.healthPreview(sinceMinutesAgo?: number): Promise<CronHealthPreviewRow[]>`

Returns execution statistics grouped by `status` (scoped to tenant). Useful for monitoring dashboards.

```typescript
const stats = await cron.healthPreview(60); // last 60 minutes
// [{ status: "success", count: 42, avg_duration_seconds: 0.3 }, ...]
```

---

### Events

#### `cron.onDone(name, callback): Unsubscriber`

Fires after successful completion. `name` can be a string or array of strings.

```typescript
const unsub = cron.onDone("backup", (job) => {
  console.log(`Next run: ${job.next_run_at}`);
});
```

#### `cron.onError(name, callback): Unsubscriber`

Fires after all attempts fail (status `error` or `timeout`).

#### `cron.unsubscribeAll(): void`

Removes all event listeners. Primarily used in tests.

---

### Tenant Scoping

#### `cron.forTenant(tenantId): CronTenantScope`

Returns a lightweight tenant-scoped view sharing the parent's processor pool.

The returned `CronTenantScope` exposes all management methods but **no** lifecycle methods (`start`, `stop`, `resetHard`, `uninstall`) — those stay on the parent `Cron`.

```typescript
const tenantA = cron.forTenant("tenant-a");
await tenantA.register("report", "0 9 * * *", handler);
const jobs = await tenantA.fetchAll();
```

**`CronTenantScope` methods:**

| Method             | Signature                                                   | Notes                                         |
| ------------------ | ----------------------------------------------------------- | --------------------------------------------- |
| `register`         | `(name, expression, handler, options?) => Promise<CronJob>` |                                               |
| `unregister`       | `(name) => Promise<void>`                                   |                                               |
| `enable`           | `(name) => Promise<CronJob>`                                |                                               |
| `disable`          | `(name) => Promise<CronJob>`                                |                                               |
| `find`             | `(name) => Promise<CronJob \| null>`                        |                                               |
| `fetchAll`         | `(options?) => Promise<CronJob[]>`                          |                                               |
| `getRunHistory`    | `(name, options?) => Promise<CronRunLog[]>`                 |                                               |
| `healthPreview`    | `(sinceMinutesAgo?) => Promise<CronHealthPreviewRow[]>`     |                                               |
| `cleanup`          | `(maxMins?) => Promise<number>`                             | Tenant-scoped (only this tenant's stuck jobs) |
| `pruneRunLog`      | `(olderThanMinutes) => Promise<number>`                     | Tenant-scoped                                 |
| `setHandler`       | `(name, handler) => CronTenantScope`                        | Chainable                                     |
| `hasHandler`       | `(name) => boolean`                                         |                                               |
| `listHandlerNames` | `() => string[]`                                            |                                               |
| `removeHandler`    | `(name) => CronTenantScope`                                 | Chainable                                     |
| `onDone`           | `(name, cb, skipIfExists?) => Unsubscriber`                 |                                               |
| `onError`          | `(name, cb, skipIfExists?) => Unsubscriber`                 |                                               |

The `tenantId` is available as a readonly property: `tenantA.tenantId`.

---

### DB Health

A health check is one `select 1`, timed. A check that has not answered within its timeout is unhealthy; its query is abandoned, not cancelled. A database that is down or does not answer gives an unhealthy [`DbHealthStatus`](#dbhealthstatus), never a rejection. After a healthy check the status carries `pgVersion`, asked once and then remembered.

#### `cron.getDbHealth(): DbHealthStatus | null`

Returns the latest status of the monitor that the `dbHealthCheck` option starts. `null` when the option is not set, and before `start()` has run the first check. After `stop()` the monitor stops and the last status stays.

```typescript
const cron = new Cron({ db, dbHealthCheck: { timeoutMs: 2_000 } });
await cron.start();
cron.getDbHealth(); // { healthy: true, latencyMs: 0.8, error: null, timestamp, pgVersion: "18.6" }
```

#### `cron.checkDbHealth(): Promise<DbHealthStatus>`

Runs one check now, whether `dbHealthCheck` is set or not, with a 5 s timeout (`dbHealthCheck.timeoutMs` applies to the monitor only). A failed check is logged at error level.

```typescript
const status = await cron.checkDbHealth();
if (!status.healthy) console.error(status.error);
```

---

### Static Methods

#### `Cron.migrate(db: CronDb, tablePrefix?: string): Promise<void>`

Idempotent schema migration. `db` is a pool, a client or a `pg` driver, as for the constructor ([`CronDb`](#crondb)). Brings any prior schema up to current. Safe to call multiple times. Handles:

- **Legacy `project_id` → `tenant_id`**: renames the old column (and its indexes) in place when present, preserving existing data.
- **v1 → v2**: adds the `tenant_id` column and reshapes indexes.
- **v2 → v3**: adds `lease_token` and `timezone` columns plus CHECK constraints.
- **Data repair**: re-stamps run-log rows whose `tenant_id` differs from their job's (3.2 and earlier logged every run under the instance's own tenant).

The migration runs in one transaction, on one connection, whichever form `db` takes. Safe to call again with a mixed-case `tablePrefix`.

```typescript
await Cron.migrate(db);
await Cron.migrate(db, "myschema."); // with table prefix
```

#### `Cron.__schema(tablePrefix?): { drop: string; create: string }`

Returns raw SQL strings for schema operations. Internal use.

---

## Task Registry

The task registry is an in-memory catalog of known task types. It maps string labels to handler functions and optional JSON Schema definitions for payload validation. The registry is stateless — the database remains the source of truth for scheduled job instances.

### `createTaskRegistry(): TaskRegistry`

Creates a new registry instance.

```typescript
import { createTaskRegistry } from "@marianmeres/cron";

const registry = createTaskRegistry();
```

### `registry.define(taskType, definition): void`

Registers a task type. Throws if `taskType` is already defined.

**Parameters:**

- `taskType` (string) — Unique task type identifier
- `definition` (TaskDefinition)
  - `handler` (CronHandler) — Required. The function to execute.
  - `description` (string, optional) — Human-readable description.
  - `paramsSchema` (object, optional) — JSON Schema for payload validation.

```typescript
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
    return { sent: recipients.length };
  },
});
```

### `registry.get(taskType): TaskDefinition | undefined`

Returns the full definition (including handler) for a task type.

### `registry.has(taskType): boolean`

Returns `true` if the task type is registered.

### `registry.list(): TaskRegistryEntry[]`

Returns all registered task types **without handlers** — safe for API serialization and UI consumption.

```typescript
const tasks = registry.list();
// [{ taskType: "send-report", description: "...", paramsSchema: {...} }, ...]
```

### `registry.validate(taskType, payload): Promise<TaskValidationResult>`

Validates a payload against the task type's `paramsSchema` — the JSON Schema is compiled by AJV, via `@marianmeres/modelize`'s `/ajv` subpath. Returns `{ valid: true, errors: [] }` if no schema is defined.

Throws if the task type is unknown, or if `@marianmeres/modelize` / `ajv` cannot be imported. `ajv` is an optional peer dependency and has to be installed explicitly.

```typescript
const result = await registry.validate("send-report", {
  recipients: ["alice@example.com"],
});
// { valid: true, errors: [] }

const bad = await registry.validate("send-report", {});
// { valid: false, errors: [{ path: "", message: "must have required property 'recipients'" }] }
```

---

## `syncRegistryToCron(cron, registry, options?): Promise<SyncRegistryResult>`

Wires task registry handlers to a `Cron` instance and reconciles state.

For each registered task type, calls `cron.setHandler(taskType, handler)`. Then:

- Removes any in-memory handlers that no longer appear in the registry (`removedHandlers`).
- Scans DB jobs in pages and reports those with no matching registry entry (`orphans`).

DB scan uses `pageSize: 500` by default; override via the third argument.

Does **not** auto-create or auto-delete DB rows — use `cron.register()` /
`cron.unregister()` separately to manage job instances.

```typescript
import { syncRegistryToCron } from "@marianmeres/cron";

const { synced, orphans, removedHandlers } = await syncRegistryToCron(
  cron,
  registry,
  { pageSize: 1000 }
);
console.log("Handlers wired:", synced);
console.log("Jobs without handlers:", orphans);
console.log("Stale handlers removed:", removedHandlers);
```

**Returns:** `SyncRegistryResult`

- `synced` (string[]) — Task types whose handlers were wired
- `orphans` (string[]) — Job names in DB with no matching registry entry
- `removedHandlers` (string[]) — In-memory handlers removed because they no longer appear in the registry

---

## Errors

- **A database call that fails** rejects with a `SqlError` from [`@marianmeres/sqlkit`](https://www.npmjs.com/package/@marianmeres/sqlkit), as the subclass of its kind: `ConnectionError`, `DeadlockError`, `SerializationError`, `BusyError`, `UniqueViolationError`, `TransactionAbortedError`, … That holds for every method that reads or writes the database, and for `start()` when the schema cannot be initialised.
  - `code` — node-postgres's: the SQLSTATE (`40P01`), or Node's code for a lost socket (`ECONNRESET`)
  - `message` — node-postgres's
  - `kind` — the class as a string (`"connection"`, `"deadlock"`, …)
  - `retryable` — whether `dbRetry` retries it by default
  - `cause` — node-postgres's error, untouched: read `detail`, `severity` or `where` there
- **A programming mistake** is a `TypeError`, never wrapped: a missing `db` or a driver whose dialect is not `pg`, and a `dbHealthCheck` option out of range (all from the constructor); a `dbRetry` option out of range (at the first call it wraps, see [`DbRetryOptions`](#dbretryoptions)).
- **What a handler throws** is not a database error: it fails the attempt and is recorded in the run log.

```typescript
import { ConnectionError, SqlError } from "@marianmeres/sqlkit";

try {
  await cron.register("report", "0 8 * * *", handler);
} catch (e) {
  if (e instanceof ConnectionError) retryLater();
  else if (e instanceof SqlError) console.error(e.kind, e.code, e.cause);
  else throw e;
}
```

`instanceof` holds against the copy of `@marianmeres/sqlkit` that cron itself resolves; `kind` and `code` hold whatever copy you import.

---

## Types

### `CronJob`

```typescript
interface CronJob {
  id: number;
  uid: string;
  tenant_id: string;
  name: string;
  expression: string;
  timezone: string | null;             // IANA tz, null = host local time
  payload: Record<string, any>;
  enabled: boolean;
  status: "idle" | "running";
  next_run_at: Date;
  last_run_at: Date | null;            // last sign of life: claim, heartbeat, or completion
  last_run_status: "success" | "error" | "timeout" | null;
  lease_token: string | null;          // per-claim fence (UUID)
  max_attempts: number;
  max_attempt_duration_ms: number;
  backoff_strategy: "none" | "exp";
  created_at: Date;
  updated_at: Date;
}
```

### `CronRunLog`

```typescript
interface CronRunLog {
  id: number;
  cron_id: number;
  cron_name: string;
  tenant_id: string;
  scheduled_at: Date;      // next_run_at captured at claim time (drift-safe reference)
  started_at: Date;
  completed_at: Date | null;
  attempt_number: number;
  status: "success" | "error" | "timeout" | null;
  result: Record<string, any> | null;
  error_message: string | null;
  error_details: Record<string, any> | null;
}
```

### `CronHealthPreviewRow`

```typescript
interface CronHealthPreviewRow {
  status: string;
  count: number;
  avg_duration_seconds: number | null;
}
```

A single row from the health preview query, representing execution statistics grouped by run status.

### `CronTenantScope`

```typescript
interface CronTenantScope {
  readonly tenantId: string;
  register(name, expression, handler, options?): Promise<CronJob>;
  unregister(name): Promise<void>;
  enable(name): Promise<CronJob>;
  disable(name): Promise<CronJob>;
  find(name): Promise<CronJob | null>;
  fetchAll(options?): Promise<CronJob[]>;
  getRunHistory(name, options?): Promise<CronRunLog[]>;
  healthPreview(sinceMinutesAgo?): Promise<CronHealthPreviewRow[]>;
  cleanup(maxAllowedRunDurationMinutes?): Promise<number>;
  pruneRunLog(olderThanMinutes): Promise<number>;
  setHandler(name, handler): CronTenantScope;
  hasHandler(name): boolean;
  listHandlerNames(): string[];
  removeHandler(name): CronTenantScope;
  onDone(name, cb, skipIfExists?): Unsubscriber;
  onError(name, cb, skipIfExists?): Unsubscriber;
}
```

A lightweight tenant-scoped view returned by `cron.forTenant()`. Shares the parent's processor pool. Has all management methods but no lifecycle methods (`start`, `stop`, `resetHard`, `uninstall`). The `cleanup()` and `pruneRunLog()` methods on a scope are tenant-scoped (only that tenant's rows), unlike the global `cron.cleanup()` / `cron.pruneRunLog()`.

### `TaskDefinition`

```typescript
interface TaskDefinition {
  description?: string;
  paramsSchema?: Record<string, any>;
  handler: CronHandler;
}
```

### `TaskRegistryEntry`

```typescript
interface TaskRegistryEntry {
  taskType: string;
  description?: string;
  paramsSchema?: Record<string, any>;
}
```

Returned by `registry.list()` — handler omitted for safe serialization.

### `TaskValidationResult`

```typescript
interface TaskValidationResult {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
}
```

### `SyncRegistryResult`

```typescript
interface SyncRegistryResult {
  synced: string[];
  orphans: string[];
  removedHandlers: string[];
}
```

---

### `CronHandler`

```typescript
type CronHandler = (job: CronJob, signal?: AbortSignal) => any | Promise<any>;
```

The return value is stored in `CronRunLog.result`. Throw to indicate failure.

The optional `signal` is `abort()`-ed when the per-attempt timeout fires **or** when the Cron instance is shutting down. Pass it through to anything cancellable (e.g. `fetch`, child processes) for real cooperative cancellation.

---

### `CronStopOptions`

```typescript
interface CronStopOptions {
  /** Hard cap (ms) on draining in-flight jobs. Default: 30_000. Pass 0 to wait forever. */
  drainTimeoutMs?: number;
}
```

---

### `CronDb`

```typescript
type CronDb = PgPoolLike | PgStandaloneClientLike | Driver;
```

What `CronOptions.db` and `Cron.migrate()` take. `PgPoolLike` and `PgStandaloneClientLike` are sqlkit's structural types (`@marianmeres/sqlkit/pg`): a `pg.Pool` and a connected `pg.Client` fit them as they are, so cron imports nothing from `pg`. `Driver` is a sqlkit driver; its `dialect` must be `"pg"`, as with `createPgDriver(pool)` or `createPgClientDriver(client)`.

- cron builds one driver per pool or client object and reuses it, however many `Cron` instances, `checkDbHealth()` or `Cron.migrate()` calls share that object. A `Driver` is used as it is.
- cron never closes what it is given: no `end()`, no `close()`.
- A shared `Driver` carries your transactions. A `cron.register()` called inside your `driver.transaction()` is part of it, and the job exists only if you commit. `dbRetry` cannot help there: after a failure Postgres has aborted the transaction.
- Make an instance's first call, and `start()`, outside any transaction of yours. On a database with no cron tables yet, a schema check inside a transaction that rolls back is rolled back with it, and the instance does not check again.
- When cron and another sqlkit-based library use the same pool, build one `Driver` and pass it to both. Two drivers on one pool each take the other's `error` listener for the host's, so neither reports a dropped idle connection.

```typescript
import pg from "pg";
import { createPgDriver } from "@marianmeres/sqlkit/pg";

const driver = createPgDriver(new pg.Pool({ connectionString: process.env.DATABASE_URL }));
const cron = new Cron({ db: driver });
await Cron.migrate(driver);
```

### `DbRetryOptions`

```typescript
interface DbRetryOptions {
  maxRetries?: number;        // calls after the first, a non-negative integer (default: 3)
  initialDelayMs?: number;    // wait before the first retry (default: 100)
  maxDelayMs?: number;        // longest wait between two calls (default: 5000)
  backoffMultiplier?: number; // each wait times this is the next one, at least 1 (default: 2)
  retryableErrors?: string[]; // replaces the default classification
  logger?: Logger;            // ignored in CronOptions.dbRetry: cron passes its own
}
```

The options of `CronOptions.dbRetry` (`true` means all defaults). The wait before retry `n` is `initialDelayMs * backoffMultiplier ** (n - 1)`, at most `maxDelayMs`. Each retry is logged at warn level.

By default an error is retried when sqlkit classifies it as retryable, by its code: a lost or refused connection (Node's socket codes, SQLSTATE class `08`), a server starting up or shutting down (`57P01`–`57P03`), too many connections (`53300`), a deadlock (`40P01`), a serialization failure (`40001`), a lock not granted in time (`55P03`), and node-postgres's pool timeout and terminated connection, which carry no code. A code that appears only in an error's message does not count.

`retryableErrors` replaces that: an error is retried exactly when its `code` is in the list, or its message contains one of the entries.

An option of the wrong type or out of range (a negative or fractional `maxRetries`, a `backoffMultiplier` below 1, a negative delay) is a `TypeError` at the first call `dbRetry` wraps. That call is the claim: the processors log the error as a claim error and claim nothing.

### `DbHealthStatus`

```typescript
interface DbHealthStatus {
  healthy: boolean;
  latencyMs: number | null; // null when the check failed; may be a fraction
  error: string | null;     // the driver's message, or the timeout's; null when healthy
  timestamp: Date;          // when the check was sent
  pgVersion?: string;       // e.g. "18.6", after a healthy check
}
```

What `cron.checkDbHealth()` and `cron.getDbHealth()` return, and what `onUnhealthy` / `onHealthy` receive.

---

## Constants

### `DEFAULT_TENANT_ID`

`"_default"` — The tenant identifier used when no `tenantId` is specified in `CronOptions`.

### `CRON_STATUS`

| Key       | Value       | Description                        |
| --------- | ----------- | ---------------------------------- |
| `IDLE`    | `"idle"`    | Job waiting for next scheduled run |
| `RUNNING` | `"running"` | Job currently executing            |

### `RUN_STATUS`

| Key       | Value       | Description                                  |
| --------- | ----------- | -------------------------------------------- |
| `SUCCESS` | `"success"` | Execution completed successfully             |
| `ERROR`   | `"error"`   | Execution failed with an error               |
| `TIMEOUT` | `"timeout"` | Execution exceeded `max_attempt_duration_ms` |

### `BACKOFF_STRATEGY`

| Key    | Value    | Description                                                   |
| ------ | -------- | ------------------------------------------------------------- |
| `NONE` | `"none"` | No delay between retries                                      |
| `EXP`  | `"exp"`  | Exponential backoff `2^attempt` seconds, **clamped at 5 min** |

---

## `CronParser`

Standalone 5-field cron notation parser. Used internally by `Cron` for expression validation and `next_run_at` computation.

```typescript
import { CronParser } from "@marianmeres/cron";

const parser = new CronParser("*/15 * * * *");
const next = parser.getNextRun(new Date());
console.log(next); // Date: next 15-minute boundary

parser.matches(new Date()); // boolean — true if expression matches this date

// Timezone-aware
const tzed = new CronParser("0 9 * * 1-5", { timezone: "Europe/Prague" });
```

#### `new CronParser(expression: string, options?: { timezone?: string })`

Throws if `expression` is not a valid 5-field cron expression, or if it describes a calendar combination that can never occur (e.g. `0 0 31 2 *`).

`timezone` is an optional IANA timezone name used to evaluate the expression. When omitted, the host's local timezone is used. DST transitions are handled correctly — spring-forward gaps skip non-existent minutes, fall-back overlaps fire only once.

#### `parser.matches(date: Date): boolean`

Returns `true` if the expression matches the given date.

**Day-of-month + day-of-week semantics:** when both fields are restricted (i.e. neither is `*`), they are **OR**-ed (POSIX/Vixie cron). When only one is restricted, only that one matters.

#### `parser.getNextRun(from?: Date): Date`

Returns the next scheduled time after `from` (default: `new Date()`).

Throws if no matching time is found within ~8 years (defensive cap; covers leap-day expressions and rare DoM+DoW combinations).
