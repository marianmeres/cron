/**
 * Regression tests for the second review round. One block per finding:
 *
 * - R1:  the job's timezone is honoured when rescheduling after a run
 * - R2:  run-log rows carry the job's tenant (+ migrate() repairs old rows)
 * - R3:  missed ticks are skipped, not replayed; enable() resumes at the next slot
 * - R4:  start() rejects instead of swallowing; drain-capped stop() leaves a
 *        restartable instance and no resurrected processor
 * - R5:  shutdown during a retry backoff abandons the remaining attempts
 * - R6:  a failure to RECORD a run is not a handler failure; dbRetry covers it
 * - R7:  a single pg.Client is limited to one processor
 * - R8:  heartbeat keeps long-running jobs from being stale-recovered
 * - R9:  healthPreview returns numbers
 * - R10: onDone/onError wrap tracking is exact for names without a handler
 * - R11: SIGTERM listener follows start()/stop(), including a restart
 *
 * (The DB side of R3 — one run, then a future slot — is test 6 in cron-db.test.ts.)
 *
 * Requires a live PostgreSQL database (TEST_PG_*) just like cron-db.test.ts.
 *
 * Jobs that must run exactly once use a yearly expression plus a backdate, so a
 * minute boundary passing mid-test cannot trigger an extra run.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import process from "node:process";
import { Cron, CronParser, CRON_STATUS, RUN_STATUS, type CronJob } from "../src/mod.ts";
import { _nextRunAt } from "../src/cron/_next-run.ts";
import { sleep } from "../src/cron/utils/sleep.ts";
import { createPg, createPgClient } from "./_pg.ts";
import type pg from "pg";
import type { Logger } from "@marianmeres/clog";

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

function createCron(db: pg.Pool | pg.Client, opts: Record<string, unknown> = {}) {
	return new Cron({
		db,
		tablePrefix: TABLE_PREFIX,
		pollTimeoutMs: POLL,
		gracefulSigterm: false,
		logger: noopLogger,
		...opts,
	});
}

async function setup(opts: Record<string, unknown> = {}) {
	const db = createPg();
	const cron = createCron(db, opts);
	await cron.resetHard();
	return { db, cron };
}

async function teardown(cron: Cron, db: pg.Pool) {
	cron.unsubscribeAll();
	await cron.stop();
	await db.end();
}

async function backdate(db: pg.Pool | pg.Client, name: string, msAgo = 100) {
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

async function fetchRunLog(db: pg.Pool) {
	const { rows } = await db.query(
		`SELECT * FROM ${TABLE_PREFIX}__cron_run_log ORDER BY id`
	);
	return rows;
}

/**
 * Makes the next `n` transaction checkouts fail with a retryable error.
 *
 * `withTx` checks a connection out with a bare `pool.connect()`; `pool.query()`
 * goes through `pool.connect(callback)`. Only the former is sabotaged, so the
 * claim and run-log queries keep working while the result TX "loses its
 * connection".
 */
function failNextTxCheckouts(db: pg.Pool, n: number) {
	const original = db.connect.bind(db);
	let left = n;
	// deno-lint-ignore no-explicit-any
	(db as any).connect = (...args: unknown[]) => {
		if (args.length === 0 && left > 0) {
			left--;
			return Promise.reject(
				Object.assign(new Error("simulated connection reset"), { code: "ECONNRESET" })
			);
		}
		// deno-lint-ignore no-explicit-any
		return (original as any)(...args);
	};
}

// =========================================================================
// R1: timezone
// =========================================================================

Deno.test("R1: _nextRunAt evaluates the expression in the job's timezone", () => {
	// 09:00 in Kathmandu (UTC+5:45, no DST) is 03:15 UTC — whatever the host TZ is.
	const job = { expression: "0 9 * * *", timezone: "Asia/Kathmandu" };
	const scheduledAt = new Date("2026-01-10T03:15:00.000Z");
	const now = new Date("2026-01-10T03:15:30.000Z");

	assertEquals(
		_nextRunAt(job, scheduledAt, now).toISOString(),
		"2026-01-11T03:15:00.000Z"
	);
});

Deno.test("R1: the timezone survives rescheduling after a run", async () => {
	const { db, cron } = await setup();
	try {
		const tz = "Asia/Kathmandu";
		const registered = await cron.register("tz-job", "0 9 * * *", async () => "ok", {
			timezone: tz,
		});
		assertEquals(registered.timezone, tz);

		await backdate(db, "tz-job");
		await cron.start(1);
		await sleep(300);
		await cron.stop();

		const row = await fetchJob(db, "tz-job");
		assertEquals(row.last_run_status, RUN_STATUS.SUCCESS);

		const expected = new CronParser("0 9 * * *", { timezone: tz }).getNextRun();
		assertEquals(new Date(row.next_run_at).toISOString(), expected.toISOString());
		// 09:00 Kathmandu is always xx:15 UTC; host-local 09:00 would be xx:00 / xx:30
		assertEquals(new Date(row.next_run_at).getUTCMinutes(), 15);
	} finally {
		await db.end();
	}
});

// =========================================================================
// R2: run-log tenant
// =========================================================================

Deno.test("R2: run-log rows carry the job's tenant, not the instance's", async () => {
	const { db, cron } = await setup();
	try {
		const tenantA = cron.forTenant("tenant-a");
		await tenantA.register("job", YEARLY, async () => "ok");
		await backdate(db, "job");

		await cron.start(1);
		await sleep(300);
		await cron.stop();

		const log = await fetchRunLog(db);
		assertEquals(
			log.map((r) => r.tenant_id),
			["tenant-a"]
		);

		// Tenant-scoped views now see their own runs — and only their own
		const previewA = await tenantA.healthPreview(60);
		assertEquals(previewA.length, 1);
		assertEquals(previewA[0].status, RUN_STATUS.SUCCESS);
		assertEquals(await cron.healthPreview(60), [], "default tenant ran nothing");

		// …and a tenant-scoped prune reaches them
		await db.query(
			`UPDATE ${TABLE_PREFIX}__cron_run_log SET started_at = NOW() - INTERVAL '120 minutes'`
		);
		assertEquals(await cron.forTenant("tenant-b").pruneRunLog(60), 0);
		assertEquals(await tenantA.pruneRunLog(60), 1);
	} finally {
		await db.end();
	}
});

Deno.test("R2: migrate() re-stamps run-log rows logged under the wrong tenant", async () => {
	const { db, cron } = await setup();
	try {
		const job = await cron
			.forTenant("tenant-a")
			.register("job", YEARLY, async () => "ok");

		// What the affected releases wrote: the instance's tenant, not the job's
		await db.query(
			`INSERT INTO ${TABLE_PREFIX}__cron_run_log
				(cron_id, cron_name, tenant_id, scheduled_at, status)
			 VALUES ($1, 'job', '_default', NOW(), 'success')`,
			[job.id]
		);

		await Cron.migrate(db, TABLE_PREFIX);
		assertEquals((await fetchRunLog(db)).map((r) => r.tenant_id), ["tenant-a"]);

		// Idempotent
		await Cron.migrate(db, TABLE_PREFIX);
		assertEquals((await fetchRunLog(db)).map((r) => r.tenant_id), ["tenant-a"]);
	} finally {
		await db.end();
	}
});

// =========================================================================
// R3: missed ticks
// =========================================================================

Deno.test("R3: _nextRunAt skips missed ticks but stays schedule-relative", () => {
	const job = { expression: "* * * * *", timezone: "UTC" };
	const at = (hms: string) => new Date(`2026-01-10T${hms}Z`);
	const next = (scheduledAt: string, now: string) =>
		_nextRunAt(job, at(scheduledAt), at(now)).toISOString();

	// On time: the slot right after the scheduled one
	assertEquals(next("09:00:00.000", "09:00:20.000"), at("09:01:00.000").toISOString());

	// Ten ticks missed: resume at the first future slot, do not replay 09:01…09:10
	assertEquals(next("09:00:00.000", "09:10:30.000"), at("09:11:00.000").toISOString());

	// The run outlasted its own interval: the tick it overran is skipped
	assertEquals(next("09:00:00.000", "09:01:00.500"), at("09:02:00.000").toISOString());

	// A slot due exactly now is not "missed"
	assertEquals(next("09:00:00.000", "09:01:00.000"), at("09:01:00.000").toISOString());

	// Local clock BEHIND the database: deriving from `now` would re-issue 09:00,
	// the slot that has just run. Deriving from the schedule does not.
	assertEquals(next("09:00:00.000", "08:59:59.900"), at("09:01:00.000").toISOString());
});

Deno.test("R3: enable() resumes at the next slot instead of firing for a missed tick", async () => {
	const { db, cron } = await setup();
	try {
		let runs = 0;
		await cron.register("paused", YEARLY, async () => {
			runs++;
		});

		// The slot comes due while the job is disabled
		await cron.disable("paused");
		await backdate(db, "paused", 5 * 60_000);

		const enabled = await cron.enable("paused");
		assertEquals(enabled.enabled, true);
		assert(
			enabled.next_run_at > new Date(),
			"re-enabling must move a slot that passed while disabled into the future"
		);

		// Enabling an ALREADY enabled job that is merely due must not lose that run
		await backdate(db, "paused", 1_000);
		const again = await cron.enable("paused");
		assert(again.next_run_at < new Date(), "a due run of an enabled job must be kept");

		await cron.start(1);
		await sleep(250);
		assertEquals(runs, 1);
	} finally {
		await teardown(cron, db);
	}
});

// =========================================================================
// R4: start() / stop() lifecycle
// =========================================================================

Deno.test("R4: start() rejects when the schema cannot be initialised", async () => {
	const db = createPg();
	// CREATE TABLE in a schema that does not exist
	const cron = createCron(db, { tablePrefix: "no_such_schema_r4." });
	try {
		await assertRejects(() => cron.start(1));
	} finally {
		await cron.stop();
		await db.end();
	}
});

Deno.test("R4: start() rejects while a stop() is still draining", async () => {
	const { db, cron } = await setup();
	try {
		await cron.register("slow", YEARLY, async () => {
			await sleep(250);
		});
		await backdate(db, "slow");
		await cron.start(1);
		await sleep(100); // claimed, handler in flight

		const stopping = cron.stop();
		await assertRejects(() => cron.start(1), Error, "shutdown in progress");
		await stopping;

		// Fully usable again once drained
		await cron.start(1);
		await cron.stop();
	} finally {
		await db.end();
	}
});

Deno.test(
	"R4: after a drain-capped stop() the abandoned processor winds down and the instance restarts",
	async () => {
		const { db, cron } = await setup();
		const ref = { id: -1 };
		try {
			let otherRuns = 0;
			// Ignores its AbortSignal → outlives the drain cap
			await cron.register("stuck", YEARLY, async () => {
				await sleep(500, ref);
			});
			await cron.register("other", YEARLY, async () => {
				otherRuns++;
			});

			await backdate(db, "stuck");
			await cron.start(1);
			await sleep(150); // claimed, handler in flight

			await cron.stop({ drainTimeoutMs: 50 }); // cap hit → processor abandoned
			// A second stop() (an app's own SIGTERM handler, a test teardown, …) used
			// to reset the shutdown flag and revive the abandoned loop.
			await cron.stop();

			await backdate(db, "other");
			await sleep(600); // the stuck handler returns in here

			assertEquals(otherRuns, 0, "an abandoned processor must not claim new work");
			const stuck = await fetchJob(db, "stuck");
			assertEquals(stuck.status, CRON_STATUS.IDLE);
			assertEquals(
				stuck.last_run_status,
				RUN_STATUS.SUCCESS,
				"its own run must still be recorded"
			);

			// The instance is usable again
			await cron.start(1);
			await sleep(250);
			assertEquals(otherRuns, 1);
		} finally {
			clearTimeout(ref.id);
			await teardown(cron, db);
		}
	}
);

// =========================================================================
// R5: shutdown during backoff
// =========================================================================

Deno.test("R5: shutdown during a retry backoff abandons the remaining attempts", async () => {
	const { db, cron } = await setup();
	try {
		let calls = 0;
		await cron.register(
			"flaky",
			YEARLY,
			async () => {
				calls++;
				throw new Error("nope");
			},
			{ max_attempts: 3, backoff_strategy: "exp" } // first backoff: 2s
		);
		await backdate(db, "flaky");
		await cron.start(1);
		await sleep(200); // attempt 1 has failed; now inside the 2s backoff

		const started = Date.now();
		await cron.stop();
		assert(Date.now() - started < 1_000, "stop() must not wait out the backoff");

		assertEquals(calls, 1, "no further attempt may start once shutting down");

		const row = await fetchJob(db, "flaky");
		assertEquals(row.status, CRON_STATUS.IDLE);
		assertEquals(row.last_run_status, RUN_STATUS.ERROR);
		assertEquals((await fetchRunLog(db)).length, 1);
	} finally {
		await db.end();
	}
});

// =========================================================================
// R6: recording a run vs. running it
// =========================================================================

Deno.test("R6: dbRetry covers the result write — a succeeded handler is not re-run", async () => {
	const { db, cron } = await setup({ dbRetry: { initialDelayMs: 10 } });
	try {
		let calls = 0;
		await cron.register(
			"once",
			YEARLY,
			async () => {
				calls++;
				return "ok";
			},
			{ max_attempts: 3 }
		);
		await backdate(db, "once");

		// The transaction that records the success loses its connection once
		failNextTxCheckouts(db, 1);

		await cron.start(1);
		await sleep(400);
		await cron.stop();

		assertEquals(calls, 1, "the handler succeeded; it must not be retried");

		const row = await fetchJob(db, "once");
		assertEquals(row.status, CRON_STATUS.IDLE);
		assertEquals(row.last_run_status, RUN_STATUS.SUCCESS);

		const log = await fetchRunLog(db);
		assertEquals(log.length, 1);
		assertEquals(log[0].status, RUN_STATUS.SUCCESS);
	} finally {
		await db.end();
	}
});

Deno.test(
	"R6: a failed result write is reported as such, never as a handler failure",
	async () => {
		const { logger, lines } = recordingLogger();
		const { db, cron } = await setup({ logger }); // no dbRetry
		try {
			let calls = 0;
			await cron.register(
				"once",
				YEARLY,
				async () => {
					calls++;
					return "ok";
				},
				{ max_attempts: 3 }
			);
			await backdate(db, "once");
			failNextTxCheckouts(db, 1);

			await cron.start(1);
			await sleep(300);
			await cron.stop();

			assertEquals(calls, 1, "a bookkeeping error must not burn handler attempts");

			assert(
				lines.error.some((l) => l.includes("could not record the run")),
				`expected a bookkeeping error, got: ${JSON.stringify(lines.error)}`
			);
			assert(
				!lines.error.some((l) => l.startsWith("Cron claim:")),
				"must not be reported as a claim error"
			);

			// The attempt is not mislabelled as an error in the run log…
			const log = await fetchRunLog(db);
			assertEquals(log.length, 1);
			assertEquals(log[0].status, null);
			// …and the row waits for stale recovery
			assertEquals((await fetchJob(db, "once")).status, CRON_STATUS.RUNNING);
			assertEquals(await cron.cleanup(0), 1);
		} finally {
			await db.end();
		}
	}
);

// =========================================================================
// R7: single pg.Client
// =========================================================================

Deno.test("R7: a single pg.Client is limited to one processor", async () => {
	const client = createPgClient();
	await client.connect();
	const { logger, lines } = recordingLogger();
	const cron = createCron(client, { logger });
	await cron.resetHard();
	try {
		let runs = 0;
		await cron.register("solo", YEARLY, async () => {
			runs++;
		});
		await backdate(client, "solo");

		await cron.start(3);
		await sleep(250);
		await cron.stop();

		assert(
			lines.warn.some((l) => l.includes("single pg.Client")),
			"clamping must be announced"
		);
		assert(lines.debug.some((l) => l.includes("count: 1")));
		assertEquals(runs, 1, "the one processor still does its job");
	} finally {
		await cron.stop();
		await client.end();
	}
});

// =========================================================================
// R8: heartbeat
// =========================================================================

Deno.test("R8: heartbeat keeps a long-running job from being stale-recovered", async () => {
	const { db, cron } = await setup({ heartbeatIntervalMs: 40 });
	try {
		let runs = 0;
		await cron.register("long", YEARLY, async () => {
			runs++;
			await sleep(500);
		});
		await backdate(db, "long");
		await cron.start(2);
		await sleep(150); // claimed, handler in flight

		// As if the job had been claimed ten minutes ago
		await db.query(
			`UPDATE ${TABLE_PREFIX}__cron
			 SET last_run_at = NOW() - INTERVAL '10 minutes'
			 WHERE name = 'long'`
		);
		await sleep(150); // a few beats

		assertEquals(await cron.cleanup(5), 0, "a heartbeating job is not stale");
		assertEquals((await fetchJob(db, "long")).status, CRON_STATUS.RUNNING);

		await sleep(400); // let it finish
		assertEquals(runs, 1, "must not have been re-claimed while in flight");
		assertEquals((await fetchJob(db, "long")).last_run_status, RUN_STATUS.SUCCESS);
	} finally {
		await teardown(cron, db);
	}
});

Deno.test("R8: heartbeatIntervalMs: 0 turns the heartbeat off", async () => {
	const { db, cron } = await setup({ heartbeatIntervalMs: 0 });
	try {
		await cron.register("long", YEARLY, async () => {
			await sleep(300);
		});
		await backdate(db, "long");
		await cron.start(1);
		await sleep(100);

		await db.query(
			`UPDATE ${TABLE_PREFIX}__cron
			 SET last_run_at = NOW() - INTERVAL '10 minutes'
			 WHERE name = 'long'`
		);
		await sleep(100);

		// Nothing renewed `last_run_at`, so the in-flight job looks dead
		assertEquals(await cron.cleanup(5), 1);
	} finally {
		// stop() drains the original run and the re-claimed one
		await teardown(cron, db);
	}
});

Deno.test("R8: a lost lease aborts the in-flight handler", async () => {
	const { db, cron } = await setup({ heartbeatIntervalMs: 40 });
	try {
		let reason: unknown = null;
		await cron.register("fenced", YEARLY, async (_job, signal) => {
			signal?.addEventListener("abort", () => {
				reason = signal.reason;
			});
			await sleep(2_000, undefined, signal); // returns early on abort
		});
		await backdate(db, "fenced");
		await cron.start(1);
		await sleep(150);

		// What stale recovery by another worker does to the row. (Disabled too, so
		// nothing re-claims it and the test stays deterministic.)
		await db.query(
			`UPDATE ${TABLE_PREFIX}__cron
			 SET status = 'idle', lease_token = NULL, enabled = FALSE
			 WHERE name = 'fenced'`
		);
		await sleep(200);

		assert(
			reason instanceof Error && /lease lost/i.test(reason.message),
			`handler must be aborted with a "lease lost" reason, got: ${reason}`
		);
	} finally {
		await teardown(cron, db);
	}
});

// =========================================================================
// R9: healthPreview types
// =========================================================================

Deno.test("R9: healthPreview returns numbers, not strings", async () => {
	const { db, cron } = await setup();
	try {
		await cron.register("stats", YEARLY, async () => "ok");
		await backdate(db, "stats");
		await cron.start(1);
		await sleep(300);
		await cron.stop();

		const [row] = await cron.healthPreview(60);
		assertEquals(row.status, RUN_STATUS.SUCCESS);
		assertEquals(row.count, 1);
		assertEquals(typeof row.avg_duration_seconds, "number");
	} finally {
		await db.end();
	}
});

// =========================================================================
// R10: event wrap tracking
// =========================================================================

Deno.test(
	"R10: unsubscribing one name keeps the dedupe working for names without a handler",
	async () => {
		const { db, cron } = await setup();
		try {
			await cron.register("evt-a", YEARLY, async () => "a");
			await cron.register("evt-b", YEARLY, async () => "b");
			// No in-memory handlers at all — jobs still run (noop) and publish events
			cron.resetHandlers();

			let calls = 0;
			const cb = (_job: CronJob) => {
				calls++;
			};

			const unsubA = cron.onDone("evt-a", cb);
			cron.onDone("evt-b", cb);

			// Must not forget that `cb` is still subscribed to evt-b…
			unsubA();
			// …otherwise this re-subscribe (skipIfExists) adds a second delivery
			cron.onDone("evt-b", cb);

			await backdate(db, "evt-a");
			await backdate(db, "evt-b");
			await cron.start(1);
			await sleep(400);

			assertEquals(calls, 1, "evt-a unsubscribed, evt-b delivered exactly once");
		} finally {
			await teardown(cron, db);
		}
	}
);

// =========================================================================
// R11: SIGTERM listener
// =========================================================================

Deno.test("R11: SIGTERM listener follows start()/stop(), including a restart", async () => {
	const { db, cron } = await setup({ gracefulSigterm: true });
	const base = process.listenerCount("SIGTERM");
	try {
		await cron.register("x", YEARLY, async () => {});
		assertEquals(
			process.listenerCount("SIGTERM"),
			base,
			"management calls must not hook process signals"
		);

		await cron.start(1);
		assertEquals(process.listenerCount("SIGTERM"), base + 1);

		await cron.stop();
		assertEquals(process.listenerCount("SIGTERM"), base);

		await cron.start(1);
		assertEquals(process.listenerCount("SIGTERM"), base + 1, "a restart must re-attach");
	} finally {
		await cron.stop();
		assertEquals(process.listenerCount("SIGTERM"), base);
		await db.end();
	}
});
