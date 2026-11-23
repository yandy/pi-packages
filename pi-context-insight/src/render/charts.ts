import { esc } from "./escape";

const RADIUS = 42;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export interface DonutArgs {
	total: number;
	parts: Array<{ id: string; value: number; label?: string }>;
	center: string;
	sub: string;
	size?: number;
}

/** A ring whose arcs share one circumference, drawn with dash arrays. */
export function donut(args: DonutArgs): string {
	const size = args.size ?? 132;
	const total = Number.isFinite(args.total) && args.total > 0 ? args.total : 0;
	let offset = 0;
	const arcs = args.parts
		.filter((part) => Number.isFinite(part.value) && part.value > 0 && total > 0)
		.map((part) => {
			const length = (Math.min(part.value, total) / total) * CIRCUMFERENCE;
			const arc = `<circle r="${RADIUS}" cx="50" cy="50" fill="none" stroke="var(--${esc(part.id)})" stroke-width="12" stroke-dasharray="${length.toFixed(2)} ${(CIRCUMFERENCE - length).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 50 50)"><title>${esc(part.label ?? part.id)}</title></circle>`;
			offset += length;
			return arc;
		})
		.join("");
	return `<svg class="donut" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-label="${esc(args.center)}">${arcs}
<text x="50" y="47" text-anchor="middle" fill="var(--text)" font-size="13" font-weight="600">${esc(args.center)}</text>
<text x="50" y="60" text-anchor="middle" fill="var(--dim)" font-size="8">${esc(args.sub)}</text></svg>`;
}

export interface StackSegment {
	id: string;
	pct: number;
	title: string;
	cls?: string;
}

export interface StackBarArgs {
	segments: StackSegment[];
	height?: number;
	ariaLabel: string;
}

/** A single horizontal bar whose segments are sized by percentage. */
export function stackBar(args: StackBarArgs): string {
	const height = args.height ?? 16;
	const segments = args.segments
		.filter((segment) => Number.isFinite(segment.pct) && segment.pct > 0)
		.map(
			(segment) =>
				`<i${segment.cls === undefined ? "" : ` class="${esc(segment.cls)}"`} style="width:${segment.pct.toFixed(1)}%;background:var(--${esc(segment.id === "" ? "line" : segment.id)})" title="${esc(segment.title)}"></i>`,
		)
		.join("");
	return `<div class="stack" role="img" aria-label="${esc(args.ariaLabel)}" style="height:${height}px">${segments}</div>`;
}
