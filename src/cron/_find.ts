import { type CronContext, type CronJob } from "./cron.ts";

/** Finds a cron job by name. Returns `null` if not found. */
export async function _findByName(
	context: CronContext,
	name: string
): Promise<CronJob | null> {
	const { db, tableNames } = context;
	const { tableCron } = tableNames;

	const { rows } = await db.query(
		`SELECT * FROM ${tableCron} WHERE name = $1`,
		[name]
	);

	return (rows[0] as CronJob) ?? null;
}

/** Fetches all cron jobs with optional WHERE clause and pagination. */
export async function _fetchAll(
	context: CronContext,
	where: string | null = null,
	options: { limit?: number; offset?: number } = {}
): Promise<CronJob[]> {
	const { db, tableNames } = context;
	const { tableCron } = tableNames;

	const parts: string[] = [`SELECT * FROM ${tableCron}`];
	if (where) parts.push(`WHERE ${where}`);
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
