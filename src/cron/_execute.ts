import { type CronContext, type CronHandler, type CronJob, RUN_STATUS } from "./cron.ts";
import { _handleCronSuccess } from "./_handle-success.ts";
import { _handleCronFailure, _backoffMs } from "./_handle-failure.ts";
import { _startHeartbeat } from "./_heartbeat.ts";
import { _logRunStart, _logRunError } from "./_log-run.ts";
import { withTimeout, TimeoutError } from "./utils/with-timeout.ts";
import { sleep } from "./utils/sleep.ts";

/** Optional knobs for `_executeCronJob`. */
export interface ExecuteCronJobOptions {
	/**
	 * Wraps every DB bookkeeping write (run log + result). The `Cron` class
	 * passes its `dbRetry`-aware wrapper; defaults to a plain call.
	 *
	 * Retrying is safe: the result writes are fenced by `lease_token` and the
	 * run-log updates are idempotent. The one write that is not — the run-log
	 * INSERT — can at worst leave an extra, never-finalised row behind.
	 */
	withRetry?: <T>(fn: () => Promise<T>) => Promise<T>;
	/** Lease heartbeat cadence in ms. `0` / omitted disables it. */
	heartbeatIntervalMs?: number;
}

/**
 * Orchestrates the full execution of one claimed cron job.
 *
 * Retry loop:
 * - Up to `job.max_attempts` attempts within a single execution cycle
 * - On success: calls `_handleCronSuccess` and publishes `pubsubDone`
 * - On all-attempts-failure: calls `_handleCronFailure` and publishes `pubsubError`
 *
 * Only an error thrown by the **handler** counts as a failed attempt. A failure
 * to record the outcome (DB unreachable after the handler already returned) is
 * a different thing: it propagates to the caller instead of being logged as a
 * handler error and triggering a re-run of work that succeeded.
 *
 * Remaining retries are abandoned when the instance is shutting down or the
 * lease was lost — the cycle then ends as a failure.
 *
 * Note: `job.next_run_at` at the time this is called IS the `scheduledAt` — the
 * claim UPDATE does not modify `next_run_at`, so it still holds the intended schedule.
 *
 * `leaseToken` is the value written to `lease_token` at claim time. Success /
 * failure handlers use it as a fence against stale-recovered re-claims, and the
 * heartbeat renews it for the duration of the cycle.
 *
 * @throws If the outcome could not be recorded. The row then stays `running`
 *   until stale recovery (`cleanup()`) resets it.
 */
export async function _executeCronJob(
	context: CronContext,
	job: CronJob,
	handler: CronHandler,
	leaseToken: string | null,
	shutdownSignal?: AbortSignal,
	options: ExecuteCronJobOptions = {}
): Promise<void> {
	const withRetry = options.withRetry ?? (<T>(fn: () => Promise<T>) => fn());

	// The job row is the source of truth for the tenant. Processors are global and
	// hand in the instance's root context, so re-scope it here — otherwise every
	// run-log row would be stamped with the instance's own tenant.
	const ctx: CronContext =
		context.tenantId === job.tenant_id
			? context
			: { ...context, tenantId: job.tenant_id };

	const eventKey = `${job.tenant_id}\0${job.name}`;

	// Capture scheduled time before any success/failure handler changes it
	const scheduledAt = job.next_run_at;

	// Mutated from the heartbeat callback, hence an object rather than `let`s.
	const state: { leaseLost: boolean; attemptCtrl: AbortController | null } = {
		leaseLost: false,
		attemptCtrl: null,
	};

	let isTimeout = false;

	// Spans the whole cycle, backoff sleeps included.
	const stopHeartbeat = _startHeartbeat(
		ctx,
		job,
		leaseToken,
		options.heartbeatIntervalMs ?? 0,
		() => {
			state.leaseLost = true;
			state.attemptCtrl?.abort(new Error("Cron job lease lost"));
		}
	);

	try {
		for (let attempt = 1; attempt <= job.max_attempts; attempt++) {
			// The first attempt always runs (the job is already claimed). Further
			// retries are pointless once we are shutting down or no longer own
			// the lease.
			if (attempt > 1 && (shutdownSignal?.aborted || state.leaseLost)) break;

			const runLogId = await withRetry(() =>
				_logRunStart(ctx, job.id, job.name, scheduledAt, attempt)
			);

			// Per-attempt abort controller. Triggered on timeout, shutdown or lease loss.
			const attemptCtrl = new AbortController();
			state.attemptCtrl = attemptCtrl;
			const onShutdown = () => attemptCtrl.abort(new Error("Cron is shutting down"));
			// An already-aborted signal never fires "abort" again — handle it eagerly
			// so the handler is not handed a live signal during shutdown.
			if (shutdownSignal?.aborted) onShutdown();
			else shutdownSignal?.addEventListener("abort", onShutdown, { once: true });

			// Plain variables rather than a discriminated union: the npm build
			// compiles without `strictNullChecks`, where that narrowing is lost.
			let failed = false;
			let result: unknown;
			let error: unknown;
			try {
				// Pass abort signal as second handler argument — handlers can opt in.
				let __handler = () => handler(job, attemptCtrl.signal);

				if (job.max_attempt_duration_ms > 0) {
					__handler = withTimeout(
						__handler,
						job.max_attempt_duration_ms,
						"Execution timed out",
						attemptCtrl
					);
				}

				result = await __handler();
			} catch (e: unknown) {
				failed = true;
				error = e;
			} finally {
				shutdownSignal?.removeEventListener("abort", onShutdown);
				state.attemptCtrl = null;
			}

			if (!failed) {
				// SUCCESS: update main row + finalise run log in a single TX
				const completedJob = await withRetry(() =>
					_handleCronSuccess(ctx, job, scheduledAt, runLogId, result, leaseToken)
				);

				ctx.pubsubDone.publish(eventKey, completedJob);
				return; // done
			}

			isTimeout = error instanceof TimeoutError;

			const runStatus = isTimeout ? RUN_STATUS.TIMEOUT : RUN_STATUS.ERROR;
			const errMsg = error instanceof Error ? error.message : `${error}`;
			const errStack =
				error instanceof Error && error.stack ? { stack: error.stack } : null;

			await withRetry(() => _logRunError(ctx, runLogId, errMsg, errStack, runStatus));

			// Apply backoff before next attempt (if any remain)
			if (attempt < job.max_attempts) {
				const delay = _backoffMs(job.backoff_strategy, attempt);
				if (delay > 0) await sleep(delay, undefined, shutdownSignal);
			}
		}

		// All attempts exhausted (or abandoned) — advance schedule so job remains alive
		const failedJob = await withRetry(() =>
			_handleCronFailure(ctx, job, scheduledAt, isTimeout, leaseToken)
		);

		ctx.pubsubError.publish(eventKey, failedJob);
	} finally {
		stopHeartbeat();
	}
}
