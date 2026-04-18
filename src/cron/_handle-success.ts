import { CronParser } from "../cron-parser.ts";
import { CRON_STATUS, RUN_STATUS, type CronContext, type CronJob } from "./cron.ts";
import { _logRunSuccess } from "./_log-run.ts";
import { withTx } from "./utils/with-tx.ts";

/**
 * Handles successful execution of a cron job.
 *
 * In a single real transaction (one physical pg connection):
 * 1. Sets the job back to `idle` (only if `lease_token` still matches —
 *    a stale-recovered job will silently no-op here)
 * 2. Advances `next_run_at` using `scheduledAt` (drift-safe: relative to the
 *    intended schedule, not the actual wall clock time of completion)
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
	leaseToken: string | null
): Promise<CronJob> {
	const { tableNames } = context;
	const { tableCron } = tableNames;

	// Compute next run relative to the scheduled time to prevent drift
	const nextRunAt = new CronParser(job.expression).getNextRun(scheduledAt);

	return await withTx(context.db, async (client) => {
		const params: unknown[] = [
			CRON_STATUS.IDLE,
			RUN_STATUS.SUCCESS,
			nextRunAt,
			job.id,
		];
		let leaseClause = "";
		if (leaseToken !== null) {
			params.push(leaseToken);
			leaseClause = ` AND lease_token = $${params.length}`;
		}

		const { rows } = await client.query(
			`UPDATE ${tableCron}
			SET status          = $1,
				last_run_status = $2,
				last_run_at     = NOW(),
				next_run_at     = $3,
				updated_at      = NOW(),
				lease_token     = NULL
			WHERE id = $4${leaseClause}
			RETURNING *`,
			params
		);

		// Always finalise the run log — the run did happen, even if the lease was lost
		await _logRunSuccess(context, runLogId, result, client);

		// If the WHERE didn't match (lease lost), return the original job for the event payload
		return ((rows[0] as CronJob | undefined) ?? job);
	});
}
