import type { CronContext, CronJob } from "./cron.ts";
import { unrefTimer } from "./utils/unref-timer.ts";

/**
 * Keeps a claimed job's lease alive while it executes.
 *
 * Every `intervalMs` the row's `last_run_at` is bumped to `NOW()` — but only
 * while `lease_token` still matches. `_markStale` measures staleness from
 * `last_run_at`, so a job that legitimately runs longer than the stale
 * threshold is no longer mistaken for a crashed one and re-claimed while its
 * first execution is still in flight. A worker that really died stops beating,
 * and is recovered as before.
 *
 * If a beat matches no row the lease is gone (stale-recovered after this
 * worker was frozen, or the job was unregistered). Beating stops and
 * `onLeaseLost` fires so the caller can cancel work whose result would be
 * discarded by the lease fence anyway.
 *
 * A failed beat (transient DB trouble) is logged and retried on the next tick.
 * The timer is unref'd: it never keeps the process alive on its own.
 *
 * @returns A `stop()` function. Always call it (use `finally`).
 */
export function _startHeartbeat(
	context: CronContext,
	job: Pick<CronJob, "id" | "name" | "tenant_id">,
	leaseToken: string | null,
	intervalMs: number,
	onLeaseLost: () => void
): () => void {
	// No lease to renew (legacy callers) or heartbeat disabled
	if (leaseToken === null || !(intervalMs > 0)) return () => {};

	const { db, tableNames, logger } = context;
	const { tableCron } = tableNames;
	const label = `"${job.name}" (tenant: ${job.tenant_id})`;

	let timer: ReturnType<typeof setInterval> | null = null;
	let stopped = false;
	let inFlight = false;

	const stop = () => {
		stopped = true;
		if (timer !== null) clearInterval(timer);
		timer = null;
	};

	const beat = async () => {
		// Never stack beats on a slow DB
		if (stopped || inFlight) return;
		inFlight = true;
		try {
			const res = await db.query(
				`UPDATE ${tableCron}
				SET last_run_at = NOW()
				WHERE id = $1 AND lease_token = $2`,
				[job.id, leaseToken]
			);
			if (!stopped && (res.rowCount ?? 0) === 0) {
				stop();
				logger?.warn?.(`Cron job ${label}: lease lost, aborting this execution`);
				onLeaseLost();
			}
		} catch (e) {
			if (!stopped) {
				logger?.warn?.(
					`Cron job ${label}: heartbeat failed (will retry): ${
						e instanceof Error ? e.message : e
					}`
				);
			}
		} finally {
			inFlight = false;
		}
	};

	timer = setInterval(() => void beat(), intervalMs);
	unrefTimer(timer);

	return stop;
}
