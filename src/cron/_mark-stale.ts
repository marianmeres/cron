import { EMPTY, raw, sql } from "@marianmeres/sqlkit";
import { CRON_STATUS, type CronContext, RUN_STATUS } from "./cron.ts";

/**
 * Resets stuck `running` jobs back to `idle` (crash recovery).
 *
 * A `running` job whose `last_run_at` is older than `maxAllowedRunDurationMinutes`
 * is assumed to have crashed. It is reset to `idle` with `next_run_at = NOW()` so
 * it is immediately eligible for re-execution on the next poll.
 *
 * `last_run_at` is set at claim time and then renewed by the executing worker's
 * heartbeat (`_heartbeat.ts`), so the threshold measures *silence*, not total run
 * time: a live worker on a long job keeps its claim, a dead one loses it.
 *
 * `lease_token` is cleared on the row. If the original (still-alive) worker
 * later returns to write a result, its `WHERE ... AND lease_token = …`
 * predicate fails and the write is silently dropped — preventing it from
 * clobbering whatever fresh execution has happened in the meantime.
 *
 * @param tenantScoped - When true, only recovers jobs for `context.tenantId`.
 *   When false (default), recovers all stuck jobs regardless of tenant.
 * @returns The number of rows recovered
 */
export async function _markStale(
	context: CronContext,
	maxAllowedRunDurationMinutes: number = 5,
	tenantScoped: boolean = false,
): Promise<number> {
	const { db, tableNames } = context;
	const { tableCron } = tableNames;

	const result = await db.query(sql`
		UPDATE ${raw(tableCron)}
		SET status          = ${CRON_STATUS.IDLE},
			last_run_status = ${RUN_STATUS.ERROR},
			next_run_at     = NOW(),
			updated_at      = NOW(),
			lease_token     = NULL
		WHERE status = ${CRON_STATUS.RUNNING}
			${tenantScoped ? sql`AND tenant_id = ${context.tenantId}` : EMPTY}
			AND last_run_at < NOW() - (${maxAllowedRunDurationMinutes} * INTERVAL '1 minute')`);
	return result.rowCount;
}
