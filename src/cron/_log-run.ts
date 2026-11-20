import { and, type Driver, EMPTY, json, raw, sql } from "@marianmeres/sqlkit";
import { type CronContext, type CronRunLog, RUN_STATUS } from "./cron.ts";

/** Opens a new run log entry. Returns the inserted row id. */
export async function _logRunStart(
	context: CronContext,
	cronId: number,
	cronName: string,
	scheduledAt: Date,
	attemptNumber: number,
	client?: Driver,
): Promise<number> {
	const { db, tableNames } = context;
	const { tableCronRunLog } = tableNames;
	const q = client ?? db;

	const { rows } = await q.query<{ id: number }>(sql`
		INSERT INTO ${raw(tableCronRunLog)} (cron_id, cron_name, tenant_id, scheduled_at, attempt_number)
		VALUES (${cronId}, ${cronName}, ${context.tenantId}, ${scheduledAt}, ${attemptNumber})
		RETURNING id`);

	return rows[0].id;
}

/**
 * Finalises a run log entry as successful.
 *
 * Pass the `tx` of an open `context.db.transaction()` to run inside it; otherwise
 * the call runs in autocommit mode against `context.db`.
 */
export async function _logRunSuccess(
	context: CronContext,
	runLogId: number,
	result: unknown,
	client?: Driver,
): Promise<void> {
	const { db, tableNames } = context;
	const { tableCronRunLog } = tableNames;
	const q = client ?? db;

	// Already JSON text (with its own fallback): bound as it is, never through `json()`,
	// which would store a JSON string holding JSON.
	let serialized: string;
	try {
		serialized = JSON.stringify(result ?? null);
	} catch (_e) {
		serialized = "null";
	}

	await q.query(sql`
		UPDATE ${raw(tableCronRunLog)}
		SET status = ${RUN_STATUS.SUCCESS},
			completed_at = NOW(),
			result = ${serialized}
		WHERE id = ${runLogId}`);
}

/** Finalises a run log entry as error or timeout. */
export async function _logRunError(
	context: CronContext,
	runLogId: number,
	errMessage: string,
	errDetails: { stack: string } | null,
	status: typeof RUN_STATUS.ERROR | typeof RUN_STATUS.TIMEOUT,
	client?: Driver,
): Promise<void> {
	const { db, tableNames } = context;
	const { tableCronRunLog } = tableNames;
	const q = client ?? db;

	// `json(null)` binds SQL NULL
	await q.query(sql`
		UPDATE ${raw(tableCronRunLog)}
		SET status = ${status},
			completed_at = NOW(),
			error_message = ${errMessage},
			error_details = ${json(errDetails)}
		WHERE id = ${runLogId}`);
}

/** Fetches the execution history for a given cron_id, newest first. */
export async function _logRunFetchAll(
	context: CronContext,
	cronId: number,
	options: {
		limit?: number;
		offset?: number;
		sinceMinutesAgo?: number;
	} = {},
): Promise<CronRunLog[]> {
	const { db, tableNames } = context;
	const { tableCronRunLog } = tableNames;

	// `sinceMinutesAgo` keeps its truthiness test: `0` means no window
	const where = and(
		sql`cron_id = ${cronId}`,
		options.sinceMinutesAgo
			? sql`started_at > NOW() - (${options.sinceMinutesAgo} * INTERVAL '1 minute')`
			: EMPTY,
	);

	const { rows } = await db.query<CronRunLog>(sql`
		SELECT * FROM ${raw(tableCronRunLog)}
		WHERE ${where}
		ORDER BY id DESC
		${options.limit !== undefined ? sql`LIMIT ${options.limit}` : EMPTY}
		${options.offset !== undefined ? sql`OFFSET ${options.offset}` : EMPTY}`);
	return rows;
}

/**
 * Deletes run log rows older than the given threshold.
 *
 * If `tenantScoped` is true, only rows for `context.tenantId` are deleted;
 * otherwise the prune is global. Returns the number of rows deleted.
 */
export async function _logRunPrune(
	context: CronContext,
	olderThanMinutes: number,
	tenantScoped: boolean = false,
): Promise<number> {
	const { db, tableNames } = context;
	const { tableCronRunLog } = tableNames;

	const result = await db.query(sql`
		DELETE FROM ${raw(tableCronRunLog)}
		WHERE started_at < NOW() - (${olderThanMinutes} * INTERVAL '1 minute')
			${tenantScoped ? sql`AND tenant_id = ${context.tenantId}` : EMPTY}`);
	return result.rowCount;
}
