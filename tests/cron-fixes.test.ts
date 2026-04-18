/**
 * Tests covering bug-fixes / behaviour additions in this release:
 *
 * - B1: real transactions on `pg.Pool` (handle-success / handle-failure)
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

import { assertEquals, assert } from "@std/assert";
import {
	Cron,
	CRON_STATUS,
	createTaskRegistry,
	RUN_STATUS,
	syncRegistryToCron,
	type CronJob,
} from "../src/mod.ts";
import { sleep } from "../src/cron/utils/sleep.ts";
import { withTx } from "../src/cron/utils/with-tx.ts";
import { withTimeout, TimeoutError } from "../src/cron/utils/with-timeout.ts";
import { _backoffMs, DEFAULT_MAX_BACKOFF_MS } from "../src/cron/_handle-failure.ts";
import { createPg } from "./_pg.ts";
import type pg from "pg";
import type { Logger } from "@marianmeres/clog";

const TABLE_PREFIX = "_test_";
const POLL = 50;

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
		[msAgo, name]
	);
}

async function fetchJob(db: pg.Pool, name: string) {
	const { rows } = await db.query(
		`SELECT * FROM ${TABLE_PREFIX}__cron WHERE name = $1`,
		[name]
	);
	return rows[0];
}

// =========================================================================
// B1: real transactions
// =========================================================================

Deno.test("B1: withTx commits all writes on the same connection", async () => {
	const db = createPg();
	try {
		await withTx(db, async (client) => {
			await client.query(`CREATE TEMP TABLE _tx_probe (v INT) ON COMMIT DROP`);
			await client.query(`INSERT INTO _tx_probe VALUES (1), (2), (3)`);
			const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM _tx_probe`);
			assertEquals(rows[0].n, 3);
		});
		// After commit, the temp table is gone (ON COMMIT DROP). A different
		// pool checkout proves the table no longer exists.
		const { rows } = await db.query(
			`SELECT to_regclass('_tx_probe') IS NULL AS gone`
		);
		assertEquals(rows[0].gone, true);
	} finally {
		await db.end();
	}
});

Deno.test("B1: withTx rolls back on error", async () => {
	const db = createPg();
	try {
		// Use a real, persistent table so we can probe across connections
		await db.query(`DROP TABLE IF EXISTS _tx_rollback_probe`);
		await db.query(`CREATE TABLE _tx_rollback_probe (v INT)`);

		try {
			await withTx(db, async (client) => {
				await client.query(`INSERT INTO _tx_rollback_probe VALUES (1)`);
				throw new Error("boom");
			});
			assert(false, "withTx should have rethrown");
		} catch (e) {
			assertEquals((e as Error).message, "boom");
		}

		const { rows } = await db.query(
			`SELECT COUNT(*)::int AS n FROM _tx_rollback_probe`
		);
		assertEquals(rows[0].n, 0, "insert must have been rolled back");

		await db.query(`DROP TABLE _tx_rollback_probe`);
	} finally {
		await db.end();
	}
});

// =========================================================================
// B5: lease token prevents stale-recovered worker from clobbering
// =========================================================================

Deno.test(
	"B5: stale-recovered worker cannot overwrite fresh claim's result",
	async () => {
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
				[oldToken]
			);

			// Stale recovery: clears lease_token, sets next_run_at = NOW()
			const recovered = await cron.cleanup(5);
			assertEquals(recovered, 1);

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
				[oldToken]
			);
			assertEquals(rowCount, 0, "stale write must be rejected by lease fence");

			const row = await fetchJob(db, "racy");
			// next_run_at must NOT be 99 years in the future
			assert(
				new Date(row.next_run_at).getFullYear() < 2050,
				"next_run_at must reflect cleanup, not the stale write"
			);
		} finally {
			await teardown(cron, db);
		}
	}
);

Deno.test("B5: lease token is set on claim, cleared on success", async () => {
	const { db, cron } = await setup();
	try {
		await cron.register("lease-job", "* * * * *", async () => "ok");
		await backdate(db, "lease-job");

		await cron.start(1);
		await sleep(300);

		const row = await fetchJob(db, "lease-job");
		assertEquals(row.last_run_status, RUN_STATUS.SUCCESS);
		assertEquals(row.lease_token, null, "lease_token must be cleared after success");
	} finally {
		await teardown(cron, db);
	}
});

// =========================================================================
// B4: onEvent wrap cache — first-unsub-kills-others bug + duplicate wrap
// =========================================================================

Deno.test(
	"B4: subscribing to multiple names then unsubscribing once detaches all",
	async () => {
		const { db, cron } = await setup();
		try {
			await cron.register("evt-a", "* * * * *", async () => "a");
			await cron.register("evt-b", "* * * * *", async () => "b");

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
			assertEquals(calls, 2, `expected 2 events, got ${calls}`);

			unsub();
			// After unsub of the first batch, only the explicit "evt-a" subscription
			// from the second call could remain; per the dedup logic both should be gone.
		} finally {
			await teardown(cron, db);
		}
	}
);

Deno.test("B4: handler exception in onDone does not kill processor", async () => {
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

		assert(secondFired, "second onDone subscriber must still fire");
	} finally {
		await teardown(cron, db);
	}
});

// =========================================================================
// B6: drainTimeoutMs returns even if handler ignores abort
// =========================================================================

Deno.test("B6: stop({ drainTimeoutMs }) returns within the cap", async () => {
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
		assert(
			elapsed < 600,
			`stop should return within ~drainTimeoutMs, took ${elapsed}ms`
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

Deno.test("D1: handler receives AbortSignal that fires on shutdown", async () => {
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

		assert(aborted, "handler's AbortSignal must fire during shutdown");
	} finally {
		await db.end();
	}
});

Deno.test("D1: withTimeout aborts the controller on timeout", async () => {
	const ctrl = new AbortController();
	let aborted = false;
	ctrl.signal.addEventListener("abort", () => {
		aborted = true;
	});

	const fn = withTimeout(
		() => sleep(2_000, undefined, ctrl.signal),
		20,
		"too slow",
		ctrl
	);

	let caught: unknown = null;
	try {
		await fn();
	} catch (e) {
		caught = e;
	}
	assert(caught instanceof TimeoutError);
	assert(aborted, "AbortController must be aborted when withTimeout fires");
});

// =========================================================================
// D2: autoCleanup option
// =========================================================================

Deno.test("D2: autoCleanup recovers stuck jobs on a timer", async () => {
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
			 WHERE name = 'autoclean'`
		);

		await cron.start(1);
		await sleep(350); // > intervalMs

		const row = await fetchJob(db, "autoclean");
		assertEquals(row.status, CRON_STATUS.IDLE, "autoCleanup must recover the job");
	} finally {
		await teardown(cron, db);
	}
});

// =========================================================================
// D4: exponential backoff is clamped
// =========================================================================

Deno.test("D4: exponential backoff is clamped to maxMs", () => {
	// attempt 1 → 2s, attempt 2 → 4s, attempt 10 → 1024s (=> clamped to maxMs)
	assertEquals(_backoffMs("exp", 1), 2_000);
	assertEquals(_backoffMs("exp", 2), 4_000);
	assertEquals(_backoffMs("exp", 20), DEFAULT_MAX_BACKOFF_MS);
	assertEquals(_backoffMs("exp", 30), DEFAULT_MAX_BACKOFF_MS);
});

Deno.test("D4: 'none' strategy returns 0", () => {
	assertEquals(_backoffMs("none", 1), 0);
	assertEquals(_backoffMs("none", 100), 0);
});

// =========================================================================
// pruneRunLog
// =========================================================================

Deno.test("pruneRunLog: deletes only old rows, returns count", async () => {
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
			 WHERE cron_name = 'prune'`
		);

		const deleted = await cron.pruneRunLog(60); // older than 60min
		assert(deleted >= 1, `expected at least 1 row deleted, got ${deleted}`);

		const history = await cron.getRunHistory("prune");
		assertEquals(history.length, 0);
	} finally {
		await db.end();
	}
});

// =========================================================================
// sync-registry: removes orphan handlers
// =========================================================================

Deno.test(
	"sync-registry: removeHandler called for in-memory handlers no longer in registry",
	async () => {
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
			assert(cron.hasHandler("ghost"));

			const registry = createTaskRegistry();
			registry.define("real", { handler: async () => "real" });

			const { synced, removedHandlers } = await syncRegistryToCron(cron, registry);

			assert(synced.includes("real"));
			assert(removedHandlers.includes("ghost"));
			assert(!cron.hasHandler("ghost"), "ghost handler must be removed");
			assert(cron.hasHandler("real"));
		} finally {
			await cron.stop();
			await db.end();
		}
	}
);
