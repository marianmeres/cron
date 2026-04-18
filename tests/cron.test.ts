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

// ---------------------------------------------------------------------------
// Day-of-month + day-of-week OR semantics (POSIX/Vixie cron)
// ---------------------------------------------------------------------------

Deno.test("DoM + DoW: OR semantics when both are restricted", () => {
	// "9am on the 15th, OR on any weekday"
	const c = new CronParser("0 9 15 * 1-5");

	// 2025-06-15 is Sunday (NOT a weekday) — only matches because day == 15
	assertEquals(c.matches(new Date("2025-06-15T09:00:00")), true);
	// 2025-06-16 is Monday (NOT the 15th) — only matches because of weekday
	assertEquals(c.matches(new Date("2025-06-16T09:00:00")), true);
	// 2025-06-21 is Saturday and not the 15th — must NOT match
	assertEquals(c.matches(new Date("2025-06-21T09:00:00")), false);
});

Deno.test("DoM + DoW: only DoM restricts when DoW is *", () => {
	const c = new CronParser("0 0 25 12 *");
	assertEquals(c.matches(new Date("2025-12-25T00:00:00")), true);
	assertEquals(c.matches(new Date("2025-12-26T00:00:00")), false);
});

Deno.test("DoM + DoW: only DoW restricts when DoM is *", () => {
	const c = new CronParser("0 9 * * 1-5");
	// 2025-06-16 is Monday
	assertEquals(c.matches(new Date("2025-06-16T09:00:00")), true);
	// 2025-06-15 is Sunday
	assertEquals(c.matches(new Date("2025-06-15T09:00:00")), false);
});

Deno.test("DoM + DoW: getNextRun honours OR semantics", () => {
	// "9am on the 15th OR on Mondays"
	const c = new CronParser("0 9 15 * 1");
	// From 2025-06-09 (Monday) at 10am → next match is 2025-06-15 (Sunday) at 9am
	const next = c.getNextRun(new Date("2025-06-09T10:00:00"));
	assertEquals(next.getDate(), 15);
	assertEquals(next.getHours(), 9);
});

// ---------------------------------------------------------------------------
// Impossible date detection
// ---------------------------------------------------------------------------

Deno.test("rejects calendar dates that cannot exist", () => {
	assertThrows(
		() => new CronParser("0 0 31 2 *"),
		Error,
		"does not exist",
	);
	assertThrows(
		() => new CronParser("0 0 31 4 *"),
		Error,
		"does not exist",
	);
	assertThrows(
		() => new CronParser("0 0 30 2 *"),
		Error,
		"does not exist",
	);
});

Deno.test("does NOT reject when DoW could rescue an impossible DoM", () => {
	// "midnight on the 31st of Feb on a Monday" — impossible by DoM, but
	// OR with DoW means "any Monday in Feb" rescues it.
	const c = new CronParser("0 0 31 2 1");
	assertEquals(c.dayOfMonth, [31]);
	// And it can find a next run (any Monday in February)
	const next = c.getNextRun(new Date("2025-01-01T00:00:00"));
	// Should land on a Monday in February
	assertEquals(next.getDay(), 1);
	assertEquals(next.getMonth(), 1); // February
});

Deno.test("Feb 29 leap day: getNextRun finds next leap year", () => {
	// 2025 is not a leap year; from March 2025 → next Feb 29 = 2028-02-29
	const c = new CronParser("0 0 29 2 *");
	const next = c.getNextRun(new Date("2025-03-01T00:00:00"));
	assertEquals(next.getFullYear(), 2028);
	assertEquals(next.getMonth(), 1); // February
	assertEquals(next.getDate(), 29);
});

// ---------------------------------------------------------------------------
// Timezone support
// ---------------------------------------------------------------------------

Deno.test("rejects invalid timezone", () => {
	assertThrows(
		() => new CronParser("* * * * *", { timezone: "Not/A_Real_Zone" }),
		Error,
		"Invalid timezone",
	);
});

Deno.test("timezone: matches in target timezone, not local", () => {
	// 9am in Tokyo on 2025-06-15 = 00:00 UTC = 02:00 in Prague (CEST)
	const c = new CronParser("0 9 * * *", { timezone: "Asia/Tokyo" });

	const utcMidnight = new Date(Date.UTC(2025, 5, 15, 0, 0, 0));
	assertEquals(c.matches(utcMidnight), true); // 9am Tokyo

	// Same UTC date, hour off by one
	const oneHourLater = new Date(Date.UTC(2025, 5, 15, 1, 0, 0));
	assertEquals(c.matches(oneHourLater), false);
});

Deno.test("timezone: getNextRun computes against TZ wall clock", () => {
	// "9am UTC daily" — easy to assert deterministically
	const c = new CronParser("0 9 * * *", { timezone: "UTC" });
	const from = new Date(Date.UTC(2025, 5, 15, 8, 0, 0));
	const next = c.getNextRun(from);
	assertEquals(next.getUTCFullYear(), 2025);
	assertEquals(next.getUTCMonth(), 5);
	assertEquals(next.getUTCDate(), 15);
	assertEquals(next.getUTCHours(), 9);
	assertEquals(next.getUTCMinutes(), 0);
});

Deno.test("timezone is stored", () => {
	const c = new CronParser("* * * * *", { timezone: "Europe/Prague" });
	assertEquals(c.timezone, "Europe/Prague");
});
