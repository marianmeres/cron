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
}

/**
 * Structural type accepted by `syncRegistryToCron`.
 * Works with both `Cron` and `CronProjectScope`.
 */
type CronLike = {
	setHandler(name: string, handler: CronHandler | undefined | null): unknown;
	hasHandler(name: string): boolean;
	fetchAll(options?: {
		enabled?: boolean;
		limit?: number;
		offset?: number;
	}): Promise<CronJob[]>;
};

/**
 * Wires task registry handlers to a Cron or CronProjectScope instance and detects orphan jobs.
 *
 * For each registered task type, calls `cron.setHandler(taskType, handler)`.
 * Then fetches all DB jobs and reports which ones have no matching registry entry.
 *
 * This function does NOT auto-create DB rows — the database remains the source
 * of truth for schedules. Use `cron.register()` separately to create job instances.
 *
 * @example
 * ```typescript
 * const { synced, orphans } = await syncRegistryToCron(cron, registry);
 * if (orphans.length) {
 *   console.warn("Jobs with no handler:", orphans);
 * }
 * ```
 */
export async function syncRegistryToCron(
	cron: CronLike,
	registry: TaskRegistry
): Promise<SyncRegistryResult> {
	const synced: string[] = [];

	for (const entry of registry.list()) {
		const def = registry.get(entry.taskType);
		if (def) {
			cron.setHandler(entry.taskType, def.handler);
			synced.push(entry.taskType);
		}
	}

	const allJobs = await cron.fetchAll();
	const registeredTypes = new Set(synced);
	const orphans = allJobs
		.filter((job) => !registeredTypes.has(job.name))
		.map((job) => job.name);

	return { synced, orphans };
}
