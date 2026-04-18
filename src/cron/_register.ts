import { CronParser } from "../cron-parser.ts";
import { type CronContext, type CronJob } from "./cron.ts";

/**
 * Upserts a cron job row identified by `name`.
 *
 * On INSERT: computes `next_run_at` via `CronParser.getNextRun()` (in the
 * job's timezone if provided).
 * On UPDATE (conflict on name): updates all fields but leaves `next_run_at`
 * unchanged — unless `forceRecalculate` is true — to avoid resetting a
 * pending schedule.
 */
export async function _register(
	context: CronContext,
	data: {
		name: string;
		expression: string;
		timezone: string | null;
		// deno-lint-ignore no-explicit-any
		payload: Record<string, any>;
		enabled: boolean;
		max_attempts: number;
		max_attempt_duration_ms: number;
		backoff_strategy: string;
	},
	forceRecalculate: boolean = false
): Promise<CronJob> {
	const { db, tableNames } = context;
	const { tableCron } = tableNames;

	const nextRunAt = new CronParser(data.expression, {
		timezone: data.timezone ?? undefined,
	}).getNextRun();

	const conflictNextRun = forceRecalculate
		? "next_run_at = EXCLUDED.next_run_at,"
		: "";

	const { rows } = await db.query(
		`INSERT INTO ${tableCron}
			(project_id, name, expression, timezone, payload, enabled, next_run_at,
			 max_attempts, max_attempt_duration_ms, backoff_strategy)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT (project_id, name) DO UPDATE SET
			expression              = EXCLUDED.expression,
			timezone                = EXCLUDED.timezone,
			payload                 = EXCLUDED.payload,
			enabled                 = EXCLUDED.enabled,
			max_attempts            = EXCLUDED.max_attempts,
			max_attempt_duration_ms = EXCLUDED.max_attempt_duration_ms,
			backoff_strategy        = EXCLUDED.backoff_strategy,
			${conflictNextRun}
			updated_at              = NOW()
		RETURNING *`,
		[
			context.projectId,
			data.name,
			data.expression,
			data.timezone,
			JSON.stringify(data.payload),
			data.enabled,
			nextRunAt,
			data.max_attempts,
			data.max_attempt_duration_ms,
			data.backoff_strategy,
		]
	);

	return rows[0] as CronJob;
}
