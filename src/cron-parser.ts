class CronParser {
	constructor(expression) {
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

		// Validate each field
		this.minute = this.parseField(parts[0], 0, 59, "minute");
		this.hour = this.parseField(parts[1], 0, 23, "hour");
		this.dayOfMonth = this.parseField(parts[2], 1, 31, "day of month");
		this.month = this.parseField(parts[3], 1, 12, "month");
		this.dayOfWeek = this.parseField(parts[4], 0, 6, "day of week");
	}

	parseField(field, min, max, fieldName) {
		// Wildcard
		if (field === "*") {
			return this.range(min, max);
		}

		// Step values
		if (field.includes("/")) {
			const [range, step] = field.split("/");
			const stepNum = parseInt(step);

			if (isNaN(stepNum) || stepNum <= 0) {
				throw new Error(`Invalid step value in ${fieldName}: ${step}`);
			}

			if (range === "*") {
				return this.range(min, max).filter((_, i) => i % stepNum === 0);
			}

			const [start, end] = range.split("-").map(Number);
			this.validateRange(start, end, min, max, fieldName);
			return this.range(start, end).filter((v, i) => i % stepNum === 0);
		}

		// Range
		if (field.includes("-")) {
			const [start, end] = field.split("-").map(Number);
			this.validateRange(start, end, min, max, fieldName);
			return this.range(start, end);
		}

		// List
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

	validateRange(start, end, min, max, fieldName) {
		if (isNaN(start) || isNaN(end)) {
			throw new Error(`Invalid range in ${fieldName}: ${start}-${end}`);
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

	range(start, end) {
		return Array.from({ length: end - start + 1 }, (_, i) => start + i);
	}

	matches(date) {
		return (
			this.minute.includes(date.getMinutes()) &&
			this.hour.includes(date.getHours()) &&
			this.dayOfMonth.includes(date.getDate()) &&
			this.month.includes(date.getMonth() + 1) && // JS months are 0-indexed
			this.dayOfWeek.includes(date.getDay())
		);
	}

	getNextRun(fromDate = new Date()) {
		const next = new Date(fromDate);
		next.setSeconds(0, 0); // Reset seconds and milliseconds
		next.setMinutes(next.getMinutes() + 1); // Start from next minute

		// Prevent infinite loops with a reasonable limit
		const maxIterations = 366 * 24 * 60; // One year worth of minutes
		let iterations = 0;

		while (!this.matches(next) && iterations < maxIterations) {
			next.setMinutes(next.getMinutes() + 1);
			iterations++;
		}

		if (iterations >= maxIterations) {
			throw new Error("Could not find next run time within one year");
		}

		return next;
	}
}
