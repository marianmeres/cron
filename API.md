# API

## Class: `Cron`

```typescript
const cron = new Cron(options: CronOptions);
```

### Constructor Options (`CronOptions`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `db` | `pg.Pool \| pg.Client` | required | PostgreSQL connection |
| `tablePrefix` | `string` | `""` | Prefix for table names (e.g. `"myschema."`) |
| `pollTimeoutMs` | `number` | `1000` | Poll interval when no jobs are due (ms) |
| `gracefulSigterm` | `boolean` | `true` | Register SIGTERM handler for graceful shutdown |
| `logger` | `Logger` | `clog("cron")` | Logger instance |
| `dbRetry` | `DbRetryOptions \| boolean` | — | Enable retry on transient DB errors |
| `dbHealthCheck` | `boolean \| object` | — | Enable DB health monitoring |

---

### Lifecycle

#### `cron.start(processorsCount?: number): Promise<void>`

Initialises the schema (idempotent) and starts N polling workers.

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

Throws if `expression` is not a valid 5-field cron expression.

**Parameters:**
- `name` (string) — Unique job identifier
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

Hard-deletes a job and its run log from the database. Also removes the in-memory handler.

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

Enables a disabled job. Returns the updated row.

#### `cron.disable(name: string): Promise<CronJob>`

Disables a job. Disabled jobs are skipped during polling. Returns the updated row.

---

### Querying

#### `cron.find(name: string): Promise<CronJob | null>`

Fetches a job by name. Returns `null` if not found.

#### `cron.fetchAll(options?): Promise<CronJob[]>`

Fetches all registered jobs.

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

#### `cron.healthPreview(sinceMinutesAgo?: number): Promise<CronHealthPreviewRow[]>`

Returns execution statistics grouped by `status`. Useful for monitoring dashboards.

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

### DB Health

#### `cron.getDbHealth(): DbHealthStatus | null`

Returns the last DB health status (requires `dbHealthCheck` option). Returns `null` if monitoring is disabled.

#### `cron.checkDbHealth(): Promise<DbHealthStatus>`

Runs a one-off DB health check.

---

## Types

### `CronJob`

```typescript
interface CronJob {
  id: number;
  uid: string;
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

---

### `CronHandler`

```typescript
type CronHandler = (job: CronJob) => any | Promise<any>;
```

The return value is stored in `CronRunLog.result`. Throw to indicate failure.

---

## Constants

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
