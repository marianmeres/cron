import { assertEquals, assertThrows } from "@std/assert";
import { CronParser } from "../src/cron-parser.ts";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

Deno.test("parses wildcard (*) to full range", () => {
	const c = new CronParser("* * * * *");
	assertEquals(c.minute.length, 60); // 0-59
	assertEquals(c.hour.length, 24); // 0-23
	assertEquals(c.dayOfMonth.length, 31); // 1-31
	assertEquals(c.month.length, 12); // 1-12
	assertEquals(c.dayOfWeek.length, 7); // 0-6
});

Deno.test("parses single values", () => {
	const c = new CronParser("5 10 15 6 3");
	assertEquals(c.minute, [5]);
	assertEquals(c.hour, [10]);
	assertEquals(c.dayOfMonth, [15]);
	assertEquals(c.month, [6]);
	assertEquals(c.dayOfWeek, [3]);
});

Deno.test("parses ranges (1-5)", () => {
	const c = new CronParser("1-5 0-3 10-15 1-6 0-4");
	assertEquals(c.minute, [1, 2, 3, 4, 5]);
	assertEquals(c.hour, [0, 1, 2, 3]);
	assertEquals(c.dayOfMonth, [10, 11, 12, 13, 14, 15]);
	assertEquals(c.month, [1, 2, 3, 4, 5, 6]);
	assertEquals(c.dayOfWeek, [0, 1, 2, 3, 4]);
});

Deno.test("parses lists (1,3,5)", () => {
	const c = new CronParser("0,15,30,45 9,17 1,15 1,7 1,5");
	assertEquals(c.minute, [0, 15, 30, 45]);
	assertEquals(c.hour, [9, 17]);
	assertEquals(c.dayOfMonth, [1, 15]);
	assertEquals(c.month, [1, 7]);
	assertEquals(c.dayOfWeek, [1, 5]);
});

Deno.test("parses step with wildcard (*/n)", () => {
	const c = new CronParser("*/15 */6 * * *");
	assertEquals(c.minute, [0, 15, 30, 45]);
	assertEquals(c.hour, [0, 6, 12, 18]);
});

Deno.test("parses step within range (a-b/n)", () => {
	const c = new CronParser("2-10/3 * * * *");
	// range 2..10, step 3: indices 0,3,6 → values 2,5,8
	assertEquals(c.minute, [2, 5, 8]);
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

Deno.test("throws on invalid characters", () => {
	assertThrows(
		() => new CronParser("0 9 * * MON"),
		Error,
		"invalid characters",
	);
});

Deno.test("throws on wrong number of fields", () => {
	assertThrows(
		() => new CronParser("0 9 * *"),
		Error,
		"must have exactly 5 fields",
	);
	assertThrows(
		() => new CronParser("0 9 * * * *"),
		Error,
		"must have exactly 5 fields",
	);
});

Deno.test("throws on out-of-range single value", () => {
	assertThrows(() => new CronParser("60 * * * *"), Error, "minute");
	assertThrows(() => new CronParser("* 25 * * *"), Error, "hour");
	assertThrows(() => new CronParser("* * 0 * *"), Error, "day of month");
	assertThrows(() => new CronParser("* * * 13 *"), Error, "month");
	assertThrows(() => new CronParser("* * * * 7"), Error, "day of week");
});

Deno.test("throws on invalid range (start > end)", () => {
	assertThrows(() => new CronParser("10-5 * * * *"), Error, "start > end");
});

Deno.test("throws on range out of bounds", () => {
	assertThrows(
		() => new CronParser("* 0-25 * * *"),
		Error,
		"Range out of bounds",
	);
});

Deno.test("throws on invalid step value", () => {
	assertThrows(
		() => new CronParser("*/0 * * * *"),
		Error,
		"Invalid step value",
	);
});

// ---------------------------------------------------------------------------
// matches()
// ---------------------------------------------------------------------------

Deno.test("matches every minute", () => {
	const c = new CronParser("* * * * *");
	assertEquals(c.matches(new Date("2025-06-15T10:30:00")), true);
});

Deno.test("matches specific minute and hour", () => {
	const c = new CronParser("30 14 * * *");
	assertEquals(c.matches(new Date("2025-06-15T14:30:00")), true);
	assertEquals(c.matches(new Date("2025-06-15T14:31:00")), false);
	assertEquals(c.matches(new Date("2025-06-15T13:30:00")), false);
});

Deno.test("matches every 15 minutes", () => {
	const c = new CronParser("*/15 * * * *");
	assertEquals(c.matches(new Date("2025-06-15T10:00:00")), true);
	assertEquals(c.matches(new Date("2025-06-15T10:15:00")), true);
	assertEquals(c.matches(new Date("2025-06-15T10:30:00")), true);
	assertEquals(c.matches(new Date("2025-06-15T10:45:00")), true);
	assertEquals(c.matches(new Date("2025-06-15T10:07:00")), false);
});

Deno.test("matches weekday range (Mon-Fri = 1-5)", () => {
	const c = new CronParser("0 9 * * 1-5");
	// 2025-06-16 is Monday
	assertEquals(c.matches(new Date("2025-06-16T09:00:00")), true);
	// 2025-06-15 is Sunday
	assertEquals(c.matches(new Date("2025-06-15T09:00:00")), false);
});

Deno.test("matches specific day of month and month", () => {
	const c = new CronParser("0 0 25 12 *");
	assertEquals(c.matches(new Date("2025-12-25T00:00:00")), true);
	assertEquals(c.matches(new Date("2025-12-26T00:00:00")), false);
	assertEquals(c.matches(new Date("2025-11-25T00:00:00")), false);
});

// ---------------------------------------------------------------------------
// getNextRun()
// ---------------------------------------------------------------------------

Deno.test("getNextRun - every minute", () => {
	const c = new CronParser("* * * * *");
	const from = new Date("2025-06-15T10:30:45");
	const next = c.getNextRun(from);
	assertEquals(next.getFullYear(), 2025);
	assertEquals(next.getMonth(), 5); // June = 5
	assertEquals(next.getDate(), 15);
	assertEquals(next.getHours(), 10);
	assertEquals(next.getMinutes(), 31);
	assertEquals(next.getSeconds(), 0);
});

Deno.test("getNextRun - specific time", () => {
	const c = new CronParser("30 14 * * *");
	const from = new Date("2025-06-15T10:00:00");
	const next = c.getNextRun(from);
	assertEquals(next.getHours(), 14);
	assertEquals(next.getMinutes(), 30);
	assertEquals(next.getDate(), 15);
});

Deno.test("getNextRun - rolls to next day", () => {
	const c = new CronParser("0 9 * * *");
	const from = new Date("2025-06-15T10:00:00");
	const next = c.getNextRun(from);
	assertEquals(next.getDate(), 16);
	assertEquals(next.getHours(), 9);
	assertEquals(next.getMinutes(), 0);
});

Deno.test("getNextRun - skips to next matching weekday", () => {
	// Monday at 9am
	const c = new CronParser("0 9 * * 1");
	// Start from Sunday 2025-06-15
	const from = new Date("2025-06-15T10:00:00");
	const next = c.getNextRun(from);
	assertEquals(next.getDay(), 1); // Monday
	assertEquals(next.getDate(), 16);
	assertEquals(next.getHours(), 9);
	assertEquals(next.getMinutes(), 0);
});

Deno.test("getNextRun - specific month", () => {
	const c = new CronParser("0 0 1 1 *");
	const from = new Date("2025-06-15T00:00:00");
	const next = c.getNextRun(from);
	assertEquals(next.getFullYear(), 2026);
	assertEquals(next.getMonth(), 0); // January
	assertEquals(next.getDate(), 1);
});

Deno.test("expression is stored", () => {
	const c = new CronParser("*/5 9-17 * * 1-5");
	assertEquals(c.expression, "*/5 9-17 * * 1-5");
});
