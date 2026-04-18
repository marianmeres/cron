import { CronParser } from "../cron-parser.ts";
import {
	BACKOFF_STRATEGY,
	CRON_STATUS,
	RUN_STATUS,
	type CronContext,
	type CronJob,
} from "./cron.ts";
import { withTx } from "./utils/with-tx.ts";

/** Default cap on inter-attempt exponential backoff. */
export const DEFAULT_MAX_BACKOFF_MS = 5 * 60 * 1_000; // 5 minutes

/**
 * Handles failed execution (all attempts exhausted) of a cron job.
 *
 * Cron jobs are always recurring — even on failure the job returns to `idle`
 * with a new `next_run_at` so it will be retried on the next scheduled cycle.
 *
 * Uses `scheduledAt` for drift-safe `next_run_at` recalculation. Wrapped in a
 * real transaction (single pg connection) so the row update is committed
 * atomically. Run log entries are already written per-attempt by the caller.
 *
 * The `WHERE` clause checks `lease_token` so a stale-recovered job does not
 * overwrite a fresh execution.
 */
export async function _handleCronFailure(
	context: CronContext,
	job: CronJob,
	scheduledAt: Date,
	isTimeout: boolean,
	leaseToken: string | null
): Promise<CronJob> {
	const { tableNames } = context;
	const { tableCron } = tableNames;

	const nextRunAt = new CronParser(job.expression).getNextRun(scheduledAt);
	const runStatus = isTimeout ? RUN_STATUS.TIMEOUT : RUN_STATUS.ERROR;

	return await withTx(context.db, async (client) => {
		const params: unknown[] = [CRON_STATUS.IDLE, runStatus, nextRunAt, job.id];
		let leaseClause = "";
		if (leaseToken !== null) {
			params.push(leaseToken);
			leaseClause = ` AND lease_token = $${params.length}`;
		}

		const { rows } = await client.query(
			`UPDATE ${tableCron}
			SET status          = $1,
				last_run_status = $2,
				last_run_at     = NOW(),
				next_run_at     = $3,
				updated_at      = NOW(),
				lease_token     = NULL
			WHERE id = $4${leaseClause}
			RETURNING *`,
			params
		);

		return ((rows[0] as CronJob | undefined) ?? job);
	});
}

/**
 * Computes backoff delay in ms for a given attempt and strategy.
 *
 * Exponential growth is clamped at `maxMs` (default 5 min) so a single
 * "execution cycle" with many attempts never wedges for hours/days.
 */
export function _backoffMs(
	strategy: string,
	attempt: number,
	maxMs: number = DEFAULT_MAX_BACKOFF_MS
): number {
	const whitelist = [BACKOFF_STRATEGY.EXP, BACKOFF_STRATEGY.NONE];
	const effectiveStrategy = whitelist.includes(strategy as typeof BACKOFF_STRATEGY.EXP)
		? strategy
		: BACKOFF_STRATEGY.NONE;

	if (effectiveStrategy === BACKOFF_STRATEGY.EXP) {
		const raw = Math.pow(2, attempt) * 1_000;
		return Math.min(raw, Math.max(0, maxMs));
	}
	return 0;
}
