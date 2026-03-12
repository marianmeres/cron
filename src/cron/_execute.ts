import { type CronContext, type CronHandler, type CronJob, RUN_STATUS } from "./cron.ts";
import { _handleCronSuccess } from "./_handle-success.ts";
import { _handleCronFailure, _backoffMs } from "./_handle-failure.ts";
import { _logRunStart, _logRunError } from "./_log-run.ts";
import { withTimeout, TimeoutError } from "./utils/with-timeout.ts";
import { sleep } from "./utils/sleep.ts";

/**
 * Orchestrates the full execution of one claimed cron job.
 *
 * Retry loop:
 * - Up to `job.max_attempts` attempts within a single execution cycle
 * - On success: calls `_handleCronSuccess` and publishes `pubsubDone`
 * - On all-attempts-failure: calls `_handleCronFailure` and publishes `pubsubError`
 *
 * Note: `job.next_run_at` at the time this is called IS the `scheduledAt` — the
 * claim UPDATE does not modify `next_run_at`, so it still holds the intended schedule.
 */
export async function _executeCronJob(
	context: CronContext,
	job: CronJob,
	handler: CronHandler
): Promise<void> {
	// Capture scheduled time before any success/failure handler changes it
	const scheduledAt = job.next_run_at;

	let lastError: any = null;
	let isTimeout = false;

	for (let attempt = 1; attempt <= job.max_attempts; attempt++) {
		const runLogId = await _logRunStart(
			context,
			job.id,
			job.name,
			scheduledAt,
			attempt
		);

		try {
			let __handler = () => handler(job);

			if (job.max_attempt_duration_ms > 0) {
				__handler = withTimeout(
					__handler,
					job.max_attempt_duration_ms,
					"Execution timed out"
				) as any;
			}

			const result = await __handler();

			// SUCCESS: update main row + finalise run log in a single TX
			const completedJob = await _handleCronSuccess(
				context,
				job,
				scheduledAt,
				runLogId,
				result
			);

			context.pubsubDone.publish(job.name, completedJob);
			return; // done

		} catch (error: any) {
			lastError = error;
			isTimeout = error instanceof TimeoutError;

			const runStatus = isTimeout ? RUN_STATUS.TIMEOUT : RUN_STATUS.ERROR;

			await _logRunError(
				context,
				runLogId,
				error?.message ?? `${error}`,
				error?.stack ? { stack: error.stack } : null,
				runStatus
			);

			// Apply backoff before next attempt (if any remain)
			if (attempt < job.max_attempts) {
				const delay = _backoffMs(job.backoff_strategy, attempt);
				if (delay > 0) await sleep(delay);
			}
		}
	}

	// All attempts exhausted — advance schedule so job remains alive
	const failedJob = await _handleCronFailure(
		context,
		job,
		scheduledAt,
		isTimeout
	);

	context.pubsubError.publish(job.name, failedJob);
}
