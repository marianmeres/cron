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

#### `cron.stop(): Promise<void>`

Gracefully stops all workers. Waits for any currently executing jobs to complete.

#### `cron.resetHard(): Promise<void>`

Drops and recreates the schema tables. **Deletes all job data.** Intended for testing only.

#### `cron.uninstall(): Promise<void>`

Permanently removes all tables created by this package.

---

### Registration

#### `cron.register(name, expression, handler, options?): Promise<CronJob>`

Registers (or updates) a cron job. On first call creates the DB row; on subsequent calls updates expression/options but preserves `next_run_at` unless `forceNextRunRecalculate` is set.

The job is scoped to the instance's `projectId`. The unique constraint is `(project_id, name)`.

Throws if `expression` is not a valid 5-field cron expression.

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
| `backoff_strategy` | `"none" \| "exp"` | `"none"` | Delay between retries |
| `forceNextRunRecalculate` | `boolean` | `false` | Recalculate `next_run_at` on upsert |

```typescript
const job = await cron.register("backup", "0 2 * * *", async (job) => {
  await runBackup(job.payload.bucket);
  return { files: 42 };
}, {
  payload: { bucket: "my-bucket" },
  max_attempts: 3,
  max_attempt_duration_ms: 60_000,
  backoff_strategy: "exp",
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

#### `cron.cleanup(maxAllowedRunDurationMinutes?: number): Promise<void>`

Resets stuck `running` jobs back to `idle` (crash recovery). Default threshold: 5 minutes.

**Global vs scoped cleanup:**
- Called on `Cron` instance: recovers **all** stuck jobs globally (no `project_id` filter).
- Called on `CronProjectScope` (via `forProject()`): recovers only that project's stuck jobs.

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
| `cleanup` | `(maxMins?) => Promise<void>` | Project-scoped (only this project's stuck jobs) |
| `setHandler` | `(name, handler) => CronProjectScope` | Chainable |
| `hasHandler` | `(name) => boolean` | |
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

Migrates an existing v1 schema to v2 by adding the `project_id` column, dropping the old single-column `name` unique index, creating the composite `(project_id, name)` unique index, and updating the polling index to `(enabled, status, next_run_at)` (global, no `project_id`). Safe to call multiple times (uses `IF NOT EXISTS` / `IF EXISTS`).

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

## `syncRegistryToCron(cron, registry): Promise<SyncRegistryResult>`

Wires task registry handlers to a `Cron` instance and detects orphan jobs.

For each registered task type, calls `cron.setHandler(taskType, handler)`. Then fetches all DB jobs for the project and reports which ones have no matching registry entry.

Does **not** auto-create DB rows — use `cron.register()` separately to create job instances with specific schedules.

```typescript
import { syncRegistryToCron } from "@marianmeres/cron";

const { synced, orphans } = await syncRegistryToCron(cron, registry);
console.log("Handlers wired:", synced);
console.log("Jobs without handlers:", orphans);
```

**Returns:** `SyncRegistryResult`
- `synced` (string[]) — Task types whose handlers were wired
- `orphans` (string[]) — Job names in DB with no matching registry entry

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
  payload: Record<string, any>;
  enabled: boolean;
  status: "idle" | "running";
  next_run_at: Date;
  last_run_at: Date | null;
  last_run_status: "success" | "error" | "timeout" | null;
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
  cleanup(maxAllowedRunDurationMinutes?): Promise<void>;
  setHandler(name, handler): CronProjectScope;
  hasHandler(name): boolean;
  removeHandler(name): CronProjectScope;
  onDone(name, cb, skipIfExists?): Unsubscriber;
  onError(name, cb, skipIfExists?): Unsubscriber;
}
```

A lightweight project-scoped view returned by `cron.forProject()`. Shares the parent's processor pool. Has all management methods but no lifecycle methods (`start`, `stop`, `resetHard`, `uninstall`). The `cleanup()` method on a scope is project-scoped (only recovers that project's stuck jobs), unlike the global `cron.cleanup()`.

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
}
```

---

### `CronHandler`

```typescript
type CronHandler = (job: CronJob) => any | Promise<any>;
```

The return value is stored in `CronRunLog.result`. Throw to indicate failure.

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
| `EXP` | `"exp"` | Exponential backoff: `2^attempt` seconds |

---

## `CronParser`

Standalone 5-field cron notation parser. Used internally by `Cron` for expression validation and `next_run_at` computation.

```typescript
import { CronParser } from "@marianmeres/cron";

const parser = new CronParser("*/15 * * * *");
const next = parser.getNextRun(new Date());
console.log(next); // Date: next 15-minute boundary

parser.matches(new Date()); // boolean — true if expression matches this date
```

#### `new CronParser(expression: string)`

Throws if `expression` is not a valid 5-field cron expression.

#### `parser.matches(date: Date): boolean`

Returns `true` if the expression matches the given date.

#### `parser.getNextRun(from?: Date): Date`

Returns the next scheduled time after `from` (default: `new Date()`).
