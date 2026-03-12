import { type CronContext } from "./cron.ts";

/**
 * Returns execution statistics from the run log, grouped by status.
 *
 * @param sinceMinutesAgo - Time window for the query (default: 60 minutes)
 */
export async function _healthPreview(
	context: CronContext,
	sinceMinutesAgo: number = 60
): Promise<any[]> {
	const { db, tableNames } = context;
	const { tableCronRunLog } = tableNames;

	const { rows } = await db.query(
		`SELECT
			status,
			COUNT(*) AS count,
			ROUND(
				AVG(EXTRACT(EPOCH FROM (completed_at - started_at)))::numeric,
				3
			) AS avg_duration_seconds
		FROM ${tableCronRunLog}
		WHERE started_at > NOW() - ($1 * INTERVAL '1 minute')
		GROUP BY status
		ORDER BY status`,
		[sinceMinutesAgo]
	);

	return rows;
}
