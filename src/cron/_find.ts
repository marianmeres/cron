import { and, EMPTY, raw, sql } from "@marianmeres/sqlkit";
import type { CronContext, CronJob } from "./cron.ts";

/** Finds a cron job by name (scoped to tenant). Returns `null` if not found. */
export async function _findByName(
	context: CronContext,
	name: string,
): Promise<CronJob | null> {
	const { db, tableNames } = context;
	const { tableCron } = tableNames;

	const { rows } = await db.query<CronJob>(
		sql`SELECT * FROM ${raw(tableCron)} WHERE tenant_id = ${context.tenantId} AND name = ${name}`,
	);

	return rows[0] ?? null;
}

/**
 * Filter / pagination options accepted by `_fetchAll`.
 * Pass via the higher-level `Cron.fetchAll()` API.
 */
export interface FetchAllOptions {
	enabled?: boolean;
	status?: "idle" | "running";
	limit?: number;
	offset?: number;
}

/** Fetches all cron jobs (scoped to tenant) with optional filters and pagination. */
export async function _fetchAll(
	context: CronContext,
	options: FetchAllOptions = {},
): Promise<CronJob[]> {
	const { db, tableNames } = context;
	const { tableCron } = tableNames;

	const where = and(
		sql`tenant_id = ${context.tenantId}`,
		options.enabled !== undefined ? sql`enabled = ${options.enabled}` : EMPTY,
		options.status !== undefined ? sql`status = ${options.status}` : EMPTY,
	);

	const { rows } = await db.query<CronJob>(sql`
		SELECT * FROM ${raw(tableCron)}
		WHERE ${where}
		ORDER BY name ASC
		${options.limit !== undefined ? sql`LIMIT ${options.limit}` : EMPTY}
		${options.offset !== undefined ? sql`OFFSET ${options.offset}` : EMPTY}`);
	return rows;
}
