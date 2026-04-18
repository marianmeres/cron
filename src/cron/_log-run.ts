import type pg from "pg";
import { RUN_STATUS, type CronContext, type CronRunLog } from "./cron.ts";

/** A pg client or pool that we can call `query()` on. */
type Queryable = pg.PoolClient | pg.Client | pg.Pool;

/** Opens a new run log entry. Returns the inserted row id. */
export async function _logRunStart(
	context: CronContext,
	cronId: number,
	cronName: string,
	scheduledAt: Date,
	attemptNumber: number,
	client?: Queryable
): Promise<number> {
	const { db, tableNames } = context;
	const { tableCronRunLog } = tableNames;
	const q = client ?? db;

	const { rows } = await q.query(
		`INSERT INTO ${tableCronRunLog} (cron_id, cron_name, project_id, scheduled_at, attempt_number)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id`,
		[cronId, cronName, context.projectId, scheduledAt, attemptNumber]
	);

	return rows[0].id as number;
}

/**
 * Finalises a run log entry as successful.
 *
 * Pass `client` to run inside an existing transaction; otherwise the call
 * runs in autocommit mode against `context.db`.
 */
export async function _logRunSuccess(
	context: CronContext,
	runLogId: number,
	result: unknown,
	client?: Queryable
): Promise<void> {
	const { db, tableNames } = context;
	const { tableCronRunLog } = tableNames;
	const q = client ?? db;

	let serialized: string;
	try {
		serialized = JSON.stringify(result ?? null);
	} catch (_e) {
		serialized = "null";
	}

	await q.query(
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
	status: typeof RUN_STATUS.ERROR | typeof RUN_STATUS.TIMEOUT,
	client?: Queryable
): Promise<void> {
	const { db, tableNames } = context;
	const { tableCronRunLog } = tableNames;
	const q = client ?? db;

	await q.query(
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
		params.push(options.limit);
		parts.push(`LIMIT $${params.length}`);
	}
	if (options.offset !== undefined) {
		params.push(options.offset);
		parts.push(`OFFSET $${params.length}`);
	}

	const { rows } = await db.query(parts.join(" "), params);
	return rows as CronRunLog[];
}

/**
 * Deletes run log rows older than the given threshold.
 *
 * If `projectScoped` is true, only rows for `context.projectId` are deleted;
 * otherwise the prune is global. Returns the number of rows deleted.
 */
export async function _logRunPrune(
	context: CronContext,
	olderThanMinutes: number,
	projectScoped: boolean = false
): Promise<number> {
	const { db, tableNames } = context;
	const { tableCronRunLog } = tableNames;

	const sql = projectScoped
		? `DELETE FROM ${tableCronRunLog}
		   WHERE project_id = $1
		     AND started_at < NOW() - ($2 * INTERVAL '1 minute')`
		: `DELETE FROM ${tableCronRunLog}
		   WHERE started_at < NOW() - ($1 * INTERVAL '1 minute')`;

	const params = projectScoped
		? [context.projectId, olderThanMinutes]
		: [olderThanMinutes];

	const result = await db.query(sql, params);
	return result.rowCount ?? 0;
}
