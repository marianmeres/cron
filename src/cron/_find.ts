import { type CronContext, type CronJob } from "./cron.ts";
import { pgQuoteValue } from "./utils/pg-quote.ts";

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

/** Fetches all cron jobs (scoped to project) with optional WHERE clause and pagination. */
export async function _fetchAll(
	context: CronContext,
	where: string | null = null,
	options: { limit?: number; offset?: number } = {}
): Promise<CronJob[]> {
	const { db, tableNames } = context;
	const { tableCron } = tableNames;

	const projectCondition = `project_id = ${pgQuoteValue(context.projectId)}`;
	const fullWhere = where
		? `${projectCondition} AND ${where}`
		: projectCondition;

	const parts: string[] = [`SELECT * FROM ${tableCron}`];
	parts.push(`WHERE ${fullWhere}`);
	parts.push("ORDER BY name ASC");
	if (options.limit !== undefined) {
		parts.push(`LIMIT ${parseInt(`${options.limit}`)}`);
	}
	if (options.offset !== undefined) {
		parts.push(`OFFSET ${parseInt(`${options.offset}`)}`);
	}

	const { rows } = await db.query(parts.join(" "));
	return rows as CronJob[];
}
