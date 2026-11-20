/**
 * What a statement reads and writes, pinned through the public API: the values that make
 * a round trip through JSON, the optional filters and pages of the two listings, the
 * run-log rows of a success and of a failure, and the health check.
 *
 * - S1: payload round trip (register, find, re-register, default)
 * - S2: `next_run_at` on re-register, with and without `forceNextRunRecalculate`
 * - S3: run-log row of a success; the result of an object, a string, `undefined`
 * - S4: run-log rows of a failure: an Error, a thrown string, a timeout
 * - S5: `fetchAll` order, filters, pages and tenant scope
 * - S6: `getRunHistory` order, pages and `sinceMinutesAgo`
 * - S7: `unregister` takes the job's run-log rows with it
 * - S8: `checkDbHealth()` and `getDbHealth()`, on a live and an unreachable database
 *
 * Not pinned on purpose: the latency and the error text of an unhealthy status, and the
 * class of a rejected database call.
 *
 * Requires a live PostgreSQL database (TEST_PG_*) just like cron-db.test.ts.
 *
 * Jobs that must run exactly once use a yearly expression plus a backdate, and a test
 * waits for a run through `onDone` / `onError`, never a fixed sleep.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "@marianmeres/clog";
import pg from "pg";
import { sleep } from "../src/cron/utils/sleep.ts";
import {
	CRON_STATUS,
	Cron,
	type CronJob,
	CronParser,
	DEFAULT_TENANT_ID,
	RUN_STATUS,
} from "../src/mod.ts";
import { createPg } from "./_pg.ts";

const TABLE_PREFIX = "_test_";
const TABLE_CRON = `${TABLE_PREFIX}__cron`;
const TABLE_RUN_LOG = `${TABLE_PREFIX}__cron_run_log`;
const POLL = 50;
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

/** Forces a job's `next_run_at` into the past so the poller picks it up. */
async function backdate(db: pg.Pool, name: string, msAgo = 100) {
	await db.query(
		`UPDATE ${TABLE_CRON}
		 SET next_run_at = NOW() - ($1 * INTERVAL '1 millisecond')
		 WHERE name = $2`,
		[msAgo, name],
	);
}

/** Inserts a finished run-log row for `job`, started `minutesAgo` minutes ago. */
async function insertRunLog(db: pg.Pool, job: CronJob, minutesAgo = 0) {
	await db.query(
		`INSERT INTO ${TABLE_RUN_LOG}
			(cron_id, cron_name, tenant_id, scheduled_at, started_at, status)
		 VALUES ($1, $2, $3, NOW(), NOW() - ($4 * INTERVAL '1 minute'), $5)`,
		[job.id, job.name, job.tenant_id, minutesAgo, RUN_STATUS.SUCCESS],
	);
}

async function countRunLog(db: pg.Pool, cronId: number): Promise<number> {
	const { rows } = await db.query(
		`SELECT COUNT(*)::int AS n FROM ${TABLE_RUN_LOG} WHERE cron_id = $1`,
		[cronId],
	);
	return rows[0].n;
}

/**
 * Resolves once every name in `names` has finished a cycle (`onDone` or `onError`,
 * both published after the outcome is recorded); rejects after `ms`. Subscribe
 * before `start()`.
 */
function settled(cron: Cron, names: string[], ms = 5_000): Promise<void> {
	const pending = new Set(names);
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(
			() =>
				reject(
					new Error(`not settled within ${ms} ms: ${[...pending].join(", ")}`),
				),
			ms,
		);
		const seen = (job: CronJob) => {
			pending.delete(job.name);
			if (pending.size) return;
			clearTimeout(timer);
			resolve();
		};
		cron.onDone(names, seen);
		cron.onError(names, seen);
	});
}

// -------------------------------------------------------------------------

test("S1 payload round trip", async () => {
	const { db, cron } = await setup();
	try {
		const payload = {
			list: [1, 2],
			text: `it's a "quote"`,
			nested: { a: null, deeper: { b: [true, "x"] } },
		};
		const registered = await cron.register("p", YEARLY, async () => {}, { payload });
		assert.deepStrictEqual(
			registered.payload,
			payload,
			"register() returns it as given",
		);

		const found = await cron.find("p");
		assert.deepStrictEqual(found?.payload, payload, "find() reads the same");

		const replaced = await cron.register("p", YEARLY, async () => {}, {
			payload: { other: true },
		});
		assert.deepStrictEqual(
			replaced.payload,
			{ other: true },
			"re-register replaces it",
		);
		assert.deepStrictEqual((await cron.find("p"))?.payload, { other: true });

		const plain = await cron.register("p0", YEARLY, async () => {});
		assert.deepStrictEqual(plain.payload, {}, "the default is {}");
	} finally {
		await teardown(cron, db);
	}
});

// -------------------------------------------------------------------------

test("S2 next_run_at on re-register: kept, or recomputed when forced", async () => {
	const { db, cron } = await setup();
	try {
		await cron.register("p", YEARLY, async () => {});
		const moved = new Date("2031-05-05T05:05:00.000Z");
		await db.query(`UPDATE ${TABLE_CRON} SET next_run_at = $1 WHERE name = $2`, [
			moved,
			"p",
		]);

		const kept = await cron.register("p", YEARLY, async () => {});
		assert.deepStrictEqual(
			kept.next_run_at.getTime(),
			moved.getTime(),
			"a plain re-register keeps next_run_at",
		);

		const forced = await cron.register("p", YEARLY, async () => {}, {
			forceNextRunRecalculate: true,
		});
		assert.deepStrictEqual(
			forced.next_run_at.toISOString(),
			new CronParser(YEARLY).getNextRun().toISOString(),
			"forceNextRunRecalculate recomputes it",
		);
	} finally {
		await teardown(cron, db);
	}
});

// -------------------------------------------------------------------------

test("S3 run log of a success: the row, and the result as it was returned", async () => {
	const { db, cron } = await setup();
	try {
		await cron.register("obj", YEARLY, async () => ({ ok: true, list: [1] }));
		await cron.register("str", YEARLY, async () => "ok");
		await cron.register("undef", YEARLY, async () => undefined);
		for (const name of ["obj", "str", "undef"]) await backdate(db, name);
		const scheduled = (await cron.find("obj"))?.next_run_at;
		assert.ok(scheduled instanceof Date, "obj is registered");

		const done = settled(cron, ["obj", "str", "undef"]);
		await cron.start(1);
		await done;
		await cron.stop();

		const history = await cron.getRunHistory("obj");
		assert.deepStrictEqual(history.length, 1);
		const [row] = history;
		assert.deepStrictEqual(row.status, RUN_STATUS.SUCCESS);
		assert.deepStrictEqual(row.attempt_number, 1);
		assert.deepStrictEqual(row.tenant_id, DEFAULT_TENANT_ID);
		assert.deepStrictEqual(row.cron_name, "obj");
		assert.ok(row.completed_at instanceof Date, "completed_at is set");
		assert.deepStrictEqual(
			row.scheduled_at.getTime(),
			scheduled.getTime(),
			"scheduled_at is the claimed next_run_at",
		);
		assert.deepStrictEqual(row.error_message, null);
		assert.deepStrictEqual(row.error_details, null);
		assert.deepStrictEqual(
			row.result,
			{ ok: true, list: [1] },
			"an object reads back",
		);

		const [str] = await cron.getRunHistory("str");
		assert.deepStrictEqual(str.result, "ok", "a string reads back as the string");

		const [undef] = await cron.getRunHistory("undef");
		assert.deepStrictEqual(undef.result, null, "undefined reads back as null");
	} finally {
		await teardown(cron, db);
	}
});

// -------------------------------------------------------------------------

test("S4 run log of a failure: an Error, a thrown string, a timeout", async () => {
	const { db, cron } = await setup();
	try {
		await cron.register(
			"err",
			YEARLY,
			async () => {
				throw new Error("boom");
			},
			{ max_attempts: 2 },
		);
		await cron.register("plain", YEARLY, async () => {
			throw "plain";
		});
		await cron.register(
			"slow",
			YEARLY,
			async (_job, signal) => {
				await sleep(300, undefined, signal);
			},
			{ max_attempt_duration_ms: 40 },
		);
		for (const name of ["err", "plain", "slow"]) await backdate(db, name);

		const done = settled(cron, ["err", "plain", "slow"]);
		await cron.start(1);
		await done;
		await cron.stop();

		const errs = await cron.getRunHistory("err");
		assert.deepStrictEqual(errs.length, 2, "two attempts");
		assert.deepStrictEqual(
			errs.map((r) => r.attempt_number),
			[2, 1],
			"newest first",
		);
		for (const r of errs) {
			assert.deepStrictEqual(r.status, RUN_STATUS.ERROR);
			assert.deepStrictEqual(r.error_message, "boom");
			assert.ok(
				typeof r.error_details?.stack === "string" &&
					r.error_details.stack.startsWith("Error: boom"),
				`error_details.stack: ${JSON.stringify(r.error_details)}`,
			);
			assert.deepStrictEqual(r.result, null);
			assert.ok(r.completed_at instanceof Date, "completed_at is set");
		}

		const [plain] = await cron.getRunHistory("plain");
		assert.deepStrictEqual(plain.status, RUN_STATUS.ERROR);
		assert.deepStrictEqual(
			plain.error_message,
			"plain",
			"a thrown string is the message",
		);
		assert.deepStrictEqual(plain.error_details, null, "and there are no details");

		const [slow] = await cron.getRunHistory("slow");
		assert.deepStrictEqual(slow.status, RUN_STATUS.TIMEOUT);
		assert.deepStrictEqual(slow.error_message, "Execution timed out");

		for (const [name, status] of [
			["err", RUN_STATUS.ERROR],
			["plain", RUN_STATUS.ERROR],
			["slow", RUN_STATUS.TIMEOUT],
		] as const) {
			const job = await cron.find(name);
			assert.deepStrictEqual(job?.status, CRON_STATUS.IDLE, `${name} ends idle`);
			assert.deepStrictEqual(
				job?.last_run_status,
				status,
				`${name} last_run_status`,
			);
		}
	} finally {
		await teardown(cron, db);
	}
});

// -------------------------------------------------------------------------

test("S5 fetchAll: order, filters, pages, tenant scope", async () => {
	const { db, cron } = await setup();
	try {
		// registered out of order: the listing orders by name
		for (const name of ["c", "a", "d", "b"])
			await cron.register(name, YEARLY, async () => {});
		await cron.disable("b");
		await db.query(`UPDATE ${TABLE_CRON} SET status = $1 WHERE name = $2`, [
			CRON_STATUS.RUNNING,
			"c",
		]);

		const names = async (options?: Parameters<Cron["fetchAll"]>[0]) =>
			(await cron.fetchAll(options)).map((j) => j.name).join("");

		assert.deepStrictEqual(await names(), "abcd", "all, ordered by name");
		assert.deepStrictEqual(await names({ enabled: false }), "b");
		assert.deepStrictEqual(await names({ enabled: true }), "acd");
		assert.deepStrictEqual(await names({ status: CRON_STATUS.RUNNING }), "c");
		assert.deepStrictEqual(await names({ status: CRON_STATUS.IDLE }), "abd");
		assert.deepStrictEqual(
			await names({ enabled: true, status: CRON_STATUS.IDLE }),
			"ad",
			"both filters",
		);
		assert.deepStrictEqual(await names({ limit: 2 }), "ab");
		assert.deepStrictEqual(await names({ limit: 2, offset: 1 }), "bc");
		assert.deepStrictEqual(await names({ offset: 3 }), "d");
		assert.deepStrictEqual(
			await cron.forTenant("other").fetchAll(),
			[],
			"another tenant sees nothing",
		);
	} finally {
		await teardown(cron, db);
	}
});

// -------------------------------------------------------------------------

test("S6 getRunHistory: order, pages, sinceMinutesAgo", async () => {
	const { db, cron } = await setup();
	try {
		const job = await cron.register("a", YEARLY, async () => {});
		// Started 0, 30 and 120 minutes ago, inserted in that order: the newest id is the
		// oldest start, so the order asserted below is by id, not by start.
		for (const minutesAgo of [0, 30, 120]) await insertRunLog(db, job, minutesAgo);

		const ids = (await cron.getRunHistory("a")).map((r) => r.id);
		assert.deepStrictEqual(ids.length, 3);
		assert.ok(ids[0] > ids[1] && ids[1] > ids[2], "newest id first");

		const pageIds = async (options: Parameters<Cron["getRunHistory"]>[1]) =>
			(await cron.getRunHistory("a", options)).map((r) => r.id);

		assert.deepStrictEqual(await pageIds({ limit: 1 }), [ids[0]]);
		assert.deepStrictEqual(await pageIds({ limit: 1, offset: 1 }), [ids[1]]);
		assert.deepStrictEqual(await pageIds({ offset: 2 }), [ids[2]]);
		// ids[2] started 0 minutes ago, ids[1] 30, ids[0] 120
		assert.deepStrictEqual(await pageIds({ sinceMinutesAgo: 60 }), [ids[1], ids[2]]);
		assert.deepStrictEqual(await pageIds({ sinceMinutesAgo: 10 }), [ids[2]]);
		assert.deepStrictEqual(
			await cron.getRunHistory("nope"),
			[],
			"an unknown name answers []",
		);
	} finally {
		await teardown(cron, db);
	}
});

// -------------------------------------------------------------------------

test("S7 unregister takes the job's run-log rows with it", async () => {
	const { db, cron } = await setup();
	try {
		const a = await cron.register("a", YEARLY, async () => {});
		const b = await cron.register("b", YEARLY, async () => {});
		await insertRunLog(db, a);
		await insertRunLog(db, a, 5);
		await insertRunLog(db, b);
		assert.deepStrictEqual(await countRunLog(db, a.id), 2);

		await cron.unregister("a");

		assert.deepStrictEqual(await cron.find("a"), null);
		assert.deepStrictEqual(await countRunLog(db, a.id), 0, "a's rows are gone");
		assert.deepStrictEqual(await countRunLog(db, b.id), 1, "b's row stays");
	} finally {
		await teardown(cron, db);
	}
});

// -------------------------------------------------------------------------

test("S8 checkDbHealth on a live database", async () => {
	const { db, cron } = await setup();
	try {
		const status = await cron.checkDbHealth();
		assert.deepStrictEqual(status.healthy, true);
		assert.deepStrictEqual(status.error, null);
		assert.deepStrictEqual(typeof status.latencyMs, "number");
		assert.ok(status.timestamp instanceof Date, "timestamp is a Date");
		assert.match(status.pgVersion ?? "", /^\d/, "pgVersion starts with a digit");
	} finally {
		await teardown(cron, db);
	}
});

test("S8 getDbHealth: null without the option or before start(), then the status", async () => {
	const { db, cron } = await setup();
	const monitored = createCron(db, { dbHealthCheck: true });
	try {
		assert.deepStrictEqual(cron.getDbHealth(), null, "null without dbHealthCheck");
		assert.deepStrictEqual(monitored.getDbHealth(), null, "null before start()");

		await monitored.start(0);
		const status = monitored.getDbHealth();
		assert.deepStrictEqual(status?.healthy, true, JSON.stringify(status));
		assert.deepStrictEqual(status?.error, null);
		assert.match(status?.pgVersion ?? "", /^\d/, "pgVersion starts with a digit");
	} finally {
		await monitored.stop();
		await teardown(cron, db);
	}
});

test("S8 checkDbHealth on an unreachable database resolves unhealthy", async () => {
	// Port 1 is bound by nothing; the connection is refused.
	const dead = new pg.Pool({
		host: "127.0.0.1",
		port: 1,
		connectionTimeoutMillis: 500,
	});
	dead.on("error", () => {});
	try {
		const status = await createCron(dead).checkDbHealth();
		assert.deepStrictEqual(status.healthy, false);
		assert.deepStrictEqual(typeof status.error, "string");
		assert.ok((status.error ?? "").length > 0, "error is not empty");
		assert.deepStrictEqual(status.pgVersion, undefined);
	} finally {
		await dead.end();
	}
});
