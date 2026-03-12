/**
 * Parses and evaluates standard 5-field cron expressions.
 *
 * Supports wildcards, ranges (1-5), lists (1,3,5),
 * and step values (e.g. every 5 minutes, or 2-10 with step 3).
 *
 * @example
 * ```typescript
 * const parser = new CronParser("0 2 * * 1-5");
 * const next = parser.getNextRun();
 * console.log(parser.matches(new Date()));
 * ```
 */
export class CronParser {
	/** The original cron expression string. */
	readonly expression: string;
	/** Expanded minute values (0–59). */
	readonly minute: number[];
	/** Expanded hour values (0–23). */
	readonly hour: number[];
	/** Expanded day-of-month values (1–31). */
	readonly dayOfMonth: number[];
	/** Expanded month values (1–12). */
	readonly month: number[];
	/** Expanded day-of-week values (0–6, where 0 = Sunday). */
	readonly dayOfWeek: number[];

	/**
	 * Creates a new CronParser instance.
	 *
	 * @param expression - A standard 5-field cron expression (minute, hour, day-of-month, month, day-of-week)
	 * @throws If the expression contains invalid characters or does not have exactly 5 fields
	 */
	constructor(expression: string) {
		this.expression = expression;

		// Validate allowed characters
		if (!/^[\d\*\-\,\/\s]+$/.test(expression)) {
			throw new Error(
				"Cron expression contains invalid characters. Allowed: digits, *, -, /, ,",
			);
		}

		const parts = expression.trim().split(/\s+/);

		if (parts.length !== 5) {
			throw new Error("Cron expression must have exactly 5 fields");
		}

		this.minute = this._parseField(parts[0], 0, 59, "minute");
		this.hour = this._parseField(parts[1], 0, 23, "hour");
		this.dayOfMonth = this._parseField(parts[2], 1, 31, "day of month");
		this.month = this._parseField(parts[3], 1, 12, "month");
		this.dayOfWeek = this._parseField(parts[4], 0, 6, "day of week");
	}

	private _parseField(
		field: string,
		min: number,
		max: number,
		fieldName: string,
	): number[] {
		// Wildcard
		if (field === "*") {
			return this._range(min, max);
		}

		// Step values (*/5 or 2-10/3)
		if (field.includes("/")) {
			const [range, step] = field.split("/");
			const stepNum = parseInt(step);

			if (isNaN(stepNum) || stepNum <= 0) {
				throw new Error(
					`Invalid step value in ${fieldName}: ${step}`,
				);
			}

			if (range === "*") {
				return this._range(min, max).filter(
					(_, i) => i % stepNum === 0,
				);
			}

			const [start, end] = range.split("-").map(Number);
			this._validateRange(start, end, min, max, fieldName);
			return this._range(start, end).filter(
				(_, i) => i % stepNum === 0,
			);
		}

		// Range (1-5)
		if (field.includes("-")) {
			const [start, end] = field.split("-").map(Number);
			this._validateRange(start, end, min, max, fieldName);
			return this._range(start, end);
		}

		// List (1,3,5)
		if (field.includes(",")) {
			const values = field.split(",").map(Number);
			values.forEach((v) => {
				if (isNaN(v) || v < min || v > max) {
					throw new Error(
						`Invalid value in ${fieldName}: ${v} (must be ${min}-${max})`,
					);
				}
			});
			return values;
		}

		// Single value
		const value = parseInt(field);
		if (isNaN(value) || value < min || value > max) {
			throw new Error(
				`Invalid ${fieldName}: ${field} (must be ${min}-${max})`,
			);
		}
		return [value];
	}

	private _validateRange(
		start: number,
		end: number,
		min: number,
		max: number,
		fieldName: string,
	): void {
		if (isNaN(start) || isNaN(end)) {
			throw new Error(
				`Invalid range in ${fieldName}: ${start}-${end}`,
			);
		}
		if (start < min || start > max || end < min || end > max) {
			throw new Error(
				`Range out of bounds in ${fieldName}: ${start}-${end} (must be ${min}-${max})`,
			);
		}
		if (start > end) {
			throw new Error(
				`Invalid range in ${fieldName}: ${start}-${end} (start > end)`,
			);
		}
	}

	private _range(start: number, end: number): number[] {
		return Array.from({ length: end - start + 1 }, (_, i) => start + i);
	}

	/**
	 * Tests whether the given date matches this cron expression.
	 *
	 * @param date - The date to test against
	 */
	matches(date: Date): boolean {
		return (
			this.minute.includes(date.getMinutes()) &&
			this.hour.includes(date.getHours()) &&
			this.dayOfMonth.includes(date.getDate()) &&
			this.month.includes(date.getMonth() + 1) &&
			this.dayOfWeek.includes(date.getDay())
		);
	}

	/**
	 * Calculates the next run time that matches this cron expression.
	 *
	 * @param fromDate - Starting point for the search (default: now)
	 * @throws If no matching time is found within one year
	 */
	getNextRun(fromDate: Date = new Date()): Date {
		const next = new Date(fromDate);
		next.setSeconds(0, 0);
		next.setMinutes(next.getMinutes() + 1);

		const maxIterations = 366 * 24 * 60; // one year of minutes
		let iterations = 0;

		while (!this.matches(next) && iterations < maxIterations) {
			next.setMinutes(next.getMinutes() + 1);
			iterations++;
		}

		if (iterations >= maxIterations) {
			throw new Error(
				"Could not find next run time within one year",
			);
		}

		return next;
	}
}
