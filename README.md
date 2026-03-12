# @marianmeres/cron

[![NPM](https://img.shields.io/npm/v/@marianmeres/cron)](https://www.npmjs.com/package/@marianmeres/cron)
[![JSR](https://jsr.io/badges/@marianmeres/cron)](https://jsr.io/@marianmeres/cron)
[![License](https://img.shields.io/npm/l/@marianmeres/cron)](LICENSE)

PostgreSQL-backed recurring cron job scheduler. Supports concurrent workers via `FOR UPDATE SKIP LOCKED`, drift-safe scheduling, retries, timeouts, and per-job run history.

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

### Cron expression format

Standard 5-field notation: `minute hour day-of-month month day-of-week`

```
"* * * * *"        — every minute
"0 2 * * *"        — daily at 02:00
"*/15 * * * *"     — every 15 minutes
"0 9 * * 1-5"      — weekdays at 09:00
"0 0 1 * *"        — first day of each month
```

## API

See [API.md](API.md) for full API reference.

## License

[MIT](LICENSE)
