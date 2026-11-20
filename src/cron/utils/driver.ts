import type { Driver } from "@marianmeres/sqlkit";
import {
	createPgClientDriver,
	createPgDriver,
	type PgPoolLike,
	type PgStandaloneClientLike,
} from "@marianmeres/sqlkit/pg";

/**
 * What `CronOptions.db` and `Cron.migrate()` take: a node-postgres `pg.Pool`, a
 * `pg.Client`, or a sqlkit `Driver` over PostgreSQL.
 *
 * The pool and the client are declared by their shape, so cron imports nothing from
 * `pg`: a host that builds a pool or a client has `pg` of its own.
 */
export type CronDb = PgPoolLike | PgStandaloneClientLike | Driver;

/**
 * One driver per pool or client object, however many callers share it. Building a
 * driver adds an `error` listener to the pool or client, and `checkDbHealth()` or
 * `Cron.migrate()` may be called any number of times.
 */
const drivers = new WeakMap<object, Driver>();

/** Whether `db` is a sqlkit `Driver` (by shape: it has a dialect, statements and transactions). */
export function isDriver(db: unknown): db is Driver {
	const d = db as Partial<Driver> | null;
	return (
		typeof d === "object" &&
		d !== null &&
		typeof d.dialect === "string" &&
		typeof d.query === "function" &&
		typeof d.exec === "function" &&
		typeof d.transaction === "function" &&
		typeof d.capabilities === "object" &&
		d.capabilities !== null
	);
}

/**
 * Type guard: tells a `pg.Pool` from a `pg.Client`. Both have a `connect()`, but only a
 * pool has `totalCount` (and `idleCount` / `waitingCount`).
 */
export function isPool(db: unknown): db is PgPoolLike {
	return (
		typeof db === "object" &&
		db !== null &&
		typeof (db as { connect?: unknown }).connect === "function" &&
		"totalCount" in db
	);
}

/**
 * The `Driver` cron runs every statement on.
 *
 * - A sqlkit `Driver` is used as it is (not wrapped, not cached), and refused with a
 *   `TypeError` unless its dialect is `pg`: cron runs on PostgreSQL.
 * - A `pg.Pool` or a `pg.Client` gets a driver of its own, built once per object and
 *   shared by every later call.
 *
 * cron never calls the driver's `close()`: that would end the host's pool or client.
 *
 * @throws {TypeError} When `db` is missing, or is a driver of another dialect.
 */
export function toDriver(db: CronDb): Driver {
	if (typeof db !== "object" || db === null) {
		throw new TypeError(
			"cron needs a database: 'db' must be a pg.Pool, a pg.Client or a sqlkit Driver",
		);
	}
	if (isDriver(db)) {
		if (db.dialect !== "pg") {
			throw new TypeError(
				`cron runs on PostgreSQL: got a "${db.dialect}" driver (${db.adapter})`,
			);
		}
		return db;
	}
	let driver = drivers.get(db);
	if (driver === undefined) {
		driver = isPool(db) ? createPgDriver(db) : createPgClientDriver(db);
		drivers.set(db, driver);
	}
	return driver;
}
