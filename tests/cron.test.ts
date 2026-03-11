import { assertEquals } from "@std/assert";
import { name } from "../src/cron.ts";

Deno.test("sanity check", () => {
	assertEquals(name(), "it works");
});

// // Usage examples:
// const cron1 = new CronParser("*/15 * * * *"); // Every 15 minutes
// const cron2 = new CronParser("0 9 * * 1-5"); // 9 AM on weekdays
// const cron3 = new CronParser("30 14 1 * *"); // 2:30 PM on 1st of each month

// console.log(cron1.matches(new Date("2025-11-07T10:15:00")));
// console.log(cron2.getNextRun());

// // Now these will throw descriptive errors:
// try {
// 	new CronParser("0 9 * * MON"); // Invalid characters
// } catch (e) {
// 	console.error(e.message);
// }

// try {
// 	new CronParser("0 25 * * *"); // Hour out of range
// } catch (e) {
// 	console.error(e.message);
// }

// try {
// 	new CronParser("0 9 * *"); // Missing field
// } catch (e) {
// 	console.error(e.message);
// }
