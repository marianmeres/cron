/**
 * @module with-db-retry
 *
 * Provides database operation retry functionality with exponential backoff.
 * Automatically retries on transient database errors like connection timeouts
 * and network issues.
 */

import type { Logger } from "@marianmeres/clog";
import { sleep } from "./sleep.ts";

/**
 * Configuration options for database retry behavior.
 */
export interface DbRetryOptions {
	/** Maximum number of retry attempts (default: 3) */
	maxRetries?: number;
	/** Initial delay before first retry in milliseconds (default: 100) */
	initialDelayMs?: number;
	/** Maximum delay between retries in milliseconds (default: 5000) */
	maxDelayMs?: number;
	/** Multiplier for exponential backoff (default: 2) */
	backoffMultiplier?: number;
	/** Error codes that should trigger a retry */
	retryableErrors?: string[];
	/** Logger instance for retry attempt logging */
	logger?: Logger;
}

const DEFAULT_RETRYABLE_ERRORS = [
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"ENOTFOUND",
	"57P03", // PG: cannot_connect_now
	"08006", // PG: connection_failure
	"08003", // PG: connection_does_not_exist
	"08000", // PG: connection_exception
];

/**
 * Wraps a database operation with exponential backoff retry logic.
 *
 * Automatically retries the operation on transient database errors such as
 * connection refused, timeouts, and PostgreSQL-specific connection errors.
 *
 * @typeParam T - The return type of the wrapped function
 * @param fn - The async function to execute with retry logic
 * @param options - Retry configuration options
 * @returns The result of the function, or throws on final failure
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
	options: DbRetryOptions = {}
): Promise<T> {
	const {
		maxRetries = 3,
		initialDelayMs = 100,
		maxDelayMs = 5000,
		backoffMultiplier = 2,
		retryableErrors = DEFAULT_RETRYABLE_ERRORS,
		logger,
	} = options;

	let lastError: any;
	let delayMs = initialDelayMs;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error: any) {
			lastError = error;

			// Check if error is retryable
			const errorCode = error?.code;
			const isRetryable = retryableErrors.some(
				(code) => errorCode === code || error?.message?.includes(code)
			);

			// Don't retry on last attempt or non-retryable errors
			if (attempt === maxRetries || !isRetryable) {
				throw error;
			}

			logger?.warn?.(
				`DB operation failed (attempt ${attempt + 1}/${maxRetries + 1}): ${
					errorCode || error?.message
				}. Retrying in ${delayMs}ms...`
			);

			// wait before retry
			await sleep(delayMs);

			// Exponential backoff
			delayMs = Math.min(delayMs * backoffMultiplier, maxDelayMs);
		}
	}

	throw lastError;
}
