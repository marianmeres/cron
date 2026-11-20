/**
 * @module with-db-retry
 *
 * Provides database operation retry functionality with exponential backoff, on
 * sqlkit's `withRetry`. What is worth another call is decided by sqlkit's Postgres
 * classifier (`classifyPg`): a lost or refused connection, a server that is starting
 * up or shutting down, too many connections, a deadlock, a serialization failure, a
 * lock not granted in time, and node-postgres's pool timeout.
 */

import type { Logger } from "@marianmeres/clog";
import { classifyPg, toSqlError, withRetry } from "@marianmeres/sqlkit";

/**
 * Configuration options for database retry behavior.
 *
 * An option of the wrong type or out of range is a `TypeError` at the call.
 */
export interface DbRetryOptions {
	/** Maximum number of retries after the first call, a non-negative integer (default: 3) */
	maxRetries?: number;
	/** Initial delay before first retry in milliseconds (default: 100) */
	initialDelayMs?: number;
	/** Maximum delay between retries in milliseconds (default: 5000) */
	maxDelayMs?: number;
	/** Multiplier for exponential backoff, at least 1 (default: 2) */
	backoffMultiplier?: number;
	/**
	 * Error codes that should trigger a retry. When given, this list replaces the default
	 * classification: an error is retried when its `code` is one of them, or when its
	 * message contains one of them.
	 */
	retryableErrors?: string[];
	/** Logger instance for retry attempt logging */
	logger?: Logger;
}

/**
 * sqlkit's classification, for its own `SqlError` (passed through as it is) and for a
 * raw driver error alike (classified by `classifyPg`).
 */
const isRetryable = (error: unknown): boolean =>
	toSqlError(error, "pg", classifyPg).retryable;

/** The error's `code`, when it has one. */
const codeOf = (error: unknown): unknown =>
	(error as Record<string, unknown> | null)?.code;

/** The error's message, or the error itself as a string. */
const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** The rule a caller-supplied `retryableErrors` list is matched by: the code, or the code in the message. */
const matches = (error: unknown, codes: string[]): boolean => {
	const errorCode = codeOf(error);
	const errorMessage = messageOf(error);
	return codes.some((code) => errorCode === code || errorMessage.includes(code));
};

/**
 * Wraps a database operation with exponential backoff retry logic.
 *
 * Retries the operation while it rejects with an error sqlkit classifies as retryable
 * (see the module comment), or, with `retryableErrors`, with an error that list names.
 * The whole function runs again, so it belongs around something safe to run twice: one
 * statement, or a whole `transaction` call, never a part of a transaction.
 *
 * @typeParam T - The return type of the wrapped function
 * @param fn - The async function to execute with retry logic
 * @param options - Retry configuration options
 * @returns The result of the function, or throws on final failure
 * @throws {TypeError} If an option is of the wrong type or out of range
 *
 * @example
 * ```typescript
 * const result = await withDbRetry(
 *   async () => await db.query("SELECT * FROM users"),
 *   { maxRetries: 5, initialDelayMs: 200 }
 * );
 * ```
 */
export async function withDbRetry<T>(
	fn: () => Promise<T>,
	options: DbRetryOptions = {},
): Promise<T> {
	const {
		maxRetries = 3,
		initialDelayMs = 100,
		maxDelayMs = 5000,
		backoffMultiplier = 2,
		retryableErrors,
		logger,
	} = options;

	return await withRetry(() => fn(), {
		retries: maxRetries,
		initialDelayMs,
		maxDelayMs,
		factor: backoffMultiplier,
		retryable: retryableErrors
			? (error) => matches(error, retryableErrors)
			: isRetryable,
		// `attempt` is the call that failed, 1 for the first
		onRetry: ({ attempt, delayMs, error }) => {
			logger?.warn?.(
				`DB operation failed (attempt ${attempt}/${maxRetries + 1}): ${
					codeOf(error) || messageOf(error)
				}. Retrying in ${delayMs}ms...`,
			);
		},
	});
}
