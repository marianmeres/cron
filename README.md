# @marianmeres/cron

[![NPM](https://img.shields.io/npm/v/@marianmeres/cron)](https://www.npmjs.com/package/@marianmeres/cron)
[![JSR](https://jsr.io/badges/@marianmeres/cron)](https://jsr.io/@marianmeres/cron)
[![License](https://img.shields.io/npm/l/@marianmeres/cron)](LICENSE)

PostgreSQL-backed recurring cron job scheduler. Supports concurrent workers via `FOR UPDATE SKIP LOCKED`, drift-safe scheduling, retries, timeouts, per-job run history, project-scoped isolation, and an optional task registry for UI-driven job management.

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

// Graceful shutdown
process.on("SIGTERM", () => cron.stop());
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

### Retries and timeouts

```typescript
await cron.register(
  "flaky-api",
  "*/5 * * * *",
  async () => callExternalApi(),
  {
    max_attempts: 3,                // retry up to 3 times per cycle
    max_attempt_duration_ms: 10000, // kill after 10s
    backoff_strategy: "exp",        // exponential backoff between retries
  }
);
```

### Concurrent workers (multiple processes)

Multiple `Cron` instances sharing the same PostgreSQL database safely co-exist — `FOR UPDATE SKIP LOCKED` ensures each job executes exactly once across all workers.

```typescript
// In each process / dyno:
const cron = new Cron({ db });
await cron.register("job", "* * * * *", handler);
await cron.start(1);
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
// [{ taskType: "send-report", description: "...", paramsSchema: {...} },
//  { taskType: "cleanup-uploads", description: "..." }]

// 3. Validate user-provided payload before creating a job
const result = await registry.validate("send-report", {
  recipients: ["alice@example.com"],
  format: "pdf",
});
// { valid: true, errors: [] }

// 4. Wire handlers to a project scope — this is where the registry
//    connects with project_id scoping. The same registry can be synced
//    to multiple project scopes independently.
const cron = new Cron({ db });
const myProject = cron.forProject("my-project");
const { synced, orphans } = await syncRegistryToCron(myProject, registry);
// synced: ["send-report", "cleanup-uploads"]
// orphans: jobs in DB with no matching registry entry

await cron.start(2);
```

`syncRegistryToCron` accepts both a `Cron` instance and a `CronProjectScope` (returned
by `forProject()`). When passed a project scope, the registry's handlers are bound to
that specific project — so the same task type definitions can serve multiple projects,
each with its own schedules and payloads, while sharing one processor pool.

> **Note:** Schema validation requires `@marianmeres/modelize` as a dependency
> (uses AJV internally). Install it alongside this package if you use `paramsSchema`.

### Cron expression format

Standard 5-field notation: `minute hour day-of-month month day-of-week`

```
"* * * * *"        — every minute
"0 2 * * *"        — daily at 02:00
"*/15 * * * *"     — every 15 minutes
"0 9 * * 1-5"      — weekdays at 09:00
"0 0 1 * *"        — first day of each month
```

### Migrating from v1

If upgrading an existing database (v1 had no `project_id` column), run the migration
helper once:

```typescript
await Cron.migrate(db);
// or with a table prefix:
await Cron.migrate(db, "myschema.");
```

This adds the `project_id` column, drops the old single-column `name` unique index,
creates the composite `(project_id, name)` unique index, and updates the polling index
to `(enabled, status, next_run_at)` (no longer project-scoped, since processors are
now global). Safe to call multiple times.

## API

See [API.md](API.md) for full API reference.

## License

[MIT](LICENSE)
