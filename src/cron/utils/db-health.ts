/**
 * @module db-health
 *
 * Provides database health checking and monitoring utilities, on sqlkit's
 * `checkHealth` and `createHealthMonitor`: a check is one `select 1`, timed, and one
 * that has not answered within `timeoutMs` (5 s) is unhealthy. Includes one-time
 * health checks and periodic monitoring with state change callbacks.
 */

import type { Logger } from "@marianmeres/clog";
import {
	checkHealth,
	createHealthMonitor,
	type Driver,
	type HealthMonitor,
	type HealthStatus,
} from "@marianmeres/sqlkit";
import { type CronDb, toDriver } from "./driver.ts";

/**
 * Represents the result of a database health check.
 */
export interface DbHealthStatus {
	/** Whether the database is healthy and responding */
	healthy: boolean;
	/** Query latency in milliseconds, or null if check failed */
	latencyMs: number | null;
	/** Error message if the check failed: the driver's, or the timeout's */
	error: string | null;
	/** Timestamp of the health check (when it was sent) */
	timestamp: Date;
	/** PostgreSQL version string (if healthy) */
	pgVersion?: string;
}

/** The server version of each driver, once it answered; asked once per driver. */
const versions = new WeakMap<Driver, string>();

/**
 * The server version (`18.6`): asked once per driver, after a healthy check, and
 * remembered once it answered. Never rejects: a version it could not get is `undefined`,
 * and the next healthy check asks again.
 */
async function versionOf(driver: Driver): Promise<string | undefined> {
	const known = versions.get(driver);
	if (known !== undefined) return known;
	try {
		const result = await driver.query<{ version?: string | null }>(
			"SELECT version()",
		);
		// "PostgreSQL 18.6 on x86_64-pc-linux-gnu, …"
		const version = result.rows[0]?.version?.split(" ")[1];
		if (version) versions.set(driver, version);
		return version;
	} catch {
		return undefined;
	}
}

/** sqlkit's status, as cron has always reported it. */
function toStatus(s: HealthStatus, pgVersion?: string): DbHealthStatus {
	return {
		healthy: s.healthy,
		latencyMs: s.latencyMs,
		error: s.error?.message ?? null,
		timestamp: s.checkedAt,
		...(pgVersion ? { pgVersion } : {}),
	};
}

/**
 * Performs a one-time health check against the database.
 *
 * Executes a simple query to verify connectivity and measure latency, raced against
 * `timeoutMs`: a check that has not answered by then is unhealthy (its query is
 * abandoned, not cancelled). After a healthy check it also reports the PostgreSQL
 * version, asked once per driver.
 *
 * @param db - A `pg.Pool`, a `pg.Client` or a sqlkit `Driver`
 * @param logger - Optional logger for error reporting
 * @param options - `timeoutMs`: milliseconds after which a check that has not answered
 *   is unhealthy, above 0 (default: 5000)
 * @returns Health status with connectivity, latency, and version info; never rejects
 *   for a database that is down
 * @throws {TypeError} (as a rejection) If `db` is not a database, or an option is of
 *   the wrong type or out of range
 *
 * @example
 * ```typescript
 * const status = await checkDbHealth(pool, logger, { timeoutMs: 2000 });
 * if (!status.healthy) {
 *   console.error(`DB error: ${status.error}`);
 * }
 * ```
 */
export async function checkDbHealth(
	db: CronDb,
	logger?: Logger,
	options: { timeoutMs?: number } = {},
): Promise<DbHealthStatus> {
	const driver = toDriver(db);
	const s = await checkHealth(driver, options);
	if (!s.healthy) logger?.error?.(`DB health check failed: ${s.error?.message}`);
	return toStatus(s, s.healthy ? await versionOf(driver) : undefined);
}

/**
 * Periodic database health monitor with state change callbacks.
 *
 * Continuously monitors database health and triggers callbacks when
 * the database transitions between healthy and unhealthy states. The next check
 * starts `intervalMs` after the previous one answered or timed out, and its timers
 * never keep a process alive.
 *
 * @example
 * ```typescript
 * const monitor = new DbHealthMonitor(pool, {
 *   intervalMs: 30000,
 *   onUnhealthy: (status) => alertOps(status.error),
 *   onHealthy: () => clearAlert(),
 * });
 *
 * await monitor.start();
 * // Later...
 * monitor.stop();
 * ```
 */
export class DbHealthMonitor {
	#driver: Driver;
	#monitor: HealthMonitor;

	/**
	 * Creates a new DbHealthMonitor instance.
	 *
	 * @param db - A `pg.Pool`, a `pg.Client` or a sqlkit `Driver`
	 * @param options - Monitor configuration options
	 * @throws {TypeError} If `db` is not a database, or an option is of the wrong type
	 *   or out of range
	 */
	constructor(
		db: CronDb,
		options: {
			/** Check interval in milliseconds, above 0 (default: 30000; 0 also means the default) */
			intervalMs?: number;
			/** Milliseconds after which a check that has not answered is unhealthy, above 0 (default: 5000) */
			timeoutMs?: number;
			/** Logger for status messages */
			logger?: Logger;
			/** Callback when database becomes unhealthy */
			onUnhealthy?: (status: DbHealthStatus) => void;
			/** Callback when database recovers */
			onHealthy?: (status: DbHealthStatus) => void;
		} = {},
	) {
		const { logger, onUnhealthy, onHealthy } = options;
		const driver = toDriver(db);
		this.#driver = driver;
		this.#monitor = createHealthMonitor(driver, {
			intervalMs: options.intervalMs || 30_000,
			timeoutMs: options.timeoutMs,
			// Called with the first status (`previous` null), then on every flip. As
			// before, a first check that is healthy is no change.
			onChange: (status, previous) => {
				if (!status.healthy) {
					logger?.error?.(`DB health check failed: ${status.error?.message}`);
					logger?.error?.("Database became unhealthy");
					onUnhealthy?.(toStatus(status));
				} else if (previous !== null) {
					logger?.debug?.("Database recovered");
					// known when an earlier check was healthy; asked for the next status if not
					void versionOf(driver);
					onHealthy?.(toStatus(status, versions.get(driver)));
				}
			},
		});
	}

	/**
	 * Starts periodic health monitoring.
	 *
	 * Performs an initial check immediately, then schedules subsequent
	 * checks at the configured interval.
	 *
	 * @returns A Promise that resolves after the first check completes
	 */
	async start(): Promise<void> {
		await this.#monitor.start();
		if (this.#monitor.last()?.healthy) await versionOf(this.#driver);
	}

	/**
	 * Stops periodic health monitoring.
	 *
	 * Cancels any pending health checks.
	 */
	stop(): void {
		this.#monitor.stop();
	}

	/**
	 * Returns the most recent health check result.
	 *
	 * @returns The last health status, or `null` if no check has been performed
	 */
	getLastStatus(): DbHealthStatus | null {
		const last = this.#monitor.last();
		if (last === null) return null;
		return toStatus(last, last.healthy ? versions.get(this.#driver) : undefined);
	}
}
