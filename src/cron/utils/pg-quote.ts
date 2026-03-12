/** Will quote identifier for pg dialect */
export function pgQuoteIdentifier(key: string): string {
	return `"${`${key}`.replaceAll('"', '""')}"`;
}

/** Will quote value for pg dialect */
export function pgQuoteValue(value: any): string {
	if (value === null || /^null$/i.test(`${value}`)) return "null";
	return `'${`${value}`.replaceAll("'", "''")}'`;
}
