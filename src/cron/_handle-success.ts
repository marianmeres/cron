import { CronParser } from "../cron-parser.ts";
import { CRON_STATUS, RUN_STATUS, type CronContext, type CronJob } from "./cron.ts";
import { _logRunSuccess } from "./_log-run.ts";

/**
 * Handles successful execution of a cron job.
 *
 * In a single transaction:
 * 1. Sets the job back to `idle`
 * 2. Advances `next_run_at` using `scheduledAt` (drift-safe: relative to the
 *    intended schedule, not the actual wall clock time of completion)
 * 3. Finalises the run log entry
 *
 * @param scheduledAt - The `next_run_at` captured at claim time
 */
export async function _handleCronSuccess(
	context: CronContext,
	job: CronJob,
	scheduledAt: Date,
	runLogId: number,
	result: any
): Promise<CronJob> {
	const { db, tableNames } = context;
	const { tableCron } = tableNames;

	// Compute next run relative to the scheduled time to prevent drift
	const nextRunAt = new CronParser(job.expression).getNextRun(scheduledAt);

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
			[CRON_STATUS.IDLE, RUN_STATUS.SUCCESS, nextRunAt, job.id]
		)
	).rows[0];

	await _logRunSuccess(context, runLogId, result);

	await db.query("COMMIT");

	return updatedJob as CronJob;
}
