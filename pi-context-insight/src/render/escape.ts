export function esc(value: unknown): string {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function attr(name: string, value: string | number | undefined): string {
	return value === undefined ? "" : ` ${name}="${esc(value)}"`;
}
