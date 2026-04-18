# API

## Class: `Cron`

```typescript
const cron = new Cron(options: CronOptions);
```

### Constructor Options (`CronOptions`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `db` | `pg.Pool \| pg.Client` | required | PostgreSQL connection |
| `projectId` | `string` | `"_default"` | Project scope identifier — isolates all jobs to this project |
| `tablePrefix` | `string` | `""` | Prefix for table names (e.g. `"myschema."`) |
| `pollTimeoutMs` | `number` | `1000` | Poll interval when no jobs are due (ms) |
| `gracefulSigterm` | `boolean` | `true` | Register SIGTERM handler for graceful shutdown |
| `logger` | `Logger` | `clog("cron")` | Logger instance |
| `dbRetry` | `DbRetryOptions \| boolean` | — | Enable retry on transient DB errors |
| `dbHealthCheck` | `boolean \| object` | — | Enable DB health monitoring |
| `autoCleanup` | `boolean \| { intervalMs?, maxAllowedRunDurationMinutes? }` | — | Automatically `cleanup()` on a timer (`true` ≡ `{ intervalMs: 60_000, maxAllowedRunDurationMinutes: 5 }`) |

#### Project scoping

The `Cron` constructor accepts a `projectId` for its own default scope (used by direct method calls like `cron.register()`). For multi-project setups, use `cron.forProject()` to get lightweight project-scoped views that share the same processor pool.

Processors are **global** — a single `start()` call serves all projects. The claim query has no `project_id` filter; handlers are resolved via composite keys.

```typescript
const cron = new Cron({ db });
const projA = cron.forProject("project-a");
const projB = cron.forProject("project-b");

await projA.register("report", "0 9 * * *", handlerA);
await projB.register("report", "0 18 * * *", handlerB);

await cron.start(2); // single pool processes all projects
```

When `projectId` is omitted, it defaults to `"_default"` (exported as `DEFAULT_PROJECT_ID`). Single-project usage is unchanged.

---

### Lifecycle

#### `cron.start(processorsCount?: number): Promise<void>`

Initialises the schema (idempotent) and starts N polling workers. Processors are global — they claim any due job regardless of `project_id`. One `start()` call serves all projects.

```typescript
await cron.start(2); // 2 concurrent workers (default)
```

#### `cron.stop(options?: { drainTimeoutMs?: number }): Promise<void>`

Gracefully stops all workers. Aborts the per-execution `AbortSignal` so handlers that honour it can cancel their work.

`drainTimeoutMs` (default: **30 000 ms**) caps how long `stop()` waits for in-flight handlers to drain. Pass `0` to wait forever (legacy behaviour). When the cap is exceeded, in-flight job IDs are logged at error level and `stop()` returns; the orphaned executions continue in the background but cannot claim new work.

#### `cron.resetHard(): Promise<void>`

Drops and recreates the schema tables. **Deletes all job data.** Intended for testing only.

#### `cron.uninstall(): Promise<void>`

Permanently removes all tables created by this package.

---

### Registration

#### `cron.register(name, expression, handler, options?): Promise<CronJob>`

Registers (or updates) a cron job. On first call creates the DB row; on subsequent calls updates expression/options but preserves `next_run_at` unless `forceNextRunRecalculate` is set.

The job is scoped to the instance's `projectId`. The unique constraint is `(project_id, name)`.

Throws if `expression` is not a valid 5-field cron expression — including impossible date combinations like `0 0 31 2 *` (Feb 31).

**Parameters:**
- `name` (string) — Job identifier (unique within the project)
- `expression` (string) — 5-field cron expression
- `handler` (CronHandler) — Async function to execute
- `options` (CronRegisterOptions, optional)

**`CronRegisterOptions`:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `payload` | `Record<string, any>` | `{}` | Static data passed to handler as `job.payload` |
| `enabled` | `boolean` | `true` | Whether job participates in polling |
| `max_attempts` | `number` | `1` | Max retries within one execution cycle |
| `max_attempt_duration_ms` | `number` | `0` | Timeout per attempt (0 = disabled) |
| `backoff_strategy` | `"none" \| "exp"` | `"none"` | Delay between retries (exp is clamped, see below) |
| `timezone` | `string \| null` | `null` | IANA timezone for the cron expression (e.g. `"Europe/Prague"`); `null` means host local time |
| `forceNextRunRecalculate` | `boolean` | `false` | Recalculate `next_run_at` on upsert |

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

#### `cron.unregister(name: string): Promise<void>`

Hard-deletes a job and its run log from the database (scoped to project). Also removes the in-memory handler.

#### `cron.setHandler(name, handler): Cron`

Sets or replaces the in-memory handler without touching the database. Pass `null` or `undefined` to remove the handler. Chainable.

#### `cron.removeHandler(name): Cron`

Removes the in-memory handler. Chainable.

#### `cron.resetHandlers(): void`

Removes all registered in-memory handlers.

#### `cron.hasHandler(name): boolean`

Returns `true` if an in-memory handler is registered.

#### `cron.listHandlerNames(): string[]`

Returns the job names of all in-memory handlers in the current project.

---

### Enable / Disable

#### `cron.enable(name: string): Promise<CronJob>`

Enables a disabled job (scoped to project). Returns the updated row.

#### `cron.disable(name: string): Promise<CronJob>`

Disables a job (scoped to project). Disabled jobs are skipped during polling. Returns the updated row.

---

### Querying

#### `cron.find(name: string): Promise<CronJob | null>`

Fetches a job by name within the current project. Returns `null` if not found.

#### `cron.fetchAll(options?): Promise<CronJob[]>`

Fetches all registered jobs for the current project.

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

When recovering a stuck row, the row's `lease_token` is cleared. If the original (still-alive) worker later writes a result, its `WHERE id = $ AND lease_token = $` predicate fails — preventing it from clobbering whatever fresh execution has happened in the meantime.

**Global vs scoped cleanup:**
- Called on `Cron` instance: recovers **all** stuck jobs globally (no `project_id` filter).
- Called on `CronProjectScope` (via `forProject()`): recovers only that project's stuck jobs.

#### `cron.pruneRunLog(olderThanMinutes: number): Promise<number>`

Deletes run-log rows older than the threshold. Returns the number of rows deleted. Same global / scoped split as `cleanup()`.

```typescript
// Keep 30 days of history
await cron.pruneRunLog(60 * 24 * 30);
```

#### `cron.healthPreview(sinceMinutesAgo?: number): Promise<CronHealthPreviewRow[]>`

Returns execution statistics grouped by `status` (scoped to project). Useful for monitoring dashboards.

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

### Project Scoping

#### `cron.forProject(projectId): CronProjectScope`

Returns a lightweight project-scoped view sharing the parent's processor pool.

The returned `CronProjectScope` exposes all management methods but **no** lifecycle methods (`start`, `stop`, `resetHard`, `uninstall`) — those stay on the parent `Cron`.

```typescript
const projA = cron.forProject("project-a");
await projA.register("report", "0 9 * * *", handler);
const jobs = await projA.fetchAll();
```

**`CronProjectScope` methods:**

| Method | Signature | Notes |
|--------|-----------|-------|
| `register` | `(name, expression, handler, options?) => Promise<CronJob>` | |
| `unregister` | `(name) => Promise<void>` | |
| `enable` | `(name) => Promise<CronJob>` | |
| `disable` | `(name) => Promise<CronJob>` | |
| `find` | `(name) => Promise<CronJob \| null>` | |
| `fetchAll` | `(options?) => Promise<CronJob[]>` | |
| `getRunHistory` | `(name, options?) => Promise<CronRunLog[]>` | |
| `healthPreview` | `(sinceMinutesAgo?) => Promise<CronHealthPreviewRow[]>` | |
| `cleanup` | `(maxMins?) => Promise<number>` | Project-scoped (only this project's stuck jobs) |
| `pruneRunLog` | `(olderThanMinutes) => Promise<number>` | Project-scoped |
| `setHandler` | `(name, handler) => CronProjectScope` | Chainable |
| `hasHandler` | `(name) => boolean` | |
| `listHandlerNames` | `() => string[]` | |
| `removeHandler` | `(name) => CronProjectScope` | Chainable |
| `onDone` | `(name, cb, skipIfExists?) => Unsubscriber` | |
| `onError` | `(name, cb, skipIfExists?) => Unsubscriber` | |

The `projectId` is available as a readonly property: `projA.projectId`.

---

### DB Health

#### `cron.getDbHealth(): DbHealthStatus | null`

Returns the last DB health status (requires `dbHealthCheck` option). Returns `null` if monitoring is disabled.

#### `cron.checkDbHealth(): Promise<DbHealthStatus>`

Runs a one-off DB health check.

---

### Static Methods

#### `Cron.migrate(db, tablePrefix?): Promise<void>`

Idempotent schema migration. Brings any prior schema (v1 with no `project_id`, or v2 without `lease_token` / `timezone` / CHECK constraints) up to current. Safe to call multiple times.

The migration runs in a real transaction (single connection — works against `pg.Pool`).

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

Validates a payload against the task type's `paramsSchema` using `@marianmeres/modelize` (AJV). Returns `{ valid: true, errors: [] }` if no schema is defined.

Throws if the task type is unknown or if `@marianmeres/modelize` is not installed.

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

## Types

### `CronJob`

```typescript
interface CronJob {
  id: number;
  uid: string;
  project_id: string;
  name: string;
  expression: string;
  timezone: string | null;             // IANA tz, null = host local time
  payload: Record<string, any>;
  enabled: boolean;
  status: "idle" | "running";
  next_run_at: Date;
  last_run_at: Date | null;
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
  project_id: string;
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

### `CronProjectScope`

```typescript
interface CronProjectScope {
  readonly projectId: string;
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
  setHandler(name, handler): CronProjectScope;
  hasHandler(name): boolean;
  listHandlerNames(): string[];
  removeHandler(name): CronProjectScope;
  onDone(name, cb, skipIfExists?): Unsubscriber;
  onError(name, cb, skipIfExists?): Unsubscriber;
}
```

A lightweight project-scoped view returned by `cron.forProject()`. Shares the parent's processor pool. Has all management methods but no lifecycle methods (`start`, `stop`, `resetHard`, `uninstall`). The `cleanup()` and `pruneRunLog()` methods on a scope are project-scoped (only that project's rows), unlike the global `cron.cleanup()` / `cron.pruneRunLog()`.

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

## Constants

### `DEFAULT_PROJECT_ID`

`"_default"` — The project identifier used when no `projectId` is specified in `CronOptions`.

### `CRON_STATUS`

| Key | Value | Description |
|-----|-------|-------------|
| `IDLE` | `"idle"` | Job waiting for next scheduled run |
| `RUNNING` | `"running"` | Job currently executing |

### `RUN_STATUS`

| Key | Value | Description |
|-----|-------|-------------|
| `SUCCESS` | `"success"` | Execution completed successfully |
| `ERROR` | `"error"` | Execution failed with an error |
| `TIMEOUT` | `"timeout"` | Execution exceeded `max_attempt_duration_ms` |

### `BACKOFF_STRATEGY`

| Key | Value | Description |
|-----|-------|-------------|
| `NONE` | `"none"` | No delay between retries |
| `EXP` | `"exp"` | Exponential backoff `2^attempt` seconds, **clamped at 5 min** |

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
