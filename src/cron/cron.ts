import { createClog, type Logger } from "@marianmeres/clog";
import { createPubSub, type Subscriber, type Unsubscriber } from "@marianmeres/pubsub";
import process from "node:process";
import type pg from "pg";
import { CronParser } from "@marianmeres/cron-parser";
import { _claimNextCronJob } from "./_claim-next.ts";
import { _executeCronJob } from "./_execute.ts";
import { _fetchAll, _findByName } from "./_find.ts";
import { _healthPreview } from "./_health-preview.ts";
import { _logRunFetchAll, _logRunPrune } from "./_log-run.ts";
import { _markStale } from "./_mark-stale.ts";
import { _nextRunAt } from "./_next-run.ts";
import { _register } from "./_register.ts";
import {
	_initialize,
	_schemaCreate,
	_schemaDrop,
	_uninstall,
} from "./_schema.ts";
import { sleep } from "./utils/sleep.ts";
import { withDbRetry, type DbRetryOptions } from "./utils/with-db-retry.ts";
import { isPool } from "./utils/with-tx.ts";
import {
	checkDbHealth,
	DbHealthMonitor,
	type DbHealthStatus,
} from "./utils/db-health.ts";

/**
 * Default tenant identifier used when no `tenantId` is specified.
 */
export const DEFAULT_TENANT_ID = "_default";

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
	tenantId: string;
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
	tenant_id: string;
	name: string;
	expression: string;
	/** IANA timezone the expression is evaluated in, or `null` for host local time. */
	timezone: string | null;
	// deno-lint-ignore no-explicit-any
	payload: Record<string, any>;
	enabled: boolean;
	status: typeof CRON_STATUS.IDLE | typeof CRON_STATUS.RUNNING;
	next_run_at: Date;
	/**
	 * Last sign of life of a run: set when the job is claimed, renewed by the
	 * worker's heartbeat while it executes, and set again on completion. Stale
	 * recovery (`cleanup()`) measures from here. For the start time of a specific
	 * attempt use `CronRunLog.started_at`.
	 */
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
	tenant_id: string;
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
	/**
	 * PostgreSQL connection. Use a `pg.Pool` for anything real: a single
	 * `pg.Client` is one session, so it is limited to **one** processor
	 * (`start()` clamps the count) and its statements share whatever
	 * transaction happens to be open on that session.
	 */
	db: pg.Pool | pg.Client;
	logger?: Logger;
	/** Tenant scope identifier (default: '_default') */
	tenantId?: string;
	/** Table name prefix, e.g. "myschema." for schema qualification */
	tablePrefix?: string;
	/** Polling interval in milliseconds when no jobs are due (default: 1000) */
	pollTimeoutMs?: number;
	/**
	 * Enable SIGTERM listener for graceful shutdown (default: true).
	 * Attached by `start()`, detached by `stop()`.
	 */
	gracefulSigterm?: boolean;
	/**
	 * Enable database retry on transient failures (true = defaults, or provide options).
	 * Covers the claim query and the writes that record a run's outcome.
	 */
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
	 * How often (ms) a worker renews the lease of the job it is executing, by
	 * bumping the row's `last_run_at`. This is what lets a job run longer than
	 * the stale threshold without being re-claimed while it is still in flight.
	 *
	 * Keep it well below the stale threshold (`maxAllowedRunDurationMinutes`) —
	 * a third of it or less. Default: 30_000. Pass `0` to disable.
	 */
	heartbeatIntervalMs?: number;
	/**
	 * Auto-recover stuck jobs on a timer. When set, every `intervalMs` ms the
	 * Cron instance calls `cleanup()` (global) with the given threshold.
	 *
	 * `maxAllowedRunDurationMinutes` is how long a `running` job may go without a
	 * heartbeat before it is presumed dead — not a cap on how long a job may run
	 * (that is `max_attempt_duration_ms`).
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
 * A lightweight tenant-scoped view over a shared `Cron` instance.
 *
 * Created via `cron.forTenant(tenantId)`. Shares the processor pool
 * with the parent `Cron` — only management methods are tenant-scoped.
 */
export interface CronTenantScope {
	readonly tenantId: string;
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
	setHandler(name: string, handler: CronHandler | undefined | null): CronTenantScope;
	hasHandler(name: string): boolean;
	listHandlerNames(): string[];
	removeHandler(name: string): CronTenantScope;
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
 * Processors are global — a single `start()` call serves all tenants.
 * Use `forTenant()` to get a tenant-scoped management view sharing the same
 * processor pool.
 *
 * @example
 * ```typescript
 * import { Cron } from "@marianmeres/cron";
 *
 * const cron = new Cron({ db: pgPool });
 *
 * const tenantA = cron.forTenant("tenant-a");
 * const tenantB = cron.forTenant("tenant-b");
 *
 * await tenantA.register("report", "0 9 * * *", handlerA);
 * await tenantB.register("report", "0 18 * * *", handlerB);
 *
 * await cron.start(2); // single pool processes ALL tenants
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

	// >0 while a `stop()` call is draining; `start()` refuses meanwhile
	#stopsInFlight = 0;
	// One controller per "generation" of processors (start → stop). Each
	// processor loop is keyed on the signal it was started with.
	#shutdownCtrl: AbortController | null = null;
	#wasInitialized = false;
	#initPromise: Promise<void> | null = null;
	#activeJobs = new Set<number>();
	#jobProcessors: Promise<void>[] = [];

	// Per-instance event handler wraps, keyed by user callback. `topics` mirrors
	// the wrap's live subscriptions (`${"done" | "error"}\0${handlerKey}`) so we
	// know exactly when it is no longer used anywhere.
	#eventWraps = new Map<
		(job: CronJob) => void,
		{ wrapped: Subscriber; topics: Set<string> }
	>();

	#sigtermListener: (() => void) | null = null;

	// prevent log spam on consecutive claim errors
	#claimErrorCounter = 0;

	#dbRetryOptions: DbRetryOptions | null = null;
	#healthMonitor: DbHealthMonitor | null = null;
	#heartbeatIntervalMs: number;

	#autoCleanupTimer: ReturnType<typeof setInterval> | null = null;
	#autoCleanupConfig: { intervalMs: number; maxAllowedRunDurationMinutes: number } | null = null;

	constructor(options: CronOptions) {
		const {
			db,
			pollTimeoutMs = 1_000,
			tablePrefix = "",
			logger = createClog("cron"),
			gracefulSigterm = true,
			tenantId = DEFAULT_TENANT_ID,
			dbRetry,
			dbHealthCheck,
			autoCleanup,
			heartbeatIntervalMs = 30_000,
		} = options || {};

		this.#db = db;
		this.#logger = logger;
		this.pollTimeoutMs = pollTimeoutMs;
		this.tablePrefix = tablePrefix;
		this.gracefulSigterm = gracefulSigterm;
		this.#heartbeatIntervalMs = heartbeatIntervalMs;

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
			tenantId,
		};
	}

	// --- Private helpers ---

	/** Composite key for the handler map: `${tenantId}\0${name}` */
	#handlerKey(tenantId: string, name: string): string {
		return `${tenantId}\0${name}`;
	}

	/** Returns a CronContext scoped to a specific tenantId */
	#tenantContext(tenantId: string): CronContext {
		if (tenantId === this.#context.tenantId) return this.#context;
		return { ...this.#context, tenantId };
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
				} finally {
					this.#initPromise = null;
				}
			})();
		}

		return this.#initPromise;
	}

	// --- Processor (global — claims any due job regardless of tenant) ---

	async #processJobs(processorId: string, shutdownSignal: AbortSignal): Promise<void> {
		const noopHandler: CronHandler = (_job) => ({ noop: true });
		const limit = 10;

		// After a hard error, briefly pause to avoid a tight error loop — but stay
		// responsive to shutdown.
		const pause = () =>
			sleep(Math.min(this.pollTimeoutMs, 1_000), undefined, shutdownSignal);

		// Keyed on the signal this processor was started with, NOT on instance
		// state: a processor abandoned by a drain-capped `stop()` must wind down
		// when its handler finally returns, whatever the instance has done since
		// (including being started again).
		while (!shutdownSignal.aborted) {
			let claimed: Awaited<ReturnType<typeof _claimNextCronJob>>;
			try {
				claimed = await this.#withRetry(() => _claimNextCronJob(this.#context));

				if (this.#claimErrorCounter) {
					if (this.#claimErrorCounter >= limit) {
						this.#logger?.debug?.(`Cron claim error reporting RESUMED...`);
					}
					this.#claimErrorCounter = 0;
				}
			} catch (e: unknown) {
				this.#claimErrorCounter++;
				if (this.#claimErrorCounter < limit) {
					this.#logger?.error?.(
						`Cron claim: ${e instanceof Error ? e.stack ?? e.message : e}`
					);
				} else if (this.#claimErrorCounter === limit) {
					this.#logger?.debug?.(`Cron claim error reporting MUTED...`);
				}
				await pause();
				continue;
			}

			if (!claimed) {
				await sleep(this.pollTimeoutMs, undefined, shutdownSignal);
				continue;
			}

			const { job, leaseToken } = claimed;
			this.#activeJobs.add(job.id);
			try {
				const key = this.#handlerKey(job.tenant_id, job.name);
				const handler = this.#handlers.get(key);
				if (!handler) {
					this.#logger?.warn?.(
						`No handler for cron job "${job.name}" (tenant: ${job.tenant_id}), using noop`
					);
				}
				this.#logger?.debug?.(
					`Executing cron job "${job.name}" (tenant: ${job.tenant_id})...`
				);
				await _executeCronJob(
					this.#context,
					job,
					handler ?? noopHandler,
					leaseToken,
					shutdownSignal,
					{
						withRetry: <T>(fn: () => Promise<T>) => this.#withRetry(fn),
						heartbeatIntervalMs: this.#heartbeatIntervalMs,
					}
				);
			} catch (e: unknown) {
				// Handler errors never reach here (they are recorded as failed
				// attempts). This is the bookkeeping itself failing.
				this.#logger?.error?.(
					`Cron job "${job.name}" (tenant: ${job.tenant_id}): could not record the run; ` +
						`the row stays "running" until cleanup() recovers it: ${
							e instanceof Error ? e.stack ?? e.message : e
						}`
				);
				await pause();
			} finally {
				this.#activeJobs.delete(job.id);
			}
		}

		this.#logger?.debug?.(`Cron processor "${processorId}" stopped`);
	}

	// --- Private #do* methods (tenant-parameterized) ---

	async #doRegister(
		tenantId: string,
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

		this.#doSetHandler(tenantId, name, handler);

		return await _register(
			this.#tenantContext(tenantId),
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

	async #doUnregister(tenantId: string, name: string): Promise<void> {
		await this.#initializeOnce();
		const { db, tableNames } = this.#context;
		const { tableCron } = tableNames;
		await db.query(
			`DELETE FROM ${tableCron} WHERE tenant_id = $1 AND name = $2`,
			[tenantId, name]
		);
		this.#handlers.delete(this.#handlerKey(tenantId, name));
	}

	async #doEnable(tenantId: string, name: string): Promise<CronJob> {
		await this.#initializeOnce();
		const ctx = this.#tenantContext(tenantId);
		const { db, tableNames } = ctx;
		const { tableCron } = tableNames;

		// A tick that came due while the job was disabled is skipped, not
		// deferred: re-enabling resumes at the next slot instead of firing at
		// once for a run the caller had switched off. The CASE re-checks the
		// conditions atomically, so enabling an already-enabled job that is
		// merely due never loses that run.
		const current = await _findByName(ctx, name);
		const resumeAt = current && !current.enabled ? _nextRunAt(current, new Date()) : null;

		const { rows } = await db.query(
			`UPDATE ${tableCron}
			SET enabled     = TRUE,
				next_run_at = CASE
					WHEN enabled = FALSE AND next_run_at <= NOW() AND $3::timestamptz IS NOT NULL
						THEN $3::timestamptz
					ELSE next_run_at
				END,
				updated_at  = NOW()
			WHERE tenant_id = $1 AND name = $2
			RETURNING *`,
			[tenantId, name, resumeAt]
		);
		return rows[0] as CronJob;
	}

	async #doDisable(tenantId: string, name: string): Promise<CronJob> {
		await this.#initializeOnce();
		const { db, tableNames } = this.#context;
		const { tableCron } = tableNames;
		const { rows } = await db.query(
			`UPDATE ${tableCron}
			SET enabled = FALSE, updated_at = NOW()
			WHERE tenant_id = $1 AND name = $2
			RETURNING *`,
			[tenantId, name]
		);
		return rows[0] as CronJob;
	}

	async #doFind(tenantId: string, name: string): Promise<CronJob | null> {
		await this.#initializeOnce();
		return await _findByName(this.#tenantContext(tenantId), name);
	}

	async #doFetchAll(
		tenantId: string,
		options: {
			enabled?: boolean;
			status?: typeof CRON_STATUS.IDLE | typeof CRON_STATUS.RUNNING;
			limit?: number;
			offset?: number;
		} = {}
	): Promise<CronJob[]> {
		await this.#initializeOnce();
		return await _fetchAll(this.#tenantContext(tenantId), options);
	}

	async #doGetRunHistory(
		tenantId: string,
		name: string,
		options: { limit?: number; offset?: number; sinceMinutesAgo?: number } = {}
	): Promise<CronRunLog[]> {
		await this.#initializeOnce();
		const ctx = this.#tenantContext(tenantId);
		const job = await _findByName(ctx, name);
		if (!job) return [];
		return await _logRunFetchAll(ctx, job.id, options);
	}

	async #doHealthPreview(
		tenantId: string,
		sinceMinutesAgo: number = 60
	): Promise<CronHealthPreviewRow[]> {
		await this.#initializeOnce();
		return await _healthPreview(this.#tenantContext(tenantId), sinceMinutesAgo);
	}

	async #doCleanup(
		tenantId: string,
		maxAllowedRunDurationMinutes: number = 5,
		tenantScoped: boolean = true
	): Promise<number> {
		await this.#initializeOnce();
		return await _markStale(
			this.#tenantContext(tenantId),
			maxAllowedRunDurationMinutes,
			tenantScoped
		);
	}

	async #doPruneRunLog(
		tenantId: string,
		olderThanMinutes: number,
		tenantScoped: boolean
	): Promise<number> {
		await this.#initializeOnce();
		return await _logRunPrune(
			this.#tenantContext(tenantId),
			olderThanMinutes,
			tenantScoped
		);
	}

	#doSetHandler(
		tenantId: string,
		name: string,
		handler: CronHandler | undefined | null
	): void {
		const key = this.#handlerKey(tenantId, name);
		if (typeof handler === "function") {
			this.#handlers.set(key, handler);
		} else {
			this.#handlers.delete(key);
		}
	}

	#doHasHandler(tenantId: string, name: string): boolean {
		return this.#handlers.has(this.#handlerKey(tenantId, name));
	}

	#doRemoveHandler(tenantId: string, name: string): void {
		this.#handlers.delete(this.#handlerKey(tenantId, name));
	}

	/** Returns all registered handler keys (composite `${tenantId}\0${name}`). @internal */
	_handlerKeys(): string[] {
		return [...this.#handlers.keys()];
	}

	/** Returns the job names that have an in-memory handler for the given tenant. */
	#doListHandlerNames(tenantId: string): string[] {
		const prefix = `${tenantId}\0`;
		const out: string[] = [];
		for (const key of this.#handlers.keys()) {
			if (key.startsWith(prefix)) out.push(key.slice(prefix.length));
		}
		return out;
	}

	#doOnEvent(
		tenantId: string,
		pubsub: ReturnType<typeof createPubSub>,
		name: string | string[],
		cb: (job: CronJob) => void,
		skipIfExists: boolean
	): Unsubscriber {
		const names = Array.isArray(name) ? name : [name];

		// One wrap per (instance, cb). Wraps catch handler errors so they
		// can't tear down the pubsub publish loop.
		let entry = this.#eventWraps.get(cb);
		if (!entry) {
			const wrapped: Subscriber = async (job: CronJob) => {
				try {
					await cb(job);
				} catch (e) {
					this.#logger?.error?.(`onEvent ${job.name}: ${e}`);
				}
			};
			entry = { wrapped, topics: new Set() };
			this.#eventWraps.set(cb, entry);
		}
		const { wrapped, topics } = entry;
		const kind = pubsub === this.#pubsubDone ? "done" : "error";

		// What THIS call subscribed — and therefore what its unsubscriber undoes.
		const mine: Array<{ id: string; unsub: Unsubscriber }> = [];

		names.forEach((n) => {
			const key = this.#handlerKey(tenantId, n);
			if (!skipIfExists || !pubsub.isSubscribed(key, wrapped)) {
				const id = `${kind}\0${key}`;
				mine.push({ id, unsub: pubsub.subscribe(key, wrapped) });
				topics.add(id);
			}
		});

		// Returned unsubscriber: detach this call's topics, then evict the wrap
		// from the per-instance cache only when no subscription for this cb
		// remains anywhere. Tracked directly (not probed through the handler
		// map), so it is exact for names that have no handler too.
		const dispose = () => {
			for (const { id, unsub } of mine) {
				unsub();
				topics.delete(id);
			}
			mine.length = 0;
			// `unsubscribeAll()` may have replaced the entry in the meantime
			if (topics.size === 0 && this.#eventWraps.get(cb) === entry) {
				this.#eventWraps.delete(cb);
			}
		};
		const u = (() => dispose()) as Unsubscriber;
		// deno-lint-ignore no-explicit-any
		(u as any)[Symbol.dispose] = dispose;
		return u;
	}

	// --- Public: Handler management ---

	/**
	 * Returns `true` if an in-memory handler is registered for the given name.
	 */
	hasHandler(name: string): boolean {
		return this.#doHasHandler(this.#context.tenantId, name);
	}

	/** Returns the names of all in-memory handlers for the current tenant. */
	listHandlerNames(): string[] {
		return this.#doListHandlerNames(this.#context.tenantId);
	}

	/**
	 * Registers or removes a handler for a specific cron job name.
	 *
	 * Does not touch the database. Useful for re-registering handlers on restart.
	 *
	 * @returns The Cron instance for method chaining
	 */
	setHandler(name: string, handler: CronHandler | undefined | null): Cron {
		this.#doSetHandler(this.#context.tenantId, name, handler);
		return this;
	}

	/**
	 * Removes the in-memory handler for the given name.
	 *
	 * @returns The Cron instance for method chaining
	 */
	removeHandler(name: string): Cron {
		this.#doRemoveHandler(this.#context.tenantId, name);
		return this;
	}

	/** Removes all registered in-memory handlers. */
	resetHandlers(): void {
		this.#handlers.clear();
	}

	// --- Lifecycle (global — not tenant-scoped) ---

	/**
	 * Initializes the database schema (if needed) and starts N polling workers.
	 *
	 * Processors are global — they claim any due job regardless of tenant.
	 * One `start()` call serves all tenants.
	 *
	 * With a single `pg.Client` as `db` the count is clamped to 1 (see
	 * `CronOptions.db`).
	 *
	 * @param processorsCount - Number of concurrent workers (default: 2)
	 * @throws If the schema cannot be initialised, or if a `stop()` is still
	 *   draining. Nothing is started in either case.
	 */
	async start(processorsCount: number = 2): Promise<void> {
		if (this.#stopsInFlight > 0) {
			const msg = `Cannot start (shutdown in progress detected)`;
			this.#logger?.error?.(msg);
			throw new Error(msg);
		}

		try {
			await this.#initializeOnce();

			if (this.#healthMonitor) {
				await this.#healthMonitor.start();
				this.#logger?.debug?.("DB health monitoring started");
			}
		} catch (e) {
			this.#logger?.error?.(`Unable to start: ${e}`);
			this.#logger?.error?.(`CRON NOT STARTED`);
			throw e;
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

		// Registered here rather than at schema init: `stop()` detaches it, so a
		// later `start()` has to attach it again — and an instance that is only
		// used for management calls should not touch the process's signals.
		if (this.gracefulSigterm && !this.#sigtermListener) {
			this.#sigtermListener = () => {
				this.#logger?.debug?.(`SIGTERM detected...`);
				void this.stop();
			};
			process.on("SIGTERM", this.#sigtermListener);
		}

		// A single `pg.Client` is ONE session. Concurrent processors would run
		// their statements inside each other's open transactions (a rollback in
		// one would undo another's claim), and pg@9 drops the client-side query
		// queue that makes concurrent `client.query()` calls work at all.
		let count = processorsCount;
		if (!isPool(this.#db)) {
			const allowed = Math.max(0, 1 - this.#jobProcessors.length);
			if (count > allowed) {
				this.#logger?.warn?.(
					`A single pg.Client can serve only one processor; starting ${allowed} ` +
						`instead of ${count}. Pass a pg.Pool to run concurrent processors.`
				);
				count = allowed;
			}
		}

		// Reuse the controller if already running, so that one `stop()` reaches
		// every processor of this generation.
		this.#shutdownCtrl ??= new AbortController();
		const shutdownSignal = this.#shutdownCtrl.signal;

		for (let i = 0; i < count; i++) {
			const processorId = `cron-processor-${i}`;
			const processor = this.#processJobs(processorId, shutdownSignal);
			this.#jobProcessors.push(processor);
		}
		this.#logger?.debug?.(`Cron processors initialized (count: ${count})...`);
	}

	/**
	 * Gracefully stops all polling workers.
	 *
	 * Waits for in-flight jobs to finish, but no longer than `drainTimeoutMs`
	 * (default: 30 s). Pass `0` to wait forever.
	 *
	 * Once it returns the instance can be started again — also after the drain
	 * cap was hit: the abandoned processors belong to the stopped generation and
	 * exit as soon as their handler returns, without claiming anything new.
	 */
	async stop(options: CronStopOptions = {}): Promise<void> {
		const drainTimeoutMs = options.drainTimeoutMs ?? 30_000;

		// `start()` is refused for as long as any `stop()` call is draining, so
		// the state below cannot change under a concurrent `stop()` (e.g. the
		// built-in SIGTERM listener racing the application's own handler).
		this.#stopsInFlight++;
		try {
			if (this.#autoCleanupTimer) {
				clearInterval(this.#autoCleanupTimer);
				this.#autoCleanupTimer = null;
			}

			if (this.#healthMonitor) {
				this.#healthMonitor.stop();
				this.#logger?.debug?.("DB health monitoring stopped");
			}

			// Ends this generation: wakes processors from sleep, makes their loops
			// exit, and tells handlers to abort their work.
			this.#shutdownCtrl?.abort();
			this.#shutdownCtrl = null;

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
				// The abandoned processors keep running until their stuck handler
				// returns; their (aborted) signal then ends the loop.
				this.#logger?.error?.(
					`Drain timeout (${drainTimeoutMs}ms) exceeded; ` +
						`abandoning ${this.#activeJobs.size} in-flight job(s): ` +
						`[${[...this.#activeJobs].join(", ")}]`
				);
			}
			this.#jobProcessors = [];

			// Detach SIGTERM listener so the Cron instance is GC-eligible
			if (this.#sigtermListener) {
				process.off("SIGTERM", this.#sigtermListener);
				this.#sigtermListener = null;
			}
		} finally {
			this.#stopsInFlight--;
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

	// --- Registration (tenant-scoped) ---

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
			this.#context.tenantId,
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
		return await this.#doUnregister(this.#context.tenantId, name);
	}

	/**
	 * Enables a previously disabled cron job.
	 *
	 * If its `next_run_at` passed while it was disabled, the schedule resumes at
	 * the next slot — the job does not fire immediately for the tick it missed.
	 *
	 * @returns The updated CronJob row
	 */
	async enable(name: string): Promise<CronJob> {
		return await this.#doEnable(this.#context.tenantId, name);
	}

	/**
	 * Disables a cron job. Disabled jobs are skipped by the polling workers.
	 *
	 * @returns The updated CronJob row
	 */
	async disable(name: string): Promise<CronJob> {
		return await this.#doDisable(this.#context.tenantId, name);
	}

	// --- Querying (tenant-scoped) ---

	/**
	 * Finds a cron job by name.
	 *
	 * @returns The CronJob row, or `null` if not found
	 */
	async find(name: string): Promise<CronJob | null> {
		return await this.#doFind(this.#context.tenantId, name);
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
		return await this.#doFetchAll(this.#context.tenantId, options);
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
		return await this.#doGetRunHistory(this.#context.tenantId, name, options);
	}

	// --- Maintenance ---

	/**
	 * Resets stuck `running` jobs back to `idle` (crash recovery).
	 *
	 * When called on a `Cron` instance: recovers ALL stuck jobs globally.
	 * When called on a `CronTenantScope`: recovers only that tenant's jobs.
	 *
	 * A job counts as stuck when its worker has not been heard from (claim or
	 * heartbeat) for longer than the threshold — so a live worker on a long job
	 * is left alone. Keep the threshold at 3x `heartbeatIntervalMs` or more.
	 *
	 * @param maxAllowedRunDurationMinutes - Threshold in minutes (default: 5)
	 * @returns The number of rows recovered
	 */
	async cleanup(maxAllowedRunDurationMinutes: number = 5): Promise<number> {
		// Global cleanup — recovers all tenants
		return await this.#doCleanup(
			this.#context.tenantId,
			maxAllowedRunDurationMinutes,
			false // tenantScoped = false → global recovery
		);
	}

	/**
	 * Deletes run-log rows older than `olderThanMinutes`.
	 *
	 * When called on a `Cron` instance: deletes globally.
	 * When called on a `CronTenantScope`: deletes only that tenant's rows.
	 *
	 * @returns The number of rows deleted
	 */
	async pruneRunLog(olderThanMinutes: number): Promise<number> {
		return await this.#doPruneRunLog(
			this.#context.tenantId,
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
		return await this.#doHealthPreview(this.#context.tenantId, sinceMinutesAgo);
	}

	// --- Events (tenant-scoped) ---

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
			this.#context.tenantId,
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
			this.#context.tenantId,
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

	// --- Tenant scoping ---

	/**
	 * Returns a lightweight tenant-scoped view sharing this instance's
	 * processor pool.
	 *
	 * The returned object exposes only management methods — lifecycle
	 * (`start`, `stop`, `resetHard`, `uninstall`) stays on the parent `Cron`.
	 *
	 * @example
	 * ```typescript
	 * const tenantA = cron.forTenant("tenant-a");
	 * await tenantA.register("report", "0 9 * * *", handler);
	 * ```
	 */
	forTenant(tenantId: string): CronTenantScope {
		// deno-lint-ignore no-this-alias
		const self = this;
		return {
			get tenantId() {
				return tenantId;
			},
			register: (name, expression, handler, options?) =>
				self.#doRegister(tenantId, name, expression, handler, options),
			unregister: (name) => self.#doUnregister(tenantId, name),
			enable: (name) => self.#doEnable(tenantId, name),
			disable: (name) => self.#doDisable(tenantId, name),
			find: (name) => self.#doFind(tenantId, name),
			fetchAll: (options?) => self.#doFetchAll(tenantId, options),
			getRunHistory: (name, options?) =>
				self.#doGetRunHistory(tenantId, name, options),
			healthPreview: (sinceMinutesAgo?) =>
				self.#doHealthPreview(tenantId, sinceMinutesAgo),
			cleanup: (maxMins?) =>
				self.#doCleanup(tenantId, maxMins, true /* tenantScoped */),
			pruneRunLog: (olderThanMinutes) =>
				self.#doPruneRunLog(tenantId, olderThanMinutes, true),
			setHandler(name, handler) {
				self.#doSetHandler(tenantId, name, handler);
				return this;
			},
			hasHandler: (name) => self.#doHasHandler(tenantId, name),
			listHandlerNames: () => self.#doListHandlerNames(tenantId),
			removeHandler(name) {
				self.#doRemoveHandler(tenantId, name);
				return this;
			},
			onDone: (name, cb, skipIfExists?) =>
				self.#doOnEvent(tenantId, self.#pubsubDone, name, cb, skipIfExists ?? true),
			onError: (name, cb, skipIfExists?) =>
				self.#doOnEvent(tenantId, self.#pubsubError, name, cb, skipIfExists ?? true),
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
	 * - legacy → current: renames the legacy `project_id` column (and its
	 *   indexes) to `tenant_id` in place when present, preserving existing data
	 * - v1 → v2: adds `tenant_id` and updates indexes
	 * - v2 → v3: adds `lease_token`, `timezone`, and CHECK constraints
	 * - data repair: re-stamps run-log rows whose `tenant_id` differs from their
	 *   job's (written by releases that logged every run under the instance's
	 *   own tenant)
	 *
	 * Safe to call multiple times — uses `IF NOT EXISTS` / `IF EXISTS`,
	 * existence-guarded renames, and idempotent CHECK additions.
	 */
	static async migrate(
		db: pg.Pool | pg.Client,
		tablePrefix: string = ""
	): Promise<void> {
		const { tableCron, tableCronRunLog } = _tableNames(tablePrefix);
		const safe = (name: string) => `${name}`.replace(/\W/g, "");

		// Builds an `information_schema.columns` EXISTS predicate for a possibly
		// schema-qualified table (e.g. "myschema.__cron"). Used to guard the
		// legacy column rename so it's idempotent and a no-op once renamed.
		//
		// Postgres folds unquoted identifiers to lower case, so `information_schema`
		// stores them lower-cased. This package always interpolates identifiers
		// unquoted, so we lower-case the table/schema names here to match —
		// otherwise a mixed-case `tablePrefix` would make the guard miss and skip
		// the rename, stranding data in the old column.
		const colExists = (qualifiedTable: string, column: string) => {
			const dot = qualifiedTable.lastIndexOf(".");
			const bare = (
				dot >= 0 ? qualifiedTable.slice(dot + 1) : qualifiedTable
			).toLowerCase();
			const schemaPred =
				dot >= 0
					? ` AND table_schema = '${qualifiedTable.slice(0, dot).toLowerCase()}'`
					: "";
			return `EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = '${bare}'${schemaPred} AND column_name = '${column}')`;
		};

		// Use the proper transaction helper so this works against a Pool too.
		const { withTx } = await import("./utils/with-tx.ts");

		const okCronStatuses = [CRON_STATUS.IDLE, CRON_STATUS.RUNNING]
			.map((v) => `'${v}'`)
			.join(", ");
		const okRunStatuses = [RUN_STATUS.SUCCESS, RUN_STATUS.ERROR, RUN_STATUS.TIMEOUT]
			.map((v) => `'${v}'`)
			.join(", ");

		await withTx(db, async (client) => {
			// legacy → current: rename the pre-2.x `project_id` column to
			// `tenant_id` in place (data preserved). Guarded so it only fires when
			// the legacy column exists and the new one does not — making it a
			// no-op on fresh installs and on already-migrated schemas. Postgres has
			// no `IF EXISTS` for `RENAME COLUMN`, hence the DO block.
			await client.query(`
				DO $$
				BEGIN
					IF ${colExists(tableCron, "project_id")}
						AND NOT ${colExists(tableCron, "tenant_id")} THEN
						EXECUTE 'ALTER TABLE ${tableCron} RENAME COLUMN project_id TO tenant_id';
					END IF;

					IF ${colExists(tableCronRunLog, "project_id")}
						AND NOT ${colExists(tableCronRunLog, "tenant_id")} THEN
						EXECUTE 'ALTER TABLE ${tableCronRunLog} RENAME COLUMN project_id TO tenant_id';
					END IF;
				END $$;

				ALTER INDEX IF EXISTS idx_${safe(tableCron)}_project_name
					RENAME TO idx_${safe(tableCron)}_tenant_name;

				ALTER INDEX IF EXISTS idx_${safe(tableCronRunLog)}_project_id
					RENAME TO idx_${safe(tableCronRunLog)}_tenant_id;
			`);

			// v1 → v2
			await client.query(`
				ALTER TABLE ${tableCron}
					ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(255) NOT NULL DEFAULT '_default';

				DROP INDEX IF EXISTS idx_${safe(tableCron)}_name;

				CREATE UNIQUE INDEX IF NOT EXISTS idx_${safe(tableCron)}_tenant_name
					ON ${tableCron}(tenant_id, name);

				DROP INDEX IF EXISTS idx_${safe(tableCron)}_next_run_at;
				CREATE INDEX IF NOT EXISTS idx_${safe(tableCron)}_next_run_at
					ON ${tableCron}(enabled, status, next_run_at);

				ALTER TABLE ${tableCronRunLog}
					ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(255) NOT NULL DEFAULT '_default';

				CREATE INDEX IF NOT EXISTS idx_${safe(tableCronRunLog)}_tenant_id
					ON ${tableCronRunLog}(tenant_id);
			`);

			// Data repair: earlier releases stamped every run-log row with the
			// tenant of the Cron instance that executed it, not the job's. The
			// FK makes the owning job unambiguous, so re-stamp from it. A no-op
			// once repaired.
			await client.query(`
				UPDATE ${tableCronRunLog} AS l
				SET tenant_id = c.tenant_id
				FROM ${tableCron} AS c
				WHERE c.id = l.cron_id
				  AND l.tenant_id IS DISTINCT FROM c.tenant_id;
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
