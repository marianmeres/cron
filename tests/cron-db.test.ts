/**
 * Integration tests for the PostgreSQL-backed Cron scheduler.
 *
 * Requires a live PostgreSQL database. Configure via environment variables:
 *   TEST_PG_HOST, TEST_PG_DATABASE, TEST_PG_USER, TEST_PG_PASSWORD, TEST_PG_PORT
 *
 * Run: deno test -A --env-file tests/cron-db.test.ts
 */

import { assertEquals, assert, assertRejects } from "@std/assert";
import { Cron, CRON_STATUS, RUN_STATUS } from "../src/mod.ts";
import { sleep } from "../src/cron/utils/sleep.ts";
import { createPg } from "./_pg.ts";

// ---- test helpers -------------------------------------------------------

const TABLE_PREFIX = "_test_";
const POLL = 50; // fast polling for tests (ms)

/** Silent logger — keeps test output clean */
const noopLogger = {
	debug: () => {},
	info: () => {},
	log: () => {},
	warn: () => {},
	error: () => {},
} as any;

function createCron(db: any) {
	return new Cron({
		db,
		tablePrefix: TABLE_PREFIX,
		pollTimeoutMs: POLL,
		gracefulSigterm: false,
		logger: noopLogger,
	});
}

/** Helper: force a job's next_run_at into the past so the poller picks it up */
async function backdateNextRun(db: any, name: string, msAgo = 100) {
	await db.query(
		`UPDATE ${TABLE_PREFIX}__cron
		 SET next_run_at = NOW() - ($1 * INTERVAL '1 millisecond')
		 WHERE name = $2`,
		[msAgo, name]
	);
}

/** Helper: fetch fresh row from DB */
async function fetchJob(db: any, name: string) {
	const { rows } = await db.query(
		`SELECT * FROM ${TABLE_PREFIX}__cron WHERE name = $1`,
		[name]
	);
	return rows[0];
}

// ---- setup / teardown per test ------------------------------------------

async function setup() {
	const db = createPg();
	const cron = createCron(db);
	await cron.resetHard();
	return { db, cron };
}

async function teardown(cron: Cron, db: any) {
	cron.unsubscribeAll();
	await cron.stop();
	await db.end();
}

// =========================================================================
// Tests
// =========================================================================

Deno.test("1 schema-init-idempotent", async () => {
	const { db, cron } = await setup();
	try {
		// Calling resetHard() twice should not throw
		await cron.resetHard();
	} finally {
		await teardown(cron, db);
	}
});

// -------------------------------------------------------------------------

Deno.test("2 register-creates-row", async () => {
	const { db, cron } = await setup();
	try {
		const job = await cron.register("greet", "* * * * *", async () => "hi");

		assertEquals(job.name, "greet");
		assertEquals(job.expression, "* * * * *");
		assertEquals(job.status, CRON_STATUS.IDLE);
		assertEquals(job.enabled, true);
		assertEquals(job.last_run_status, null);
		assert(job.next_run_at > new Date(), "next_run_at must be in the future");
	} finally {
		await teardown(cron, db);
	}
});

// -------------------------------------------------------------------------

Deno.test("3 register-upsert-keeps-next-run-at", async () => {
	const { db, cron } = await setup();
	try {
		const original = await cron.register("greet", "* * * * *", async () => "v1");
		const originalNextRun = original.next_run_at;

		// Re-register with a different expression
		const updated = await cron.register("greet", "0 * * * *", async () => "v2");

		assertEquals(updated.expression, "0 * * * *");
		// next_run_at must NOT have been reset
		assertEquals(
			updated.next_run_at.toISOString(),
			originalNextRun.toISOString(),
			"next_run_at should not change on upsert"
		);
	} finally {
		await teardown(cron, db);
	}
});

// -------------------------------------------------------------------------

Deno.test("4 register-invalid-expression-throws", async () => {
	const { db, cron } = await setup();
	try {
		await assertRejects(
			() => cron.register("bad", "not a valid expression", async () => {}),
			Error
		);
	} finally {
		await teardown(cron, db);
	}
});

// -------------------------------------------------------------------------

Deno.test("5 happy-flow", async () => {
	const { db, cron } = await setup();
	try {
		let called = false;
		await cron.register("job", "* * * * *", async () => {
			called = true;
			return { ok: true };
		});

		await backdateNextRun(db, "job");
		await cron.start(1);
		await sleep(300);

		const row = await fetchJob(db, "job");
		assert(called, "handler must have been called");
		assertEquals(row.last_run_status, RUN_STATUS.SUCCESS);
		assert(row.next_run_at > new Date(), "next_run_at must be in the future");
	} finally {
		await teardown(cron, db);
	}
});

// -------------------------------------------------------------------------

Deno.test("6 drift-prevention", async () => {
	// Proof: after execution, next_run_at is computed from the SCHEDULED time,
	// not the wall clock. With a 10-minute backdate and a 1-minute interval:
	//   drift-safe:   next_run_at = scheduled + 1min = 9 min ago (still in the past)
	//   drift-UNSAFE: next_run_at = NOW() + 1min         (in the future)
	//
	// The handler sleeps 200ms so stop() waits for it — guaranteeing exactly 1 run
	// and no leaked timers. Only 1 run can happen in the 100ms window before stop().
	const { db, cron } = await setup();
	try {
		await cron.register("precise", "* * * * *", async () => {
			await sleep(200); // slow enough that only 1 run fits before stop()
			return "ok";
		});

		// Backdate by 10 minutes — far enough that drift-safe result is still in the past
		const scheduledAt = new Date();
		scheduledAt.setMinutes(scheduledAt.getMinutes() - 10);
		scheduledAt.setSeconds(0, 0);
		scheduledAt.setMilliseconds(0);

		await db.query(
			`UPDATE ${TABLE_PREFIX}__cron SET next_run_at = $1 WHERE name = 'precise'`,
			[scheduledAt]
		);

		await cron.start(1);
		await sleep(100); // let the poller claim and start the job (poll=50ms)
		await cron.stop(); // waits for the 200ms handler to finish → exactly 1 run

		const after = await fetchJob(db, "precise");
		assertEquals(after.last_run_status, RUN_STATUS.SUCCESS);

		// Drift-safe: next_run_at must still be in the past (~9 min ago)
		assert(
			new Date(after.next_run_at) < new Date(),
			`drift detected! next_run_at is in the future, meaning it was computed from NOW() not scheduledAt`
		);
	} finally {
		await db.end();
	}
});

// -------------------------------------------------------------------------

Deno.test("7 failure-with-retries-succeeds-on-third-attempt", async () => {
	const { db, cron } = await setup();
	try {
		let attempts = 0;
		await cron.register(
			"retry-job",
			"* * * * *",
			async () => {
				attempts++;
				if (attempts < 3) throw new Error(`fail attempt ${attempts}`);
				return { done: true };
			},
			{ max_attempts: 3 }
		);

		await backdateNextRun(db, "retry-job");
		await cron.start(1);
		await sleep(500);

		assertEquals(attempts, 3);
		const row = await fetchJob(db, "retry-job");
		assertEquals(row.last_run_status, RUN_STATUS.SUCCESS);

		// Run log should have 3 entries
		const history = await cron.getRunHistory("retry-job");
		assertEquals(history.length, 3);
	} finally {
		await teardown(cron, db);
	}
});

// -------------------------------------------------------------------------

Deno.test("8 max-attempts-exceeded-advances-schedule", async () => {
	const { db, cron } = await setup();
	try {
		let attempts = 0;
		await cron.register(
			"always-fail",
			"* * * * *",
			async () => {
				attempts++;
				throw new Error("always fails");
			},
			{ max_attempts: 2 }
		);

		await backdateNextRun(db, "always-fail");
		await cron.start(1);
		await sleep(400);

		assertEquals(attempts, 2);
		const row = await fetchJob(db, "always-fail");
		assertEquals(row.last_run_status, RUN_STATUS.ERROR);
		assertEquals(row.status, CRON_STATUS.IDLE, "job must return to idle");
		assert(row.next_run_at > new Date(), "next_run_at must still advance");

		const history = await cron.getRunHistory("always-fail");
		assertEquals(history.length, 2);
	} finally {
		await teardown(cron, db);
	}
});

// -------------------------------------------------------------------------

Deno.test("9 timeout-enforcement", async () => {
	// The handler sleeps 500ms but is killed by TimeoutError at 50ms.
	// The handler's sleep(500) timer is abandoned — it fires at ~500ms.
	// We wait 700ms total so the timer fires during this test (not after),
	// avoiding a "timer started here but completed in next test" leak.
	const { db, cron } = await setup();
	try {
		await cron.register(
			"slow-job",
			"* * * * *",
			async () => {
				await sleep(500); // will be killed at 50ms; timer resolves at ~500ms
				return "done";
			},
			{ max_attempt_duration_ms: 50 }
		);

		await backdateNextRun(db, "slow-job");
		await cron.start(1);
		await sleep(700); // > 500ms: ensures abandoned sleep(500) fires during this test
		await cron.stop();

		const row = await fetchJob(db, "slow-job");
		assertEquals(row.last_run_status, RUN_STATUS.TIMEOUT);
		assertEquals(row.status, CRON_STATUS.IDLE);
	} finally {
		await db.end();
	}
});

// -------------------------------------------------------------------------

Deno.test("10 disabled-jobs-not-polled", async () => {
	const { db, cron } = await setup();
	try {
		let called = false;
		await cron.register("quiet", "* * * * *", async () => {
			called = true;
		});

		await cron.disable("quiet");
		await backdateNextRun(db, "quiet");
		await cron.start(1);
		await sleep(200);

		assert(!called, "handler must NOT be called for disabled job");
		const row = await fetchJob(db, "quiet");
		assertEquals(row.enabled, false);
	} finally {
		await teardown(cron, db);
	}
});

// -------------------------------------------------------------------------

Deno.test("11 enable-disable-toggle", async () => {
	const { db, cron } = await setup();
	try {
		await cron.register("toggle", "* * * * *", async () => {});

		const disabled = await cron.disable("toggle");
		assertEquals(disabled.enabled, false);

		const enabled = await cron.enable("toggle");
		assertEquals(enabled.enabled, true);
	} finally {
		await teardown(cron, db);
	}
});

// -------------------------------------------------------------------------

Deno.test("12 concurrent-no-double-execution", async () => {
	const db = createPg();
	const cron1 = createCron(db);
	await cron1.resetHard();

	let callCount = 0;
	const handler = async () => {
		callCount++;
		await sleep(50);
		return { done: true };
	};

	const cron2 = createCron(db);

	try {
		await cron1.register("shared", "* * * * *", handler);
		await backdateNextRun(db, "shared");

		cron2.setHandler("shared", handler);

		await cron1.start(1);
		await cron2.start(1);
		await sleep(400);

		assertEquals(callCount, 1, "job must execute exactly once");
	} finally {
		cron1.unsubscribeAll();
		await cron1.stop();
		await cron2.stop();
		await db.end();
	}
});

// -------------------------------------------------------------------------

Deno.test("13 onDone-fires-on-success", async () => {
	const { db, cron } = await setup();
	try {
		await cron.register("notify", "* * * * *", async () => ({ result: 42 }));

		let doneJob: any = null;
		cron.onDone("notify", (job) => {
			doneJob = job;
		});

		await backdateNextRun(db, "notify");
		await cron.start(1);
		await sleep(300);

		assert(doneJob !== null, "onDone callback must fire");
		assertEquals(doneJob.last_run_status, RUN_STATUS.SUCCESS);
		assertEquals(doneJob.name, "notify");
	} finally {
		await teardown(cron, db);
	}
});

// -------------------------------------------------------------------------

Deno.test("14 onError-fires-on-failure", async () => {
	const { db, cron } = await setup();
	try {
		await cron.register("broken", "* * * * *", async () => {
			throw new Error("intentional");
		});

		let errorJob: any = null;
		cron.onError("broken", (job) => {
			errorJob = job;
		});

		await backdateNextRun(db, "broken");
		await cron.start(1);
		await sleep(300);

		assert(errorJob !== null, "onError callback must fire");
		assertEquals(errorJob.last_run_status, RUN_STATUS.ERROR);
	} finally {
		await teardown(cron, db);
	}
});

// -------------------------------------------------------------------------

Deno.test("15 getRunHistory-returns-logs", async () => {
	const { db, cron } = await setup();
	try {
		let runs = 0;
		await cron.register("history", "* * * * *", async () => ++runs);
		await cron.start(1);

		// First run
		await backdateNextRun(db, "history");
		await sleep(200);

		// Second run
		await backdateNextRun(db, "history");
		await sleep(200);

		const history = await cron.getRunHistory("history");
		assert(history.length >= 2, "must have at least 2 run log entries");
		// Newest first
		assert(
			new Date(history[0].started_at) >= new Date(history[1].started_at),
			"run log must be ordered newest first"
		);
	} finally {
		await teardown(cron, db);
	}
});

// -------------------------------------------------------------------------

Deno.test("16 cleanup-reclaims-stale-running-jobs", async () => {
	const { db, cron } = await setup();
	try {
		await cron.register("stuck", "* * * * *", async () => {});

		// Manually put job into running state with an old last_run_at
		await db.query(
			`UPDATE ${TABLE_PREFIX}__cron
			 SET status = 'running',
			     last_run_at = NOW() - INTERVAL '10 minutes'
			 WHERE name = 'stuck'`
		);

		const before = await fetchJob(db, "stuck");
		assertEquals(before.status, "running");

		await cron.cleanup(5); // 5-minute threshold

		const after = await fetchJob(db, "stuck");
		assertEquals(after.status, CRON_STATUS.IDLE, "stale job must be reset to idle");
	} finally {
		await teardown(cron, db);
	}
});

// -------------------------------------------------------------------------

Deno.test("17 unregister-removes-job", async () => {
	const { db, cron } = await setup();
	try {
		await cron.register("temp", "* * * * *", async () => {});

		const before = await cron.find("temp");
		assert(before !== null, "job must exist before unregister");

		await cron.unregister("temp");

		const after = await cron.find("temp");
		assertEquals(after, null, "job must be gone after unregister");
		assert(!cron.hasHandler("temp"), "in-memory handler must also be removed");
	} finally {
		await teardown(cron, db);
	}
});

// -------------------------------------------------------------------------

Deno.test("18 healthPreview-returns-stats", async () => {
	const { db, cron } = await setup();
	try {
		await cron.register("stats", "* * * * *", async () => "ok");
		await backdateNextRun(db, "stats");
		await cron.start(1);
		await sleep(300);

		const preview = await cron.healthPreview(60);
		assert(Array.isArray(preview), "healthPreview must return an array");

		const successRow = preview.find((r) => r.status === RUN_STATUS.SUCCESS);
		assert(successRow !== undefined, "must have a success stats row");
		assert(parseInt(successRow.count) >= 1, "count must be at least 1");
	} finally {
		await teardown(cron, db);
	}
});

// -------------------------------------------------------------------------

Deno.test("19 resetHard-clears-all-jobs", async () => {
	const { db, cron } = await setup();
	try {
		await cron.register("to-be-cleared", "* * * * *", async () => {});

		const before = await cron.fetchAll();
		assertEquals(before.length, 1);

		await cron.resetHard();

		const after = await cron.fetchAll();
		assertEquals(after.length, 0);
	} finally {
		await teardown(cron, db);
	}
});

// -------------------------------------------------------------------------

Deno.test("20 graceful-shutdown-waits-for-active-jobs", async () => {
	const { db, cron } = await setup();
	try {
		let completed = false;
		await cron.register("long-job", "* * * * *", async () => {
			await sleep(200);
			completed = true;
			return "done";
		});

		await backdateNextRun(db, "long-job");
		await cron.start(1);

		// Give the poller time to claim the job
		await sleep(100);

		// Stop before the handler finishes — stop() must wait
		await cron.stop();

		assert(completed, "job must complete before stop() returns");
	} finally {
		await db.end();
	}
});
