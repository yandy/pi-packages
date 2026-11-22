export function escapeHtml(value: unknown): string {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function formatTokens(value: number): string {
	if (!Number.isFinite(value)) return "—";
	const absolute = Math.abs(value);
	if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (absolute >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return Math.round(value).toLocaleString("en-US");
}

export function formatCost(value: number): string {
	return Number.isFinite(value) ? `$${value.toFixed(4)}` : "—";
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms)) return "—";
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
	if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
	return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function formatPercent(value: number | null | undefined): string {
	return value === null || value === undefined || !Number.isFinite(value) ? "—" : `${value.toFixed(1)}%`;
}

export function formatRatio(value: number | null): string {
	return value === null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function formatTimestamp(value: string | number | undefined): string {
	if (value === undefined) return "—";
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

export function clipText(value: string, max: number): string {
	if (value.length <= max) return value;
	if (max <= 0) return "";
	if (max === 1) return "…";
	return `${value.slice(0, max - 1)}…`;
}
