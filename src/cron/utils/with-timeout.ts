/** Error used in the Promise.race rejection */
export class TimeoutError extends Error {}

/**
 * Wraps `fn` so that it rejects with a `TimeoutError` if it doesn't settle
 * within `timeout` ms.
 *
 * If an `AbortController` is provided, it is `abort()`-ed when the timeout
 * fires. Pass the controller's `signal` into `fn` (e.g. `fn(signal)`) to
 * give the wrapped work a chance to actually cancel — `Promise.race` alone
 * just stops *waiting* for `fn`; the underlying work keeps running until it
 * notices the abort.
 *
 * @example
 * ```ts
 * const ctrl = new AbortController();
 * const wrapped = withTimeout(
 *   () => fetch(url, { signal: ctrl.signal }),
 *   5_000,
 *   "fetch too slow",
 *   ctrl
 * );
 * await wrapped();
 * ```
 */
export function withTimeout<T>(
	fn: CallableFunction,
	timeout: number = 1_000,
	errMessage?: string,
	abortController?: AbortController
): (...args: unknown[]) => Promise<T> {
	return (...args: unknown[]) => {
		let _timeoutId: ReturnType<typeof setTimeout>;

		const _clock = new Promise<never>((_, reject) => {
			_timeoutId = setTimeout(() => {
				const err = new TimeoutError(
					errMessage || `Timed out after ${timeout} ms`
				);
				abortController?.abort(err);
				reject(err);
			}, timeout);
		});

		const _promise = Promise.resolve().then(() => fn(...args));

		return Promise.race([_promise, _clock]).finally(() =>
			clearTimeout(_timeoutId)
		) as Promise<T>;
	};
}
