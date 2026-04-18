import { type CronContext, type CronJob } from "./cron.ts";

/** Finds a cron job by name (scoped to project). Returns `null` if not found. */
export async function _findByName(
	context: CronContext,
	name: string
): Promise<CronJob | null> {
	const { db, tableNames } = context;
	const { tableCron } = tableNames;

	const { rows } = await db.query(
		`SELECT * FROM ${tableCron} WHERE project_id = $1 AND name = $2`,
		[context.projectId, name]
	);

	return (rows[0] as CronJob) ?? null;
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

/** Fetches all cron jobs (scoped to project) with optional filters and pagination. */
export async function _fetchAll(
	context: CronContext,
	options: FetchAllOptions = {}
): Promise<CronJob[]> {
	const { db, tableNames } = context;
	const { tableCron } = tableNames;

	const params: unknown[] = [context.projectId];
	const conditions: string[] = [`project_id = $${params.length}`];

	if (options.enabled !== undefined) {
		params.push(options.enabled);
		conditions.push(`enabled = $${params.length}`);
	}
	if (options.status !== undefined) {
		params.push(options.status);
		conditions.push(`status = $${params.length}`);
	}

	const parts: string[] = [
		`SELECT * FROM ${tableCron}`,
		`WHERE ${conditions.join(" AND ")}`,
		`ORDER BY name ASC`,
	];

	if (options.limit !== undefined) {
		params.push(options.limit);
		parts.push(`LIMIT $${params.length}`);
	}
	if (options.offset !== undefined) {
		params.push(options.offset);
		parts.push(`OFFSET $${params.length}`);
	}

	const { rows } = await db.query(parts.join(" "), params);
	return rows as CronJob[];
}
