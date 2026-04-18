import { CRON_STATUS, RUN_STATUS, type CronContext } from "./cron.ts";
import { withTx } from "./utils/with-tx.ts";

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

	const okCronStatuses = [CRON_STATUS.IDLE, CRON_STATUS.RUNNING]
		.map((v) => `'${v}'`)
		.join(", ");
	const okRunStatuses = [RUN_STATUS.SUCCESS, RUN_STATUS.ERROR, RUN_STATUS.TIMEOUT]
		.map((v) => `'${v}'`)
		.join(", ");

	// prettier-ignore
	return `
		CREATE TABLE IF NOT EXISTS ${tableCron} (
			id                      SERIAL PRIMARY KEY,
			uid                     UUID NOT NULL DEFAULT gen_random_uuid(),
			project_id              VARCHAR(255) NOT NULL DEFAULT '_default',
			name                    VARCHAR(255) NOT NULL,
			expression              VARCHAR(100) NOT NULL,
			timezone                VARCHAR(64),
			payload                 JSONB NOT NULL DEFAULT '{}',
			enabled                 BOOLEAN NOT NULL DEFAULT TRUE,
			status                  VARCHAR(20) NOT NULL DEFAULT '${CRON_STATUS.IDLE}'
				CHECK (status IN (${okCronStatuses})),
			next_run_at             TIMESTAMPTZ NOT NULL,
			last_run_at             TIMESTAMPTZ,
			last_run_status         VARCHAR(20)
				CHECK (last_run_status IS NULL OR last_run_status IN (${okRunStatuses})),
			lease_token             UUID,
			max_attempts            INTEGER NOT NULL DEFAULT 1
				CHECK (max_attempts >= 1),
			max_attempt_duration_ms INTEGER NOT NULL DEFAULT 0
				CHECK (max_attempt_duration_ms >= 0),
			backoff_strategy        VARCHAR(20) NOT NULL DEFAULT 'none',
			created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);

		CREATE UNIQUE INDEX IF NOT EXISTS idx_${safe(tableCron)}_project_name
			ON ${tableCron}(project_id, name);

		CREATE INDEX IF NOT EXISTS idx_${safe(tableCron)}_next_run_at
			ON ${tableCron}(enabled, status, next_run_at);

		-- Per-execution audit log
		CREATE TABLE IF NOT EXISTS ${tableCronRunLog} (
			id              SERIAL PRIMARY KEY,
			cron_id         INTEGER NOT NULL,
			cron_name       VARCHAR(255) NOT NULL,
			project_id      VARCHAR(255) NOT NULL DEFAULT '_default',
			scheduled_at    TIMESTAMPTZ NOT NULL,
			started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			completed_at    TIMESTAMPTZ,
			attempt_number  INTEGER NOT NULL DEFAULT 1
				CHECK (attempt_number >= 1),
			status          VARCHAR(20)
				CHECK (status IS NULL OR status IN (${okRunStatuses})),
			result          JSONB,
			error_message   TEXT,
			error_details   JSONB,

			FOREIGN KEY (cron_id) REFERENCES ${tableCron}(id) ON UPDATE CASCADE ON DELETE CASCADE
		);

		CREATE INDEX IF NOT EXISTS idx_${safe(tableCronRunLog)}_cron_id
			ON ${tableCronRunLog}(cron_id);

		CREATE INDEX IF NOT EXISTS idx_${safe(tableCronRunLog)}_started_at
			ON ${tableCronRunLog}(started_at DESC);

		CREATE INDEX IF NOT EXISTS idx_${safe(tableCronRunLog)}_project_id
			ON ${tableCronRunLog}(project_id);
	`;
}

export async function _initialize(
	context: CronContext,
	hard = false
): Promise<void> {
	const sql = [hard && _schemaDrop(context), _schemaCreate(context)]
		.filter(Boolean)
		.join("\n");

	await withTx(context.db, async (client) => {
		await client.query(sql);
	});
}

export async function _uninstall(context: CronContext): Promise<void> {
	await withTx(context.db, async (client) => {
		await client.query(_schemaDrop(context));
	});
}
