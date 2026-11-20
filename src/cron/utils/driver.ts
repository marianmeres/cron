import type { Driver } from "@marianmeres/sqlkit";
import { type PgDb, toPgDriver } from "@marianmeres/sqlkit/pg";

/**
 * What `CronOptions.db` and `Cron.migrate()` take: a node-postgres `pg.Pool`, a
 * `pg.Client`, or a sqlkit `Driver` over PostgreSQL (sqlkit's `PgDb`).
 *
 * The pool and the client are declared by their shape, so cron imports nothing from
 * `pg`: a host that builds a pool or a client has `pg` of its own.
 */
export type CronDb = PgDb;

/**
 * The `Driver` cron runs every statement on: sqlkit's `toPgDriver`, which
 *
 * - uses a sqlkit `Driver` as it is (not wrapped, not cached), and refuses one whose
 *   dialect is not `pg` or that lacks a member of the contract;
 * - builds one driver per `pg.Pool` or `pg.Client` object and hands the same one to
 *   every later call (building one adds an `error` listener to the pool or client, and
 *   `checkDbHealth()` or `Cron.migrate()` may be called any number of times).
 *
 * cron never calls the driver's `close()`: that would end the host's pool or client.
 *
 * @throws {TypeError} When `db` is missing, or is none of the three.
 */
export function toDriver(db: CronDb): Driver {
	if (typeof db !== "object" || db === null) {
		throw new TypeError(
			"cron needs a database: 'db' must be a pg.Pool, a pg.Client or a sqlkit Driver",
		);
	}
	return toPgDriver(db);
}
