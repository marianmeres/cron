/**
 * Tests for the TaskRegistry (in-memory, no DB required)
 * and syncRegistryToCron (requires PostgreSQL).
 */

import { assertEquals, assert, assertRejects } from "@std/assert";
import {
	Cron,
	createTaskRegistry,
	syncRegistryToCron,
	type CronJob,
} from "../src/mod.ts";
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

// =========================================================================
// TaskRegistry unit tests (no DB)
// =========================================================================

Deno.test("registry: define and get", () => {
	const registry = createTaskRegistry();
	const handler = async (_job: CronJob) => "ok";

	registry.define("send-email", {
		description: "Send an email",
		handler,
	});

	const def = registry.get("send-email");
	assert(def !== undefined);
	assertEquals(def!.description, "Send an email");
	assertEquals(def!.handler, handler);
});

Deno.test("registry: define duplicate throws", () => {
	const registry = createTaskRegistry();
	const handler = async (_job: CronJob) => {};

	registry.define("task-a", { handler });

	try {
		registry.define("task-a", { handler });
		assert(false, "should have thrown");
	} catch (e) {
		assert((e as Error).message.includes("already defined"));
	}
});

Deno.test("registry: has", () => {
	const registry = createTaskRegistry();
	assertEquals(registry.has("nope"), false);

	registry.define("exists", { handler: async () => {} });
	assertEquals(registry.has("exists"), true);
});

Deno.test("registry: list omits handlers", () => {
	const registry = createTaskRegistry();
	registry.define("task-a", {
		description: "A",
		handler: async () => {},
	});
	registry.define("task-b", {
		description: "B",
		paramsSchema: { type: "object" },
		handler: async () => {},
	});

	const list = registry.list();
	assertEquals(list.length, 2);

	for (const entry of list) {
		// deno-lint-ignore no-explicit-any
		assert(!("handler" in entry), "handler must not be in list entries");
		assert("taskType" in entry);
	}

	assertEquals(list[0].taskType, "task-a");
	assertEquals(list[1].taskType, "task-b");
	assertEquals(list[1].paramsSchema, { type: "object" });
});

Deno.test("registry: validate with no schema returns valid", async () => {
	const registry = createTaskRegistry();
	registry.define("no-schema", { handler: async () => {} });

	const result = await registry.validate("no-schema", { anything: true });
	assertEquals(result.valid, true);
	assertEquals(result.errors.length, 0);
});

Deno.test("registry: validate unknown task type throws", async () => {
	const registry = createTaskRegistry();

	await assertRejects(
		() => registry.validate("unknown", {}),
		Error,
		"Unknown task type"
	);
});

Deno.test("registry: validate with valid payload", async () => {
	const registry = createTaskRegistry();
	registry.define("send-email", {
		paramsSchema: {
			type: "object",
			properties: {
				to: { type: "string", minLength: 1 },
				subject: { type: "string" },
			},
			required: ["to"],
		},
		handler: async () => {},
	});

	const result = await registry.validate("send-email", {
		to: "test@example.com",
		subject: "Hello",
	});
	assertEquals(result.valid, true);
	assertEquals(result.errors.length, 0);
});

Deno.test("registry: validate with invalid payload", async () => {
	const registry = createTaskRegistry();
	registry.define("send-email", {
		paramsSchema: {
			type: "object",
			properties: {
				to: { type: "string", minLength: 1 },
			},
			required: ["to"],
		},
		handler: async () => {},
	});

	const result = await registry.validate("send-email", {});
	assertEquals(result.valid, false);
	assert(result.errors.length > 0);
});

// =========================================================================
// syncRegistryToCron integration tests (requires DB)
// =========================================================================

Deno.test("syncRegistryToCron: wires handlers and detects orphans", async () => {
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
		const registry = createTaskRegistry();
		registry.define("task-a", { handler: async () => "a" });
		registry.define("task-b", { handler: async () => "b" });

		// Register a DB job that matches task-a
		await cron.register("task-a", "* * * * *", async () => {});
		// Register a DB job that has NO matching registry entry
		await cron.register("orphan-job", "* * * * *", async () => {});

		const { synced, orphans } = await syncRegistryToCron(cron, registry);

		assertEquals(synced.length, 2);
		assert(synced.includes("task-a"));
		assert(synced.includes("task-b"));

		assertEquals(orphans.length, 1);
		assertEquals(orphans[0], "orphan-job");

		// Verify handlers were wired
		assert(cron.hasHandler("task-a"));
		assert(cron.hasHandler("task-b"));
	} finally {
		await cron.stop();
		await db.end();
	}
});
