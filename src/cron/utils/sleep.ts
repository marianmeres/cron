/**
 * Delays execution for `timeout` milliseconds.
 *
 * Resolves early (without throwing) if the optional `signal` is aborted.
 *
 * @example
 * ```ts
 * await sleep(100);
 * ```
 *
 * @example
 * ```ts
 * // Usage with timer reference
 * let ref = { id: -1 };
 * some(() => sleep(100, ref))
 * // ...
 * clearTimeout(ref.id)
 * ```
 *
 * @example
 * ```ts
 * // Abortable sleep
 * const ctrl = new AbortController();
 * setTimeout(() => ctrl.abort(), 50);
 * await sleep(10_000, undefined, ctrl.signal); // returns after ~50ms
 * ```
 */
export function sleep(
	timeout: number,
	/**
	 * Deno.test is quite strict and reports every non-cleared timeout... so we have to
	 * be able to pass in some object ref if needed (eg when sleep is not resolved via Promise.race)
	 * to be able to do the clearing eventually.
	 *
	 * If calling directly `await sleep(x)` in a top level flow, this dance is not needed.
	 */
	__timeout_ref__: { id: number } = { id: -1 },
	signal?: AbortSignal
): Promise<void> {
	if (signal?.aborted) return Promise.resolve();

	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(__timeout_ref__.id);
			resolve(undefined);
		};

		__timeout_ref__.id = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			clearTimeout(__timeout_ref__.id);
			resolve(undefined);
		// deno-lint-ignore no-explicit-any
		}, timeout) as any;

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
