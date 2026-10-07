/**
 * Marks a timer as not keeping the process alive (Node/Bun `timer.unref()`,
 * Deno `Deno.unrefTimer(id)`). A no-op where neither exists.
 *
 * Used for background timers that must never be the only reason a process
 * stays up — the timer still fires as long as something else keeps it running.
 */
export function unrefTimer(timer: unknown): void {
	// deno-lint-ignore no-explicit-any
	const t = timer as any;
	if (typeof t?.unref === "function") {
		t.unref();
		return;
	}
	// deno-lint-ignore no-explicit-any
	(globalThis as any).Deno?.unrefTimer?.(t);
}
