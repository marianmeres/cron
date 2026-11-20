import { EMPTY, raw, sql } from "@marianmeres/sqlkit";
import { _nextRunAt } from "./_next-run.ts";
import {
	BACKOFF_STRATEGY,
	CRON_STATUS,
	type CronContext,
	type CronJob,
	RUN_STATUS,
} from "./cron.ts";

/** Default cap on inter-attempt exponential backoff. */
export const DEFAULT_MAX_BACKOFF_MS = 5 * 60 * 1_000; // 5 minutes

/**
 * Handles failed execution (all attempts exhausted) of a cron job.
 *
 * Cron jobs are always recurring — even on failure the job returns to `idle`
 * with a new `next_run_at` so it will be retried on the next scheduled cycle.
 *
 * `next_run_at` comes from `_nextRunAt` (schedule-relative, in the job's
 * timezone, missed ticks skipped). Wrapped in a real transaction
 * (`context.db.transaction()`, one connection) so the row update is committed
 * atomically. Run log entries are
 * already written per-attempt by the caller.
 *
 * The `WHERE` clause checks `lease_token` so a stale-recovered job does not
 * overwrite a fresh execution.
 */
export async function _handleCronFailure(
	context: CronContext,
	job: CronJob,
	scheduledAt: Date,
	isTimeout: boolean,
	leaseToken: string | null,
): Promise<CronJob> {
	const { tableNames } = context;
	const { tableCron } = tableNames;

	const nextRunAt = _nextRunAt(job, scheduledAt);
	const runStatus = isTimeout ? RUN_STATUS.TIMEOUT : RUN_STATUS.ERROR;

	return await context.db.transaction(async (tx) => {
		const leaseFence =
			leaseToken !== null ? sql`AND lease_token = ${leaseToken}` : EMPTY;

		const { rows } = await tx.query<CronJob>(sql`
			UPDATE ${raw(tableCron)}
			SET status          = ${CRON_STATUS.IDLE},
				last_run_status = ${runStatus},
				last_run_at     = NOW(),
				next_run_at     = ${nextRunAt},
				updated_at      = NOW(),
				lease_token     = NULL
			WHERE id = ${job.id} ${leaseFence}
			RETURNING *`);

		return (rows[0] as CronJob | undefined) ?? job;
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
	maxMs: number = DEFAULT_MAX_BACKOFF_MS,
): number {
	const whitelist = [BACKOFF_STRATEGY.EXP, BACKOFF_STRATEGY.NONE];
	const effectiveStrategy = whitelist.includes(strategy as typeof BACKOFF_STRATEGY.EXP)
		? strategy
		: BACKOFF_STRATEGY.NONE;

	if (effectiveStrategy === BACKOFF_STRATEGY.EXP) {
		const raw = 2 ** attempt * 1_000;
		return Math.min(raw, Math.max(0, maxMs));
	}
	return 0;
}
