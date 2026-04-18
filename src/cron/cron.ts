import { createClog, type Logger } from "@marianmeres/clog";
import { createPubSub, type Subscriber, type Unsubscriber } from "@marianmeres/pubsub";
import process from "node:process";
import type pg from "pg";
import { CronParser } from "../cron-parser.ts";
import { _claimNextCronJob } from "./_claim-next.ts";
import { _executeCronJob } from "./_execute.ts";
import { _fetchAll, _findByName } from "./_find.ts";
import { _healthPreview } from "./_health-preview.ts";
import { _logRunFetchAll, _logRunPrune } from "./_log-run.ts";
import { _markStale } from "./_mark-stale.ts";
import { _register } from "./_register.ts";
import {
	_initialize,
	_schemaCreate,
	_schemaDrop,
	_uninstall,
} from "./_schema.ts";
import { sleep } from "./utils/sleep.ts";
import { withDbRetry, type DbRetryOptions } from "./utils/with-db-retry.ts";
import {
	checkDbHealth,
	DbHealthMonitor,
	type DbHealthStatus,
} from "./utils/db-health.ts";

/**
 * Default project identifier used when no `projectId` is specified.
 */
export const DEFAULT_PROJECT_ID = "_default";

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
 * - `EXP` - Exponential backoff (capped — see `_handle-failure.ts`)
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
 *
 * The optional `signal` is `abort()`-ed when the per-attempt timeout fires
 * or when the Cron instance is shutting down. Handlers performing
 * cancellable work (e.g. `fetch`, child processes) should pass it through
 * to enable real cancellation.
 */
// deno-lint-ignore no-explicit-any
export type CronHandler = (job: CronJob, signal?: AbortSignal) => any | Promise<any>;

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
	projectId: string;
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
	project_id: string;
	name: string;
	expression: string;
	/** IANA timezone the expression is evaluated in, or `null` for host local time. */
	timezone: string | null;
	// deno-lint-ignore no-explicit-any
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
	/**
	 * Per-claim fence token. Set on claim, cleared on success/failure/stale-recovery.
	 * Used so a stale-recovered worker cannot overwrite a fresh claim's result.
	 */
	lease_token: string | null;
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
	project_id: string;
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
	// deno-lint-ignore no-explicit-any
	result: Record<string, any> | null;
	error_message: string | null;
	// deno-lint-ignore no-explicit-any
	error_details: Record<string, any> | null;
}

/**
 * A single row from the health preview query, representing
 * execution statistics grouped by run status.
 */
export interface CronHealthPreviewRow {
	status: string;
	count: number;
	avg_duration_seconds: number | null;
}

/**
 * Options for registering a cron job.
 */
export interface CronRegisterOptions {
	// deno-lint-ignore no-explicit-any
	payload?: Record<string, any>;
	enabled?: boolean;
	max_attempts?: number;
	max_attempt_duration_ms?: number;
	backoff_strategy?: typeof BACKOFF_STRATEGY.NONE | typeof BACKOFF_STRATEGY.EXP;
	/** IANA timezone to evaluate the cron expression in (e.g. "Europe/Prague"). */
	timezone?: string | null;
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
	/** Project scope identifier (default: '_default') */
	projectId?: string;
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
	/**
	 * Auto-recover stuck jobs on a timer. When set, every `intervalMs` ms the
	 * Cron instance calls `cleanup()` (global) with the given threshold.
	 *
	 * - `true` → defaults: `{ intervalMs: 60_000, maxAllowedRunDurationMinutes: 5 }`
	 * - object → custom config
	 * - `false` / undefined → disabled (caller is responsible for `cleanup()`)
	 */
	autoCleanup?:
		| boolean
		| {
				intervalMs?: number;
				maxAllowedRunDurationMinutes?: number;
		  };
}

/**
 * Options accepted by `Cron.stop()`.
 */
export interface CronStopOptions {
	/**
	 * Hard cap (ms) on how long `stop()` will wait for in-flight jobs to drain.
	 * After the cap elapses, `stop()` returns regardless and the still-running
	 * job IDs are logged.
	 *
	 * Default: 30_000 (30 s). Pass `0` to wait forever (legacy behaviour).
	 */
	drainTimeoutMs?: number;
}

/**
 * A lightweight project-scoped view over a shared `Cron` instance.
 *
 * Created via `cron.forProject(projectId)`. Shares the processor pool
 * with the parent `Cron` — only management methods are project-scoped.
 */
export interface CronProjectScope {
	readonly projectId: string;
	register(
		name: string,
		expression: string,
		handler: CronHandler,
		options?: CronRegisterOptions
	): Promise<CronJob>;
	unregister(name: string): Promise<void>;
	enable(name: string): Promise<CronJob>;
	disable(name: string): Promise<CronJob>;
	find(name: string): Promise<CronJob | null>;
	fetchAll(options?: {
		enabled?: boolean;
		status?: typeof CRON_STATUS.IDLE | typeof CRON_STATUS.RUNNING;
		limit?: number;
		offset?: number;
	}): Promise<CronJob[]>;
	getRunHistory(
		name: string,
		options?: { limit?: number; offset?: number; sinceMinutesAgo?: number }
	): Promise<CronRunLog[]>;
	healthPreview(sinceMinutesAgo?: number): Promise<CronHealthPreviewRow[]>;
	cleanup(maxAllowedRunDurationMinutes?: number): Promise<number>;
	pruneRunLog(olderThanMinutes: number): Promise<number>;
	setHandler(name: string, handler: CronHandler | undefined | null): CronProjectScope;
	hasHandler(name: string): boolean;
	listHandlerNames(): string[];
	removeHandler(name: string): CronProjectScope;
	onDone(
		name: string | string[],
		cb: (job: CronJob) => void,
		skipIfExists?: boolean
	): Unsubscriber;
	onError(
		name: string | string[],
		cb: (job: CronJob) => void,
		skipIfExists?: boolean
	): Unsubscriber;
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
 * Processors are global — a single `start()` call serves all projects.
 * Use `forProject()` to get a project-scoped management view sharing the same
 * processor pool.
 *
 * @example
 * ```typescript
 * import { Cron } from "@marianmeres/cron";
 *
 * const cron = new Cron({ db: pgPool });
 *
 * const projA = cron.forProject("project-a");
 * const projB = cron.forProject("project-b");
 *
 * await projA.register("report", "0 9 * * *", handlerA);
 * await projB.register("report", "0 18 * * *", handlerB);
 *
 * await cron.start(2); // single pool processes ALL projects
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
	#shutdownCtrl: AbortController | null = null;
	#wasInitialized = false;
	#initPromise: Promise<void> | null = null;
	#activeJobs = new Set<number>();
	#jobProcessors: Promise<void>[] = [];

	// per-instance event handler wraps: keyed by user callback
	#eventWraps = new Map<(job: CronJob) => void, Subscriber>();

	#sigtermListener: (() => void) | null = null;

	// prevent log spam on consecutive claim errors
	#claimErrorCounter = 0;

	#dbRetryOptions: DbRetryOptions | null = null;
	#healthMonitor: DbHealthMonitor | null = null;

	#autoCleanupTimer: ReturnType<typeof setInterval> | null = null;
	#autoCleanupConfig: { intervalMs: number; maxAllowedRunDurationMinutes: number } | null = null;

	constructor(options: CronOptions) {
		const {
			db,
			pollTimeoutMs = 1_000,
			tablePrefix = "",
			logger = createClog("cron"),
			gracefulSigterm = true,
			projectId = DEFAULT_PROJECT_ID,
			dbRetry,
			dbHealthCheck,
			autoCleanup,
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

		if (autoCleanup) {
			const cfg = autoCleanup === true ? {} : autoCleanup;
			this.#autoCleanupConfig = {
				intervalMs: cfg.intervalMs ?? 60_000,
				maxAllowedRunDurationMinutes: cfg.maxAllowedRunDurationMinutes ?? 5,
			};
		}

		this.#context = {
			db: this.#db,
			tableNames: _tableNames(tablePrefix),
			logger: this.#logger,
			pubsubDone: this.#pubsubDone,
			pubsubError: this.#pubsubError,
			projectId,
		};
	}

	// --- Private helpers ---

	/** Composite key for the handler map: `${projectId}\0${name}` */
	#handlerKey(projectId: string, name: string): string {
		return `${projectId}\0${name}`;
	}

	/** Returns a CronContext scoped to a specific projectId */
	#projectContext(projectId: string): CronContext {
		if (projectId === this.#context.projectId) return this.#context;
		return { ...this.#context, projectId };
	}

	/** Wrapper for database operations with optional retry */
	async #withRetry<T>(fn: () => Promise<T>): Promise<T> {
		if (this.#dbRetryOptions) {
			return await withDbRetry(fn, this.#dbRetryOptions);
		}
		return await fn();
	}

	/**
	 * Initialises the schema exactly once per instance.
	 *
	 * Concurrent callers share a single in-flight `_initialize` promise so we
	 * never run the CREATE statements twice in parallel.
	 */
	async #initializeOnce(hard?: boolean): Promise<void> {
		if (this.#wasInitialized && !hard) return;

		if (!this.#initPromise) {
			this.#initPromise = (async () => {
				try {
					await _initialize(this.#context, !!hard);
					this.#wasInitialized = true;
					this.#logger?.debug?.(`System initialized${hard ? " (hard)" : ""}`);

					if (this.gracefulSigterm && !this.#sigtermListener) {
						this.#sigtermListener = () => {
							this.#logger?.debug?.(`SIGTERM detected...`);
							void this.stop();
						};
						process.on("SIGTERM", this.#sigtermListener);
					}
				} finally {
					this.#initPromise = null;
				}
			})();
		}

		return this.#initPromise;
	}

	// --- Processor (global — claims any due job regardless of project) ---

	async #processJobs(processorId: string): Promise<void> {
		const noopHandler: CronHandler = (_job) => ({ noop: true });
		const limit = 10;
		const shutdownSignal = this.#shutdownCtrl!.signal;

		while (!this.#isShuttingDown) {
			try {
				const claimed = await this.#withRetry(() =>
					_claimNextCronJob(this.#context)
				);

				if (claimed) {
					const { job, leaseToken } = claimed;
					this.#activeJobs.add(job.id);
					try {
						const key = this.#handlerKey(job.project_id, job.name);
						const handler = this.#handlers.get(key);
						if (!handler) {
							this.#logger?.warn?.(
								`No handler for cron job "${job.name}" (project: ${job.project_id}), using noop`
							);
						}
						this.#logger?.debug?.(
							`Executing cron job "${job.name}" (project: ${job.project_id})...`
						);
						await _executeCronJob(
							this.#context,
							job,
							handler ?? noopHandler,
							leaseToken,
							shutdownSignal
						);
					} finally {
						this.#activeJobs.delete(job.id);
					}
				} else {
					await sleep(this.pollTimeoutMs, undefined, shutdownSignal);
				}

				if (this.#claimErrorCounter) {
					if (this.#claimErrorCounter >= limit) {
						this.#logger?.debug?.(`Cron claim error reporting RESUMED...`);
					}
					this.#claimErrorCounter = 0;
				}
			} catch (e: unknown) {
				this.#claimErrorCounter++;
				if (this.#claimErrorCounter < limit) {
					this.#logger?.error?.(`Cron claim: ${e instanceof Error ? e.stack ?? e.message : e}`);
				} else if (this.#claimErrorCounter === limit) {
					this.#logger?.debug?.(`Cron claim error reporting MUTED...`);
				}
				// On a hard error, briefly pause to avoid a tight error loop —
				// but stay responsive to shutdown.
				await sleep(Math.min(this.pollTimeoutMs, 1_000), undefined, shutdownSignal);
			}
		}

		this.#logger?.debug?.(`Cron processor "${processorId}" stopped`);
	}

	// --- Private #do* methods (project-parameterized) ---

	async #doRegister(
		projectId: string,
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
			timezone = null,
			forceNextRunRecalculate = false,
		} = options;

		// Validate expression early (throws on invalid)
		new CronParser(expression, { timezone: timezone ?? undefined });

		await this.#initializeOnce();

		this.#doSetHandler(projectId, name, handler);

		return await _register(
			this.#projectContext(projectId),
			{
				name,
				expression,
				timezone,
				payload,
				enabled,
				max_attempts,
				max_attempt_duration_ms,
				backoff_strategy,
			},
			forceNextRunRecalculate
		);
	}

	async #doUnregister(projectId: string, name: string): Promise<void> {
		await this.#initializeOnce();
		const { db, tableNames } = this.#context;
		const { tableCron } = tableNames;
		await db.query(
			`DELETE FROM ${tableCron} WHERE project_id = $1 AND name = $2`,
			[projectId, name]
		);
		this.#handlers.delete(this.#handlerKey(projectId, name));
	}

	async #doEnable(projectId: string, name: string): Promise<CronJob> {
		await this.#initializeOnce();
		const { db, tableNames } = this.#context;
		const { tableCron } = tableNames;
		const { rows } = await db.query(
			`UPDATE ${tableCron}
			SET enabled = TRUE, updated_at = NOW()
			WHERE project_id = $1 AND name = $2
			RETURNING *`,
			[projectId, name]
		);
		return rows[0] as CronJob;
	}

	async #doDisable(projectId: string, name: string): Promise<CronJob> {
		await this.#initializeOnce();
		const { db, tableNames } = this.#context;
		const { tableCron } = tableNames;
		const { rows } = await db.query(
			`UPDATE ${tableCron}
			SET enabled = FALSE, updated_at = NOW()
			WHERE project_id = $1 AND name = $2
			RETURNING *`,
			[projectId, name]
		);
		return rows[0] as CronJob;
	}

	async #doFind(projectId: string, name: string): Promise<CronJob | null> {
		await this.#initializeOnce();
		return await _findByName(this.#projectContext(projectId), name);
	}

	async #doFetchAll(
		projectId: string,
		options: {
			enabled?: boolean;
			status?: typeof CRON_STATUS.IDLE | typeof CRON_STATUS.RUNNING;
			limit?: number;
			offset?: number;
		} = {}
	): Promise<CronJob[]> {
		await this.#initializeOnce();
		return await _fetchAll(this.#projectContext(projectId), options);
	}

	async #doGetRunHistory(
		projectId: string,
		name: string,
		options: { limit?: number; offset?: number; sinceMinutesAgo?: number } = {}
	): Promise<CronRunLog[]> {
		await this.#initializeOnce();
		const ctx = this.#projectContext(projectId);
		const job = await _findByName(ctx, name);
		if (!job) return [];
		return await _logRunFetchAll(ctx, job.id, options);
	}

	async #doHealthPreview(
		projectId: string,
		sinceMinutesAgo: number = 60
	): Promise<CronHealthPreviewRow[]> {
		await this.#initializeOnce();
		return await _healthPreview(this.#projectContext(projectId), sinceMinutesAgo);
	}

	async #doCleanup(
		projectId: string,
		maxAllowedRunDurationMinutes: number = 5,
		projectScoped: boolean = true
	): Promise<number> {
		await this.#initializeOnce();
		return await _markStale(
			this.#projectContext(projectId),
			maxAllowedRunDurationMinutes,
			projectScoped
		);
	}

	async #doPruneRunLog(
		projectId: string,
		olderThanMinutes: number,
		projectScoped: boolean
	): Promise<number> {
		await this.#initializeOnce();
		return await _logRunPrune(
			this.#projectContext(projectId),
			olderThanMinutes,
			projectScoped
		);
	}

	#doSetHandler(
		projectId: string,
		name: string,
		handler: CronHandler | undefined | null
	): void {
		const key = this.#handlerKey(projectId, name);
		if (typeof handler === "function") {
			this.#handlers.set(key, handler);
		} else {
			this.#handlers.delete(key);
		}
	}

	#doHasHandler(projectId: string, name: string): boolean {
		return this.#handlers.has(this.#handlerKey(projectId, name));
	}

	#doRemoveHandler(projectId: string, name: string): void {
		this.#handlers.delete(this.#handlerKey(projectId, name));
	}

	/** Returns all registered handler keys (composite `${projectId}\0${name}`). @internal */
	_handlerKeys(): string[] {
		return [...this.#handlers.keys()];
	}

	/** Returns the job names that have an in-memory handler for the given project. */
	#doListHandlerNames(projectId: string): string[] {
		const prefix = `${projectId}\0`;
		const out: string[] = [];
		for (const key of this.#handlers.keys()) {
			if (key.startsWith(prefix)) out.push(key.slice(prefix.length));
		}
		return out;
	}

	#doOnEvent(
		projectId: string,
		pubsub: ReturnType<typeof createPubSub>,
		name: string | string[],
		cb: (job: CronJob) => void,
		skipIfExists: boolean
	): Unsubscriber {
		const names = Array.isArray(name) ? name : [name];
		const unsubs: Unsubscriber[] = [];

		// One wrap per (instance, cb). Wraps catch handler errors so they
		// can't tear down the pubsub publish loop.
		let wrapped = this.#eventWraps.get(cb);
		if (!wrapped) {
			wrapped = async (job: CronJob) => {
				try {
					await cb(job);
				} catch (e) {
					this.#logger?.error?.(`onEvent ${job.name}: ${e}`);
				}
			};
			this.#eventWraps.set(cb, wrapped);
		}
		const wrap = wrapped;

		names.forEach((n) => {
			const key = this.#handlerKey(projectId, n);
			if (!skipIfExists || !pubsub.isSubscribed(key, wrap)) {
				const unsub = pubsub.subscribe(key, wrap);
				unsubs.push(unsub);
			}
		});

		// Returned unsubscriber: detach all topics, then evict the wrap from
		// the per-instance cache only when no subscriptions for this cb
		// remain anywhere. This avoids the "first unsub kills the others"
		// bug and the duplicate-wrap-on-resubscribe footgun.
		const dispose = () => {
			unsubs.forEach((u) => u());
			const stillSubscribed =
				this.#hasAnySubscription(this.#pubsubDone, wrap) ||
				this.#hasAnySubscription(this.#pubsubError, wrap);
			if (!stillSubscribed) this.#eventWraps.delete(cb);
		};
		const u = (() => dispose()) as Unsubscriber;
		// deno-lint-ignore no-explicit-any
		(u as any)[Symbol.dispose] = dispose;
		return u;
	}

	#hasAnySubscription(
		pubsub: ReturnType<typeof createPubSub>,
		wrapped: Subscriber
	): boolean {
		// pubsub doesn't expose a "any topic?" query, so probe each key.
		// In practice the handler map is small.
		for (const key of this.#handlers.keys()) {
			if (pubsub.isSubscribed(key, wrapped)) return true;
		}
		return false;
	}

	// --- Public: Handler management ---

	/**
	 * Returns `true` if an in-memory handler is registered for the given name.
	 */
	hasHandler(name: string): boolean {
		return this.#doHasHandler(this.#context.projectId, name);
	}

	/** Returns the names of all in-memory handlers for the current project. */
	listHandlerNames(): string[] {
		return this.#doListHandlerNames(this.#context.projectId);
	}

	/**
	 * Registers or removes a handler for a specific cron job name.
	 *
	 * Does not touch the database. Useful for re-registering handlers on restart.
	 *
	 * @returns The Cron instance for method chaining
	 */
	setHandler(name: string, handler: CronHandler | undefined | null): Cron {
		this.#doSetHandler(this.#context.projectId, name, handler);
		return this;
	}

	/**
	 * Removes the in-memory handler for the given name.
	 *
	 * @returns The Cron instance for method chaining
	 */
	removeHandler(name: string): Cron {
		this.#doRemoveHandler(this.#context.projectId, name);
		return this;
	}

	/** Removes all registered in-memory handlers. */
	resetHandlers(): void {
		this.#handlers.clear();
	}

	// --- Lifecycle (global — not project-scoped) ---

	/**
	 * Initializes the database schema (if needed) and starts N polling workers.
	 *
	 * Processors are global — they claim any due job regardless of project.
	 * One `start()` call serves all projects.
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

			if (this.#autoCleanupConfig && !this.#autoCleanupTimer) {
				const { intervalMs, maxAllowedRunDurationMinutes } = this.#autoCleanupConfig;
				this.#autoCleanupTimer = setInterval(() => {
					this.cleanup(maxAllowedRunDurationMinutes).catch((e) => {
						this.#logger?.error?.(`Auto-cleanup failed: ${e}`);
					});
				}, intervalMs);
				this.#logger?.debug?.(
					`Auto-cleanup enabled (every ${intervalMs}ms, threshold ${maxAllowedRunDurationMinutes}min)`
				);
			}
		} catch (e) {
			this.#logger?.error?.(`Unable to start: ${e}`);
			this.#logger?.error?.(`CRON NOT STARTED`);
			return;
		}

		this.#shutdownCtrl = new AbortController();

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
	 * Waits for in-flight jobs to finish, but no longer than `drainTimeoutMs`
	 * (default: 30 s). Pass `0` to wait forever.
	 */
	async stop(options: CronStopOptions = {}): Promise<void> {
		const drainTimeoutMs = options.drainTimeoutMs ?? 30_000;

		if (this.#autoCleanupTimer) {
			clearInterval(this.#autoCleanupTimer);
			this.#autoCleanupTimer = null;
		}

		if (this.#healthMonitor) {
			this.#healthMonitor.stop();
			this.#logger?.debug?.("DB health monitoring stopped");
		}

		this.#isShuttingDown = true;
		// Tell processors to wake from sleep + handlers to abort their work
		this.#shutdownCtrl?.abort();

		// Race the processor wait against the drain cap. Processors block on
		// the in-flight `await _executeCronJob(...)` until that promise
		// settles — which may be never if a handler ignores its AbortSignal.
		const processorsDone = Promise.all(this.#jobProcessors).then(() => true);
		let allDone: boolean;
		if (drainTimeoutMs > 0) {
			const drainCtrl = new AbortController();
			const cap = sleep(drainTimeoutMs, undefined, drainCtrl.signal).then(
				() => false
			);
			allDone = await Promise.race([processorsDone, cap]);
			// If processors won the race, abort the cap sleep so its timer is cleared.
			if (allDone) drainCtrl.abort();
		} else {
			allDone = await processorsDone;
		}

		if (!allDone) {
			this.#logger?.error?.(
				`Drain timeout (${drainTimeoutMs}ms) exceeded; ` +
					`abandoning ${this.#activeJobs.size} in-flight job(s): ` +
					`[${[...this.#activeJobs].join(", ")}]`
			);
			// Abandoned processors are still running. We deliberately leave
			// `#isShuttingDown = true` so that as soon as their stuck handler
			// finally returns, the loop body sees the flag and exits — without
			// claiming any *new* jobs. The instance is not safe to re-`start()`
			// until those processors drain in the background.
		}
		this.#jobProcessors = [];

		// Detach SIGTERM listener so the Cron instance is GC-eligible
		if (this.#sigtermListener) {
			process.off("SIGTERM", this.#sigtermListener);
			this.#sigtermListener = null;
		}

		// Only fully reset state when processors actually exited. Otherwise we
		// leave the abort signal connected and `#isShuttingDown` true so the
		// orphaned processor loop terminates cleanly when its handler returns.
		if (allDone) {
			this.#shutdownCtrl = null;
			this.#isShuttingDown = false;
		}
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

	// --- Registration (project-scoped) ---

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
		return await this.#doRegister(
			this.#context.projectId,
			name,
			expression,
			handler,
			options
		);
	}

	/**
	 * Hard-deletes a cron job (and its run log) from the database.
	 *
	 * Also removes the in-memory handler.
	 */
	async unregister(name: string): Promise<void> {
		return await this.#doUnregister(this.#context.projectId, name);
	}

	/**
	 * Enables a previously disabled cron job.
	 *
	 * @returns The updated CronJob row
	 */
	async enable(name: string): Promise<CronJob> {
		return await this.#doEnable(this.#context.projectId, name);
	}

	/**
	 * Disables a cron job. Disabled jobs are skipped by the polling workers.
	 *
	 * @returns The updated CronJob row
	 */
	async disable(name: string): Promise<CronJob> {
		return await this.#doDisable(this.#context.projectId, name);
	}

	// --- Querying (project-scoped) ---

	/**
	 * Finds a cron job by name.
	 *
	 * @returns The CronJob row, or `null` if not found
	 */
	async find(name: string): Promise<CronJob | null> {
		return await this.#doFind(this.#context.projectId, name);
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
		return await this.#doFetchAll(this.#context.projectId, options);
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
		return await this.#doGetRunHistory(this.#context.projectId, name, options);
	}

	// --- Maintenance ---

	/**
	 * Resets stuck `running` jobs back to `idle` (crash recovery).
	 *
	 * When called on a `Cron` instance: recovers ALL stuck jobs globally.
	 * When called on a `CronProjectScope`: recovers only that project's jobs.
	 *
	 * @param maxAllowedRunDurationMinutes - Threshold in minutes (default: 5)
	 * @returns The number of rows recovered
	 */
	async cleanup(maxAllowedRunDurationMinutes: number = 5): Promise<number> {
		// Global cleanup — recovers all projects
		return await this.#doCleanup(
			this.#context.projectId,
			maxAllowedRunDurationMinutes,
			false // projectScoped = false → global recovery
		);
	}

	/**
	 * Deletes run-log rows older than `olderThanMinutes`.
	 *
	 * When called on a `Cron` instance: deletes globally.
	 * When called on a `CronProjectScope`: deletes only that project's rows.
	 *
	 * @returns The number of rows deleted
	 */
	async pruneRunLog(olderThanMinutes: number): Promise<number> {
		return await this.#doPruneRunLog(
			this.#context.projectId,
			olderThanMinutes,
			false // global
		);
	}

	/**
	 * Returns execution statistics grouped by run status.
	 *
	 * @param sinceMinutesAgo - Time window for statistics (default: 60)
	 */
	async healthPreview(sinceMinutesAgo: number = 60): Promise<CronHealthPreviewRow[]> {
		return await this.#doHealthPreview(this.#context.projectId, sinceMinutesAgo);
	}

	// --- Events (project-scoped) ---

	/**
	 * Subscribes to successful completion events for the given job name(s).
	 *
	 * @returns Unsubscribe function
	 */
	onDone(
		name: string | string[],
		cb: (job: CronJob) => void,
		skipIfExists: boolean = true
	): Unsubscriber {
		return this.#doOnEvent(
			this.#context.projectId,
			this.#pubsubDone,
			name,
			cb,
			skipIfExists
		);
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
		return this.#doOnEvent(
			this.#context.projectId,
			this.#pubsubError,
			name,
			cb,
			skipIfExists
		);
	}

	/** Removes all event listeners. Primarily used in tests. */
	unsubscribeAll(): void {
		this.#pubsubDone.unsubscribeAll();
		this.#pubsubError.unsubscribeAll();
		this.#eventWraps.clear();
	}

	// --- Project scoping ---

	/**
	 * Returns a lightweight project-scoped view sharing this instance's
	 * processor pool.
	 *
	 * The returned object exposes only management methods — lifecycle
	 * (`start`, `stop`, `resetHard`, `uninstall`) stays on the parent `Cron`.
	 *
	 * @example
	 * ```typescript
	 * const projA = cron.forProject("project-a");
	 * await projA.register("report", "0 9 * * *", handler);
	 * ```
	 */
	forProject(projectId: string): CronProjectScope {
		// deno-lint-ignore no-this-alias
		const self = this;
		return {
			get projectId() {
				return projectId;
			},
			register: (name, expression, handler, options?) =>
				self.#doRegister(projectId, name, expression, handler, options),
			unregister: (name) => self.#doUnregister(projectId, name),
			enable: (name) => self.#doEnable(projectId, name),
			disable: (name) => self.#doDisable(projectId, name),
			find: (name) => self.#doFind(projectId, name),
			fetchAll: (options?) => self.#doFetchAll(projectId, options),
			getRunHistory: (name, options?) =>
				self.#doGetRunHistory(projectId, name, options),
			healthPreview: (sinceMinutesAgo?) =>
				self.#doHealthPreview(projectId, sinceMinutesAgo),
			cleanup: (maxMins?) =>
				self.#doCleanup(projectId, maxMins, true /* projectScoped */),
			pruneRunLog: (olderThanMinutes) =>
				self.#doPruneRunLog(projectId, olderThanMinutes, true),
			setHandler(name, handler) {
				self.#doSetHandler(projectId, name, handler);
				return this;
			},
			hasHandler: (name) => self.#doHasHandler(projectId, name),
			listHandlerNames: () => self.#doListHandlerNames(projectId),
			removeHandler(name) {
				self.#doRemoveHandler(projectId, name);
				return this;
			},
			onDone: (name, cb, skipIfExists?) =>
				self.#doOnEvent(projectId, self.#pubsubDone, name, cb, skipIfExists ?? true),
			onError: (name, cb, skipIfExists?) =>
				self.#doOnEvent(projectId, self.#pubsubError, name, cb, skipIfExists ?? true),
		};
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

	/**
	 * Migrates an existing schema to the current version.
	 *
	 * Currently performs:
	 * - v1 → v2: adds `project_id` and updates indexes
	 * - v2 → v3: adds `lease_token`, `timezone`, and CHECK constraints
	 *
	 * Safe to call multiple times — uses `IF NOT EXISTS` / `IF EXISTS` and
	 * idempotent CHECK additions.
	 */
	static async migrate(
		db: pg.Pool | pg.Client,
		tablePrefix: string = ""
	): Promise<void> {
		const { tableCron, tableCronRunLog } = _tableNames(tablePrefix);
		const safe = (name: string) => `${name}`.replace(/\W/g, "");

		// Use the proper transaction helper so this works against a Pool too.
		const { withTx } = await import("./utils/with-tx.ts");

		const okCronStatuses = [CRON_STATUS.IDLE, CRON_STATUS.RUNNING]
			.map((v) => `'${v}'`)
			.join(", ");
		const okRunStatuses = [RUN_STATUS.SUCCESS, RUN_STATUS.ERROR, RUN_STATUS.TIMEOUT]
			.map((v) => `'${v}'`)
			.join(", ");

		await withTx(db, async (client) => {
			// v1 → v2
			await client.query(`
				ALTER TABLE ${tableCron}
					ADD COLUMN IF NOT EXISTS project_id VARCHAR(255) NOT NULL DEFAULT '_default';

				DROP INDEX IF EXISTS idx_${safe(tableCron)}_name;

				CREATE UNIQUE INDEX IF NOT EXISTS idx_${safe(tableCron)}_project_name
					ON ${tableCron}(project_id, name);

				DROP INDEX IF EXISTS idx_${safe(tableCron)}_next_run_at;
				CREATE INDEX IF NOT EXISTS idx_${safe(tableCron)}_next_run_at
					ON ${tableCron}(enabled, status, next_run_at);

				ALTER TABLE ${tableCronRunLog}
					ADD COLUMN IF NOT EXISTS project_id VARCHAR(255) NOT NULL DEFAULT '_default';

				CREATE INDEX IF NOT EXISTS idx_${safe(tableCronRunLog)}_project_id
					ON ${tableCronRunLog}(project_id);
			`);

			// v2 → v3: lease token + timezone
			await client.query(`
				ALTER TABLE ${tableCron}
					ADD COLUMN IF NOT EXISTS lease_token UUID;

				ALTER TABLE ${tableCron}
					ADD COLUMN IF NOT EXISTS timezone VARCHAR(64);
			`);

			// v2 → v3: CHECK constraints (Postgres has no IF NOT EXISTS for constraints,
			// so we look it up first and add only if missing).
			const addCheckIfMissing = async (
				table: string,
				name: string,
				expr: string
			) => {
				const exists = await client.query(
					`SELECT 1 FROM pg_constraint WHERE conname = $1`,
					[name]
				);
				if (exists.rowCount === 0) {
					await client.query(
						`ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${expr})`
					);
				}
			};

			await addCheckIfMissing(
				tableCron,
				`chk_${safe(tableCron)}_status`,
				`status IN (${okCronStatuses})`
			);
			await addCheckIfMissing(
				tableCron,
				`chk_${safe(tableCron)}_last_status`,
				`last_run_status IS NULL OR last_run_status IN (${okRunStatuses})`
			);
			await addCheckIfMissing(
				tableCron,
				`chk_${safe(tableCron)}_max_attempts`,
				`max_attempts >= 1`
			);
			await addCheckIfMissing(
				tableCron,
				`chk_${safe(tableCron)}_max_attempt_duration`,
				`max_attempt_duration_ms >= 0`
			);
			await addCheckIfMissing(
				tableCronRunLog,
				`chk_${safe(tableCronRunLog)}_status`,
				`status IS NULL OR status IN (${okRunStatuses})`
			);
			await addCheckIfMissing(
				tableCronRunLog,
				`chk_${safe(tableCronRunLog)}_attempt_number`,
				`attempt_number >= 1`
			);
		});
	}

	/** Returns raw SQL strings for schema operations. @internal */
	static __schema(tablePrefix: string = ""): { drop: string; create: string } {
		const context = { tableNames: _tableNames(tablePrefix) };
		return {
			drop: _schemaDrop(context),
			create: _schemaCreate(context),
		};
	}
}
