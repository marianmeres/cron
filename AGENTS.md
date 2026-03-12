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
  cron-parser.ts          — 5-field cron notation parser
  task-registry.ts        — in-memory task type catalog with JSON Schema validation
  sync-registry.ts        — bridge: wires registry handlers to Cron instance
  cron/
    cron.ts               — Cron class + all types/constants
    _schema.ts            — CREATE/DROP tables (_initialize, _uninstall)
    _register.ts          — UPSERT job row (keyed on project_id + name)
    _claim-next.ts        — FOR UPDATE SKIP LOCKED atomic claim (global — no project_id filter)
    _execute.ts           — retry loop, timeout, success/failure dispatch
    _handle-success.ts    — drift-safe next_run_at after success
    _handle-failure.ts    — drift-safe next_run_at after all attempts fail
    _find.ts              — _findByName, _fetchAll (project-scoped)
    _log-run.ts           — run log CRUD
    _mark-stale.ts        — crash recovery: reset stuck RUNNING jobs (global or project-scoped)
    _health-preview.ts    — aggregate stats from run log (project-scoped)
    utils/
      sleep.ts            — sleep(ms) with __timeout_ref__ for Deno hygiene
      with-timeout.ts     — TimeoutError + withTimeout<T>()
      with-db-retry.ts    — withDbRetry() with exponential backoff
      db-health.ts        — DbHealthMonitor, checkDbHealth()
      pg-quote.ts         — pgQuoteIdentifier, pgQuoteValue
tests/
  _pg.ts                  — createPg() from TEST_PG_* env vars
  cron.test.ts            — 23 CronParser unit tests (no DB)
  cron-db.test.ts         — 26 integration tests (requires DB, includes project_id scoping)
  task-registry.test.ts   — 9 tests: registry unit tests + syncRegistryToCron integration
```

---

## Critical Conventions

### 1. Processors are global, management is project-scoped (FUNDAMENTAL)

Processors claim any due job regardless of `project_id` — the claim query in `_claim-next.ts` has **no** project filter. Handler lookup uses composite keys: `${projectId}\0${name}`.

Management operations (register, unregister, find, fetchAll, enable, disable, health-preview) are project-scoped via `context.projectId`. The `project_id` column appears in both `__cron` and `__cron_run_log` tables. The unique constraint on `__cron` is `(project_id, name)`.

`forProject(projectId)` returns a `CronProjectScope` — a lightweight object that delegates to the parent `Cron`'s private `#do*` methods with a fixed `projectId`. It exposes management methods only; lifecycle methods (`start`, `stop`, `resetHard`, `uninstall`) stay on the parent.

`cron.cleanup()` recovers all stuck jobs globally. `scope.cleanup()` (via `forProject()`) recovers only that project's stuck jobs. This is controlled by the `projectScoped` parameter in `_markStale`.

When adding new management queries, always include `project_id` in WHERE clauses. When adding processor-level logic, do NOT filter by `project_id`.

### 2. Drift-safe scheduling (INVARIANT — never break this)

Both `_handle-success.ts` and `_handle-failure.ts` MUST compute:
```typescript
const nextRunAt = new CronParser(job.expression).getNextRun(scheduledAt);
```
where `scheduledAt = job.next_run_at` captured at the START of `_executeCronJob`, BEFORE the claim UPDATE changes anything. The claim UPDATE (`_claim-next.ts`) deliberately does NOT touch `next_run_at`.

### 3. Claim pattern

`_claimNextCronJob` uses `FOR UPDATE SKIP LOCKED` — safe for concurrent workers. It does **not** filter by `project_id` (global claim). Returns the job row with the original `next_run_at` (= scheduledAt). The processor resolves the handler via composite key `${job.project_id}\0${job.name}`.

### 4. Always recurring

Jobs toggle between `idle ↔ running` only. There are no terminal states in the `__cron` table. Terminal outcomes (`success | error | timeout`) live in `__cron_run_log`.

### 5. Retry scope

`max_attempts` = retries within ONE execution cycle (the `for` loop in `_execute.ts`). Each retry logs a separate run log entry. After all attempts fail, `_handleCronFailure` advances the schedule.

### 6. Table prefix

All tables are prefixed: `${tablePrefix}__cron` and `${tablePrefix}__cron_run_log`. Always use `context.tableNames.tableCron` / `context.tableNames.tableCronRunLog`.

### 7. CronContext

Internal functions receive `CronContext` (not the `Cron` class). It holds `db`, `tableNames`, `logger`, `pubsubDone`, `pubsubError`, `projectId`. Handler keys in `#handlers` Map and pubsub channels use composite format: `${projectId}\0${name}`.

### 8. Transactions

`_handleCronSuccess` wraps `UPDATE __cron + _logRunSuccess` in `BEGIN/COMMIT`. Always keep these atomic.

### 9. Task Registry

The task registry (`src/task-registry.ts`) is an in-memory `Map<string, TaskDefinition>`. It has no DB dependency. Key points:
- `define()` throws on duplicate task type names
- `list()` omits handlers (safe for API/UI serialization)
- `validate()` uses dynamic `import("@marianmeres/modelize")` for JSON Schema validation via AJV — returns `{ valid, errors }`. Returns `{ valid: true }` if no schema defined.
- The bridge `syncRegistryToCron()` wires handlers via `cron.setHandler()` and detects orphan DB jobs

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
| payload | JSONB | default `{}` |
| enabled | BOOLEAN | default TRUE |
| status | VARCHAR(20) | `idle \| running` |
| next_run_at | TIMESTAMPTZ | drift-safe scheduled time |
| last_run_at | TIMESTAMPTZ | wall-clock time of last claim |
| last_run_status | VARCHAR(20) | `success \| error \| timeout \| null` |
| max_attempts | INTEGER | default 1 |
| max_attempt_duration_ms | INTEGER | 0 = disabled |
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
| attempt_number | INTEGER | 1-based |
| status | VARCHAR(20) | `success \| error \| timeout` |
| result | JSONB | handler return value |
| error_message | TEXT | |
| error_details | JSONB | `{ stack }` |

**Indexes:**
- `(cron_id)` — FK lookups
- `(started_at DESC)` — history queries
- `(project_id)` — per-project log queries

### Migration from v1

Use `Cron.migrate(db, tablePrefix?)` to add `project_id` columns and update indexes on existing installations. Safe to call repeatedly.

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
- Tests 21-26: project_id scoping (isolation, find, unregister, enable/disable, claim)
- `tests/task-registry.test.ts`: registry unit tests (no DB) + `syncRegistryToCron` integration test

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
              CronProjectScope } from "./cron.ts";
export { CronParser } from "./cron-parser.ts";

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
- [ ] For new management queries: always include `project_id` filtering
- [ ] For processor-level logic: do NOT filter by `project_id` (processors are global)
- [ ] Run `deno task test` after changes
- [ ] DB integration tests require `TEST_PG_*` env vars
