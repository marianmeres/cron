# @marianmeres/cron — Agent Guide

## Quick Reference

- **Stack**: TypeScript (erasable-only), Node LTS (`.node-version`), pnpm, `node:test`, Biome;
  PostgreSQL through `@marianmeres/sqlkit` (`pg` v8 is a dev dependency: the tests build pools)
- **Install**: `pnpm install` | **Test**: `pnpm test` (one file: `node --test --env-file-if-exists=.env tests/cron-db.test.ts`)
  | **Check all**: `pnpm run ci` (typecheck + lint + test)
- **Build npm**: `pnpm run build` (`tsc` → `dist/`) | **Release + publish**: `pnpm run rp` / `rpm`
  (human action)
- **Registry**: npm only; it gets `dist/` (manifest `package.json`). 3.3.0 is the last version
  on JSR.
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
    _schema.ts            — CREATE/DROP tables (_initialize, _uninstall) — db.transaction + tx.exec
    _register.ts          — UPSERT job row (keyed on tenant_id + name); takes timezone
    _claim-next.ts        — FOR UPDATE SKIP LOCKED atomic claim; issues lease_token
    _execute.ts           — retry loop, timeout, success/failure dispatch; passes AbortSignal to handler;
                            re-scopes the context to the job's tenant; runs the heartbeat
    _next-run.ts          — _nextRunAt(): THE next_run_at computation (schedule-relative, tz, missed ticks skipped)
    _heartbeat.ts         — _startHeartbeat(): renews last_run_at while lease_token matches; reports lease loss
    _handle-success.ts    — next_run_at via _nextRunAt after success; real TX (db.transaction); lease_token fence
    _handle-failure.ts    — next_run_at via _nextRunAt after all attempts fail; real TX; lease_token fence
                            also exports _backoffMs and DEFAULT_MAX_BACKOFF_MS (5 min)
    _find.ts              — _findByName, _fetchAll (tenant-scoped; optional filters through and())
    _log-run.ts           — run log CRUD + _logRunPrune
    _mark-stale.ts        — crash recovery: reset RUNNING jobs with no recent sign of life (clears lease_token)
    _health-preview.ts    — aggregate stats from run log (tenant-scoped)
    utils/
      sleep.ts            — sleep(ms, ref?, signal?) with __timeout_ref__ (test timer hygiene) + AbortSignal
      with-timeout.ts     — TimeoutError + withTimeout<T>(fn, ms, msg, abortController?)
      driver.ts           — CronDb (pg.Pool | pg.Client | sqlkit Driver), toDriver() (one cached driver
                            per pool/client, refuses a non-pg dialect), isDriver(), isPool()
      unref-timer.ts      — unrefTimer(): Node's .unref(), a no-op where the timer has none
      with-db-retry.ts    — withDbRetry() + DbRetryOptions on sqlkit's withRetry: retries what classifyPg
                            calls retryable, or exactly a caller's retryableErrors
      db-health.ts        — DbHealthMonitor, checkDbHealth() + DbHealthStatus on sqlkit's checkHealth /
                            createHealthMonitor: `select 1` raced against timeoutMs (5 s), pgVersion asked
                            once per driver; logs only on a flip; imports driver.ts only, never cron.ts
tests/
  _pg.ts                  — createPg() / createPgClient() from TEST_PG_* env vars
  _time.ts                — clearOfMinuteBoundary(): waits a near minute boundary out before a test
  cron-db.test.ts         — 34 integration tests (requires DB, includes tenant_id scoping + legacy migration
                            + eight concurrent initializers on fresh tables)
  cron-fixes.test.ts      — 14 tests covering B1/B4/B5/B6/D1/D2/D4 + pruneRunLog + sync orphan handlers
  driver.test.ts          — 5 tests: a host's sqlkit Driver as `db`, non-pg dialect and missing db refused,
                            one driver (one pool `error` listener) per pool, CronDb exported
  cron-fixes-2.test.ts    — 19 tests, R1–R11: timezone, run-log tenant, missed ticks, start/stop lifecycle,
                            shutdown during backoff, bookkeeping vs handler errors, processors on one pg.Client,
                            heartbeat, healthPreview types, event-wrap tracking, SIGTERM listener
  statements.test.ts      — 10 tests, S1–S8: what statements read and write — payload and result JSON
                            round trips, run-log rows of success / error / timeout, fetchAll and
                            getRunHistory filters and pages, unregister cascade, checkDbHealth / getDbHealth
  db-resilience.test.ts   — 7 tests: what withDbRetry retries by default and with retryableErrors, a
                            TypeError for an option out of range, dbRetry around the claim; a health check
                            timing out, a monitor's flips, dbHealthCheck.timeoutMs
  task-registry.test.ts   — 9 tests: registry unit tests + syncRegistryToCron integration
package.json              — manifest of record: version, npm exports, deps, optional peer ajv, scripts
tsconfig.json             — type gate (src + tests, noEmit)
tsconfig.build.json       — src → dist (ESM + .d.ts) for npm
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

### 3. Real transactions through the driver (CRITICAL)

`context.db` is a sqlkit `Driver`, built once by `toDriver(db)` in the constructor (and in `Cron.migrate`) from the host's `pg.Pool`, `pg.Client` or `Driver`. Never send `BEGIN` / `COMMIT` yourself: through a pool each statement may take a different connection. Anywhere a transaction is required, use:

```typescript
await context.db.transaction(async (tx) => {
  await tx.query(sql`UPDATE ${raw(tableCron)} SET … WHERE id = ${job.id}`);
  await someHelper(context, …, tx);  // pass tx through to inner helpers
});
```

The driver checks the `COMMIT` (a transaction a failed statement aborted rejects with `TransactionAbortedError`), destroys a connection whose `ROLLBACK` failed, and wraps every database error in a sqlkit `SqlError` (node-postgres's `code` and `message`, the original as `cause`).

- `query(statement)` runs **one** statement; a script of several (the schema, `_schemaDrop`, the `Cron.migrate` steps) goes through `exec(script)`, which takes no values.
- Every statement is one sqlkit `sql` fragment; nothing is numbered by hand (`$1`) and no value is written into the text. The rules:
  - A value is interpolated bare and bound: `status = ${CRON_STATUS.IDLE}`. Quotes around an interpolation (`'${x}'`) are a bug: a literal holding `$1`.
  - The table name is the only text spliced in, as `raw(tableCron)` / `raw(tableCronRunLog)`, never `ident()`: a prefix may carry a schema (`"app."`), and unquoted names fold to lower case (a quoted mixed-case prefix would name another table). Nothing a caller supplied goes through `raw()`.
  - An optional predicate is a fragment or `EMPTY` (``leaseToken !== null ? sql`AND lease_token = ${leaseToken}` : EMPTY``); a list of optional filters goes through `and()`, which skips `EMPTY` parts.
  - A JSON column takes `json(value)` (`json(null)` binds SQL `NULL`), except the run result, which `_logRunSuccess` serializes itself and binds as the string it is.
  - Minutes stay `(${n} * INTERVAL '1 minute')`: a fraction of a minute is valid input.
- Type a row read: `db.query<CronJob>(…)`. `rowCount` is always a number.
- Never call the driver's `close()`: it ends the host's pool or client. `toDriver` caches one driver per pool/client object (a `WeakMap`) because building one adds an `error` listener to the pool; a host's own `Driver` is used as it is.

Currently used in:

- `_handle-success.ts` (UPDATE row + finalize run log)
- `_handle-failure.ts` (UPDATE row)
- `_schema.ts` `_initialize` / `_uninstall`
- `Cron.migrate` (static method)

Inner helpers (`_logRunSuccess`, `_logRunError`, `_logRunStart`) accept an optional `client?: Driver` — pass `tx` for the transactional path, omit for autocommit. (Inside a transaction callback `tx` and `context.db` are the same object; the async context decides which transaction a statement is in. Pass `tx` anyway: it says what is meant.)

A single `pg.Client` is one session, and `start(n)` runs all `n` processors on it: sqlkit's single-connection driver gives each transaction its turn, and a statement from outside an open transaction waits for it to end. Handlers overlap; database work does not. Do not clamp the count or branch on the adapter or on `capabilities` (the same holds for a host's `Driver` over one connection). `pg.Pool` stays the recommendation.

### 4. Lease token fence (CRITICAL for stale recovery)

`_claim-next.ts` issues a fresh `lease_token UUID` per claim. `_mark-stale.ts` clears the column on stale recovery. `_handle-success.ts` / `_handle-failure.ts` add `AND lease_token = $` to their UPDATE — so an orphaned worker (whose lease was cleared by cleanup) cannot clobber a fresh claim's result.

When introducing new write paths against a claimed row, include the lease check.

**Heartbeat.** The fence protects the _write_; the heartbeat protects the _execution_. `_startHeartbeat` (started and stopped by `_executeCronJob`, spanning the whole retry cycle) bumps `last_run_at` every `heartbeatIntervalMs` (default 30 s, `0` = off) `WHERE lease_token = $`. `_markStale` measures from `last_run_at`, so its threshold means "silent for N minutes", not "running for N minutes" — a live worker on a long job is never re-claimed. A beat that matches no row means the lease is lost: beating stops, the attempt's `AbortSignal` is aborted, remaining retries are skipped. The timer is unref'd (`unrefTimer`) so it never keeps the process alive. A hung handler in a live process keeps beating — bounding it is `max_attempt_duration_ms`'s job.

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

**`dbRetry`** (`withDbRetry`) runs the wrapped function again whole, so it wraps one statement or one whole `db.transaction` call, never part of a transaction. By default it retries what sqlkit's `classifyPg` calls retryable (a lost connection, a deadlock, a serialization failure, …), decided by the error's code (or node-postgres's two code-less connection messages), never by a code found in a message; a caller's `retryableErrors` replaces that with exactly its list.

### 9. Table prefix

All tables are prefixed: `${tablePrefix}__cron` and `${tablePrefix}__cron_run_log`. Always use `context.tableNames.tableCron` / `context.tableNames.tableCronRunLog`.

### 10. CronContext

Internal functions receive `CronContext` (not the `Cron` class). It holds `db` (a sqlkit `Driver`), `tableNames`, `logger`, `pubsubDone`, `pubsubError`, `tenantId`. Handler keys in `#handlers` Map and pubsub channels use composite format: `${tenantId}\0${name}`.

### 11. Day-of-month + day-of-week semantics

The `CronParser.matches()` function uses **OR** when both DoM and DoW fields are restricted (POSIX/Vixie cron). When one is `*`, only the other restricts. The parser caches `dayOfMonthIsStar` / `dayOfWeekIsStar` to make this decision.

### 12. Impossible date detection

`CronParser` rejects expressions whose DoM × month combination has zero solutions (e.g. `0 0 31 2 *`) at construction time — but only when DoW is unrestricted (because a restricted DoW can rescue an otherwise-impossible DoM via OR semantics).

### 13. Timezone

`CronParser` accepts `{ timezone?: string }` (IANA). When set, all wall-clock extraction goes through `Intl.DateTimeFormat`. The host's timezone is used when omitted. The `__cron.timezone` column persists the value per job; `_register` and the parser keep them in sync.

### 14. Event handler wraps (per-instance, no leaks)

`#eventWraps: Map<cb, { wrapped, topics }>` is a per-instance cache (not static). `topics` is the set of the wrap's live subscriptions (`${"done"|"error"}\0${handlerKey}`), maintained on subscribe / unsubscribe; the wrap is evicted when it empties. Do not derive "still subscribed?" from the `#handlers` map — subscriptions exist for names that have no handler. The returned `Unsubscriber` is constructed to satisfy `pubsub@3`'s interface (callable + `Symbol.dispose`).

### 15. Lifecycle: `start()` / `stop()`

**Generations.** Each `start()` → `stop()` span is one generation with its own `AbortController`. A processor loop runs `while (!shutdownSignal.aborted)` on the signal it was _started_ with — never on instance state. `stop()` aborts the controller and drops it; the next `start()` creates a fresh one (a second `start()` without a `stop()` reuses the live one, so a single `stop()` reaches every processor).

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

## Tooling Conventions

1. **Runtime policy** — Node at the keyboard, npm the only registry. No `Deno.*`, `Bun.*`,
   `jsr:` or `npm:` specifiers in `src/` or `tests/`.
2. **Erasable TypeScript** — no `enum`, `namespace`, constructor parameter properties;
   `import type` for types; explicit `.ts` import extensions (rewritten to `.js` on emit).
   Node strips types and never checks them: `pnpm run typecheck` is the only type gate.
   `noUncheckedIndexedAccess` is off (Deno never had it, and the move off Deno changed no code).
3. **Formatting** — tabs, 4 wide, 90 columns, double quotes (`biome.json`); manifests at 2
   spaces. `pnpm run format` before committing.
4. **Never run a script named `publish`** (npm lifecycle hook); publishing is `pnpm publish`,
   via `rp` / `rpm`.

---

## DB Schema

### `__cron`

| Column                  | Type         | Notes                                                                             |
| ----------------------- | ------------ | --------------------------------------------------------------------------------- |
| id                      | SERIAL PK    |                                                                                   |
| uid                     | UUID         | gen_random_uuid()                                                                 |
| tenant_id               | VARCHAR(255) | NOT NULL, DEFAULT '_default'                                                      |
| name                    | VARCHAR(255) | NOT NULL                                                                          |
| expression              | VARCHAR(100) | 5-field cron                                                                      |
| timezone                | VARCHAR(64)  | nullable; IANA tz name (default: host local)                                      |
| payload                 | JSONB        | default `{}`                                                                      |
| enabled                 | BOOLEAN      | default TRUE                                                                      |
| status                  | VARCHAR(20)  | `idle \| running` (CHECK constraint)                                              |
| next_run_at             | TIMESTAMPTZ  | scheduled slot; only ever computed by `_register` / `_nextRunAt`                  |
| last_run_at             | TIMESTAMPTZ  | last sign of life: claim, heartbeat, or completion — what stale recovery measures |
| last_run_status         | VARCHAR(20)  | `success \| error \| timeout \| null` (CHECK)                                     |
| lease_token             | UUID         | per-claim fence; cleared on success/failure/stale                                 |
| max_attempts            | INTEGER      | default 1 (CHECK >= 1)                                                            |
| max_attempt_duration_ms | INTEGER      | 0 = disabled (CHECK >= 0)                                                         |
| backoff_strategy        | VARCHAR(20)  | `none \| exp`                                                                     |
| created_at / updated_at | TIMESTAMPTZ  |                                                                                   |

**Indexes:**

- `UNIQUE (tenant_id, name)` — composite uniqueness
- `(enabled, status, next_run_at)` — polling index (global, no tenant_id — processors claim across all tenants)

### `__cron_run_log`

| Column         | Type         | Notes                                                      |
| -------------- | ------------ | ---------------------------------------------------------- |
| id             | SERIAL PK    |                                                            |
| cron_id        | INTEGER FK   | ON DELETE CASCADE                                          |
| cron_name      | VARCHAR(255) |                                                            |
| tenant_id      | VARCHAR(255) | NOT NULL, DEFAULT '_default'; always the job's `tenant_id` |
| scheduled_at   | TIMESTAMPTZ  | next_run_at captured at claim time                         |
| started_at     | TIMESTAMPTZ  |                                                            |
| completed_at   | TIMESTAMPTZ  | nullable                                                   |
| attempt_number | INTEGER      | 1-based (CHECK >= 1)                                       |
| status         | VARCHAR(20)  | `success \| error \| timeout` (CHECK)                      |
| result         | JSONB        | handler return value                                       |
| error_message  | TEXT         |                                                            |
| error_details  | JSONB        | `{ stack }`                                                |

**Indexes:**

- `(cron_id)` — FK lookups
- `(started_at DESC)` — history queries
- `(tenant_id)` — per-tenant log queries

### Schema creation lock

`_initialize` (boot-time `CREATE … IF NOT EXISTS`, and `resetHard()`'s drop + create) takes `pg_advisory_xact_lock(hashtext('cron:<tableCron>'))` as the first statement of its transaction. Without it, concurrent initializers on a fresh database (N replicas booting at once) collide in `pg_type` with `23505` and all but one fail. Transaction-scoped: released by `COMMIT` / `ROLLBACK`. `_uninstall` takes no lock.

### Migration

`Cron.migrate(db, tablePrefix?)` is the single migration entry point. Takes a `CronDb`; runs in one `transaction`, each step a script through `tx.exec` (works on Pool, Client or Driver). Idempotent. Currently bundles:

- legacy → current: rename the pre-rename `project_id` column + its indexes to `tenant_id` in place (guarded `DO` block + `ALTER INDEX IF EXISTS`); preserves data. The only place the legacy `project_id` literal is still allowed to appear.
- v1 → v2: add `tenant_id` columns + reshape indexes
- v2 → v3: add `lease_token` and `timezone` columns + add CHECK constraints
- data repair: re-stamp run-log rows whose `tenant_id` differs from their job's (older releases logged under the executing instance's tenant). Joined through the `cron_id` FK; a no-op once repaired.

The legacy rename uses a `colExists()` JS helper to build an `information_schema.columns` guard (Postgres has no `IF EXISTS` for `RENAME COLUMN`), schema-qualified when a `tablePrefix` carries a schema. The helper lower-cases the table/schema names so the guard matches Postgres's unquoted-identifier folding — a mixed-case `tablePrefix` would otherwise skip the rename. When extending the schema in the future, add a new step inside `Cron.migrate` and bump the conceptual version note. CHECK additions go through the `addCheckIfMissing` helper (Postgres has no `IF NOT EXISTS` for constraints), which lower-cases the constraint name it looks up in `pg_constraint` for the same folding reason — a mixed-case `tablePrefix` would otherwise miss the existing constraint and fail the second call with 42710.

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
- **No test may straddle a schedule slot.** A `* * * * *` job comes due again at every minute boundary, so a test that asserts an exact number of runs, or that a job did not run, registers its job with the yearly expression `0 0 1 1 *` (the `YEARLY` constant of the DB test files) and backdates it to make it due once. A test that has to keep a per-minute job calls `clearOfMinuteBoundary()` from `tests/_time.ts` first. Wait for a run through `onDone` rather than a fixed sleep where the next step depends on it being recorded (test 15)
- Test 6 (missed ticks): 10-minute backdate on a per-minute job must yield exactly 1 run and a future `next_run_at`; it keeps `* * * * *`, so it calls `clearOfMinuteBoundary()` before its setup
- cron checks a connection out with a bare `pool.connect()` for every statement and every transaction; the tests' own `pool.query()` goes through `pool.connect(cb)`. Statements reach the client as a config object (`{ text, values }`) with lower-case `begin` / `commit`: read `typeof q === "string" ? q : q.text` and match case-insensitively, by verb and table name
- `tests/cron-fixes-2.test.ts`: `failNextTxCheckouts(db, n)` makes the next `n` bare checkouts fail with `ECONNRESET` while `pool.query()` keeps working. It cannot tell a transaction from a statement, so the R6 tests arm it from inside the handler, where the next checkout is the finalization's
- Heartbeat tests set `heartbeatIntervalMs: 40`; the 30 s default never fires inside a test
- Tests 21-31: tenant_id scoping (isolation, find, unregister, enable/disable, claim)
- Test 32: legacy `project_id` → `tenant_id` migration (column + indexes renamed in place, data preserved, idempotent)
- Test 33: legacy migration with a mixed-case `tablePrefix`, run twice — `colExists()` and `addCheckIfMissing` lower-case identifiers to match Postgres folding (else the rename silently no-ops, or the second call re-adds a CHECK constraint and fails)
- `tests/task-registry.test.ts`: registry unit tests (no DB) + `syncRegistryToCron` integration test
- `tests/cron-fixes.test.ts`: covers the finalization's transaction (B1: one connection from `begin` to `commit`; a failed run-log write rolls the job row back — `recordCheckouts()` records each checkout's statements), lease_token fence, onEvent unsubscribe semantics, drainTimeoutMs cap, AbortSignal propagation, autoCleanup, backoff cap, pruneRunLog, sync orphan-handler removal
- `tests/db-resilience.test.ts`: the retry tests call `withDbRetry` directly with driver-shaped errors (`Object.assign(new Error(…), { code })`), no database; the `dbRetry` test arms `failNextCheckouts(db, 2, "ECONNREFUSED")` before `start(1)`, so the refused checkouts are the claim's (the instance is initialized by then). The health tests run on `pgStub(query)`, a stub pg `Driver` whose `query` gets each statement's text (a fragment's chunks joined by `?`); a `select 1` that never settles is a database that hangs
- `tests/statements.test.ts` (S1–S8): pins, through the public API, what a statement binds and reads back — payload, result and `error_details` after the JSON round trip, the optional filters and pages of `fetchAll` / `getRunHistory`, the unregister cascade, and the health status. A change to how statements are built must keep it green unchanged. It deliberately does not assert the `latencyMs` or the error text of an unhealthy status, nor the class of a rejected database call. Its `settled(cron, names)` helper waits for each job's `onDone` / `onError`

### Avoiding leaked timers in tests with abandoned handlers

When a test deliberately stops the cron _before_ an in-flight handler returns (e.g. testing `drainTimeoutMs`), the handler's still-running setTimeout keeps the file's process alive under `node --test` until it fires. Patterns:

1. Pass a `__timeout_ref__` ref into the handler's `sleep(ms, ref)` so the test can `clearTimeout(ref.id)` before exiting.
2. Wait long enough at the end of the test for the abandoned timer to fire naturally (e.g. handler sleep 700ms, test trailing sleep 800ms).

### Test DB setup

`pnpm test` loads `.env` when present (`--env-file-if-exists`); copy `.env.example`. Files run
one at a time (`--test-concurrency=1`), as `deno test` ran them: every file uses the same
`_test_` tables.

```bash
# Requires TEST_PG_* env vars (see .env.example)
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
              CronTenantScope, CronStopOptions, CronDb,
              DbRetryOptions, DbHealthStatus } from "./cron.ts";
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
- [ ] For a new statement: one `sql` fragment, values interpolated bare, the table as `raw(tableCron)` (see §3)
- [ ] For multi-statement DB work: use `context.db.transaction(async (tx) => …)` (never send `BEGIN` yourself); a script of several statements goes through `exec`
- [ ] For new management queries: always include `tenant_id` filtering
- [ ] For processor-level logic: do NOT filter by `tenant_id` (processors are global)
- [ ] For waits inside processor loops or handlers: plumb the appropriate AbortSignal through
- [ ] For schema changes: extend `Cron.migrate` with an idempotent step
- [ ] Run `pnpm run ci` after changes (typecheck + lint + 95 tests); `pnpm run format` before committing
- [ ] DB integration tests require `TEST_PG_*` env vars
