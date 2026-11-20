/**
 * What `db` takes, and how cron turns it into the driver it runs on:
 *
 * - a sqlkit `Driver` the host built is used as it is: jobs run on it, `migrate` too
 * - a driver of another dialect, or no database at all, is a `TypeError` at construction
 * - one driver per pool, however many instances and calls share it (one `error` listener),
 *   and the same one sqlkit's `toPgDriver` hands any other caller
 * - `CronDb` is nameable from the package entry
 *
 * Requires a live PostgreSQL database (TEST_PG_*) just like cron-db.test.ts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "@marianmeres/clog";
import type { Driver } from "@marianmeres/sqlkit";
import { createPgDriver, toPgDriver } from "@marianmeres/sqlkit/pg";
import type pg from "pg";
import {
	CRON_STATUS,
	Cron,
	type CronDb,
	type CronJob,
	type CronOptions,
	RUN_STATUS,
} from "../src/mod.ts";
import { createPg, createPgClient } from "./_pg.ts";

const TABLE_PREFIX = "_test_";
const POLL = 50;
const YEARLY = "0 0 1 1 *";

const noopLogger = {
	debug: () => {},
	info: () => {},
	log: () => {},
	warn: () => {},
	error: () => {},
} as Logger;

function createCron(db: CronDb) {
	return new Cron({
		db,
		tablePrefix: TABLE_PREFIX,
		pollTimeoutMs: POLL,
		gracefulSigterm: false,
		logger: noopLogger,
	});
}

async function backdate(db: pg.Pool, name: string, msAgo = 100) {
	await db.query(
		`UPDATE ${TABLE_PREFIX}__cron
		 SET next_run_at = NOW() - ($1 * INTERVAL '1 millisecond')
		 WHERE name = $2`,
		[msAgo, name],
	);
}

/** Resolves with the job once `name` has run to success; rejects after `ms`. */
function doneWithin(cron: Cron, name: string, ms = 5_000): Promise<CronJob> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${name}: no run in ${ms} ms`)),
			ms,
		);
		cron.onDone(name, (job) => {
			clearTimeout(timer);
			resolve(job);
		});
	});
}

/** Shaped like a `Driver`, of a dialect cron does not run on. Never reaches a database. */
function sqliteStub(): Driver {
	const stub: Driver = {
		dialect: "sqlite",
		adapter: "node:sqlite",
		capabilities: { sync: false, concurrentWriters: false, crossProcessLock: false },
		query: async () => ({ rows: [], rowCount: 0 }),
		exec: async () => {},
		transaction: async (fn) => await fn(stub),
		exclusive: async (_name, fn) => await fn(stub),
		savepoint: async (fn) => await fn(stub),
		close: async () => {},
	} as Driver;
	return stub;
}

test("driver: a Driver built by the host runs jobs and migrations", async () => {
	const pool = createPg();
	const driver = createPgDriver(pool);
	const cron = createCron(driver);
	try {
		await cron.resetHard();
		let calls = 0;
		await cron.register("via-driver", YEARLY, async () => {
			calls++;
			return "ok";
		});
		await backdate(pool, "via-driver");
		const done = doneWithin(cron, "via-driver");

		await cron.start(2);
		const job = await done;
		await cron.stop();

		assert.deepStrictEqual(calls, 1);
		assert.deepStrictEqual(job.status, CRON_STATUS.IDLE);
		assert.deepStrictEqual(job.last_run_status, RUN_STATUS.SUCCESS);

		await Cron.migrate(driver, TABLE_PREFIX);

		// Used as it is: cron built no second driver over the host's pool
		assert.deepStrictEqual(pool.listenerCount("error"), 1);
	} finally {
		cron.unsubscribeAll();
		await cron.stop();
		await pool.end();
	}
});

test("driver: a driver of another dialect is refused at construction", async () => {
	assert.throws(() => createCron(sqliteStub()), TypeError);
	await assert.rejects(Cron.migrate(sqliteStub(), TABLE_PREFIX), TypeError);
});

test("driver: no database is refused at construction", () => {
	assert.throws(() => new Cron({} as CronOptions), TypeError);
});

test("driver: one driver per pool, however many callers share it", async () => {
	const pool = createPg();
	const a = createCron(pool);
	const b = createCron(pool);
	try {
		await a.resetHard();
		for (let i = 0; i < 10; i++) {
			assert.ok((await a.checkDbHealth()).healthy);
			assert.ok((await b.checkDbHealth()).healthy);
		}
		await Cron.migrate(pool, TABLE_PREFIX);

		// The pool's driver listens for `error` once; the host added none
		assert.deepStrictEqual(pool.listenerCount("error"), 1);
	} finally {
		await pool.end();
	}
});

test("driver: cron and toPgDriver share the pool's driver", async () => {
	const pool = createPg();
	const cron = createCron(pool);
	try {
		await cron.resetHard();
		const driver = toPgDriver(pool);
		// A job registered inside the host's transaction is part of it
		await assert.rejects(
			driver.transaction(async () => {
				await cron.register("rolled-back", YEARLY, async () => {});
				throw new Error("roll back");
			}),
			/roll back/,
		);
		assert.deepStrictEqual(await cron.find("rolled-back"), null);
		assert.deepStrictEqual(pool.listenerCount("error"), 1);
	} finally {
		cron.unsubscribeAll();
		await pool.end();
	}
});

test("driver: CronDb names a pool, a client and a driver", async () => {
	const pool = createPg();
	try {
		// Never connected: this is about the type, checked by `tsc` over the tests
		const dbs: CronDb[] = [pool, createPgClient(), createPgDriver(pool)];
		assert.deepStrictEqual(dbs.length, 3);
	} finally {
		await pool.end();
	}
});
