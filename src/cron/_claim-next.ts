import { CRON_STATUS, type CronContext, type CronJob } from "./cron.ts";

/**
 * Atomically claims the next eligible cron job by marking it as `running`.
 *
 * Uses `FOR UPDATE SKIP LOCKED` so concurrent workers never double-claim.
 * Claims any due job regardless of `project_id` — project scoping is handled
 * by the management layer, not the processor.
 *
 * Issues a fresh `lease_token` (UUID) per claim. Stale-recovery (`_markStale`)
 * clears the column; success/failure handlers compare against it as a fence.
 *
 * @returns The claimed CronJob and its `lease_token`, or `null` if nothing is due
 */
export async function _claimNextCronJob(
	context: CronContext
): Promise<{ job: CronJob; leaseToken: string } | null> {
	const { db, tableNames } = context;
	const { tableCron } = tableNames;

	const result = await db.query(
		`UPDATE ${tableCron}
		SET status      = $1,
			last_run_at = NOW(),
			updated_at  = NOW(),
			lease_token = gen_random_uuid()
		WHERE id = (
			SELECT id FROM ${tableCron}
			WHERE enabled = TRUE
			  AND status = $2
			  AND next_run_at <= NOW()
			ORDER BY next_run_at ASC
			FOR UPDATE SKIP LOCKED
			LIMIT 1
		)
		RETURNING *`,
		[CRON_STATUS.RUNNING, CRON_STATUS.IDLE]
	);

	const row = result.rows[0] as (CronJob & { lease_token: string }) | undefined;
	if (!row) return null;
	return { job: row, leaseToken: row.lease_token };
}
