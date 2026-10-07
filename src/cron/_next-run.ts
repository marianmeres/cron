import { CronParser } from "@marianmeres/cron-parser";
import type { CronJob } from "./cron.ts";

/**
 * Computes the `next_run_at` to store once an execution cycle has ended.
 *
 * Single source of truth for both `_handleCronSuccess` and `_handleCronFailure`.
 * Two rules, applied in this order:
 *
 * 1. **Schedule-relative.** The next slot is derived from `scheduledAt` (the
 *    `next_run_at` that was claimed), evaluated in the job's own timezone —
 *    never from the wall clock. A worker whose clock lags the database could
 *    otherwise compute the very slot it has just run and fire it twice.
 *
 * 2. **Never in the past.** If that slot has already gone by — the process was
 *    down, or the run outlasted its own interval — the missed ticks are skipped
 *    and the job resumes at the first slot after `now`. Without this floor a job
 *    replays every missed tick back-to-back. (A slot that is due exactly `now`
 *    is not missed and is kept.)
 *
 * @param scheduledAt - The `next_run_at` captured at claim time
 * @param now - Injectable clock (tests)
 */
export function _nextRunAt(
	job: Pick<CronJob, "expression" | "timezone">,
	scheduledAt: Date,
	now: Date = new Date()
): Date {
	const parser = new CronParser(job.expression, {
		timezone: job.timezone ?? undefined,
	});

	const next = parser.getNextRun(scheduledAt);
	return next.getTime() >= now.getTime() ? next : parser.getNextRun(now);
}
