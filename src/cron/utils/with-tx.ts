import type pg from "pg";

/**
 * Type guard: distinguishes a `pg.Pool` from a `pg.Client`.
 *
 * `pg.Pool` exposes a `connect()` that returns a `PoolClient` requiring a
 * `release()` call. `pg.Client` may expose `connect()` too, but it returns
 * `void` and there is no per-call client lifecycle.
 */
function isPool(db: pg.Pool | pg.Client): db is pg.Pool {
	// `pg.Pool` exposes `totalCount` (and `idleCount`/`waitingCount`); `pg.Client` does not.
	// deno-lint-ignore no-explicit-any
	return typeof (db as any).totalCount === "number";
}

/**
 * Runs `fn` inside a single PostgreSQL transaction.
 *
 * Crucially: when `db` is a `pg.Pool`, this checks out a single underlying
 * connection so that `BEGIN` / queries / `COMMIT` all run on the same
 * physical session. (Calling `pool.query("BEGIN")` directly is a no-op
 * because pg returns the connection to the pool right after.)
 *
 * If `fn` throws, the transaction is rolled back and the error re-thrown.
 *
 * @internal
 */
export async function withTx<T>(
	db: pg.Pool | pg.Client,
	fn: (client: pg.PoolClient | pg.Client) => Promise<T>
): Promise<T> {
	if (isPool(db)) {
		const client = await db.connect();
		try {
			await client.query("BEGIN");
			const out = await fn(client);
			await client.query("COMMIT");
			return out;
		} catch (e) {
			try {
				await client.query("ROLLBACK");
			} catch {
				// ignore rollback failure — original error is more interesting
			}
			throw e;
		} finally {
			client.release();
		}
	}

	// Single Client — already a single session
	try {
		await db.query("BEGIN");
		const out = await fn(db);
		await db.query("COMMIT");
		return out;
	} catch (e) {
		try {
			await db.query("ROLLBACK");
		} catch {
			// ignore
		}
		throw e;
	}
}
