# Backlog

Work after 4.0.0, ranked, not scheduled. This is the open copy: change it here.

The rows come from the plan that moved cron onto `@marianmeres/sqlkit` for 4.0.0, and
their ids continue that plan's. The plan was a local working set and is not part of the
repository, so a row that needs more than one line has its detail below the table.

**Status:** ⬜ open · ⏭️ deferred until its trigger · ✅ done

| Status | ID  | Rank | Task                                                                                                                                                                                                       |
| ------ | --- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ⬜     | T13 | 1    | PGlite as a tested target: a test in the suite on a `Driver` over PGlite. Adds a dev dependency. Ready once PGlite support is decided.                                                                     |
| ⏭️     | T14 | 2    | The schema and `Cron.migrate()` through sqlkit's migrate wiring. Needs its own plan. Trigger: the first schema change the two idempotent scripts cannot express.                                           |
| ⏭️     | T15 | 3    | A SQLite backend. Needs its own plan.                                                                                                                                                                      |
| ⏭️     | T16 | 4    | `Cron.migrate()`'s constraint lookup: on its table, not by name alone, and past 63 bytes. Trigger: a deployment that reaches several schemas through `search_path` with one prefix, or a very long prefix. |

## T13: PGlite as a tested target

PGlite speaks the `pg` dialect, so a host can pass a sqlkit `Driver` built on it through the
`db` option, and since 4.0.0 several processors can share its one connection. It has not
been run against cron. Before it can be called supported it needs a test in the suite:
`start(2)` on a `Driver` over PGlite, one job through to `success`.

## T14: the schema through migrations

cron's schema is one idempotent script run at first use, and `Cron.migrate()` is a second
idempotent script that brings older tables up to date. Versioned migrations need a version
table per table prefix (sqlkit's table names take letters, digits and underscores only, and
a prefix can be `"app."`), and a first version for deployed tables that is those same
scripts. No schema change is waiting for it.

## T15: a SQLite backend

It would come in through the `Driver` option, like PGlite: the host builds the driver, and
cron imports no SQLite library. Today a driver whose dialect is not `pg` is refused with a
`TypeError`. 4.0.0 already did the dialect-neutral half:

- statements are sqlkit `sql` fragments rendered per dialect, `?` placeholders included;
- JSON is bound as text, through `json()`;
- several processors share one connection through sqlkit's single-connection driver;
- a busy database (`BusyError`) is retried;
- the health check is `select 1`;
- `pg` is no longer a dependency.

Still to do:

- the schema per dialect: `SERIAL`, `JSONB`, `TIMESTAMPTZ`, `gen_random_uuid()`, the
  `DO $$` blocks and the advisory lock are all Postgres;
- time: `NOW()`, the interval arithmetic and `EXTRACT(EPOCH …)`;
- the claim's `FOR UPDATE SKIP LOCKED`, and the `gen_random_uuid()` that issues its lease
  token;
- rows: SQLite stores JSON, booleans and instants as text or integers, so a job row has to
  be decoded;
- the suite, which sets its cases up with Postgres SQL on a raw pool, has to run per
  driver;
- accepting a driver whose dialect is not `pg`.

## T16: the constraint lookup in `Cron.migrate()`

`Cron.migrate()` adds each CHECK constraint only when it is missing, and looks it up in
`pg_constraint` by its name, lower-cased to match Postgres's folding of unquoted names. Two
cases are not covered, and neither is known to bite anyone:

- The lookup is by name alone. Two schemas reached through `search_path` with the same
  `tablePrefix` share constraint names, so once one of them has a constraint, the other's
  is taken as present and never added.
- Postgres truncates a name past 63 bytes. With a prefix long enough to push a constraint
  name past that, the lookup never finds it, and the second call fails adding it again.
