/** Error used in the Promise.race rejection */
export class TimeoutError extends Error {}

/**
 * Creates a new function which returns the promise-wrapped `fn`, which will
 * reject if the execution duration is longer than the provided `timeout`.
 */
export function withTimeout<T>(
	fn: CallableFunction,
	timeout: number = 1_000,
	errMessage?: string
): (...args: unknown[]) => Promise<T> {
	return (...args: unknown[]) => {
		const _promise = fn(...args);

		let _timeoutId: ReturnType<typeof setTimeout>;
		const _clock = new Promise((_, reject) => {
			_timeoutId = setTimeout(() => {
				reject(new TimeoutError(errMessage || `Timed out after ${timeout} ms`));
			}, timeout);
		});

		return new Promise<T>((res, rej) => {
			return Promise.race([_promise, _clock])
				.then(res)
				.catch(rej)
				.finally(() => clearTimeout(_timeoutId));
		});
	};
}
