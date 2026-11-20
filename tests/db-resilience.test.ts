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
 * The last test requires a live PostgreSQL database (TEST_PG_*) just like
 * cron-db.test.ts; the others need none.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "@marianmeres/clog";
import type pg from "pg";
import { withDbRetry } from "../src/cron/utils/with-db-retry.ts";
import { Cron, type CronJob, type DbRetryOptions, RUN_STATUS } from "../src/mod.ts";
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
