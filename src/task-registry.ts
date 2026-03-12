import type { CronHandler } from "./cron.ts";

/**
 * Definition of a task type in the registry.
 */
export interface TaskDefinition {
	/** Human-readable description of what this task does */
	description?: string;
	/** JSON Schema describing the expected payload parameters */
	// deno-lint-ignore no-explicit-any
	paramsSchema?: Record<string, any>;
	/** The handler function to execute */
	handler: CronHandler;
}

/**
 * A task registry entry as returned by `list()` — handler omitted for safe serialization.
 */
export interface TaskRegistryEntry {
	taskType: string;
	description?: string;
	// deno-lint-ignore no-explicit-any
	paramsSchema?: Record<string, any>;
}

/**
 * Validation result from `validate()`.
 */
export interface TaskValidationResult {
	valid: boolean;
	errors: Array<{ path: string; message: string }>;
}

/**
 * In-memory catalog of known task types with handlers and parameter schemas.
 *
 * The registry is the "what can be done" layer — it maps string labels to
 * handler functions and optional JSON Schema definitions for payload validation.
 */
export interface TaskRegistry {
	/** Register a new task type. Throws if `taskType` is already defined. */
	define(taskType: string, definition: TaskDefinition): void;

	/** Returns the full definition (including handler) for a task type. */
	get(taskType: string): TaskDefinition | undefined;

	/** Returns `true` if the task type is registered. */
	has(taskType: string): boolean;

	/** Returns all registered task types without handlers (safe for API/UI). */
	list(): TaskRegistryEntry[];

	/**
	 * Validates a payload against the task type's `paramsSchema`.
	 * Returns `{ valid: true, errors: [] }` if no schema is defined.
	 *
	 * Requires `@marianmeres/modelize` to be installed.
	 */
	validate(
		taskType: string,
		payload: Record<string, unknown>
	): Promise<TaskValidationResult>;
}

/**
 * Creates a new task registry instance.
 *
 * @example
 * ```typescript
 * const registry = createTaskRegistry();
 *
 * registry.define("send-report", {
 *   description: "Send a report to recipients",
 *   paramsSchema: {
 *     type: "object",
 *     properties: {
 *       recipients: { type: "array", items: { type: "string" } },
 *       format: { type: "string", enum: ["pdf", "csv"] },
 *     },
 *     required: ["recipients"],
 *   },
 *   handler: async (job) => {
 *     // ...business logic using job.payload
 *   },
 * });
 * ```
 */
export function createTaskRegistry(): TaskRegistry {
	const registry = new Map<string, TaskDefinition>();

	function define(taskType: string, definition: TaskDefinition): void {
		if (registry.has(taskType)) {
			throw new Error(
				`Task type "${taskType}" is already defined`
			);
		}
		registry.set(taskType, definition);
	}

	function get(taskType: string): TaskDefinition | undefined {
		return registry.get(taskType);
	}

	function has(taskType: string): boolean {
		return registry.has(taskType);
	}

	function list(): TaskRegistryEntry[] {
		const entries: TaskRegistryEntry[] = [];
		for (const [taskType, def] of registry) {
			entries.push({
				taskType,
				description: def.description,
				paramsSchema: def.paramsSchema,
			});
		}
		return entries;
	}

	async function validate(
		taskType: string,
		payload: Record<string, unknown>
	): Promise<TaskValidationResult> {
		const def = registry.get(taskType);
		if (!def) {
			throw new Error(`Unknown task type "${taskType}"`);
		}
		if (!def.paramsSchema) {
			return { valid: true, errors: [] };
		}

		let modelize: typeof import("@marianmeres/modelize").modelize;
		try {
			const mod = await import("@marianmeres/modelize");
			modelize = mod.modelize;
		} catch {
			throw new Error(
				`@marianmeres/modelize is required for schema validation. ` +
					`Install it to use paramsSchema.`
			);
		}

		const model = modelize(
			{ ...payload } as Record<string, unknown>,
			{ schema: def.paramsSchema }
		);

		// deno-lint-ignore no-explicit-any
		const m = model as any;
		const valid: boolean = m.__isValid;
		const errors: Array<{ path: string; message: string }> = valid
			? []
			: [...m.__errors];

		return { valid, errors };
	}

	return { define, get, has, list, validate };
}
