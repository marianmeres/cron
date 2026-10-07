import { type CronContext, type CronHealthPreviewRow } from "./cron.ts";

/**
 * Returns execution statistics from the run log, grouped by status.
 *
 * `count` / `avg_duration_seconds` are cast to `int` / `float8` so pg hands back
 * JS numbers (bare `COUNT(*)` is a bigint and `ROUND(numeric)` a numeric — both
 * arrive as strings).
 *
 * @param sinceMinutesAgo - Time window for the query (default: 60 minutes)
 */
export async function _healthPreview(
	context: CronContext,
	sinceMinutesAgo: number = 60
): Promise<CronHealthPreviewRow[]> {
	const { db, tableNames } = context;
	const { tableCronRunLog } = tableNames;

	const { rows } = await db.query(
		`SELECT
			status,
			COUNT(*)::int AS count,
			ROUND(
				AVG(EXTRACT(EPOCH FROM (completed_at - started_at)))::numeric,
				3
			)::float8 AS avg_duration_seconds
		FROM ${tableCronRunLog}
		WHERE tenant_id = $1
		  AND started_at > NOW() - ($2 * INTERVAL '1 minute')
		GROUP BY status
		ORDER BY status`,
		[context.tenantId, sinceMinutesAgo]
	);

	return rows;
}
