import { CronParser } from "../cron-parser.ts";
import {
	BACKOFF_STRATEGY,
	CRON_STATUS,
	RUN_STATUS,
	type CronContext,
	type CronJob,
} from "./cron.ts";

/**
 * Handles failed execution (all attempts exhausted) of a cron job.
 *
 * Cron jobs are always recurring — even on failure the job returns to `idle`
 * with a new `next_run_at` so it will be retried on the next scheduled cycle.
 *
 * Uses `scheduledAt` for drift-safe `next_run_at` recalculation.
 * Run log entries are already written per-attempt by the caller.
 */
export async function _handleCronFailure(
	context: CronContext,
	job: CronJob,
	scheduledAt: Date,
	isTimeout: boolean
): Promise<CronJob> {
	const { db, tableNames } = context;
	const { tableCron } = tableNames;

	// Compute next run relative to the scheduled time to prevent drift
	const nextRunAt = new CronParser(job.expression).getNextRun(scheduledAt);
	const runStatus = isTimeout ? RUN_STATUS.TIMEOUT : RUN_STATUS.ERROR;

	await db.query("BEGIN");

	const updatedJob = (
		await db.query(
			`UPDATE ${tableCron}
			SET status          = $1,
				last_run_status = $2,
				last_run_at     = NOW(),
				next_run_at     = $3,
				updated_at      = NOW()
			WHERE id = $4
			RETURNING *`,
			[CRON_STATUS.IDLE, runStatus, nextRunAt, job.id]
		)
	).rows[0];

	await db.query("COMMIT");

	return updatedJob as CronJob;
}

/** Computes backoff delay in ms for a given attempt and strategy. */
export function _backoffMs(
	strategy: string,
	attempt: number
): number {
	const whitelist = [BACKOFF_STRATEGY.EXP, BACKOFF_STRATEGY.NONE];
	const effectiveStrategy = whitelist.includes(strategy as any)
		? strategy
		: BACKOFF_STRATEGY.NONE;

	if (effectiveStrategy === BACKOFF_STRATEGY.EXP) {
		return Math.pow(2, attempt) * 1_000; // 2^attempt seconds
	}
	return 0;
}
