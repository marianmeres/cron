# @marianmeres/cron — Agent Guide

## Quick Reference

- **Stack**: Deno, TypeScript, PostgreSQL (pg v8)
- **Test**: `deno task test` (all) | `deno test -A --env-file tests/cron-db.test.ts` (DB only)
- **Build**: `deno task npm:build`
- **Entry**: `src/mod.ts` → `src/cron.ts` → `src/cron/cron.ts` (includes `CronProjectScope` interface)

---

## Project Structure

```
src/
  mod.ts                  — public exports
  cron.ts                 — re-exports from src/cron/cron.ts
  cron-parser.ts          — 5-field cron notation parser (timezone-aware, POSIX DoM/DoW)
  task-registry.ts        — in-memory task type catalog with JSON Schema validation
  sync-registry.ts        — bridge: wires registry handlers to Cron, paginates DB scan, removes orphan handlers
  cron/
    cron.ts               — Cron class + all types/constants
    _schema.ts            — CREATE/DROP tables (_initialize, _uninstall) — uses withTx
    _register.ts          — UPSERT job row (keyed on project_id + name); takes timezone
    _claim-next.ts        — FOR UPDATE SKIP LOCKED atomic claim; issues lease_token
    _execute.ts           — retry loop, timeout, success/failure dispatch; passes AbortSignal to handler
    _handle-success.ts    — drift-safe next_run_at after success; real TX via withTx; lease_token fence
    _handle-failure.ts    — drift-safe next_run_at after all attempts fail; real TX; lease_token fence
                            also exports _backoffMs and DEFAULT_MAX_BACKOFF_MS (5 min)
    _find.ts              — _findByName, _fetchAll (project-scoped, fully parameterised)
    _log-run.ts           — run log CRUD + _logRunPrune
    _mark-stale.ts        — crash recovery: reset stuck RUNNING jobs (clears lease_token)
    _health-preview.ts    — aggregate stats from run log (project-scoped)
    utils/
      sleep.ts            — sleep(ms, ref?, signal?) with __timeout_ref__ for Deno hygiene + AbortSignal
      with-timeout.ts     — TimeoutError + withTimeout<T>(fn, ms, msg, abortController?)
      with-tx.ts          — withTx(db, async (client) => …) — works on Pool AND Client
      with-db-retry.ts    — withDbRetry() with exponential backoff
      db-health.ts        — DbHealthMonitor, checkDbHealth()
      pg-quote.ts         — pgQuoteIdentifier, pgQuoteValue (kept for legacy callers)
tests/
  _pg.ts                  — createPg() from TEST_PG_* env vars
  cron.test.ts            — 34 CronParser unit tests (no DB) — incl. DoM/DoW OR, leap day, timezone
  cron-db.test.ts         — 31 integration tests (requires DB, includes project_id scoping)
  cron-fixes.test.ts      — 14 tests covering B1/B4/B5/B6/D1/D2/D4 + pruneRunLog + sync orphan handlers
  task-registry.test.ts   — 9 tests: registry unit tests + syncRegistryToCron integration
```

---

## Critical Conventions

### 1. Processors are global, management is project-scoped (FUNDAMENTAL)

Processors claim any due job regardless of `project_id` — the claim query in `_claim-next.ts` has **no** project filter. Handler lookup uses composite keys: `${projectId}\0${name}`.

Management operations (register, unregister, find, fetchAll, enable, disable, health-preview, pruneRunLog) are project-scoped via `context.projectId`. The `project_id` column appears in both `__cron` and `__cron_run_log` tables. The unique constraint on `__cron` is `(project_id, name)`.

`forProject(projectId)` returns a `CronProjectScope` — a lightweight object that delegates to the parent `Cron`'s private `#do*` methods with a fixed `projectId`. It exposes management methods only; lifecycle methods (`start`, `stop`, `resetHard`, `uninstall`) stay on the parent.

`cron.cleanup()` and `cron.pruneRunLog()` recover/prune **globally**. Their counterparts on a `CronProjectScope` are project-scoped. Controlled by the `projectScoped` parameter in `_markStale` / `_logRunPrune`.

When adding new management queries, always include `project_id` in WHERE clauses. When adding processor-level logic, do NOT filter by `project_id`.

### 2. Drift-safe scheduling (INVARIANT — never break this)

Both `_handle-success.ts` and `_handle-failure.ts` MUST compute:
```typescript
const nextRunAt = new CronParser(job.expression, { timezone: job.timezone ?? undefined }).getNextRun(scheduledAt);
```
where `scheduledAt = job.next_run_at` captured at the START of `_executeCronJob`, BEFORE the claim UPDATE changes anything. The claim UPDATE (`_claim-next.ts`) deliberately does NOT touch `next_run_at`.

### 3. Real transactions on `pg.Pool` (CRITICAL)

`pool.query("BEGIN")` does NOT open a transaction — pg returns the connection right after, and `UPDATE` / `COMMIT` run on **different** connections. Anywhere a transaction is required, use:

```typescript
import { withTx } from "./utils/with-tx.ts";

await withTx(context.db, async (client) => {
  await client.query("UPDATE …");
  await someHelper(context, …, client);  // pass client through to inner helpers
});
```

Currently used in:
- `_handle-success.ts` (UPDATE row + finalize run log)
- `_handle-failure.ts` (UPDATE row)
- `_schema.ts` `_initialize` / `_uninstall`
- `Cron.migrate` (static method)

Inner helpers (`_logRunSuccess`, `_logRunError`, `_logRunStart`) accept an optional `client?` parameter — pass `client` for the transactional path, omit for autocommit.

### 4. Lease token fence (CRITICAL for stale recovery)

`_claim-next.ts` issues a fresh `lease_token UUID` per claim. `_mark-stale.ts` clears the column on stale recovery. `_handle-success.ts` / `_handle-failure.ts` add `AND lease_token = $` to their UPDATE — so an orphaned worker (whose lease was cleared by cleanup) cannot clobber a fresh claim's result.

When introducing new write paths against a claimed row, include the lease check.

### 5. AbortSignal propagation

`Cron.start()` creates an `AbortController` (`#shutdownCtrl`); `stop()` aborts it. `_executeCronJob` derives a per-attempt controller wired to the shutdown signal AND to the `withTimeout` controller. The handler signature is `(job, signal?)` — the signal aborts on either timeout or shutdown. `sleep()` accepts an optional `signal` so it returns early on abort.

When adding any wait inside a processor loop or handler chain, plumb the relevant signal through.

### 6. Claim pattern

`_claimNextCronJob` uses `FOR UPDATE SKIP LOCKED` — safe for concurrent workers. It does **not** filter by `project_id` (global claim). Returns `{ job, leaseToken }` — the `lease_token` is also written to the column on UPDATE. The processor resolves the handler via composite key `${job.project_id}\0${job.name}`.

### 7. Always recurring

Jobs toggle between `idle ↔ running` only. There are no terminal states in the `__cron` table. Terminal outcomes (`success | error | timeout`) live in `__cron_run_log`.

### 8. Retry scope

`max_attempts` = retries within ONE execution cycle (the `for` loop in `_execute.ts`). Each retry logs a separate run log entry. After all attempts fail, `_handleCronFailure` advances the schedule. Backoff between attempts uses `_backoffMs(strategy, attempt, maxMs?)`, clamped at `DEFAULT_MAX_BACKOFF_MS` (5 min) for `"exp"`.

### 9. Table prefix

All tables are prefixed: `${tablePrefix}__cron` and `${tablePrefix}__cron_run_log`. Always use `context.tableNames.tableCron` / `context.tableNames.tableCronRunLog`.

### 10. CronContext

Internal functions receive `CronContext` (not the `Cron` class). It holds `db`, `tableNames`, `logger`, `pubsubDone`, `pubsubError`, `projectId`. Handler keys in `#handlers` Map and pubsub channels use composite format: `${projectId}\0${name}`.

### 11. Day-of-month + day-of-week semantics

The `CronParser.matches()` function uses **OR** when both DoM and DoW fields are restricted (POSIX/Vixie cron). When one is `*`, only the other restricts. The parser caches `dayOfMonthIsStar` / `dayOfWeekIsStar` to make this decision.

### 12. Impossible date detection

`CronParser` rejects expressions whose DoM × month combination has zero solutions (e.g. `0 0 31 2 *`) at construction time — but only when DoW is unrestricted (because a restricted DoW can rescue an otherwise-impossible DoM via OR semantics).

### 13. Timezone

`CronParser` accepts `{ timezone?: string }` (IANA). When set, all wall-clock extraction goes through `Intl.DateTimeFormat`. The host's timezone is used when omitted. The `__cron.timezone` column persists the value per job; `_register` and the parser keep them in sync.

### 14. Event handler wraps (per-instance, no leaks)

`#eventWraps: Map<cb, Subscriber>` is a per-instance cache (not static). Wraps are evicted only when no subscriptions for the cb remain across either pubsub. The returned `Unsubscriber` is constructed to satisfy `pubsub@3`'s interface (callable + `Symbol.dispose`).

### 15. `stop()` drain cap

`stop({ drainTimeoutMs: 30_000 })` (default) races processor exit against a cap. If the cap wins, in-flight job IDs are logged at error level, `#isShuttingDown` stays `true`, and the orphaned processors will exit cleanly when their handler eventually returns (without claiming new jobs). The instance is not safe to `start()` again until those drain.

### 16. Auto-cleanup

`new Cron({ db, autoCleanup: true })` (or `{ intervalMs?, maxAllowedRunDurationMinutes? }`) starts a `setInterval` on `start()` that calls `cleanup()` at the configured cadence and clears the timer on `stop()`.

### 17. Task Registry

The task registry (`src/task-registry.ts`) is an in-memory `Map<string, TaskDefinition>`. It has no DB dependency. Key points:
- `define()` throws on duplicate task type names
- `list()` omits handlers (safe for API/UI serialization)
- `validate()` uses dynamic `import("@marianmeres/modelize")` for JSON Schema validation via AJV — returns `{ valid, errors }`. Returns `{ valid: true }` if no schema defined.
- The bridge `syncRegistryToCron()` wires handlers via `cron.setHandler()`, removes orphan handlers (in-memory handlers no longer in the registry), and paginates DB scan when reporting orphan jobs.

---

## DB Schema

### `__cron`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| uid | UUID | gen_random_uuid() |
| project_id | VARCHAR(255) | NOT NULL, DEFAULT '_default' |
| name | VARCHAR(255) | NOT NULL |
| expression | VARCHAR(100) | 5-field cron |
| timezone | VARCHAR(64) | nullable; IANA tz name (default: host local) |
| payload | JSONB | default `{}` |
| enabled | BOOLEAN | default TRUE |
| status | VARCHAR(20) | `idle \| running` (CHECK constraint) |
| next_run_at | TIMESTAMPTZ | drift-safe scheduled time |
| last_run_at | TIMESTAMPTZ | wall-clock time of last claim |
| last_run_status | VARCHAR(20) | `success \| error \| timeout \| null` (CHECK) |
| lease_token | UUID | per-claim fence; cleared on success/failure/stale |
| max_attempts | INTEGER | default 1 (CHECK >= 1) |
| max_attempt_duration_ms | INTEGER | 0 = disabled (CHECK >= 0) |
| backoff_strategy | VARCHAR(20) | `none \| exp` |
| created_at / updated_at | TIMESTAMPTZ | |

**Indexes:**
- `UNIQUE (project_id, name)` — composite uniqueness
- `(enabled, status, next_run_at)` — polling index (global, no project_id — processors claim across all projects)

### `__cron_run_log`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| cron_id | INTEGER FK | ON DELETE CASCADE |
| cron_name | VARCHAR(255) | |
| project_id | VARCHAR(255) | NOT NULL, DEFAULT '_default' |
| scheduled_at | TIMESTAMPTZ | next_run_at captured at claim time |
| started_at | TIMESTAMPTZ | |
| completed_at | TIMESTAMPTZ | nullable |
| attempt_number | INTEGER | 1-based (CHECK >= 1) |
| status | VARCHAR(20) | `success \| error \| timeout` (CHECK) |
| result | JSONB | handler return value |
| error_message | TEXT | |
| error_details | JSONB | `{ stack }` |

**Indexes:**
- `(cron_id)` — FK lookups
- `(started_at DESC)` — history queries
- `(project_id)` — per-project log queries

### Migration

`Cron.migrate(db, tablePrefix?)` is the single migration entry point. Runs in a real transaction (works on Pool). Idempotent. Currently bundles:
- v1 → v2: add `project_id` columns + reshape indexes
- v2 → v3: add `lease_token` and `timezone` columns + add CHECK constraints

When extending the schema in the future, add a new step inside `Cron.migrate` and bump the conceptual version note. CHECK additions go through the `addCheckIfMissing` helper (Postgres has no `IF NOT EXISTS` for constraints).

---

## Testing

- `tablePrefix = '_test_'` — tables are `_test___cron` and `_test___cron_run_log`
- `pollTimeoutMs = 50` — fast polling in tests
- `gracefulSigterm = false` — no SIGTERM handler in tests
- `noopLogger` — silent; suppress all output
- `setup()` / `teardown()` — factory pattern per test
- `backdateNextRun(db, name)` — forces `next_run_at` into the past so poller picks it up
- `createCronWithProject(db, projectId)` — helper for project-scoped tests
- Test 9 (timeout): handler's `sleep(500)` is abandoned by TimeoutError at 50ms; test waits 700ms to let the timer fire during the test — avoids cross-test leaks
- Test 6 (drift): uses 200ms handler + 100ms window to guarantee exactly 1 run before `stop()`
- Tests 21-31: project_id scoping (isolation, find, unregister, enable/disable, claim)
- `tests/task-registry.test.ts`: registry unit tests (no DB) + `syncRegistryToCron` integration test
- `tests/cron-fixes.test.ts`: covers withTx atomicity / rollback, lease_token fence, onEvent unsubscribe semantics, drainTimeoutMs cap, AbortSignal propagation, autoCleanup, backoff cap, pruneRunLog, sync orphan-handler removal

### Avoiding leaked timers in tests with abandoned handlers

When a test deliberately stops the cron *before* an in-flight handler returns (e.g. testing `drainTimeoutMs`), Deno's leak detector will flag the still-running setTimeout from the handler. Patterns:

1. Pass a `__timeout_ref__` ref into the handler's `sleep(ms, ref)` so the test can `clearTimeout(ref.id)` before exiting.
2. Wait long enough at the end of the test for the abandoned timer to fire naturally (e.g. handler sleep 700ms, test trailing sleep 800ms).

### Test DB setup
```bash
# Requires TEST_PG_* env vars (see tests/.env or .env)
TEST_PG_HOST=localhost
TEST_PG_DATABASE=cron_test
TEST_PG_USER=...
TEST_PG_PASSWORD=...
TEST_PG_PORT=5432
```

---

## Key Exports (`src/mod.ts`)

```typescript
// Core
export { Cron, DEFAULT_PROJECT_ID } from "./cron.ts";
export { CRON_STATUS, RUN_STATUS, BACKOFF_STRATEGY } from "./cron.ts";
export type { CronJob, CronRunLog, CronHealthPreviewRow, CronHandler,
              CronOptions, CronRegisterOptions, CronContext,
              CronProjectScope, CronStopOptions } from "./cron.ts";
export { CronParser, type CronParserOptions } from "./cron-parser.ts";

// Task Registry
export { createTaskRegistry } from "./task-registry.ts";
export type { TaskRegistry, TaskDefinition, TaskRegistryEntry,
              TaskValidationResult } from "./task-registry.ts";
export { syncRegistryToCron } from "./sync-registry.ts";
export type { SyncRegistryResult } from "./sync-registry.ts";
```

---

## Before Making Changes

- [ ] Read `src/cron/cron.ts` for types and context structure
- [ ] For scheduling logic changes: verify drift-safe invariant in `_handle-success.ts` and `_handle-failure.ts`
- [ ] For new write paths against a claimed row: include `lease_token` fence in WHERE
- [ ] For multi-statement DB work: use `withTx` (NOT `db.query("BEGIN")` on a Pool)
- [ ] For new management queries: always include `project_id` filtering
- [ ] For processor-level logic: do NOT filter by `project_id` (processors are global)
- [ ] For waits inside processor loops or handlers: plumb the appropriate AbortSignal through
- [ ] For schema changes: extend `Cron.migrate` with an idempotent step
- [ ] Run `deno task test` after changes (88 tests)
- [ ] DB integration tests require `TEST_PG_*` env vars
