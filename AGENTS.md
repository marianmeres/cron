# @marianmeres/cron — Agent Guide

## Quick Reference

- **Stack**: Deno, TypeScript, PostgreSQL (pg v8)
- **Test**: `deno task test` (all) | `deno test -A --env-file tests/cron-db.test.ts` (DB only)
- **Build**: `deno task npm:build`
- **Entry**: `src/mod.ts` → `src/cron.ts` → `src/cron/cron.ts`

---

## Project Structure

```
src/
  mod.ts                  — public exports
  cron.ts                 — re-exports from src/cron/cron.ts
  cron-parser.ts          — 5-field cron notation parser (existing)
  cron/
    cron.ts               — Cron class + all types/constants
    _schema.ts            — CREATE/DROP tables (_initialize, _uninstall)
    _register.ts          — UPSERT job row
    _claim-next.ts        — FOR UPDATE SKIP LOCKED atomic claim
    _execute.ts           — retry loop, timeout, success/failure dispatch
    _handle-success.ts    — drift-safe next_run_at after success
    _handle-failure.ts    — drift-safe next_run_at after all attempts fail
    _find.ts              — _findByName, _fetchAll
    _log-run.ts           — run log CRUD
    _mark-stale.ts        — crash recovery: reset stuck RUNNING jobs
    _health-preview.ts    — aggregate stats from run log
    utils/
      sleep.ts            — sleep(ms) with __timeout_ref__ for Deno hygiene
      with-timeout.ts     — TimeoutError + withTimeout<T>()
      with-db-retry.ts    — withDbRetry() with exponential backoff
      db-health.ts        — DbHealthMonitor, checkDbHealth()
      pg-quote.ts         — pgQuoteIdentifier, pgQuoteValue
tests/
  _pg.ts                  — createPg() from TEST_PG_* env vars
  cron.test.ts            — 23 CronParser unit tests (no DB)
  cron-db.test.ts         — 20 integration tests (requires DB)
```

---

## Critical Conventions

### 1. Drift-safe scheduling (INVARIANT — never break this)

Both `_handle-success.ts` and `_handle-failure.ts` MUST compute:
```typescript
const nextRunAt = new CronParser(job.expression).getNextRun(scheduledAt);
```
where `scheduledAt = job.next_run_at` captured at the START of `_executeCronJob`, BEFORE the claim UPDATE changes anything. The claim UPDATE (`_claim-next.ts`) deliberately does NOT touch `next_run_at`.

### 2. Claim pattern

`_claimNextCronJob` uses `FOR UPDATE SKIP LOCKED` — safe for concurrent workers. It returns the job row with the original `next_run_at` (= scheduledAt).

### 3. Always recurring

Jobs toggle between `idle ↔ running` only. There are no terminal states in the `__cron` table. Terminal outcomes (`success | error | timeout`) live in `__cron_run_log`.

### 4. Retry scope

`max_attempts` = retries within ONE execution cycle (the `for` loop in `_execute.ts`). Each retry logs a separate run log entry. After all attempts fail, `_handleCronFailure` advances the schedule.

### 5. Table prefix

All tables are prefixed: `${tablePrefix}__cron` and `${tablePrefix}__cron_run_log`. Always use `context.tableNames.tableCron` / `context.tableNames.tableCronRunLog`.

### 6. CronContext

Internal functions receive `CronContext` (not the `Cron` class). It holds `db`, `tableNames`, `logger`, `pubsubDone`, `pubsubError`.

### 7. Transactions

`_handleCronSuccess` wraps `UPDATE __cron + _logRunSuccess` in `BEGIN/COMMIT`. Always keep these atomic.

---

## DB Schema

### `__cron`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| uid | UUID | gen_random_uuid() |
| name | VARCHAR(255) UNIQUE | |
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

### `__cron_run_log`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| cron_id | INTEGER FK | ON DELETE CASCADE |
| cron_name | VARCHAR(255) | |
| scheduled_at | TIMESTAMPTZ | next_run_at captured at claim time |
| started_at | TIMESTAMPTZ | |
| completed_at | TIMESTAMPTZ | nullable |
| attempt_number | INTEGER | 1-based |
| status | VARCHAR(20) | `success \| error \| timeout` |
| result | JSONB | handler return value |
| error_message | TEXT | |
| error_details | JSONB | `{ stack }` |

---

## Testing

- `tablePrefix = '_test_'` — tables are `_test___cron` and `_test___cron_run_log`
- `pollTimeoutMs = 50` — fast polling in tests
- `gracefulSigterm = false` — no SIGTERM handler in tests
- `noopLogger` — silent; suppress all output
- `setup()` / `teardown()` — factory pattern per test
- `backdateNextRun(db, name)` — forces `next_run_at` into the past so poller picks it up
- Test 9 (timeout): handler's `sleep(500)` is abandoned by TimeoutError at 50ms; test waits 700ms to let the timer fire during the test — avoids cross-test leaks
- Test 6 (drift): uses 200ms handler + 100ms window to guarantee exactly 1 run before `stop()`

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
export { Cron } from "./cron.ts";
export { CRON_STATUS, RUN_STATUS, BACKOFF_STRATEGY } from "./cron.ts";
export type { CronJob, CronRunLog, CronHandler, CronOptions, CronRegisterOptions, CronContext } from "./cron.ts";
export { CronParser } from "./cron-parser.ts";
```

---

## Before Making Changes

- [ ] Read `src/cron/cron.ts` for types and context structure
- [ ] For scheduling logic changes: verify drift-safe invariant in `_handle-success.ts` and `_handle-failure.ts`
- [ ] Run `deno task test` after changes
- [ ] DB integration tests require `TEST_PG_*` env vars
