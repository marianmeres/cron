import { CRON_STATUS, type CronContext, type CronJob } from "./cron.ts";

/**
 * Atomically claims the next eligible cron job by marking it as `running`.
 *
 * Uses `FOR UPDATE SKIP LOCKED` so concurrent workers never double-claim.
 * The returned job's `next_run_at` is the scheduled time captured at claim —
 * this value is used downstream for drift-safe `next_run_at` recalculation.
 *
 * @returns The claimed CronJob, or `null` if nothing is due
 */
export async function _claimNextCronJob(
	context: CronContext
): Promise<CronJob | null> {
	const { db, tableNames } = context;
	const { tableCron } = tableNames;

	const result = await db.query(`
		UPDATE ${tableCron}
		SET status      = '${CRON_STATUS.RUNNING}',
			last_run_at = NOW(),
			updated_at  = NOW()
		WHERE id = (
			SELECT id FROM ${tableCron}
			WHERE enabled = TRUE
			  AND status = '${CRON_STATUS.IDLE}'
			  AND next_run_at <= NOW()
			ORDER BY next_run_at ASC
			FOR UPDATE SKIP LOCKED
			LIMIT 1
		)
		RETURNING *`);

	return result.rows[0] ?? null;
}
