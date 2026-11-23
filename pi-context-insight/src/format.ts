// --- v2 formatters: locale-independent by design (the report never localizes numbers) ---

const DASH = "—";

function finiteOrNull(value: number): number | null {
	return Number.isFinite(value) ? value : null;
}

export function fmtTokens(value: number): string {
	const n = finiteOrNull(value);
	if (n === null) return DASH;
	const sign = n < 0 ? "-" : "";
	const abs = Math.abs(n);
	if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(1)}B`;
	if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
	if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}k`;
	return `${sign}${Math.round(abs)}`;
}

export function fmtDuration(ms: number): string {
	const n = finiteOrNull(ms);
	if (n === null || n <= 0) return DASH;
	if (n < 1000) return `${Math.round(n)}ms`;
	if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
	const totalSeconds = Math.round(n / 1000);
	if (totalSeconds < 3600) {
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
	}
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
}

export function fmtClock(ms: number): string {
	const n = finiteOrNull(ms);
	if (n === null) return DASH;
	const date = new Date(n);
	if (Number.isNaN(date.getTime())) return DASH;
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function fmtPercent(value: number | null | undefined): string {
	if (value === null || value === undefined) return DASH;
	const n = finiteOrNull(value);
	return n === null ? DASH : `${n.toFixed(1)}%`;
}

export function fmtShare(part: number, total: number): string {
	if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return DASH;
	if (part <= 0) return "0.0%";
	const pct = (part / total) * 100;
	if (pct < 0.1) return "<0.1%";
	return `${Math.min(pct, 100).toFixed(1)}%`;
}

export function fmtCost(value: number): string {
	const n = finiteOrNull(value);
	if (n === null) return DASH;
	return `$${(Math.abs(n) >= 1 ? n.toFixed(2) : n.toPrecision(2)).toString()}`;
}
