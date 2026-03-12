/**
 * @module db-health
 *
 * Provides database health checking and monitoring utilities.
 * Includes one-time health checks and periodic monitoring with
 * state change callbacks.
 */

import type pg from "pg";
import type { Logger } from "@marianmeres/clog";

/**
 * Represents the result of a database health check.
 */
export interface DbHealthStatus {
	/** Whether the database is healthy and responding */
	healthy: boolean;
	/** Query latency in milliseconds, or null if check failed */
	latencyMs: number | null;
	/** Error message if the check failed */
	error: string | null;
	/** Timestamp of the health check */
	timestamp: Date;
	/** PostgreSQL version string (if healthy) */
	pgVersion?: string;
}

/**
 * Performs a one-time health check against the database.
 *
 * Executes a simple query to verify connectivity and measure latency.
 * Also retrieves the PostgreSQL version.
 *
 * @param db - PostgreSQL connection pool or client
 * @param logger - Optional logger for error reporting
 * @returns Health status with connectivity, latency, and version info
 *
 * @example
 * ```typescript
 * const status = await checkDbHealth(pool);
 * if (!status.healthy) {
 *   console.error(`DB error: ${status.error}`);
 * }
 * ```
 */
export async function checkDbHealth(
	db: pg.Pool | pg.Client,
	logger?: Logger
): Promise<DbHealthStatus> {
	const start = Date.now();
	const timestamp = new Date();

	try {
		// Simple query to test connection
		const result = await db.query("SELECT version(), NOW() as now");
		const latencyMs = Date.now() - start;

		return {
			healthy: true,
			latencyMs,
			error: null,
			timestamp,
			pgVersion: result.rows[0]?.version?.split(" ")[1], // Extract version number
		};
	} catch (error: any) {
		const latencyMs = Date.now() - start;
		logger?.error?.(`DB health check failed: ${error?.message}`);

		return {
			healthy: false,
			latencyMs,
			error: error?.message || String(error),
			timestamp,
		};
	}
}

/**
 * Periodic database health monitor with state change callbacks.
 *
 * Continuously monitors database health and triggers callbacks when
 * the database transitions between healthy and unhealthy states.
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
	#db: pg.Pool | pg.Client;
	#logger?: Logger;
	#intervalMs: number;
	#timeoutId: any = null;
	#isRunning = false;
	#lastStatus: DbHealthStatus | null = null;
	#onUnhealthy?: (status: DbHealthStatus) => void;
	#onHealthy?: (status: DbHealthStatus) => void;

	/**
	 * Creates a new DbHealthMonitor instance.
	 *
	 * @param db - PostgreSQL connection pool or client
	 * @param options - Monitor configuration options
	 */
	constructor(
		db: pg.Pool | pg.Client,
		options: {
			/** Check interval in milliseconds (default: 30000) */
			intervalMs?: number;
			/** Logger for status messages */
			logger?: Logger;
			/** Callback when database becomes unhealthy */
			onUnhealthy?: (status: DbHealthStatus) => void;
			/** Callback when database recovers */
			onHealthy?: (status: DbHealthStatus) => void;
		} = {}
	) {
		this.#db = db;
		this.#logger = options.logger;
		this.#intervalMs = options.intervalMs || 30_000;
		this.#onUnhealthy = options.onUnhealthy;
		this.#onHealthy = options.onHealthy;
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
		if (this.#isRunning) return;

		this.#isRunning = true;
		await this.#scheduleNext();
	}

	/**
	 * Stops periodic health monitoring.
	 *
	 * Cancels any pending health checks.
	 */
	stop(): void {
		this.#isRunning = false;
		if (this.#timeoutId) {
			clearTimeout(this.#timeoutId);
			this.#timeoutId = null;
		}
	}

	/**
	 * Returns the most recent health check result.
	 *
	 * @returns The last health status, or `null` if no check has been performed
	 */
	getLastStatus(): DbHealthStatus | null {
		return this.#lastStatus;
	}

	async #scheduleNext(): Promise<void> {
		if (!this.#isRunning) return;

		// Perform the check
		await this.#check();

		// Schedule next check (only if still running)
		if (this.#isRunning) {
			this.#timeoutId = setTimeout(() => this.#scheduleNext(), this.#intervalMs);
		}
	}

	async #check(): Promise<void> {
		const status = await checkDbHealth(this.#db, this.#logger);
		const wasHealthy = this.#lastStatus?.healthy ?? true;

		this.#lastStatus = status;

		// Trigger callbacks on state changes
		if (!status.healthy && wasHealthy) {
			this.#logger?.error?.("Database became unhealthy");
			this.#onUnhealthy?.(status);
		} else if (status.healthy && !wasHealthy) {
			this.#logger?.debug?.("Database recovered");
			this.#onHealthy?.(status);
		}

		// Log if unhealthy
		if (!status.healthy) {
			this.#logger?.warn?.(
				`DB health check failed (latency: ${status.latencyMs}ms): ${status.error}`
			);
		}
	}
}
