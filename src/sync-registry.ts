import { type CronHandler, type CronJob } from "./cron.ts";
import { type TaskRegistry } from "./task-registry.ts";

/**
 * Result of syncing a task registry with a Cron instance.
 */
export interface SyncRegistryResult {
	/** Task types whose handlers were successfully wired */
	synced: string[];
	/** Job names in the DB that have no matching registry entry */
	orphans: string[];
	/** Handler names removed because they no longer appear in the registry */
	removedHandlers: string[];
}

/**
 * Structural type accepted by `syncRegistryToCron`.
 * Works with both `Cron` and `CronProjectScope`.
 */
type CronLike = {
	setHandler(name: string, handler: CronHandler | undefined | null): unknown;
	hasHandler(name: string): boolean;
	removeHandler(name: string): unknown;
	listHandlerNames(): string[];
	fetchAll(options?: {
		enabled?: boolean;
		limit?: number;
		offset?: number;
	}): Promise<CronJob[]>;
};

/** Page size for the orphan-detection scan. Tunable via `options.pageSize`. */
const DEFAULT_PAGE_SIZE = 500;

/**
 * Wires task registry handlers to a Cron or CronProjectScope instance and
 * detects / cleans up out-of-sync state.
 *
 * For each registered task type, calls `cron.setHandler(taskType, handler)`.
 * Then:
 * - Removes any in-memory handlers that no longer appear in the registry
 *   (`removedHandlers`).
 * - Scans DB jobs in pages and reports those with no matching registry entry
 *   (`orphans`).
 *
 * This function does NOT auto-create or auto-delete DB rows — the database
 * remains the source of truth for schedules. Use `cron.register()` /
 * `cron.unregister()` separately to manage job instances.
 *
 * @example
 * ```typescript
 * const { synced, orphans, removedHandlers } = await syncRegistryToCron(cron, registry);
 * if (orphans.length) {
 *   console.warn("Jobs with no handler:", orphans);
 * }
 * ```
 */
export async function syncRegistryToCron(
	cron: CronLike,
	registry: TaskRegistry,
	options: { pageSize?: number } = {}
): Promise<SyncRegistryResult> {
	const synced: string[] = [];
	const registeredTypes = new Set<string>();

	for (const entry of registry.list()) {
		const def = registry.get(entry.taskType);
		if (def) {
			cron.setHandler(entry.taskType, def.handler);
			synced.push(entry.taskType);
			registeredTypes.add(entry.taskType);
		}
	}

	// Remove in-memory handlers that no longer appear in the registry.
	const removedHandlers: string[] = [];
	for (const name of cron.listHandlerNames()) {
		if (!registeredTypes.has(name)) {
			cron.removeHandler(name);
			removedHandlers.push(name);
		}
	}

	// Scan DB jobs in pages — avoids loading all rows at once for large installs.
	const pageSize = Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE);
	const orphans: string[] = [];
	let offset = 0;
	while (true) {
		const page = await cron.fetchAll({ limit: pageSize, offset });
		for (const job of page) {
			if (!registeredTypes.has(job.name)) orphans.push(job.name);
		}
		if (page.length < pageSize) break;
		offset += pageSize;
	}

	return { synced, orphans, removedHandlers };
}
