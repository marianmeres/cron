/**
 * Delays execution for `timeout` milliseconds.
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
	__timeout_ref__: { id: number } = { id: -1 }
): Promise<void> {
	return new Promise((resolve) => {
		__timeout_ref__.id = setTimeout(() => {
			clearTimeout(__timeout_ref__.id);
			resolve(undefined);
		}, timeout) as any;
	});
}
