import { CRON_STATUS, RUN_STATUS, type CronContext } from "./cron.ts";

/**
 * Resets stuck `running` jobs back to `idle` (crash recovery).
 *
 * Jobs that have been in `running` state longer than `maxAllowedRunDurationMinutes`
 * are assumed to have crashed. They are reset to `idle` with `next_run_at = NOW()`
 * so they are immediately eligible for re-execution on the next poll.
 *
 * `lease_token` is cleared on the row. If the original (still-alive) worker
 * later returns to write a result, its `WHERE ... AND lease_token = $`
 * predicate fails and the write is silently dropped — preventing it from
 * clobbering whatever fresh execution has happened in the meantime.
 *
 * @param projectScoped - When true, only recovers jobs for `context.projectId`.
 *   When false (default), recovers all stuck jobs regardless of project.
 * @returns The number of rows recovered
 */
export async function _markStale(
	context: CronContext,
	maxAllowedRunDurationMinutes: number = 5,
	projectScoped: boolean = false
): Promise<number> {
	const { db, tableNames } = context;
	const { tableCron } = tableNames;

	if (projectScoped) {
		const result = await db.query(
			`UPDATE ${tableCron}
			SET status          = $1,
				last_run_status = $2,
				next_run_at     = NOW(),
				updated_at      = NOW(),
				lease_token     = NULL
			WHERE status = $3
			  AND project_id = $4
			  AND last_run_at < NOW() - ($5 * INTERVAL '1 minute')`,
			[
				CRON_STATUS.IDLE,
				RUN_STATUS.ERROR,
				CRON_STATUS.RUNNING,
				context.projectId,
				maxAllowedRunDurationMinutes,
			]
		);
		return result.rowCount ?? 0;
	}

	const result = await db.query(
		`UPDATE ${tableCron}
		SET status          = $1,
			last_run_status = $2,
			next_run_at     = NOW(),
			updated_at      = NOW(),
			lease_token     = NULL
		WHERE status = $3
		  AND last_run_at < NOW() - ($4 * INTERVAL '1 minute')`,
		[
			CRON_STATUS.IDLE,
			RUN_STATUS.ERROR,
			CRON_STATUS.RUNNING,
			maxAllowedRunDurationMinutes,
		]
	);
	return result.rowCount ?? 0;
}
