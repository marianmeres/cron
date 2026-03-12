import { RUN_STATUS, type CronContext, type CronRunLog } from "./cron.ts";

/** Opens a new run log entry. Returns the inserted row id. */
export async function _logRunStart(
	context: CronContext,
	cronId: number,
	cronName: string,
	scheduledAt: Date,
	attemptNumber: number
): Promise<number> {
	const { db, tableNames } = context;
	const { tableCronRunLog } = tableNames;

	const { rows } = await db.query(
		`INSERT INTO ${tableCronRunLog} (cron_id, cron_name, project_id, scheduled_at, attempt_number)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id`,
		[cronId, cronName, context.projectId, scheduledAt, attemptNumber]
	);

	return rows[0].id as number;
}

/** Finalises a run log entry as successful. Must be called within an open transaction. */
export async function _logRunSuccess(
	context: CronContext,
	runLogId: number,
	result: unknown
): Promise<void> {
	const { db, tableNames } = context;
	const { tableCronRunLog } = tableNames;

	let serialized: string;
	try {
		serialized = JSON.stringify(result ?? null);
	} catch (_e) {
		serialized = "null";
	}

	await db.query(
		`UPDATE ${tableCronRunLog}
		SET status = $1,
			completed_at = NOW(),
			result = $2
		WHERE id = $3`,
		[RUN_STATUS.SUCCESS, serialized, runLogId]
	);
}

/** Finalises a run log entry as error or timeout. */
export async function _logRunError(
	context: CronContext,
	runLogId: number,
	errMessage: string,
	errDetails: { stack: string } | null,
	status: typeof RUN_STATUS.ERROR | typeof RUN_STATUS.TIMEOUT
): Promise<void> {
	const { db, tableNames } = context;
	const { tableCronRunLog } = tableNames;

	await db.query(
		`UPDATE ${tableCronRunLog}
		SET status = $1,
			completed_at = NOW(),
			error_message = $2,
			error_details = $3
		WHERE id = $4`,
		[
			status,
			errMessage,
			errDetails ? JSON.stringify(errDetails) : null,
			runLogId,
		]
	);
}

/** Fetches the execution history for a given cron_id, newest first. */
export async function _logRunFetchAll(
	context: CronContext,
	cronId: number,
	options: {
		limit?: number;
		offset?: number;
		sinceMinutesAgo?: number;
	} = {}
): Promise<CronRunLog[]> {
	const { db, tableNames } = context;
	const { tableCronRunLog } = tableNames;

	const parts: string[] = [`SELECT * FROM ${tableCronRunLog} WHERE cron_id = $1`];
	const params: (number | string | Date)[] = [cronId];

	if (options.sinceMinutesAgo) {
		params.push(options.sinceMinutesAgo);
		parts.push(`AND started_at > NOW() - ($${params.length} * INTERVAL '1 minute')`);
	}

	parts.push("ORDER BY id DESC");

	if (options.limit !== undefined) {
		parts.push(`LIMIT ${parseInt(`${options.limit}`)}`);
	}
	if (options.offset !== undefined) {
		parts.push(`OFFSET ${parseInt(`${options.offset}`)}`);
	}

	const { rows } = await db.query(parts.join(" "), params);
	return rows as CronRunLog[];
}
