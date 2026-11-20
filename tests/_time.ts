import { sleep } from "../src/cron/utils/sleep.ts";

/**
 * Sleeps past the next wall-clock minute boundary when it is closer than `windowMs`.
 *
 * For a test that has to keep a per-minute (`* * * * *`) job: a boundary passing while
 * it runs makes the job due again. Call it first, before the test's own setup. It costs
 * at most `windowMs`, and only when the test would have started that close to a boundary.
 */
export async function clearOfMinuteBoundary(windowMs = 1_500): Promise<void> {
	const left = 60_000 - (Date.now() % 60_000);
	if (left < windowMs) await sleep(left + 50);
}
