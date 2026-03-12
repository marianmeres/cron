import pg from "pg";

const { PG_HOST, PG_DATABASE, PG_USER, PG_PASSWORD, PG_PORT } = {
	PG_HOST: Deno.env.get("TEST_PG_HOST") || "localhost",
	PG_DATABASE: Deno.env.get("TEST_PG_DATABASE"),
	PG_USER: Deno.env.get("TEST_PG_USER"),
	PG_PASSWORD: Deno.env.get("TEST_PG_PASSWORD"),
	PG_PORT: Deno.env.get("TEST_PG_PORT") || "5432",
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
