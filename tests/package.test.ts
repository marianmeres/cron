/**
 * What the published package lets a consumer load:
 *
 * - each entry point names its file under `default`, the condition both `import` and
 *   `require()` match (under `import` alone, `require()` finds no entry point), with
 *   `types` first (TypeScript takes the first condition that matches)
 * - the entry's source loads with `require()` as well as with `import`, as one module:
 *   `require()` refuses a module graph that awaits at its top level anywhere
 *
 * Runs on the source, not on `dist/`: the build maps `src/mod.ts` to `dist/mod.js`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const pkg = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { exports: Record<string, Record<string, string>> };

test("package: every entry point is under default, types first", () => {
	for (const [key, conditions] of Object.entries(pkg.exports)) {
		const names = Object.keys(conditions);
		assert.deepStrictEqual(names[0], "types", `${key}: "types" is not first`);
		assert.ok(names.includes("default"), `${key}: no "default" condition`);
	}
});

test("package: the entry loads with require() and with import, as one module", async () => {
	const require = createRequire(import.meta.url);
	const required = require("../src/mod.ts") as Record<string, unknown>;
	const imported = (await import("../src/mod.ts")) as Record<string, unknown>;
	assert.deepStrictEqual(Object.keys(required).sort(), Object.keys(imported).sort());
	for (const name of Object.keys(imported)) {
		assert.strictEqual(required[name], imported[name], name);
	}
});
