/**
 * Parses and evaluates standard 5-field cron expressions.
 *
 * Supports wildcards, ranges (1-5), lists (1,3,5),
 * and step values (e.g. every 5 minutes, or 2-10 with step 3).
 *
 * **Day-of-month + day-of-week semantics:** when both are restricted (i.e.
 * neither is `*`), the expression matches a date that satisfies *either*
 * field — this matches POSIX / Vixie cron. When one of the two is `*`,
 * only the other restricts.
 *
 * **Timezone:** by default, all date math is in the host's local timezone.
 * Pass `{ timezone: "Europe/Prague" }` (any IANA name) to evaluate the
 * expression in that timezone. This correctly handles DST transitions:
 * the underlying iteration walks UTC minutes and asks "does the wall-clock
 * representation in TZ match?", so spring-forward gaps simply skip the
 * non-existent minutes and fall-back overlaps fire only once.
 *
 * @example
 * ```typescript
 * const parser = new CronParser("0 2 * * 1-5");
 * const next = parser.getNextRun();
 * console.log(parser.matches(new Date()));
 *
 * // Timezone-aware
 * const tz = new CronParser("0 9 * * 1-5", { timezone: "America/New_York" });
 * ```
 */
export interface CronParserOptions {
	/** IANA timezone (e.g. "UTC", "Europe/Prague"). Default: host local time. */
	timezone?: string;
}

export class CronParser {
	/** The original cron expression string. */
	readonly expression: string;
	/** Optional IANA timezone the expression is evaluated in. */
	readonly timezone: string | null;
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
	/** True if the day-of-month field was `*` (unrestricted). */
	readonly dayOfMonthIsStar: boolean;
	/** True if the day-of-week field was `*` (unrestricted). */
	readonly dayOfWeekIsStar: boolean;

	/**
	 * Creates a new CronParser instance.
	 *
	 * @param expression - A standard 5-field cron expression (minute, hour, day-of-month, month, day-of-week)
	 * @param options - Optional `timezone` (IANA name)
	 * @throws If the expression contains invalid characters, does not have exactly 5 fields,
	 *   or describes a calendar combination that can never occur (e.g. `0 0 31 2 *`)
	 */
	constructor(expression: string, options: CronParserOptions = {}) {
		this.expression = expression;
		this.timezone = options.timezone ?? null;

		// Validate timezone eagerly so misuse fails fast at construction time
		if (this.timezone) {
			try {
				new Intl.DateTimeFormat("en-US", { timeZone: this.timezone });
			} catch {
				throw new Error(
					`Invalid timezone: "${this.timezone}" (must be a valid IANA timezone name)`
				);
			}
		}

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
		this.dayOfMonthIsStar = this._fieldIsStar(parts[2]);
		this.dayOfWeekIsStar = this._fieldIsStar(parts[4]);

		// Reject calendar combinations that have zero solutions
		this._assertHasSolution();
	}

	private _fieldIsStar(field: string): boolean {
		// "*" or "*/n" both cover the entire range and behave like "*"
		// for the OR-vs-AND day-of-month/day-of-week rule.
		return field === "*" || /^\*\/\d+$/.test(field);
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

	/** Throws if no calendar date can ever satisfy this expression. */
	private _assertHasSolution(): void {
		// max possible day for each month (ignoring leap year for Feb)
		const maxDay: Record<number, number> = {
			1: 31, 2: 29, 3: 31, 4: 30, 5: 31, 6: 30,
			7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31,
		};

		// Check if at least one (month, day) pair is anatomically possible.
		// If day-of-week is restricted, it can rescue an otherwise-impossible
		// day-of-month, so don't reject in that case.
		if (!this.dayOfWeekIsStar) return;

		const anyValid = this.month.some((m) =>
			this.dayOfMonth.some((d) => d <= maxDay[m])
		);
		if (!anyValid) {
			throw new Error(
				`Cron expression "${this.expression}" describes a date that does not exist`,
			);
		}
	}

	/** Returns the wall-clock components of `date` in this parser's timezone. */
	private _getParts(date: Date): {
		minute: number;
		hour: number;
		day: number;
		month: number;
		dayOfWeek: number;
	} {
		if (!this.timezone) {
			return {
				minute: date.getMinutes(),
				hour: date.getHours(),
				day: date.getDate(),
				month: date.getMonth() + 1,
				dayOfWeek: date.getDay(),
			};
		}

		// Use Intl to get wall-clock fields in the requested zone
		const fmt = new Intl.DateTimeFormat("en-US", {
			timeZone: this.timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			weekday: "short",
			hour12: false,
		});

		const parts = fmt.formatToParts(date);
		const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
		const weekdayMap: Record<string, number> = {
			Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
		};
		// `hour` may come back as "24" in some ICU versions for midnight — normalise
		let h = parseInt(get("hour"), 10);
		if (h === 24) h = 0;

		return {
			minute: parseInt(get("minute"), 10),
			hour: h,
			day: parseInt(get("day"), 10),
			month: parseInt(get("month"), 10),
			dayOfWeek: weekdayMap[get("weekday")] ?? 0,
		};
	}

	/**
	 * Tests whether the given date matches this cron expression.
	 *
	 * @param date - The date to test against
	 */
	matches(date: Date): boolean {
		const p = this._getParts(date);

		const timeMatches =
			this.minute.includes(p.minute) &&
			this.hour.includes(p.hour) &&
			this.month.includes(p.month);

		if (!timeMatches) return false;

		const dayMatches = this.dayOfMonth.includes(p.day);
		const dowMatches = this.dayOfWeek.includes(p.dayOfWeek);

		// POSIX/Vixie cron: when both DoM and DoW are restricted, OR them.
		// When one is `*`, only the other restricts.
		if (this.dayOfMonthIsStar && this.dayOfWeekIsStar) return true;
		if (this.dayOfMonthIsStar) return dowMatches;
		if (this.dayOfWeekIsStar) return dayMatches;
		return dayMatches || dowMatches;
	}

	/**
	 * Calculates the next run time that matches this cron expression.
	 *
	 * @param fromDate - Starting point for the search (default: now)
	 * @throws If no matching time is found within ~8 years (defensive cap)
	 */
	getNextRun(fromDate: Date = new Date()): Date {
		const next = new Date(fromDate);
		next.setSeconds(0, 0);
		next.setMinutes(next.getMinutes() + 1);

		// 8 years of minutes — generous enough for leap-day schedules and
		// rare day-of-week + day-of-month combinations.
		const maxIterations = 8 * 366 * 24 * 60;
		let iterations = 0;

		while (!this.matches(next) && iterations < maxIterations) {
			next.setMinutes(next.getMinutes() + 1);
			iterations++;
		}

		if (iterations >= maxIterations) {
			throw new Error(
				`Could not find next run time within 8 years for "${this.expression}"`,
			);
		}

		return next;
	}
}
