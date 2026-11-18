/**
 * Tests for the TaskRegistry (in-memory, no DB required)
 * and syncRegistryToCron (requires PostgreSQL).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
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

test("registry: define and get", () => {
	const registry = createTaskRegistry();
	const handler = async (_job: CronJob) => "ok";

	registry.define("send-email", {
		description: "Send an email",
		handler,
	});

	const def = registry.get("send-email");
	assert.ok(def !== undefined);
	assert.deepStrictEqual(def!.description, "Send an email");
	assert.deepStrictEqual(def!.handler, handler);
});

test("registry: define duplicate throws", () => {
	const registry = createTaskRegistry();
	const handler = async (_job: CronJob) => {};

	registry.define("task-a", { handler });

	try {
		registry.define("task-a", { handler });
		assert.ok(false, "should have thrown");
	} catch (e) {
		assert.ok((e as Error).message.includes("already defined"));
	}
});

test("registry: has", () => {
	const registry = createTaskRegistry();
	assert.deepStrictEqual(registry.has("nope"), false);

	registry.define("exists", { handler: async () => {} });
	assert.deepStrictEqual(registry.has("exists"), true);
});

test("registry: list omits handlers", () => {
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
	assert.deepStrictEqual(list.length, 2);

	for (const entry of list) {
		// deno-lint-ignore no-explicit-any
		assert.ok(!("handler" in entry), "handler must not be in list entries");
		assert.ok("taskType" in entry);
	}

	assert.deepStrictEqual(list[0].taskType, "task-a");
	assert.deepStrictEqual(list[1].taskType, "task-b");
	assert.deepStrictEqual(list[1].paramsSchema, { type: "object" });
});

test("registry: validate with no schema returns valid", async () => {
	const registry = createTaskRegistry();
	registry.define("no-schema", { handler: async () => {} });

	const result = await registry.validate("no-schema", { anything: true });
	assert.deepStrictEqual(result.valid, true);
	assert.deepStrictEqual(result.errors.length, 0);
});

test("registry: validate unknown task type throws", async () => {
	const registry = createTaskRegistry();

	await assert.rejects(
		() => registry.validate("unknown", {}),
		(e: unknown) => e instanceof Error && e.message.includes("Unknown task type"),
	);
});

test("registry: validate with valid payload", async () => {
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
	assert.deepStrictEqual(result.valid, true);
	assert.deepStrictEqual(result.errors.length, 0);
});

test("registry: validate with invalid payload", async () => {
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
	assert.deepStrictEqual(result.valid, false);
	assert.ok(result.errors.length > 0);
});

// =========================================================================
// syncRegistryToCron integration tests (requires DB)
// =========================================================================

test("syncRegistryToCron: wires handlers and detects orphans", async () => {
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

		assert.deepStrictEqual(synced.length, 2);
		assert.ok(synced.includes("task-a"));
		assert.ok(synced.includes("task-b"));

		assert.deepStrictEqual(orphans.length, 1);
		assert.deepStrictEqual(orphans[0], "orphan-job");

		// Verify handlers were wired
		assert.ok(cron.hasHandler("task-a"));
		assert.ok(cron.hasHandler("task-b"));
	} finally {
		await cron.stop();
		await db.end();
	}
});
