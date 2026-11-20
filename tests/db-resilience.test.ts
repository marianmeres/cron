/**
 * What a database call that fails is retried on: `withDbRetry`, on sqlkit's `withRetry`
 * and classified by sqlkit's Postgres classifier, and the `dbRetry` option around the
 * claim.
 *
 * - by default: a deadlock is retried, a unique violation is not, nor is a code that
 *   only appears in a message
 * - a caller's `retryableErrors` replaces the default with exactly its list
 * - an option out of range is a `TypeError` at the call, before anything runs
 * - `dbRetry` covers the claim: checkouts refused before `start()` do not cost the run
 *
 * And how a health check ends, on sqlkit's `checkHealth` and `createHealthMonitor`:
 *
 * - a check that never answers is unhealthy at `timeoutMs`, `latencyMs` `null`
 * - a monitor calls `onUnhealthy` on the flip down and `onHealthy` on the flip back, once
 *   each, and no longer warns on every failed check
 * - `dbHealthCheck.timeoutMs` reaches the monitor `start()` runs
 *
 * The `dbRetry` test requires a live PostgreSQL database (TEST_PG_*) just like
 * cron-db.test.ts; the others need none (the health tests run on a stub `Driver`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "@marianmeres/clog";
import type { Driver, Sql } from "@marianmeres/sqlkit";
import type pg from "pg";
import { checkDbHealth, DbHealthMonitor } from "../src/cron/utils/db-health.ts";
import { withDbRetry } from "../src/cron/utils/with-db-retry.ts";
import {
	Cron,
	type CronJob,
	type DbHealthStatus,
	type DbRetryOptions,
	RUN_STATUS,
} from "../src/mod.ts";
import { createPg } from "./_pg.ts";

const TABLE_PREFIX = "_test_";
const POLL = 50;
const YEARLY = "0 0 1 1 *";

/** Retries without waiting long: the tests are about which error is retried. */
const FAST: DbRetryOptions = { initialDelayMs: 1, maxDelayMs: 1 };

/** Logger that records every message per level. */
function recordingLogger() {
	const lines: Record<"debug" | "warn" | "error", string[]> = {
		debug: [],
		warn: [],
		error: [],
	};
	const logger = {
		debug: (...a: unknown[]) => void lines.debug.push(a.join(" ")),
		info: () => {},
		log: () => {},
		warn: (...a: unknown[]) => void lines.warn.push(a.join(" ")),
		error: (...a: unknown[]) => void lines.error.push(a.join(" ")),
	} as unknown as Logger;
	return { logger, lines };
}

/** An error as a driver throws it: a message and, where given, a `code`. */
function driverError(message: string, code?: string): Error {
	return code === undefined
		? new Error(message)
		: Object.assign(new Error(message), { code });
}

/** A function that rejects with `error` on its first call and resolves `"ok"` after. */
function failingOnce(error: unknown) {
	let calls = 0;
	const fn = async () => {
		calls++;
		if (calls === 1) throw error;
		return "ok";
	};
	return { fn, calls: () => calls };
}

/** `fn` was retried: called twice, resolved with the second call's value. */
async function assertRetried(error: unknown, options: DbRetryOptions) {
	const { fn, calls } = failingOnce(error);
	assert.deepStrictEqual(await withDbRetry(fn, options), "ok");
	assert.deepStrictEqual(calls(), 2);
}

/** `fn` was not retried: called once, rejected with its own error, untouched. */
async function assertNotRetried(error: unknown, options: DbRetryOptions) {
	const { fn, calls } = failingOnce(error);
	await assert.rejects(withDbRetry(fn, options), (e) => e === error);
	assert.deepStrictEqual(calls(), 1);
}

/**
 * Makes the next `n` bare `pool.connect()` calls (cron's checkouts) reject with a
 * driver error of `code`; the tests' own `pool.query()` goes through
 * `pool.connect(callback)` and is left alone. Returns how many are left.
 */
function failNextCheckouts(db: pg.Pool, n: number, code: string) {
	const original = db.connect.bind(db);
	let left = n;
	// biome-ignore lint/suspicious/noExplicitAny: patching an overloaded method
	(db as any).connect = (...args: unknown[]) => {
		if (args.length === 0 && left > 0) {
			left--;
			return Promise.reject(driverError(`simulated ${code}`, code));
		}
		// biome-ignore lint/suspicious/noExplicitAny: patching an overloaded method
		return (original as any)(...args);
	};
	return () => left;
}

// -------------------------------------------------------------------------

test("retry: by default sqlkit's classification decides, by the code", async () => {
	// A deadlock is what a retry exists for
	await assertRetried(driverError("deadlock detected", "40P01"), FAST);
	// A unique violation fails the same way every time
	await assertNotRetried(
		driverError("duplicate key value violates unique constraint", "23505"),
		FAST,
	);
	// A code found only in the message is not the error's code
	await assertNotRetried(driverError("upstream said ECONNRESET"), FAST);
});

test("retry: retryableErrors replaces the default with exactly its list", async () => {
	const options: DbRetryOptions = { ...FAST, retryableErrors: ["XX000"] };
	await assertRetried(driverError("internal error", "XX000"), options);
	// Retryable by default, but not on the caller's list
	await assertNotRetried(driverError("connect refused", "ECONNREFUSED"), options);
});

test("retry: an option out of range is a TypeError at the call", async () => {
	let calls = 0;
	const fn = async () => {
		calls++;
		return "ok";
	};
	await assert.rejects(withDbRetry(fn, { backoffMultiplier: 0.5 }), TypeError);
	assert.deepStrictEqual(calls, 0, "nothing runs on options that are refused");
});

test("retry: dbRetry covers the claim", async () => {
	const db = createPg();
	try {
		const { logger, lines } = recordingLogger();
		const cron = new Cron({
			db,
			tablePrefix: TABLE_PREFIX,
			pollTimeoutMs: POLL,
			gracefulSigterm: false,
			logger,
			dbRetry: { initialDelayMs: 10 },
		});
		await cron.resetHard();

		let calls = 0;
		await cron.register("once", YEARLY, () => {
			calls++;
			return "ok";
		});
		await db.query(
			`UPDATE ${TABLE_PREFIX}__cron
			 SET next_run_at = NOW() - INTERVAL '100 milliseconds'
			 WHERE name = $1`,
			["once"],
		);

		const done = new Promise<CronJob>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("no run within 5 s")), 5_000);
			cron.onDone("once", (job) => {
				clearTimeout(timer);
				resolve(job);
			});
		});

		// The instance is initialized: the first checkouts after start() are the claim's
		const left = failNextCheckouts(db, 2, "ECONNREFUSED");
		await cron.start(1);
		const job = await done;
		cron.unsubscribeAll();
		await cron.stop();

		assert.deepStrictEqual(left(), 0, "both refused checkouts were consumed");
		assert.deepStrictEqual(calls, 1);
		assert.deepStrictEqual(job.last_run_status, RUN_STATUS.SUCCESS);
		assert.ok(
			!lines.error.some((l) => l.startsWith("Cron claim:")),
			`the claim was retried, not failed: ${JSON.stringify(lines.error)}`,
		);
		assert.deepStrictEqual(
			lines.warn.filter((l) => l.startsWith("DB operation failed")).length,
			2,
			`one retry per refused checkout: ${JSON.stringify(lines.warn)}`,
		);

		const { rows } = await db.query(
			`SELECT status FROM ${TABLE_PREFIX}__cron_run_log WHERE cron_name = $1`,
			["once"],
		);
		assert.deepStrictEqual(rows, [{ status: RUN_STATUS.SUCCESS }]);
	} finally {
		await db.end();
	}
});

// -------------------------------------------------------------------------

/**
 * Shaped like a pg `Driver`, never reaching a database: every statement goes to
 * `query(text)` (a fragment as its chunks joined by `?`), a script resolves, a
 * transaction calls its callback with the stub.
 */
function pgStub(query: (text: string) => Promise<unknown>): Driver {
	const stub = {
		dialect: "pg",
		adapter: "stub",
		capabilities: { sync: false, concurrentWriters: true, crossProcessLock: true },
		query: (statement: string | Sql) =>
			query(typeof statement === "string" ? statement : statement.chunks.join("?")),
		exec: async () => {},
		transaction: async (fn: (tx: Driver) => Promise<unknown>) => await fn(stub),
		exclusive: async (_name: string, fn: (tx: Driver) => Promise<unknown>) =>
			await fn(stub),
		close: async () => {},
	} as unknown as Driver;
	return stub;
}

/** Whether `text` is the health check's own statement (sqlkit sends `select 1`). */
const isHealthCheck = (text: string) => /^\s*select 1\s*$/i.test(text);

/** A promise that never settles: a database that hangs rather than refuses. */
const never = () => new Promise<never>(() => {});

test("health: a check that never answers is unhealthy at timeoutMs", async () => {
	const stub = pgStub(() => never());
	const started = Date.now();
	const status: DbHealthStatus = await checkDbHealth(stub, undefined, {
		timeoutMs: 50,
	});
	assert.deepStrictEqual(status.healthy, false);
	assert.deepStrictEqual(status.latencyMs, null);
	assert.match(status.error ?? "", /timed out/);
	assert.deepStrictEqual(status.pgVersion, undefined);
	assert.ok(status.timestamp instanceof Date, "timestamp is a Date");
	assert.ok(Date.now() - started < 2_000, "answered at the timeout, not later");
});

test("health: a monitor reports the flip down and the flip back, once each", async () => {
	let checks = 0;
	const stub = pgStub(async (text) => {
		if (isHealthCheck(text) && ++checks <= 2) {
			throw driverError("connect ECONNREFUSED 127.0.0.1:5432", "ECONNREFUSED");
		}
		return { rows: [], rowCount: 0 };
	});
	const { logger, lines } = recordingLogger();
	const unhealthy: DbHealthStatus[] = [];
	const healthy: DbHealthStatus[] = [];
	let recovered: () => void = () => {};
	const recovery = new Promise<void>((resolve) => {
		recovered = resolve;
	});
	const monitor = new DbHealthMonitor(stub, {
		intervalMs: 10,
		logger,
		onUnhealthy: (status) => void unhealthy.push(status),
		onHealthy: (status) => {
			healthy.push(status);
			recovered();
		},
	});
	const timer = setTimeout(() => recovered(), 2_000);
	try {
		await monitor.start();
		assert.deepStrictEqual(monitor.getLastStatus()?.healthy, false);
		await recovery;
		// a few more healthy checks: none of them is a flip
		await new Promise((resolve) => setTimeout(resolve, 50));
	} finally {
		clearTimeout(timer);
		monitor.stop();
	}

	assert.deepStrictEqual(unhealthy.length, 1, "onUnhealthy once");
	assert.deepStrictEqual(healthy.length, 1, "onHealthy once");
	assert.deepStrictEqual(unhealthy[0].healthy, false);
	assert.deepStrictEqual(unhealthy[0].latencyMs, null);
	assert.match(unhealthy[0].error ?? "", /ECONNREFUSED/);
	assert.deepStrictEqual(healthy[0].healthy, true);
	assert.deepStrictEqual(healthy[0].error, null);
	assert.ok(checks > 3, `the monitor went on checking: ${checks} checks`);
	assert.deepStrictEqual(monitor.getLastStatus()?.healthy, true);
	assert.ok(
		lines.error.includes("Database became unhealthy"),
		JSON.stringify(lines.error),
	);
	assert.ok(lines.debug.includes("Database recovered"), JSON.stringify(lines.debug));
	assert.deepStrictEqual(lines.warn, [], "no warning on every failed check");
});

test("health: dbHealthCheck.timeoutMs reaches the monitor start() runs", async () => {
	// Answers everything start() asks for the schema, never the health check
	const stub = pgStub((text) =>
		isHealthCheck(text) ? never() : Promise.resolve({ rows: [], rowCount: 0 }),
	);
	const { logger } = recordingLogger();
	const cron = new Cron({
		db: stub,
		tablePrefix: TABLE_PREFIX,
		gracefulSigterm: false,
		logger,
		dbHealthCheck: { timeoutMs: 50, intervalMs: 20 },
	});
	try {
		assert.deepStrictEqual(cron.getDbHealth(), null, "null before start()");
		await cron.start(0);
		const status = cron.getDbHealth();
		assert.deepStrictEqual(status?.healthy, false, JSON.stringify(status));
		assert.deepStrictEqual(status?.latencyMs, null);
		assert.match(status?.error ?? "", /timed out after 50 ms/);
	} finally {
		await cron.stop();
	}
});
