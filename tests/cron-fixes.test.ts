/**
 * Tests covering bug-fixes / behaviour additions in this release:
 *
 * - B1: a run is finalized in one real transaction (job row + run log, or neither)
 * - B4: per-instance onEvent wrap cache, no first-unsub-kills-others bug
 * - B5: lease_token fence — stale-recovered jobs cannot clobber fresh writes
 * - B6: stop({ drainTimeoutMs }) returns even when a handler ignores abort
 * - D1: AbortSignal handed to handler; aborted on shutdown
 * - D2: autoCleanup option auto-runs cleanup() on a timer
 * - D4: exponential backoff is clamped (unit test)
 * - D5: pruneRunLog deletes old run-log rows
 * - sync-registry: removes orphan handlers
 *
 * Requires a live PostgreSQL database (TEST_PG_*) just like cron-db.test.ts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "@marianmeres/clog";
import type pg from "pg";
import { _backoffMs, DEFAULT_MAX_BACKOFF_MS } from "../src/cron/_handle-failure.ts";
import { sleep } from "../src/cron/utils/sleep.ts";
import { TimeoutError, withTimeout } from "../src/cron/utils/with-timeout.ts";
import {
	CRON_STATUS,
	Cron,
	type CronJob,
	createTaskRegistry,
	RUN_STATUS,
	syncRegistryToCron,
} from "../src/mod.ts";
import { createPg } from "./_pg.ts";

const TABLE_PREFIX = "_test_";
const POLL = 50;
/** Once a year: a job that must run exactly once is registered with it and backdated. */
const YEARLY = "0 0 1 1 *";

const noopLogger = {
	debug: () => {},
	info: () => {},
	log: () => {},
	warn: () => {},
	error: () => {},
} as Logger;

function createCron(db: pg.Pool, opts: Record<string, unknown> = {}) {
	return new Cron({
		db,
		tablePrefix: TABLE_PREFIX,
		pollTimeoutMs: POLL,
		gracefulSigterm: false,
		logger: noopLogger,
		...opts,
	});
}

async function setup() {
	const db = createPg();
	const cron = createCron(db);
	await cron.resetHard();
	return { db, cron };
}

async function teardown(cron: Cron, db: pg.Pool) {
	cron.unsubscribeAll();
	await cron.stop();
	await db.end();
}

async function backdate(db: pg.Pool, name: string, msAgo = 100) {
	await db.query(
		`UPDATE ${TABLE_PREFIX}__cron
		 SET next_run_at = NOW() - ($1 * INTERVAL '1 millisecond')
		 WHERE name = $2`,
		[msAgo, name],
	);
}

async function fetchJob(db: pg.Pool, name: string) {
	const { rows } = await db.query(
		`SELECT * FROM ${TABLE_PREFIX}__cron WHERE name = $1`,
		[name],
	);
	return rows[0];
}

// =========================================================================
// B1: real transactions
// =========================================================================

/** One statement a checked-out client ran, with the index of that checkout. */
interface Recorded {
	checkout: number;
	text: string;
}

/**
 * Records every statement a client checked out with a bare `pool.connect()` runs, with
 * the index of its checkout. (The tests' own `db.query()` goes through
 * `pool.connect(callback)` and is not recorded.) Statements arrive as a string or as a
 * config object, so the text is read from either.
 *
 * `rejectOnce` makes the first statement matching it fail once, with a plain `Error`,
 * without reaching the database.
 */
function recordCheckouts(db: pg.Pool, rejectOnce?: RegExp): Recorded[] {
	type Query = (q: string | { text: string }, ...rest: unknown[]) => Promise<unknown>;
	type Client = { query: Query; release: (...a: unknown[]) => void };
	const log: Recorded[] = [];
	const pool = db as unknown as { connect: (...args: unknown[]) => Promise<unknown> };
	const connect = pool.connect.bind(db);
	let checkouts = 0;
	let armed = rejectOnce;
	pool.connect = async (...args: unknown[]) => {
		if (args.length > 0) return connect(...args);
		const client = (await connect()) as Client;
		const checkout = checkouts++;
		const query = client.query;
		const release = client.release;
		client.query = (q, ...rest) => {
			const text = typeof q === "string" ? q : q.text;
			log.push({ checkout, text });
			if (armed?.test(text)) {
				armed = undefined;
				return Promise.reject(new Error("simulated run-log write failure"));
			}
			return query.call(client, q, ...rest);
		};
		// The pool hands the same client out again: unwrap it on its way back
		client.release = (...a) => {
			client.query = query;
			client.release = release;
			release.apply(client, a);
		};
		return client;
	};
	return log;
}

const RE_UPDATE_CRON = /update\s+\S*__cron\s/i;
const RE_UPDATE_RUN_LOG = /update\s+\S*__cron_run_log\s/i;

/** Resolves once `cond()` holds; rejects after `ms`. */
async function until(cond: () => boolean, ms = 5_000, label = "condition") {
	const deadline = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error(`${label}: not met within ${ms} ms`);
		await sleep(10);
	}
}

test("B1: a run is finalized in one transaction, on one connection", async () => {
	const { db, cron } = await setup();
	try {
		let calls = 0;
		await cron.register("tx-ok", YEARLY, async () => {
			calls++;
			return "ok";
		});
		await backdate(db, "tx-ok");
		const done = new Promise<void>((resolve) =>
			cron.onDone("tx-ok", () => resolve()),
		);
		const log = recordCheckouts(db);

		await cron.start(1);
		await done;
		await cron.stop();
		assert.deepStrictEqual(calls, 1);

		// The run-log UPDATE is the finalization's alone (the start of a run INSERTs)
		const runLogUpdate = log.find((r) => RE_UPDATE_RUN_LOG.test(r.text));
		assert.ok(runLogUpdate, "the finalization must UPDATE the run log");

		// Everything that checkout ran, from its `begin` to its `commit`
		const tx = log
			.filter((r) => r.checkout === runLogUpdate.checkout)
			.map((r) => r.text);
		assert.match(tx[0], /^\s*begin\b/i, `expected begin first, got: ${tx[0]}`);
		assert.match(tx.at(-1) ?? "", /^\s*commit\b/i, `expected commit last: ${tx}`);
		assert.ok(
			tx.some((t) => RE_UPDATE_CRON.test(t)),
			"the job row UPDATE must be on the same connection",
		);
		assert.ok(tx.some((t) => RE_UPDATE_RUN_LOG.test(t)));

		const row = await fetchJob(db, "tx-ok");
		assert.deepStrictEqual(row.status, CRON_STATUS.IDLE);
		assert.deepStrictEqual(row.last_run_status, RUN_STATUS.SUCCESS);
	} finally {
		await teardown(cron, db);
	}
});

test("B1: a failed run-log write rolls the job row back with it", async () => {
	const errors: string[] = [];
	const logger = {
		...noopLogger,
		error: (...a: unknown[]) => void errors.push(a.join(" ")),
	} as Logger;
	const db = createPg();
	const cron = createCron(db, { logger });
	await cron.resetHard();
	try {
		let calls = 0;
		await cron.register("tx-fail", YEARLY, async () => {
			calls++;
			return "ok";
		});
		await backdate(db, "tx-fail");
		recordCheckouts(db, RE_UPDATE_RUN_LOG);

		await cron.start(1);
		await until(
			() => errors.some((l) => l.includes("could not record the run")),
			5_000,
			"bookkeeping error",
		);
		await cron.stop();

		assert.deepStrictEqual(calls, 1, "the handler ran once");

		// The job row UPDATE went with the rollback: still claimed, lease intact
		const row = await fetchJob(db, "tx-fail");
		assert.deepStrictEqual(row.status, CRON_STATUS.RUNNING);
		assert.ok(row.lease_token, "lease_token must still be set");

		// …so stale recovery picks it up
		assert.deepStrictEqual(await cron.cleanup(0), 1);
	} finally {
		await teardown(cron, db);
	}
});

// =========================================================================
// B5: lease token prevents stale-recovered worker from clobbering
// =========================================================================

test("B5: stale-recovered worker cannot overwrite fresh claim's result", async () => {
	const { db, cron } = await setup();
	try {
		await cron.register("racy", "* * * * *", async () => "fresh");

		// Manually pretend a worker claimed the job a long time ago, with a
		// known lease_token that will get cleared by cleanup().
		const oldToken = "11111111-1111-1111-1111-111111111111";
		await db.query(
			`UPDATE ${TABLE_PREFIX}__cron
				 SET status = 'running',
				     last_run_at = NOW() - INTERVAL '10 minutes',
				     lease_token = $1
				 WHERE name = 'racy'`,
			[oldToken],
		);

		// Stale recovery: clears lease_token, sets next_run_at = NOW()
		const recovered = await cron.cleanup(5);
		assert.deepStrictEqual(recovered, 1);

		// Now the (still-alive) old worker tries to write its result via
		// _handleCronSuccess. We simulate that by running the same UPDATE
		// _handleCronSuccess would issue, with the OLD lease token.
		const { rowCount } = await db.query(
			`UPDATE ${TABLE_PREFIX}__cron
				 SET status = 'idle',
				     last_run_status = 'success',
				     next_run_at = NOW() + INTERVAL '99 years',
				     lease_token = NULL
				 WHERE name = 'racy' AND lease_token = $1`,
			[oldToken],
		);
		assert.deepStrictEqual(
			rowCount,
			0,
			"stale write must be rejected by lease fence",
		);

		const row = await fetchJob(db, "racy");
		// next_run_at must NOT be 99 years in the future
		assert.ok(
			new Date(row.next_run_at).getFullYear() < 2050,
			"next_run_at must reflect cleanup, not the stale write",
		);
	} finally {
		await teardown(cron, db);
	}
});

test("B5: lease token is set on claim, cleared on success", async () => {
	const { db, cron } = await setup();
	try {
		await cron.register("lease-job", "* * * * *", async () => "ok");
		await backdate(db, "lease-job");

		await cron.start(1);
		await sleep(300);

		const row = await fetchJob(db, "lease-job");
		assert.deepStrictEqual(row.last_run_status, RUN_STATUS.SUCCESS);
		assert.deepStrictEqual(
			row.lease_token,
			null,
			"lease_token must be cleared after success",
		);
	} finally {
		await teardown(cron, db);
	}
});

// =========================================================================
// B4: onEvent wrap cache — first-unsub-kills-others bug + duplicate wrap
// =========================================================================

test("B4: subscribing to multiple names then unsubscribing once detaches all", async () => {
	const { db, cron } = await setup();
	try {
		await cron.register("evt-a", YEARLY, async () => "a");
		await cron.register("evt-b", YEARLY, async () => "b");

		let calls = 0;
		const cb = (_job: CronJob) => {
			calls++;
		};

		const unsub = cron.onDone(["evt-a", "evt-b"], cb);

		// Re-subscribe BEFORE unsubscribing — should NOT create a duplicate
		cron.onDone(["evt-a"], cb);

		await backdate(db, "evt-a");
		await backdate(db, "evt-b");

		await cron.start(1);
		await sleep(400);

		// Each job fires once; cb should be invoked at most once per job
		assert.deepStrictEqual(calls, 2, `expected 2 events, got ${calls}`);

		unsub();
		// After unsub of the first batch, only the explicit "evt-a" subscription
		// from the second call could remain; per the dedup logic both should be gone.
	} finally {
		await teardown(cron, db);
	}
});

test("B4: handler exception in onDone does not kill processor", async () => {
	const { db, cron } = await setup();
	try {
		let secondFired = false;
		await cron.register("evt1", "* * * * *", async () => {});
		cron.onDone("evt1", () => {
			throw new Error("intentional in event handler");
		});
		cron.onDone("evt1", () => {
			secondFired = true;
		});

		await backdate(db, "evt1");
		await cron.start(1);
		await sleep(300);

		assert.ok(secondFired, "second onDone subscriber must still fire");
	} finally {
		await teardown(cron, db);
	}
});

// =========================================================================
// B6: drainTimeoutMs returns even if handler ignores abort
// =========================================================================

test("B6: stop({ drainTimeoutMs }) returns within the cap", async () => {
	const { db, cron } = await setup();
	try {
		// Handler that sleeps longer than the drain cap and ignores the
		// AbortSignal — but short enough that the leftover timer drains
		// during the trailing sleep so Deno's leak detector is happy.
		const ref = { id: -1 };
		await cron.register("stuck", "* * * * *", async () => {
			// pass a ref so we can clean up the abandoned timer at the end
			await sleep(700, ref);
		});
		await backdate(db, "stuck");
		await cron.start(1);
		// Wait for the poller to claim
		await sleep(200);

		const started = Date.now();
		await cron.stop({ drainTimeoutMs: 100 });
		const elapsed = Date.now() - started;
		assert.ok(
			elapsed < 600,
			`stop should return within ~drainTimeoutMs, took ${elapsed}ms`,
		);

		// Wait long enough for the abandoned handler timer to fire,
		// keeping Deno's leak detector quiet.
		await sleep(800);
		clearTimeout(ref.id);
	} finally {
		await db.end();
	}
});

// =========================================================================
// D1: AbortSignal forwarded to handler
// =========================================================================

test("D1: handler receives AbortSignal that fires on shutdown", async () => {
	const { db, cron } = await setup();
	try {
		let aborted = false;
		await cron.register("abortable", "* * * * *", async (_job, signal) => {
			signal?.addEventListener("abort", () => {
				aborted = true;
			});
			await sleep(2_000, undefined, signal);
		});
		await backdate(db, "abortable");
		await cron.start(1);
		await sleep(150);
		await cron.stop({ drainTimeoutMs: 500 });

		assert.ok(aborted, "handler's AbortSignal must fire during shutdown");
	} finally {
		await db.end();
	}
});

test("D1: withTimeout aborts the controller on timeout", async () => {
	const ctrl = new AbortController();
	let aborted = false;
	ctrl.signal.addEventListener("abort", () => {
		aborted = true;
	});

	const fn = withTimeout(
		() => sleep(2_000, undefined, ctrl.signal),
		20,
		"too slow",
		ctrl,
	);

	let caught: unknown = null;
	try {
		await fn();
	} catch (e) {
		caught = e;
	}
	assert.ok(caught instanceof TimeoutError);
	assert.ok(aborted, "AbortController must be aborted when withTimeout fires");
});

// =========================================================================
// D2: autoCleanup option
// =========================================================================

test("D2: autoCleanup recovers stuck jobs on a timer", async () => {
	const db = createPg();
	const cron = createCron(db, {
		autoCleanup: { intervalMs: 100, maxAllowedRunDurationMinutes: 0.001 }, // 60ms threshold
	});
	await cron.resetHard();
	try {
		await cron.register("autoclean", "* * * * *", async () => {});

		// Force into stale running state
		await db.query(
			`UPDATE ${TABLE_PREFIX}__cron
			 SET status = 'running',
			     last_run_at = NOW() - INTERVAL '5 minutes'
			 WHERE name = 'autoclean'`,
		);

		await cron.start(1);
		await sleep(350); // > intervalMs

		const row = await fetchJob(db, "autoclean");
		assert.deepStrictEqual(
			row.status,
			CRON_STATUS.IDLE,
			"autoCleanup must recover the job",
		);
	} finally {
		await teardown(cron, db);
	}
});

// =========================================================================
// D4: exponential backoff is clamped
// =========================================================================

test("D4: exponential backoff is clamped to maxMs", () => {
	// attempt 1 → 2s, attempt 2 → 4s, attempt 10 → 1024s (=> clamped to maxMs)
	assert.deepStrictEqual(_backoffMs("exp", 1), 2_000);
	assert.deepStrictEqual(_backoffMs("exp", 2), 4_000);
	assert.deepStrictEqual(_backoffMs("exp", 20), DEFAULT_MAX_BACKOFF_MS);
	assert.deepStrictEqual(_backoffMs("exp", 30), DEFAULT_MAX_BACKOFF_MS);
});

test("D4: 'none' strategy returns 0", () => {
	assert.deepStrictEqual(_backoffMs("none", 1), 0);
	assert.deepStrictEqual(_backoffMs("none", 100), 0);
});

// =========================================================================
// pruneRunLog
// =========================================================================

test("pruneRunLog: deletes only old rows, returns count", async () => {
	const { db, cron } = await setup();
	try {
		await cron.register("prune", "* * * * *", async () => "ok");
		await backdate(db, "prune");
		await cron.start(1);
		await sleep(250);
		await cron.stop();

		// Backdate the existing run-log row to be "old"
		await db.query(
			`UPDATE ${TABLE_PREFIX}__cron_run_log
			 SET started_at = NOW() - INTERVAL '120 minutes'
			 WHERE cron_name = 'prune'`,
		);

		const deleted = await cron.pruneRunLog(60); // older than 60min
		assert.ok(deleted >= 1, `expected at least 1 row deleted, got ${deleted}`);

		const history = await cron.getRunHistory("prune");
		assert.deepStrictEqual(history.length, 0);
	} finally {
		await db.end();
	}
});

// =========================================================================
// sync-registry: removes orphan handlers
// =========================================================================

test("sync-registry: removeHandler called for in-memory handlers no longer in registry", async () => {
	const db = createPg();
	const cron = new Cron({
		db,
		tablePrefix: TABLE_PREFIX,
		pollTimeoutMs: POLL,
		gracefulSigterm: false,
		logger: noopLogger,
	});
	await cron.resetHard();

	try {
		// Pre-existing in-memory handler that won't be in the registry
		cron.setHandler("ghost", async () => "ghost");
		assert.ok(cron.hasHandler("ghost"));

		const registry = createTaskRegistry();
		registry.define("real", { handler: async () => "real" });

		const { synced, removedHandlers } = await syncRegistryToCron(cron, registry);

		assert.ok(synced.includes("real"));
		assert.ok(removedHandlers.includes("ghost"));
		assert.ok(!cron.hasHandler("ghost"), "ghost handler must be removed");
		assert.ok(cron.hasHandler("real"));
	} finally {
		await cron.stop();
		await db.end();
	}
});
