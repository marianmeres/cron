import { createClog, type Logger } from "@marianmeres/clog";
import { createPubSub, type Unsubscriber } from "@marianmeres/pubsub";
import process from "node:process";
import type pg from "pg";
import { CronParser } from "../cron-parser.ts";
import { _claimNextCronJob } from "./_claim-next.ts";
import { _executeCronJob } from "./_execute.ts";
import { _fetchAll, _findByName } from "./_find.ts";
import { _healthPreview } from "./_health-preview.ts";
import { _logRunFetchAll } from "./_log-run.ts";
import { _markStale } from "./_mark-stale.ts";
import { _register } from "./_register.ts";
import {
	_initialize,
	_schemaCreate,
	_schemaDrop,
	_uninstall,
} from "./_schema.ts";
import { pgQuoteValue } from "./utils/pg-quote.ts";
import { sleep } from "./utils/sleep.ts";
import { withDbRetry, type DbRetryOptions } from "./utils/with-db-retry.ts";
import {
	checkDbHealth,
	DbHealthMonitor,
	type DbHealthStatus,
} from "./utils/db-health.ts";

/**
 * Available cron job statuses.
 *
 * - `IDLE` - Job is waiting for its next scheduled run
 * - `RUNNING` - Job is currently being executed
 */
export const CRON_STATUS = {
	IDLE: "idle",
	RUNNING: "running",
} as const;

/**
 * Available run log statuses.
 *
 * - `SUCCESS` - Execution completed successfully
 * - `ERROR` - Execution failed with an error
 * - `TIMEOUT` - Execution exceeded the allowed duration
 */
export const RUN_STATUS = {
	SUCCESS: "success",
	ERROR: "error",
	TIMEOUT: "timeout",
} as const;

/**
 * Available backoff strategies for retries within a single execution cycle.
 *
 * - `NONE` - No delay between retries
 * - `EXP` - Exponential backoff: 2^attempt seconds
 */
export const BACKOFF_STRATEGY = {
	NONE: "none",
	EXP: "exp",
} as const;

/**
 * Handler function type for cron jobs.
 *
 * The returned value is stored in the run log's `result` field.
 * Throw an error to indicate failure.
 */
export type CronHandler = (job: CronJob) => any | Promise<any>;

/**
 * Internal context passed to cron utilities.
 * @internal
 */
export interface CronContext {
	db: pg.Pool | pg.Client;
	tableNames: {
		tableCron: string;
		tableCronRunLog: string;
	};
	logger: Logger;
	pubsubDone: ReturnType<typeof createPubSub>;
	pubsubError: ReturnType<typeof createPubSub>;
}

/**
 * Represents a cron job row in the database.
 *
 * Unlike one-time jobs, cron jobs are always recurring — they toggle between
 * `idle` and `running` indefinitely. Terminal states live only in the run log.
 */
export interface CronJob {
	id: number;
	uid: string;
	name: string;
	expression: string;
	payload: Record<string, any>;
	enabled: boolean;
	status: typeof CRON_STATUS.IDLE | typeof CRON_STATUS.RUNNING;
	next_run_at: Date;
	last_run_at: Date | null;
	last_run_status:
		| typeof RUN_STATUS.SUCCESS
		| typeof RUN_STATUS.ERROR
		| typeof RUN_STATUS.TIMEOUT
		| null;
	max_attempts: number;
	max_attempt_duration_ms: number;
	backoff_strategy: typeof BACKOFF_STRATEGY.NONE | typeof BACKOFF_STRATEGY.EXP;
	created_at: Date;
	updated_at: Date;
}

/**
 * Represents a single execution entry in the run log.
 */
export interface CronRunLog {
	id: number;
	cron_id: number;
	cron_name: string;
	/** The next_run_at value that was claimed — used for drift-safe scheduling */
	scheduled_at: Date;
	started_at: Date;
	completed_at: Date | null;
	attempt_number: number;
	status:
		| typeof RUN_STATUS.SUCCESS
		| typeof RUN_STATUS.ERROR
		| typeof RUN_STATUS.TIMEOUT
		| null;
	result: Record<string, any> | null;
	error_message: string | null;
	error_details: Record<string, any> | null;
}

/**
 * Options for registering a cron job.
 */
export interface CronRegisterOptions {
	payload?: Record<string, any>;
	enabled?: boolean;
	max_attempts?: number;
	max_attempt_duration_ms?: number;
	backoff_strategy?: typeof BACKOFF_STRATEGY.NONE | typeof BACKOFF_STRATEGY.EXP;
	/**
	 * By default, re-registering an existing job does NOT recalculate `next_run_at`
	 * (to avoid resetting a pending schedule). Set this to `true` to force recalculation.
	 */
	forceNextRunRecalculate?: boolean;
}

/**
 * Configuration options for the Cron manager.
 *
 * @example
 * ```typescript
 * const cron = new Cron({
 *   db: pgPool,
 *   pollTimeoutMs: 1000,
 *   dbRetry: true,
 * });
 * ```
 */
export interface CronOptions {
	db: pg.Pool | pg.Client;
	logger?: Logger;
	/** Table name prefix, e.g. "myschema." for schema qualification */
	tablePrefix?: string;
	/** Polling interval in milliseconds when no jobs are due (default: 1000) */
	pollTimeoutMs?: number;
	/** Enable SIGTERM listener for graceful shutdown (default: true) */
	gracefulSigterm?: boolean;
	/** Enable database retry on transient failures (true = defaults, or provide options) */
	dbRetry?: DbRetryOptions | boolean;
	/** Enable database health monitoring (true = defaults, or provide options) */
	dbHealthCheck?:
		| boolean
		| {
				intervalMs?: number;
				onUnhealthy?: (status: DbHealthStatus) => void;
				onHealthy?: (status: DbHealthStatus) => void;
		  };
}

/** @internal */
function _tableNames(tablePrefix: string = ""): CronContext["tableNames"] {
	return {
		tableCron: `${tablePrefix}__cron`,
		tableCronRunLog: `${tablePrefix}__cron_run_log`,
	};
}

/**
 * PostgreSQL-based recurring cron job scheduler.
 *
 * Manages named cron jobs with PostgreSQL persistence, `FOR UPDATE SKIP LOCKED`
 * claiming for safe concurrent workers, and drift-safe `next_run_at` scheduling.
 *
 * @example
 * ```typescript
 * import { Cron } from "@marianmeres/cron";
 *
 * const cron = new Cron({ db: pgPool });
 *
 * await cron.register("backup", "0 2 * * *", async (job) => {
 *   await runBackup(job.payload);
 *   return { backed_up: true };
 * });
 *
 * await cron.start(1);
 *
 * cron.onDone("backup", (job) => {
 *   console.log(`Backup completed, next run: ${job.next_run_at}`);
 * });
 *
 * // On shutdown:
 * await cron.stop();
 * ```
 */
export class Cron {
	readonly pollTimeoutMs: number;
	readonly gracefulSigterm: boolean;
	readonly tablePrefix: string;

	#db: pg.Pool | pg.Client;
	#handlers: Map<string, CronHandler> = new Map();
	#logger: Logger;
	#pubsubDone: ReturnType<typeof createPubSub> = createPubSub();
	#pubsubError: ReturnType<typeof createPubSub> = createPubSub();
	#context: CronContext;

	#isShuttingDown = false;
	#wasInitialized = false;
	#activeJobs = new Set<number>();
	#jobProcessors: Promise<void>[] = [];

	// event handler try/catch wraps (triggered outside typical request handlers)
	static #onEventWraps = new Map<CallableFunction, CallableFunction>();

	// prevent log spam on consecutive claim errors
	#claimErrorCounter = 0;

	#dbRetryOptions: DbRetryOptions | null = null;
	#healthMonitor: DbHealthMonitor | null = null;

	constructor(options: CronOptions) {
		const {
			db,
			pollTimeoutMs = 1_000,
			tablePrefix = "",
			logger = createClog("cron"),
			gracefulSigterm = true,
			dbRetry,
			dbHealthCheck,
		} = options || {};

		this.#db = db;
		this.#logger = logger;
		this.pollTimeoutMs = pollTimeoutMs;
		this.tablePrefix = tablePrefix;
		this.gracefulSigterm = gracefulSigterm;

		if (dbRetry) {
			this.#dbRetryOptions =
				dbRetry === true
					? { logger: this.#logger }
					: { ...dbRetry, logger: this.#logger };
		}

		if (dbHealthCheck) {
			const healthOptions =
				dbHealthCheck === true
					? { logger: this.#logger }
					: { ...dbHealthCheck, logger: this.#logger };
			this.#healthMonitor = new DbHealthMonitor(this.#db, healthOptions);
		}

		this.#context = {
			db: this.#db,
			tableNames: _tableNames(tablePrefix),
			logger: this.#logger,
			pubsubDone: this.#pubsubDone,
			pubsubError: this.#pubsubError,
		};
	}

	/** Wrapper for database operations with optional retry */
	async #withRetry<T>(fn: () => Promise<T>): Promise<T> {
		if (this.#dbRetryOptions) {
			return await withDbRetry(fn, this.#dbRetryOptions);
		}
		return await fn();
	}

	async #initializeOnce(hard?: boolean): Promise<void> {
		if (!this.#wasInitialized) {
			await _initialize(this.#context, !!hard);
			this.#wasInitialized = true;
			this.#logger?.debug?.(`System initialized${hard ? " (hard)" : ""}`);

			if (this.gracefulSigterm) {
				process.on("SIGTERM", async () => {
					this.#logger?.debug?.(`SIGTERM detected...`);
					await this.stop();
				});
			}
		}
	}

	async #processJobs(processorId: string): Promise<void> {
		const noopHandler: CronHandler = (_job) => ({ noop: true });
		const limit = 10;

		while (!this.#isShuttingDown) {
			try {
				const job = await this.#withRetry(() => _claimNextCronJob(this.#context));
				if (job) {
					this.#activeJobs.add(job.id);
					try {
						this.#logger?.debug?.(`Executing cron job "${job.name}"...`);
						const handler = this.#handlers.get(job.name);
						if (!handler) {
							this.#logger?.warn?.(
								`No handler for cron job "${job.name}", using noop`
							);
						}
						await _executeCronJob(
							this.#context,
							job,
							handler ?? noopHandler
						);
					} finally {
						this.#activeJobs.delete(job.id);
					}
				} else {
					await sleep(this.pollTimeoutMs);
				}

				if (this.#claimErrorCounter) {
					if (this.#claimErrorCounter >= limit) {
						this.#logger?.debug?.(`Cron claim error reporting RESUMED...`);
					}
					this.#claimErrorCounter = 0;
				}
			} catch (e: any) {
				this.#claimErrorCounter++;
				if (this.#claimErrorCounter < limit) {
					this.#logger?.error?.(`Cron claim: ${e?.stack ?? e}`);
				} else if (this.#claimErrorCounter === limit) {
					this.#logger?.debug?.(`Cron claim error reporting MUTED...`);
				}
			}
		}

		// shutdown: wait for active executions to finish
		if (this.#activeJobs.size > 0) {
			this.#logger?.debug?.(
				`Waiting for ${this.#activeJobs.size} cron job(s) to complete...`
			);
			while (this.#activeJobs.size > 0) {
				await sleep(100);
			}
		}

		this.#logger?.debug?.(`Cron processor "${processorId}" stopped`);
	}

	// --- Handler management ---

	/**
	 * Returns `true` if an in-memory handler is registered for the given name.
	 */
	hasHandler(name: string): boolean {
		return this.#handlers.has(name);
	}

	/**
	 * Registers or removes a handler for a specific cron job name.
	 *
	 * Does not touch the database. Useful for re-registering handlers on restart.
	 *
	 * @returns The Cron instance for method chaining
	 */
	setHandler(name: string, handler: CronHandler | undefined | null): Cron {
		if (typeof handler === "function") {
			this.#handlers.set(name, handler);
		} else {
			this.#handlers.delete(name);
		}
		return this;
	}

	/**
	 * Removes the in-memory handler for the given name.
	 *
	 * @returns The Cron instance for method chaining
	 */
	removeHandler(name: string): Cron {
		this.#handlers.delete(name);
		return this;
	}

	/** Removes all registered in-memory handlers. */
	resetHandlers(): void {
		this.#handlers.clear();
	}

	// --- Lifecycle ---

	/**
	 * Initializes the database schema (if needed) and starts N polling workers.
	 *
	 * @param processorsCount - Number of concurrent workers (default: 2)
	 */
	async start(processorsCount: number = 2): Promise<void> {
		try {
			if (this.#isShuttingDown) {
				const msg = `Cannot start (shutdown in progress detected)`;
				this.#logger?.error?.(msg);
				throw new Error(msg);
			}

			await this.#initializeOnce();

			if (this.#healthMonitor) {
				await this.#healthMonitor.start();
				this.#logger?.debug?.("DB health monitoring started");
			}
		} catch (e) {
			this.#logger?.error?.(`Unable to start: ${e}`);
			this.#logger?.error?.(`CRON NOT STARTED`);
			return;
		}

		for (let i = 0; i < processorsCount; i++) {
			const processorId = `cron-processor-${i}`;
			const processor = this.#processJobs(processorId);
			this.#jobProcessors.push(processor);
		}
		this.#logger?.debug?.(
			`Cron processors initialized (count: ${processorsCount})...`
		);
	}

	/**
	 * Gracefully stops all polling workers.
	 *
	 * Waits for all currently executing jobs to complete.
	 */
	async stop(): Promise<void> {
		if (this.#healthMonitor) {
			this.#healthMonitor.stop();
			this.#logger?.debug?.("DB health monitoring stopped");
		}

		this.#isShuttingDown = true;
		await Promise.all(this.#jobProcessors);
		this.#jobProcessors = [];
		this.#isShuttingDown = false;
	}

	/**
	 * Drops and recreates the database schema.
	 *
	 * **Warning:** Deletes all cron job data. Intended for testing only.
	 */
	async resetHard(): Promise<void> {
		this.#wasInitialized = false;
		return await this.#initializeOnce(true);
	}

	/**
	 * Permanently removes all tables created by this package.
	 *
	 * **Warning:** Destructive and irreversible.
	 */
	async uninstall(): Promise<void> {
		return await _uninstall(this.#context);
	}

	// --- Registration ---

	/**
	 * Registers (or updates) a cron job and its handler.
	 *
	 * On first call: creates the DB row and computes `next_run_at`.
	 * On subsequent calls with the same name: updates expression/options but
	 * leaves `next_run_at` unchanged unless `forceNextRunRecalculate` is set.
	 *
	 * @throws If `expression` is not a valid cron expression
	 */
	async register(
		name: string,
		expression: string,
		handler: CronHandler,
		options: CronRegisterOptions = {}
	): Promise<CronJob> {
		const {
			payload = {},
			enabled = true,
			max_attempts = 1,
			max_attempt_duration_ms = 0,
			backoff_strategy = BACKOFF_STRATEGY.NONE,
			forceNextRunRecalculate = false,
		} = options;

		// Validate expression early (throws on invalid)
		new CronParser(expression);

		await this.#initializeOnce();

		this.setHandler(name, handler);

		return await _register(
			this.#context,
			{
				name,
				expression,
				payload,
				enabled,
				max_attempts,
				max_attempt_duration_ms,
				backoff_strategy,
			},
			forceNextRunRecalculate
		);
	}

	/**
	 * Hard-deletes a cron job (and its run log) from the database.
	 *
	 * Also removes the in-memory handler.
	 */
	async unregister(name: string): Promise<void> {
		await this.#initializeOnce();
		const { db, tableNames } = this.#context;
		const { tableCron } = tableNames;
		await db.query(`DELETE FROM ${tableCron} WHERE name = $1`, [name]);
		this.#handlers.delete(name);
	}

	/**
	 * Enables a previously disabled cron job.
	 *
	 * @returns The updated CronJob row
	 */
	async enable(name: string): Promise<CronJob> {
		await this.#initializeOnce();
		const { db, tableNames } = this.#context;
		const { tableCron } = tableNames;
		const { rows } = await db.query(
			`UPDATE ${tableCron}
			SET enabled = TRUE, updated_at = NOW()
			WHERE name = $1
			RETURNING *`,
			[name]
		);
		return rows[0] as CronJob;
	}

	/**
	 * Disables a cron job. Disabled jobs are skipped by the polling workers.
	 *
	 * @returns The updated CronJob row
	 */
	async disable(name: string): Promise<CronJob> {
		await this.#initializeOnce();
		const { db, tableNames } = this.#context;
		const { tableCron } = tableNames;
		const { rows } = await db.query(
			`UPDATE ${tableCron}
			SET enabled = FALSE, updated_at = NOW()
			WHERE name = $1
			RETURNING *`,
			[name]
		);
		return rows[0] as CronJob;
	}

	// --- Querying ---

	/**
	 * Finds a cron job by name.
	 *
	 * @returns The CronJob row, or `null` if not found
	 */
	async find(name: string): Promise<CronJob | null> {
		await this.#initializeOnce();
		return await _findByName(this.#context, name);
	}

	/**
	 * Fetches all registered cron jobs with optional filtering.
	 */
	async fetchAll(
		options: {
			enabled?: boolean;
			status?: typeof CRON_STATUS.IDLE | typeof CRON_STATUS.RUNNING;
			limit?: number;
			offset?: number;
		} = {}
	): Promise<CronJob[]> {
		await this.#initializeOnce();

		const conditions: string[] = [];
		if (options.enabled !== undefined) {
			conditions.push(`enabled = ${options.enabled ? "TRUE" : "FALSE"}`);
		}
		if (options.status) {
			conditions.push(`status = ${pgQuoteValue(options.status)}`);
		}

		const where = conditions.length ? conditions.join(" AND ") : null;
		return await _fetchAll(this.#context, where, options);
	}

	/**
	 * Fetches the execution history for a named cron job.
	 *
	 * @returns Array of run log entries, newest first
	 */
	async getRunHistory(
		name: string,
		options: { limit?: number; offset?: number; sinceMinutesAgo?: number } = {}
	): Promise<CronRunLog[]> {
		await this.#initializeOnce();
		const job = await _findByName(this.#context, name);
		if (!job) return [];
		return await _logRunFetchAll(this.#context, job.id, options);
	}

	// --- Maintenance ---

	/**
	 * Resets stuck `running` jobs back to `idle` (crash recovery).
	 *
	 * Jobs are considered stale if they have been running for longer than
	 * `maxAllowedRunDurationMinutes` (default: 5).
	 */
	async cleanup(maxAllowedRunDurationMinutes: number = 5): Promise<void> {
		await this.#initializeOnce();
		return await _markStale(this.#context, maxAllowedRunDurationMinutes);
	}

	/**
	 * Returns execution statistics grouped by run status.
	 *
	 * @param sinceMinutesAgo - Time window for statistics (default: 60)
	 */
	async healthPreview(sinceMinutesAgo: number = 60): Promise<any[]> {
		await this.#initializeOnce();
		return await _healthPreview(this.#context, sinceMinutesAgo);
	}

	// --- Events ---

	/**
	 * Subscribes to successful completion events for the given job name(s).
	 *
	 * @returns Unsubscribe function
	 *
	 * @example
	 * ```typescript
	 * const unsub = cron.onDone("backup", (job) => {
	 *   console.log(`Next backup at: ${job.next_run_at}`);
	 * });
	 * ```
	 */
	onDone(
		name: string | string[],
		cb: (job: CronJob) => void,
		skipIfExists: boolean = true
	): Unsubscriber {
		return this.#onEvent(this.#pubsubDone, name, cb, skipIfExists);
	}

	/**
	 * Subscribes to error/timeout events for the given job name(s).
	 *
	 * @returns Unsubscribe function
	 */
	onError(
		name: string | string[],
		cb: (job: CronJob) => void,
		skipIfExists: boolean = true
	): Unsubscriber {
		return this.#onEvent(this.#pubsubError, name, cb, skipIfExists);
	}

	#onEvent(
		pubsub: ReturnType<typeof createPubSub>,
		name: string | string[],
		cb: (job: CronJob) => void,
		skipIfExists: boolean
	): Unsubscriber {
		const names = Array.isArray(name) ? name : [name];
		const unsubs: any[] = [];

		// wrap to prevent unhandled errors from killing the process
		if (!Cron.#onEventWraps.has(cb)) {
			Cron.#onEventWraps.set(cb, async (job: CronJob) => {
				try {
					await cb(job);
				} catch (e) {
					this.#logger?.error?.(`onEvent ${name}: ${e}`);
				}
			});
		}
		const wrapped = Cron.#onEventWraps.get(cb) as any;

		names.forEach((n) => {
			if (!skipIfExists || !pubsub.isSubscribed(n, wrapped)) {
				const unsub = pubsub.subscribe(n, wrapped);
				unsubs.push(() => {
					unsub();
					Cron.#onEventWraps.delete(cb);
				});
			}
		});
		return () => unsubs.forEach((u) => u());
	}

	/** Removes all event listeners. Primarily used in tests. */
	unsubscribeAll(): void {
		this.#pubsubDone.unsubscribeAll();
		this.#pubsubError.unsubscribeAll();
	}

	// --- DB health ---

	/**
	 * Returns the last database health status, or `null` if monitoring is not enabled.
	 */
	getDbHealth(): DbHealthStatus | null {
		return this.#healthMonitor?.getLastStatus() ?? null;
	}

	/** Manually triggers a one-off database health check. */
	async checkDbHealth(): Promise<DbHealthStatus> {
		return await checkDbHealth(this.#db, this.#logger);
	}

	// --- Static helpers ---

	/** Returns raw SQL strings for schema operations. @internal */
	static __schema(tablePrefix: string = ""): { drop: string; create: string } {
		const context = { tableNames: _tableNames(tablePrefix) };
		return {
			drop: _schemaDrop(context),
			create: _schemaCreate(context),
		};
	}
}
