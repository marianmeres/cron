import process from "node:process";
import pg from "pg";

const { PG_HOST, PG_DATABASE, PG_USER, PG_PASSWORD, PG_PORT } = {
	PG_HOST: process.env.TEST_PG_HOST || "localhost",
	PG_DATABASE: process.env.TEST_PG_DATABASE,
	PG_USER: process.env.TEST_PG_USER,
	PG_PASSWORD: process.env.TEST_PG_PASSWORD,
	PG_PORT: process.env.TEST_PG_PORT || "5432",
};

export function createPg() {
	return new pg.Pool({
		host: PG_HOST,
		user: PG_USER,
		database: PG_DATABASE,
		password: PG_PASSWORD,
		port: parseInt(PG_PORT!),
	});
}

/** A single (unconnected) client with the same settings — call `connect()` yourself. */
export function createPgClient() {
	return new pg.Client({
		host: PG_HOST,
		user: PG_USER,
		database: PG_DATABASE,
		password: PG_PASSWORD,
		port: parseInt(PG_PORT!),
	});
}
