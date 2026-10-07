# @marianmeres/cron — Agent Guide

## Quick Reference

- **Stack**: Deno, TypeScript, PostgreSQL (pg v8)
- **Test**: `deno task test` (all) | `deno test -A --env-file tests/cron-db.test.ts` (DB only)
- **Build**: `deno task npm:build`
- **Entry**: `src/mod.ts` → `src/cron.ts` → `src/cron/cron.ts` (includes `CronTenantScope` interface)

---

## Project Structure

```
src/
  mod.ts                  — public exports (re-exports CronParser from @marianmeres/cron-parser)
  cron.ts                 — re-exports from src/cron/cron.ts
  task-registry.ts        — in-memory task type catalog with JSON Schema validation
  sync-registry.ts        — bridge: wires registry handlers to Cron, paginates DB scan, removes orphan handlers
  cron/
    cron.ts               — Cron class + all types/constants
    _schema.ts            — CREATE/DROP tables (_initialize, _uninstall) — uses withTx
    _register.ts          — UPSERT job row (keyed on tenant_id + name); takes timezone
    _claim-next.ts        — FOR UPDATE SKIP LOCKED atomic claim; issues lease_token
    _execute.ts           — retry loop, timeout, success/failure dispatch; passes AbortSignal to handler;
                            re-scopes the context to the job's tenant; runs the heartbeat
    _next-run.ts          — _nextRunAt(): THE next_run_at computation (schedule-relative, tz, missed ticks skipped)
    _heartbeat.ts         — _startHeartbeat(): renews last_run_at while lease_token matches; reports lease loss
    _handle-success.ts    — next_run_at via _nextRunAt after success; real TX via withTx; lease_token fence
    _handle-failure.ts    — next_run_at via _nextRunAt after all attempts fail; real TX; lease_token fence
                            also exports _backoffMs and DEFAULT_MAX_BACKOFF_MS (5 min)
    _find.ts              — _findByName, _fetchAll (tenant-scoped, fully parameterised)
    _log-run.ts           — run log CRUD + _logRunPrune
    _mark-stale.ts        — crash recovery: reset RUNNING jobs with no recent sign of life (clears lease_token)
    _health-preview.ts    — aggregate stats from run log (tenant-scoped)
    utils/
      sleep.ts            — sleep(ms, ref?, signal?) with __timeout_ref__ for Deno hygiene + AbortSignal
      with-timeout.ts     — TimeoutError + withTimeout<T>(fn, ms, msg, abortController?)
      with-tx.ts          — withTx(db, async (client) => …) — works on Pool AND Client; exports isPool()
      unref-timer.ts      — unrefTimer(): Node/Bun .unref() or Deno.unrefTimer()
      with-db-retry.ts    — withDbRetry() with exponential backoff
      db-health.ts        — DbHealthMonitor, checkDbHealth()
      pg-quote.ts         — pgQuoteIdentifier, pgQuoteValue (kept for legacy callers)
tests/
  _pg.ts                  — createPg() / createPgClient() from TEST_PG_* env vars
  cron-db.test.ts         — 33 integration tests (requires DB, includes tenant_id scoping + legacy migration)
  cron-fixes.test.ts      — 14 tests covering B1/B4/B5/B6/D1/D2/D4 + pruneRunLog + sync orphan handlers
  cron-fixes-2.test.ts    — 19 tests, R1–R11: timezone, run-log tenant, missed ticks, start/stop lifecycle,
                            shutdown during backoff, bookkeeping vs handler errors, pg.Client clamp,
                            heartbeat, healthPreview types, event-wrap tracking, SIGTERM listener
  task-registry.test.ts   — 9 tests: registry unit tests + syncRegistryToCron integration
```

---

## Critical Conventions

### 1. Processors are global, management is tenant-scoped (FUNDAMENTAL)

Processors claim any due job regardless of `tenant_id` — the claim query in `_claim-next.ts` has **no** tenant filter. Handler lookup uses composite keys: `${tenantId}\0${name}`.

Management operations (register, unregister, find, fetchAll, enable, disable, health-preview, pruneRunLog) are tenant-scoped via `context.tenantId`. The `tenant_id` column appears in both `__cron` and `__cron_run_log` tables. The unique constraint on `__cron` is `(tenant_id, name)`.

`forTenant(tenantId)` returns a `CronTenantScope` — a lightweight object that delegates to the parent `Cron`'s private `#do*` methods with a fixed `tenantId`. It exposes management methods only; lifecycle methods (`start`, `stop`, `resetHard`, `uninstall`) stay on the parent.

`cron.cleanup()` and `cron.pruneRunLog()` recover/prune **globally**. Their counterparts on a `CronTenantScope` are tenant-scoped. Controlled by the `tenantScoped` parameter in `_markStale` / `_logRunPrune`.

When adding new management queries, always include `tenant_id` in WHERE clauses. When adding processor-level logic, do NOT filter by `tenant_id`.

Processors hand `_executeCronJob` the instance's **root** context. `_executeCronJob` re-scopes it to `job.tenant_id` before any write — the job row, never `context.tenantId`, decides which tenant a run-log row belongs to. Anything written on behalf of a claimed job must use that re-scoped context.

### 2. Next-run computation (INVARIANT — never break this)

`_nextRunAt(job, scheduledAt)` in `_next-run.ts` is the only place `next_run_at` is computed after a run. Both `_handle-success.ts` and `_handle-failure.ts` MUST call it — never build a `CronParser` there directly. It applies, in order:

1. **Schedule-relative, in the job's timezone**: `new CronParser(job.expression, { timezone: job.timezone ?? undefined }).getNextRun(scheduledAt)`. Dropping the `timezone` option silently reschedules in host local time.
2. **Never in the past**: if that slot is `< now`, return `getNextRun(now)` instead. Missed ticks are skipped, not replayed.

`scheduledAt = job.next_run_at` captured at the START of `_executeCronJob`, BEFORE the claim UPDATE changes anything. The claim UPDATE (`_claim-next.ts`) deliberately does NOT touch `next_run_at`.

Do not "simplify" this to `getNextRun(now)`: a worker whose clock lags the DB would recompute the slot it has just run and fire it twice.

`enable()` applies the same rule at the management layer: a job that was disabled and whose `next_run_at` passed meanwhile is moved to the next slot (atomic `CASE` in the UPDATE; a no-op for an already-enabled job).

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

A single `pg.Client` is one session: every statement issued on it while a `withTx` is open lands inside that transaction. Hence `start()` clamps a `pg.Client` to **one** processor (`isPool()` check, logs a warning). `pg.Pool` is the supported path for concurrency.

### 4. Lease token fence (CRITICAL for stale recovery)

`_claim-next.ts` issues a fresh `lease_token UUID` per claim. `_mark-stale.ts` clears the column on stale recovery. `_handle-success.ts` / `_handle-failure.ts` add `AND lease_token = $` to their UPDATE — so an orphaned worker (whose lease was cleared by cleanup) cannot clobber a fresh claim's result.

When introducing new write paths against a claimed row, include the lease check.

**Heartbeat.** The fence protects the *write*; the heartbeat protects the *execution*. `_startHeartbeat` (started and stopped by `_executeCronJob`, spanning the whole retry cycle) bumps `last_run_at` every `heartbeatIntervalMs` (default 30 s, `0` = off) `WHERE lease_token = $`. `_markStale` measures from `last_run_at`, so its threshold means "silent for N minutes", not "running for N minutes" — a live worker on a long job is never re-claimed. A beat that matches no row means the lease is lost: beating stops, the attempt's `AbortSignal` is aborted, remaining retries are skipped. The timer is unref'd (`unrefTimer`) so it never keeps the process alive. A hung handler in a live process keeps beating — bounding it is `max_attempt_duration_ms`'s job.

### 5. AbortSignal propagation

`Cron.start()` creates an `AbortController` (`#shutdownCtrl`); `stop()` aborts it. `_executeCronJob` derives a per-attempt controller wired to the shutdown signal AND to the `withTimeout` controller. The handler signature is `(job, signal?)` — the signal aborts on timeout, shutdown, or lease loss. `sleep()` accepts an optional `signal` so it returns early on abort.

An already-aborted signal never fires `"abort"` again: check `signal.aborted` before `addEventListener` (as `_executeCronJob` does), or the listener silently never runs.

When adding any wait inside a processor loop or handler chain, plumb the relevant signal through.

### 6. Claim pattern

`_claimNextCronJob` uses `FOR UPDATE SKIP LOCKED` — safe for concurrent workers. It does **not** filter by `tenant_id` (global claim). Returns `{ job, leaseToken }` — the `lease_token` is also written to the column on UPDATE. The processor resolves the handler via composite key `${job.tenant_id}\0${job.name}`.

### 7. Always recurring

Jobs toggle between `idle ↔ running` only. There are no terminal states in the `__cron` table. Terminal outcomes (`success | error | timeout`) live in `__cron_run_log`.

### 8. Retry scope

`max_attempts` = retries within ONE execution cycle (the `for` loop in `_execute.ts`). Each retry logs a separate run log entry. After all attempts fail, `_handleCronFailure` advances the schedule. Backoff between attempts uses `_backoffMs(strategy, attempt, maxMs?)`, clamped at `DEFAULT_MAX_BACKOFF_MS` (5 min) for `"exp"`.

The first attempt always runs. Attempts 2+ are skipped once the shutdown signal is aborted or the lease is lost; the cycle then ends through `_handleCronFailure`.

**Handler errors vs bookkeeping errors.** Only an error thrown by the handler is a failed attempt. The handler call sits in its own `try`; the DB writes that record the outcome (`_logRunStart`, `_handleCronSuccess`, `_logRunError`, `_handleCronFailure`) sit outside it, wrapped in `options.withRetry` (the `dbRetry`-aware wrapper from `Cron`). If one of them still fails, `_executeCronJob` throws; the processor logs "could not record the run" and the row stays `running` until `cleanup()`. Never move those writes back inside the handler's `try` — a DB blip after a successful handler would be logged as a handler error and the handler re-run.

### 9. Table prefix

All tables are prefixed: `${tablePrefix}__cron` and `${tablePrefix}__cron_run_log`. Always use `context.tableNames.tableCron` / `context.tableNames.tableCronRunLog`.

### 10. CronContext

Internal functions receive `CronContext` (not the `Cron` class). It holds `db`, `tableNames`, `logger`, `pubsubDone`, `pubsubError`, `tenantId`. Handler keys in `#handlers` Map and pubsub channels use composite format: `${tenantId}\0${name}`.

### 11. Day-of-month + day-of-week semantics

The `CronParser.matches()` function uses **OR** when both DoM and DoW fields are restricted (POSIX/Vixie cron). When one is `*`, only the other restricts. The parser caches `dayOfMonthIsStar` / `dayOfWeekIsStar` to make this decision.

### 12. Impossible date detection

`CronParser` rejects expressions whose DoM × month combination has zero solutions (e.g. `0 0 31 2 *`) at construction time — but only when DoW is unrestricted (because a restricted DoW can rescue an otherwise-impossible DoM via OR semantics).

### 13. Timezone

`CronParser` accepts `{ timezone?: string }` (IANA). When set, all wall-clock extraction goes through `Intl.DateTimeFormat`. The host's timezone is used when omitted. The `__cron.timezone` column persists the value per job; `_register` and the parser keep them in sync.

### 14. Event handler wraps (per-instance, no leaks)

`#eventWraps: Map<cb, { wrapped, topics }>` is a per-instance cache (not static). `topics` is the set of the wrap's live subscriptions (`${"done"|"error"}\0${handlerKey}`), maintained on subscribe / unsubscribe; the wrap is evicted when it empties. Do not derive "still subscribed?" from the `#handlers` map — subscriptions exist for names that have no handler. The returned `Unsubscriber` is constructed to satisfy `pubsub@3`'s interface (callable + `Symbol.dispose`).

### 15. Lifecycle: `start()` / `stop()`

**Generations.** Each `start()` → `stop()` span is one generation with its own `AbortController`. A processor loop runs `while (!shutdownSignal.aborted)` on the signal it was *started* with — never on instance state. `stop()` aborts the controller and drops it; the next `start()` creates a fresh one (a second `start()` without a `stop()` reuses the live one, so a single `stop()` reaches every processor).

**`start()` rejects** (after logging) when schema init fails or while any `stop()` is draining (`#stopsInFlight > 0`). It attaches the SIGTERM listener (`gracefulSigterm`); `stop()` detaches it. Nothing at init time touches process signals.

**Drain cap.** `stop({ drainTimeoutMs: 30_000 })` (default) races processor exit against a cap. If the cap wins, in-flight job IDs are logged at error level and `stop()` returns. The abandoned processors belong to the stopped generation: when their handler returns they record the run and exit without claiming anything. The instance is immediately safe to `start()` again.

Concurrent `stop()` calls (built-in SIGTERM listener + the app's own) each wait for the same processors.

### 16. Auto-cleanup

`new Cron({ db, autoCleanup: true })` (or `{ intervalMs?, maxAllowedRunDurationMinutes? }`) starts a `setInterval` on `start()` that calls `cleanup()` at the configured cadence and clears the timer on `stop()`.

`maxAllowedRunDurationMinutes` is the heartbeat-silence threshold (see #4), not a run-time cap. Keep it ≥ 3× `heartbeatIntervalMs`.

### 17. Task Registry

The task registry (`src/task-registry.ts`) is an in-memory `Map<string, TaskDefinition>`. It has no DB dependency. Key points:
- `define()` throws on duplicate task type names
- `list()` omits handlers (safe for API/UI serialization)
- `validate()` dynamically imports `@marianmeres/modelize` **and** `@marianmeres/modelize/ajv` — since modelize v3 the core validates through Standard Schema only, so `ajvSchema()` adapts the plain JSON Schema document. Each import is optional and throws its own install hint (`ajv` is an optional peer dependency on npm). Returns `{ valid, errors }`, or `{ valid: true }` if no schema defined.
- The bridge `syncRegistryToCron()` wires handlers via `cron.setHandler()`, removes orphan handlers (in-memory handlers no longer in the registry), and paginates DB scan when reporting orphan jobs.

---

## DB Schema

### `__cron`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| uid | UUID | gen_random_uuid() |
| tenant_id | VARCHAR(255) | NOT NULL, DEFAULT '_default' |
| name | VARCHAR(255) | NOT NULL |
| expression | VARCHAR(100) | 5-field cron |
| timezone | VARCHAR(64) | nullable; IANA tz name (default: host local) |
| payload | JSONB | default `{}` |
| enabled | BOOLEAN | default TRUE |
| status | VARCHAR(20) | `idle \| running` (CHECK constraint) |
| next_run_at | TIMESTAMPTZ | scheduled slot; only ever computed by `_register` / `_nextRunAt` |
| last_run_at | TIMESTAMPTZ | last sign of life: claim, heartbeat, or completion — what stale recovery measures |
| last_run_status | VARCHAR(20) | `success \| error \| timeout \| null` (CHECK) |
| lease_token | UUID | per-claim fence; cleared on success/failure/stale |
| max_attempts | INTEGER | default 1 (CHECK >= 1) |
| max_attempt_duration_ms | INTEGER | 0 = disabled (CHECK >= 0) |
| backoff_strategy | VARCHAR(20) | `none \| exp` |
| created_at / updated_at | TIMESTAMPTZ | |

**Indexes:**
- `UNIQUE (tenant_id, name)` — composite uniqueness
- `(enabled, status, next_run_at)` — polling index (global, no tenant_id — processors claim across all tenants)

### `__cron_run_log`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| cron_id | INTEGER FK | ON DELETE CASCADE |
| cron_name | VARCHAR(255) | |
| tenant_id | VARCHAR(255) | NOT NULL, DEFAULT '_default'; always the job's `tenant_id` |
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
- `(tenant_id)` — per-tenant log queries

### Migration

`Cron.migrate(db, tablePrefix?)` is the single migration entry point. Runs in a real transaction (works on Pool). Idempotent. Currently bundles:
- legacy → current: rename the pre-rename `project_id` column + its indexes to `tenant_id` in place (guarded `DO` block + `ALTER INDEX IF EXISTS`); preserves data. The only place the legacy `project_id` literal is still allowed to appear.
- v1 → v2: add `tenant_id` columns + reshape indexes
- v2 → v3: add `lease_token` and `timezone` columns + add CHECK constraints
- data repair: re-stamp run-log rows whose `tenant_id` differs from their job's (older releases logged under the executing instance's tenant). Joined through the `cron_id` FK; a no-op once repaired.

The legacy rename uses a `colExists()` JS helper to build an `information_schema.columns` guard (Postgres has no `IF EXISTS` for `RENAME COLUMN`), schema-qualified when a `tablePrefix` carries a schema. The helper lower-cases the table/schema names so the guard matches Postgres's unquoted-identifier folding — a mixed-case `tablePrefix` would otherwise skip the rename. When extending the schema in the future, add a new step inside `Cron.migrate` and bump the conceptual version note. CHECK additions go through the `addCheckIfMissing` helper (Postgres has no `IF NOT EXISTS` for constraints).

---

## Testing

- `tablePrefix = '_test_'` — tables are `_test___cron` and `_test___cron_run_log`
- `pollTimeoutMs = 50` — fast polling in tests
- `gracefulSigterm = false` — no SIGTERM handler in tests
- `noopLogger` — silent; suppress all output
- `setup()` / `teardown()` — factory pattern per test
- `backdateNextRun(db, name)` — forces `next_run_at` into the past so poller picks it up
- `createCronWithTenant(db, tenantId)` — helper for tenant-scoped tests
- Test 9 (timeout): handler's `sleep(500)` is abandoned by TimeoutError at 50ms; test waits 700ms to let the timer fire during the test — avoids cross-test leaks
- Test 6 (missed ticks): 10-minute backdate on a per-minute job must yield exactly 1 run and a future `next_run_at`
- `tests/cron-fixes-2.test.ts`: jobs that must run exactly once use a yearly expression (`0 0 1 1 *`) + backdate, so a minute boundary passing mid-test cannot add a run. `failNextTxCheckouts(db, n)` makes the next `n` `withTx` checkouts fail with `ECONNRESET` while `pool.query()` keeps working (bare `pool.connect()` vs `pool.connect(cb)`)
- Heartbeat tests set `heartbeatIntervalMs: 40`; the 30 s default never fires inside a test
- Tests 21-31: tenant_id scoping (isolation, find, unregister, enable/disable, claim)
- Test 32: legacy `project_id` → `tenant_id` migration (column + indexes renamed in place, data preserved, idempotent)
- Test 33: legacy migration with a mixed-case `tablePrefix` — `colExists()` lower-cases identifiers to match Postgres folding (else the rename silently no-ops)
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
export { Cron, DEFAULT_TENANT_ID } from "./cron.ts";
export { CRON_STATUS, RUN_STATUS, BACKOFF_STRATEGY } from "./cron.ts";
export type { CronJob, CronRunLog, CronHealthPreviewRow, CronHandler,
              CronOptions, CronRegisterOptions, CronContext,
              CronTenantScope, CronStopOptions } from "./cron.ts";
export { CronParser, type CronParserOptions } from "@marianmeres/cron-parser"; // re-export

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
- [ ] For scheduling logic changes: go through `_nextRunAt` (`_next-run.ts`); never compute `next_run_at` elsewhere
- [ ] For anything written on behalf of a claimed job: use the job-tenant context, keep it OUTSIDE the handler's `try`
- [ ] For new write paths against a claimed row: include `lease_token` fence in WHERE
- [ ] For multi-statement DB work: use `withTx` (NOT `db.query("BEGIN")` on a Pool)
- [ ] For new management queries: always include `tenant_id` filtering
- [ ] For processor-level logic: do NOT filter by `tenant_id` (processors are global)
- [ ] For waits inside processor loops or handlers: plumb the appropriate AbortSignal through
- [ ] For schema changes: extend `Cron.migrate` with an idempotent step
- [ ] Run `deno task test` after changes (75 tests)
- [ ] DB integration tests require `TEST_PG_*` env vars
