/**
 * Integration tests for the PostgreSQL-backed Cron scheduler.
 *
 * Requires a live PostgreSQL database. Configure via environment variables:
 *   TEST_PG_HOST, TEST_PG_DATABASE, TEST_PG_USER, TEST_PG_PASSWORD, TEST_PG_PORT
 *
 * Run: deno test -A --env-file tests/cron-db.test.ts
 */

import { assertEquals, assert, assertRejects } from "@std/assert";
import {
	Cron,
	CRON_STATUS,
	DEFAULT_TENANT_ID,
	RUN_STATUS,
	type CronJob,
} from "../src/mod.ts";
import { sleep } from "../src/cron/utils/sleep.ts";
import { createPg } from "./_pg.ts";
import type pg from "pg";
import type { Logger } from "@marianmeres/clog";

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
} as Logger;

function createCron(db: pg.Pool) {
	return new Cron({
		db,
		tablePrefix: TABLE_PREFIX,
		pollTimeoutMs: POLL,
		gracefulSigterm: false,
		logger: noopLogger,
	});
}

/** Helper: force a job's next_run_at into the past so the poller picks it up */
async function backdateNextRun(db: pg.Pool, name: string, msAgo = 100) {
	await db.query(
		`UPDATE ${TABLE_PREFIX}__cron
		 SET next_run_at = NOW() - ($1 * INTERVAL '1 millisecond')
		 WHERE name = $2`,
		[msAgo, name]
	);
}

/** Helper: fetch fresh row from DB */
async function fetchJob(db: pg.Pool, name: string) {
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

async function teardown(cron: Cron, db: pg.Pool) {
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

		let doneJob: CronJob | null = null;
		cron.onDone("notify", (job) => {
			doneJob = job;
		});

		await backdateNextRun(db, "notify");
		await cron.start(1);
		await sleep(300);

		assert(doneJob !== null, "onDone callback must fire");
		assertEquals((doneJob as CronJob).last_run_status, RUN_STATUS.SUCCESS);
		assertEquals((doneJob as CronJob).name, "notify");
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

		let errorJob: CronJob | null = null;
		cron.onError("broken", (job) => {
			errorJob = job;
		});

		await backdateNextRun(db, "broken");
		await cron.start(1);
		await sleep(300);

		assert(errorJob !== null, "onError callback must fire");
		assertEquals((errorJob as CronJob).last_run_status, RUN_STATUS.ERROR);
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
		assert(parseInt(`${successRow!.count}`) >= 1, "count must be at least 1");
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

// =========================================================================
// tenant_id scoping tests
// =========================================================================

function createCronWithTenant(db: pg.Pool, tenantId: string) {
	return new Cron({
		db,
		tablePrefix: TABLE_PREFIX,
		pollTimeoutMs: POLL,
		gracefulSigterm: false,
		logger: noopLogger,
		tenantId,
	});
}

Deno.test("21 tenant_id-defaults-to-_default", async () => {
	const { db, cron } = await setup();
	try {
		const job = await cron.register("greet", "* * * * *", async () => "hi");
		assertEquals(job.tenant_id, DEFAULT_TENANT_ID);
	} finally {
		await teardown(cron, db);
	}
});

// -------------------------------------------------------------------------

Deno.test("22 tenant_id-same-name-different-tenants", async () => {
	const db = createPg();
	const cronA = createCronWithTenant(db, "tenant-a");
	await cronA.resetHard();

	const cronB = createCronWithTenant(db, "tenant-b");

	try {
		const jobA = await cronA.register(
			"report",
			"* * * * *",
			async () => "a"
		);
		const jobB = await cronB.register(
			"report",
			"0 * * * *",
			async () => "b"
		);

		assertEquals(jobA.tenant_id, "tenant-a");
		assertEquals(jobB.tenant_id, "tenant-b");
		assertEquals(jobA.name, jobB.name);

		// Each instance sees only its own job
		const allA = await cronA.fetchAll();
		const allB = await cronB.fetchAll();
		assertEquals(allA.length, 1);
		assertEquals(allB.length, 1);
		assertEquals(allA[0].tenant_id, "tenant-a");
		assertEquals(allB[0].tenant_id, "tenant-b");
	} finally {
		await cronA.stop();
		await cronB.stop();
		await db.end();
	}
});

// -------------------------------------------------------------------------

Deno.test("23 tenant_id-find-is-scoped", async () => {
	const db = createPg();
	const cronA = createCronWithTenant(db, "tenant-a");
	await cronA.resetHard();

	const cronB = createCronWithTenant(db, "tenant-b");

	try {
		await cronA.register("shared-name", "* * * * *", async () => "a");
		await cronB.register("shared-name", "* * * * *", async () => "b");

		const foundA = await cronA.find("shared-name");
		const foundB = await cronB.find("shared-name");

		assert(foundA !== null);
		assert(foundB !== null);
		assertEquals(foundA!.tenant_id, "tenant-a");
		assertEquals(foundB!.tenant_id, "tenant-b");
	} finally {
		await cronA.stop();
		await cronB.stop();
		await db.end();
	}
});

// -------------------------------------------------------------------------

Deno.test("24 tenant_id-unregister-is-scoped", async () => {
	const db = createPg();
	const cronA = createCronWithTenant(db, "tenant-a");
	await cronA.resetHard();

	const cronB = createCronWithTenant(db, "tenant-b");

	try {
		await cronA.register("job", "* * * * *", async () => "a");
		await cronB.register("job", "* * * * *", async () => "b");

		await cronA.unregister("job");

		// A's job is gone, B's still exists
		const foundA = await cronA.find("job");
		const foundB = await cronB.find("job");
		assertEquals(foundA, null);
		assert(foundB !== null);
	} finally {
		await cronA.stop();
		await cronB.stop();
		await db.end();
	}
});

// -------------------------------------------------------------------------

Deno.test("25 tenant_id-enable-disable-is-scoped", async () => {
	const db = createPg();
	const cronA = createCronWithTenant(db, "tenant-a");
	await cronA.resetHard();

	const cronB = createCronWithTenant(db, "tenant-b");

	try {
		await cronA.register("job", "* * * * *", async () => "a");
		await cronB.register("job", "* * * * *", async () => "b");

		await cronA.disable("job");

		const jobA = await cronA.find("job");
		const jobB = await cronB.find("job");
		assertEquals(jobA!.enabled, false);
		assertEquals(jobB!.enabled, true, "tenant-b's job must remain enabled");
	} finally {
		await cronA.stop();
		await cronB.stop();
		await db.end();
	}
});

// -------------------------------------------------------------------------

Deno.test("26 single-start-serves-multiple-tenants", async () => {
	const db = createPg();
	const cron = createCron(db);
	await cron.resetHard();

	const projA = cron.forTenant("tenant-a");
	const projB = cron.forTenant("tenant-b");

	try {
		let calledA = false;
		let calledB = false;
		await projA.register("job", "* * * * *", async () => {
			calledA = true;
		});
		await projB.register("job", "* * * * *", async () => {
			calledB = true;
		});

		// Backdate both jobs
		await db.query(
			`UPDATE ${TABLE_PREFIX}__cron
			 SET next_run_at = NOW() - INTERVAL '1 second'
			 WHERE name = 'job'`
		);

		// Single start() processes both tenants
		await cron.start(1);
		await sleep(400);

		assert(calledA, "tenant-a handler must have been called");
		assert(calledB, "tenant-b handler must have been called");
	} finally {
		cron.unsubscribeAll();
		await cron.stop();
		await db.end();
	}
});

// -------------------------------------------------------------------------

Deno.test("27 forTenant-management-is-isolated", async () => {
	const db = createPg();
	const cron = createCron(db);
	await cron.resetHard();

	const projA = cron.forTenant("tenant-a");
	const projB = cron.forTenant("tenant-b");

	try {
		await projA.register("report", "* * * * *", async () => "a");
		await projB.register("report", "0 * * * *", async () => "b");
		await projB.register("extra", "* * * * *", async () => "x");

		// fetchAll is scoped
		const allA = await projA.fetchAll();
		const allB = await projB.fetchAll();
		assertEquals(allA.length, 1);
		assertEquals(allB.length, 2);
		assertEquals(allA[0].tenant_id, "tenant-a");

		// find is scoped
		const foundA = await projA.find("report");
		const foundB = await projB.find("report");
		assert(foundA !== null);
		assert(foundB !== null);
		assertEquals(foundA!.expression, "* * * * *");
		assertEquals(foundB!.expression, "0 * * * *");

		// unregister is scoped
		await projA.unregister("report");
		assertEquals(await projA.find("report"), null);
		assert((await projB.find("report")) !== null);
	} finally {
		await cron.stop();
		await db.end();
	}
});

// -------------------------------------------------------------------------

Deno.test("28 forTenant-event-isolation", async () => {
	const db = createPg();
	const cron = createCron(db);
	await cron.resetHard();

	const projA = cron.forTenant("tenant-a");
	const projB = cron.forTenant("tenant-b");

	try {
		await projA.register("job", "* * * * *", async () => "a");
		await projB.register("job", "* * * * *", async () => "b");

		let doneA: CronJob | null = null;
		let doneB: CronJob | null = null;
		projA.onDone("job", (job) => { doneA = job; });
		projB.onDone("job", (job) => { doneB = job; });

		// Only backdate tenant-a
		await db.query(
			`UPDATE ${TABLE_PREFIX}__cron
			 SET next_run_at = NOW() - INTERVAL '1 second'
			 WHERE tenant_id = 'tenant-a' AND name = 'job'`
		);

		await cron.start(1);
		await sleep(300);

		assert(doneA !== null, "projA onDone must fire");
		assertEquals((doneA as CronJob).tenant_id, "tenant-a");
		assertEquals(doneB, null, "projB onDone must NOT fire (its job was not due)");
	} finally {
		cron.unsubscribeAll();
		await cron.stop();
		await db.end();
	}
});

// -------------------------------------------------------------------------

Deno.test("29 global-cleanup-recovers-all-tenants", async () => {
	const db = createPg();
	const cron = createCron(db);
	await cron.resetHard();

	const projA = cron.forTenant("tenant-a");
	const projB = cron.forTenant("tenant-b");

	try {
		await projA.register("stuck", "* * * * *", async () => {});
		await projB.register("stuck", "* * * * *", async () => {});

		// Put both jobs into stale running state
		await db.query(
			`UPDATE ${TABLE_PREFIX}__cron
			 SET status = 'running',
			     last_run_at = NOW() - INTERVAL '10 minutes'
			 WHERE name = 'stuck'`
		);

		// Global cleanup on the Cron instance recovers all
		await cron.cleanup(5);

		const jobA = await projA.find("stuck");
		const jobB = await projB.find("stuck");
		assertEquals(jobA!.status, CRON_STATUS.IDLE);
		assertEquals(jobB!.status, CRON_STATUS.IDLE);
	} finally {
		await cron.stop();
		await db.end();
	}
});

// -------------------------------------------------------------------------

Deno.test("30 scoped-cleanup-recovers-only-own-tenant", async () => {
	const db = createPg();
	const cron = createCron(db);
	await cron.resetHard();

	const projA = cron.forTenant("tenant-a");
	const projB = cron.forTenant("tenant-b");

	try {
		await projA.register("stuck", "* * * * *", async () => {});
		await projB.register("stuck", "* * * * *", async () => {});

		// Put both jobs into stale running state
		await db.query(
			`UPDATE ${TABLE_PREFIX}__cron
			 SET status = 'running',
			     last_run_at = NOW() - INTERVAL '10 minutes'
			 WHERE name = 'stuck'`
		);

		// Scoped cleanup on projA only recovers tenant-a
		await projA.cleanup(5);

		const jobA = await projA.find("stuck");
		const jobB = await projB.find("stuck");
		assertEquals(jobA!.status, CRON_STATUS.IDLE, "tenant-a must be recovered");
		assertEquals(jobB!.status, "running", "tenant-b must still be stuck");
	} finally {
		await cron.stop();
		await db.end();
	}
});

// -------------------------------------------------------------------------

Deno.test("31 forTenant-correct-handler-per-tenant", async () => {
	const db = createPg();
	const cron = createCron(db);
	await cron.resetHard();

	const projA = cron.forTenant("tenant-a");
	const projB = cron.forTenant("tenant-b");

	try {
		let resultA = "";
		let resultB = "";
		await projA.register("job", "* * * * *", async () => {
			resultA = "handler-a";
		});
		await projB.register("job", "* * * * *", async () => {
			resultB = "handler-b";
		});

		// Only backdate tenant-a's job
		await db.query(
			`UPDATE ${TABLE_PREFIX}__cron
			 SET next_run_at = NOW() - INTERVAL '1 second'
			 WHERE tenant_id = 'tenant-a' AND name = 'job'`
		);

		await cron.start(1);
		await sleep(300);

		assertEquals(resultA, "handler-a", "tenant-a's handler must run");
		assertEquals(resultB, "", "tenant-b's handler must NOT run (not due)");
	} finally {
		cron.unsubscribeAll();
		await cron.stop();
		await db.end();
	}
});

// -------------------------------------------------------------------------

// Legacy migration: pre-2.x schemas used a `project_id` column. `Cron.migrate()`
// must rename it (and its indexes) to `tenant_id` in place, preserving data,
// and be idempotent.
Deno.test("32 migrate-renames-legacy-project_id-to-tenant_id", async () => {
	const db = createPg();
	const cron = `${TABLE_PREFIX}__cron`;
	const runLog = `${TABLE_PREFIX}__cron_run_log`;
	const safe = (n: string) => n.replace(/\W/g, "");
	const sc = safe(cron);
	const sr = safe(runLog);

	const cols = async (table: string): Promise<string[]> => {
		const { rows } = await db.query(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_name = $1 AND table_schema = 'public'`,
			[table]
		);
		return rows.map((r) => r.column_name as string);
	};
	const idxs = async (table: string): Promise<string[]> => {
		const { rows } = await db.query(
			`SELECT indexname FROM pg_indexes WHERE tablename = $1 AND schemaname = 'public'`,
			[table]
		);
		return rows.map((r) => r.indexname as string);
	};

	try {
		// Build a legacy-shaped schema with `project_id` + old index names.
		await db.query(`
			DROP TABLE IF EXISTS ${runLog};
			DROP TABLE IF EXISTS ${cron};
			CREATE TABLE ${cron} (
				id SERIAL PRIMARY KEY,
				uid UUID NOT NULL DEFAULT gen_random_uuid(),
				project_id VARCHAR(255) NOT NULL DEFAULT '_default',
				name VARCHAR(255) NOT NULL,
				expression VARCHAR(100) NOT NULL,
				timezone VARCHAR(64),
				payload JSONB NOT NULL DEFAULT '{}',
				enabled BOOLEAN NOT NULL DEFAULT TRUE,
				status VARCHAR(20) NOT NULL DEFAULT 'idle',
				next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				last_run_at TIMESTAMPTZ,
				last_run_status VARCHAR(20),
				lease_token UUID,
				max_attempts INTEGER NOT NULL DEFAULT 1,
				max_attempt_duration_ms INTEGER NOT NULL DEFAULT 0,
				backoff_strategy VARCHAR(20) NOT NULL DEFAULT 'none',
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);
			CREATE UNIQUE INDEX idx_${sc}_project_name ON ${cron}(project_id, name);
			CREATE INDEX idx_${sc}_next_run_at ON ${cron}(enabled, status, next_run_at);
			CREATE TABLE ${runLog} (
				id SERIAL PRIMARY KEY,
				cron_id INTEGER NOT NULL,
				cron_name VARCHAR(255) NOT NULL,
				project_id VARCHAR(255) NOT NULL DEFAULT '_default',
				scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				completed_at TIMESTAMPTZ,
				attempt_number INTEGER NOT NULL DEFAULT 1,
				status VARCHAR(20),
				result JSONB,
				error_message TEXT,
				error_details JSONB
			);
			CREATE INDEX idx_${sr}_cron_id ON ${runLog}(cron_id);
			CREATE INDEX idx_${sr}_project_id ON ${runLog}(project_id);
		`);
		await db.query(
			`INSERT INTO ${cron} (project_id, name, expression) VALUES ('acme', 'job', '* * * * *')`
		);

		await Cron.migrate(db, TABLE_PREFIX);

		// Column renamed, data preserved
		const cronCols = await cols(cron);
		assert(cronCols.includes("tenant_id"), "__cron must have tenant_id");
		assert(!cronCols.includes("project_id"), "__cron must not have project_id");
		const runCols = await cols(runLog);
		assert(runCols.includes("tenant_id"), "run log must have tenant_id");
		assert(!runCols.includes("project_id"), "run log must not have project_id");

		const { rows } = await db.query(
			`SELECT tenant_id FROM ${cron} WHERE name = 'job'`
		);
		assertEquals(rows[0]?.tenant_id, "acme", "data must be preserved across rename");

		// Indexes renamed
		const cronIdx = await idxs(cron);
		assert(cronIdx.includes(`idx_${sc}_tenant_name`), "unique index renamed to tenant_name");
		assert(!cronIdx.includes(`idx_${sc}_project_name`), "old project_name index gone");
		const runIdx = await idxs(runLog);
		assert(runIdx.includes(`idx_${sr}_tenant_id`), "run log index renamed to tenant_id");
		assert(!runIdx.includes(`idx_${sr}_project_id`), "old project_id index gone");

		// Idempotent — a second migrate() must not throw or regress
		await Cron.migrate(db, TABLE_PREFIX);
		const cronCols2 = await cols(cron);
		assert(cronCols2.includes("tenant_id") && !cronCols2.includes("project_id"));
	} finally {
		await db.query(`DROP TABLE IF EXISTS ${runLog}; DROP TABLE IF EXISTS ${cron};`);
		await db.end();
	}
});

// -------------------------------------------------------------------------

// Regression: a mixed-case `tablePrefix` must still trigger the legacy rename.
// Postgres folds unquoted identifiers to lower case, so the `information_schema`
// guard in migrate() must compare against lower-cased names — otherwise the
// rename silently no-ops and strands data in the old `project_id` column.
Deno.test("33 migrate-legacy-rename-with-mixed-case-prefix", async () => {
	const db = createPg();
	const PREFIX = "MixCase_"; // mixed-case NAME prefix (no schema needed)
	const cron = `${PREFIX}__cron`;
	const runLog = `${PREFIX}__cron_run_log`;
	const safe = (n: string) => n.replace(/\W/g, "");
	const sc = safe(cron);
	const sr = safe(runLog);

	const cols = async (tableLower: string): Promise<string[]> => {
		const { rows } = await db.query(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_name = $1 AND table_schema = 'public'`,
			[tableLower.toLowerCase()]
		);
		return rows.map((r) => r.column_name as string);
	};

	try {
		await db.query(`
			DROP TABLE IF EXISTS ${runLog};
			DROP TABLE IF EXISTS ${cron};
			CREATE TABLE ${cron} (
				id SERIAL PRIMARY KEY,
				project_id VARCHAR(255) NOT NULL DEFAULT '_default',
				name VARCHAR(255) NOT NULL,
				expression VARCHAR(100) NOT NULL,
				enabled BOOLEAN NOT NULL DEFAULT TRUE,
				status VARCHAR(20) NOT NULL DEFAULT 'idle',
				next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				last_run_status VARCHAR(20),
				max_attempts INTEGER NOT NULL DEFAULT 1,
				max_attempt_duration_ms INTEGER NOT NULL DEFAULT 0
			);
			CREATE UNIQUE INDEX idx_${sc}_project_name ON ${cron}(project_id, name);
			CREATE INDEX idx_${sc}_next_run_at ON ${cron}(enabled, status, next_run_at);
			CREATE TABLE ${runLog} (
				id SERIAL PRIMARY KEY,
				cron_id INTEGER NOT NULL,
				project_id VARCHAR(255) NOT NULL DEFAULT '_default',
				status VARCHAR(20),
				attempt_number INTEGER NOT NULL DEFAULT 1
			);
			CREATE INDEX idx_${sr}_project_id ON ${runLog}(project_id);
		`);
		await db.query(
			`INSERT INTO ${cron} (project_id, name, expression) VALUES ('acme', 'job', '* * * * *')`
		);

		await Cron.migrate(db, PREFIX);

		const cronCols = await cols(cron);
		assert(cronCols.includes("tenant_id"), "tenant_id must exist after migrate");
		assert(
			!cronCols.includes("project_id"),
			"legacy project_id must be renamed (not left stranded) for a mixed-case prefix"
		);
		const { rows } = await db.query(`SELECT tenant_id FROM ${cron} WHERE name = 'job'`);
		assertEquals(rows[0]?.tenant_id, "acme", "data preserved across the case-sensitive rename");
	} finally {
		await db.query(`DROP TABLE IF EXISTS ${runLog}; DROP TABLE IF EXISTS ${cron};`);
		await db.end();
	}
});
