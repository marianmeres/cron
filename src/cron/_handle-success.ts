import { EMPTY, raw, sql } from "@marianmeres/sqlkit";
import { _logRunSuccess } from "./_log-run.ts";
import { _nextRunAt } from "./_next-run.ts";
import { CRON_STATUS, type CronContext, type CronJob, RUN_STATUS } from "./cron.ts";

/**
 * Handles successful execution of a cron job.
 *
 * In a single real transaction (`context.db.transaction()`, one connection):
 * 1. Sets the job back to `idle` (only if `lease_token` still matches —
 *    a stale-recovered job will silently no-op here)
 * 2. Advances `next_run_at` via `_nextRunAt` (relative to the intended
 *    schedule and in the job's timezone; missed ticks are skipped)
 * 3. Finalises the run log entry
 *
 * @param scheduledAt - The `next_run_at` captured at claim time
 * @param leaseToken - The `lease_token` issued at claim time; if NULL the
 *   write is unconditional (legacy schema fallback)
 * @returns The updated row, or the original `job` if the lease was lost
 */
export async function _handleCronSuccess(
	context: CronContext,
	job: CronJob,
	scheduledAt: Date,
	runLogId: number,
	result: unknown,
	leaseToken: string | null,
): Promise<CronJob> {
	const { tableNames } = context;
	const { tableCron } = tableNames;

	const nextRunAt = _nextRunAt(job, scheduledAt);

	return await context.db.transaction(async (tx) => {
		const leaseFence =
			leaseToken !== null ? sql`AND lease_token = ${leaseToken}` : EMPTY;

		const { rows } = await tx.query<CronJob>(sql`
			UPDATE ${raw(tableCron)}
			SET status          = ${CRON_STATUS.IDLE},
				last_run_status = ${RUN_STATUS.SUCCESS},
				last_run_at     = NOW(),
				next_run_at     = ${nextRunAt},
				updated_at      = NOW(),
				lease_token     = NULL
			WHERE id = ${job.id} ${leaseFence}
			RETURNING *`);

		// Always finalise the run log — the run did happen, even if the lease was lost
		await _logRunSuccess(context, runLogId, result, tx);

		// If the WHERE didn't match (lease lost), return the original job for the event payload
		return (rows[0] as CronJob | undefined) ?? job;
	});
}
