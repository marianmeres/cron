import { CRON_STATUS, type CronContext } from "./cron.ts";

export function _schemaDrop(context: Pick<CronContext, "tableNames">): string {
	const { tableCron, tableCronRunLog } = context.tableNames;
	return `
		DROP TABLE IF EXISTS ${tableCronRunLog};
		DROP TABLE IF EXISTS ${tableCron};
	`;
}

export function _schemaCreate(context: Pick<CronContext, "tableNames">): string {
	const { tableCron, tableCronRunLog } = context.tableNames;

	// so we can work with "schema." prefix in naming things...
	const safe = (name: string) => `${name}`.replace(/\W/g, "");

	// prettier-ignore
	return `
		CREATE TABLE IF NOT EXISTS ${tableCron} (
			id                      SERIAL PRIMARY KEY,
			uid                     UUID NOT NULL DEFAULT gen_random_uuid(),
			name                    VARCHAR(255) NOT NULL UNIQUE,
			expression              VARCHAR(100) NOT NULL,
			payload                 JSONB NOT NULL DEFAULT '{}',
			enabled                 BOOLEAN NOT NULL DEFAULT TRUE,
			status                  VARCHAR(20) NOT NULL DEFAULT '${CRON_STATUS.IDLE}',
			next_run_at             TIMESTAMPTZ NOT NULL,
			last_run_at             TIMESTAMPTZ,
			last_run_status         VARCHAR(20),
			max_attempts            INTEGER NOT NULL DEFAULT 1,
			max_attempt_duration_ms INTEGER NOT NULL DEFAULT 0,
			backoff_strategy        VARCHAR(20) NOT NULL DEFAULT 'none',
			created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);

		CREATE UNIQUE INDEX IF NOT EXISTS idx_${safe(tableCron)}_name
			ON ${tableCron}(name);

		CREATE INDEX IF NOT EXISTS idx_${safe(tableCron)}_next_run_at
			ON ${tableCron}(enabled, status, next_run_at);

		-- Per-execution audit log
		CREATE TABLE IF NOT EXISTS ${tableCronRunLog} (
			id              SERIAL PRIMARY KEY,
			cron_id         INTEGER NOT NULL,
			cron_name       VARCHAR(255) NOT NULL,
			scheduled_at    TIMESTAMPTZ NOT NULL,
			started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			completed_at    TIMESTAMPTZ,
			attempt_number  INTEGER NOT NULL DEFAULT 1,
			status          VARCHAR(20),
			result          JSONB,
			error_message   TEXT,
			error_details   JSONB,

			FOREIGN KEY (cron_id) REFERENCES ${tableCron}(id) ON UPDATE CASCADE ON DELETE CASCADE
		);

		CREATE INDEX IF NOT EXISTS idx_${safe(tableCronRunLog)}_cron_id
			ON ${tableCronRunLog}(cron_id);

		CREATE INDEX IF NOT EXISTS idx_${safe(tableCronRunLog)}_started_at
			ON ${tableCronRunLog}(started_at DESC);
	`;
}

export async function _initialize(
	context: CronContext,
	hard = false
): Promise<void> {
	const { db } = context;

	const sql = [hard && _schemaDrop(context), _schemaCreate(context)]
		.filter(Boolean)
		.join("\n");

	await db.query("BEGIN");
	await db.query(sql);
	await db.query("COMMIT");
}

export async function _uninstall(context: CronContext): Promise<void> {
	const { db } = context;
	await db.query("BEGIN");
	await db.query(_schemaDrop(context));
	await db.query("COMMIT");
}
