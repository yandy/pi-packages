import { t } from "../i18n";
import type { Lang } from "../model";
import { esc } from "./escape";

/** Column span inside the 12 column report grid. */
export type GridSpan = 3 | 4 | 5 | 6 | 7 | 8 | 12;

export interface SectionArgs {
	id: string;
	titleKey: string;
	lang: Lang;
	/** Pre-rendered markup shown at the right of the title bar; the caller escapes it. */
	meta?: string;
	span?: GridSpan;
	body: string;
}

/** Escapes a value for use inside a double quoted attribute. */
function attr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Escapes a value for use inside a single quoted attribute. */
function attrSingle(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#39;");
}

/**
 * Attributes that let the client retranslate a node in place. The visible text is
 * already rendered in `lang`; the client only needs the key and the params.
 */
export function i18nAttrs(key: string, params?: Record<string, string | number>): string {
	const base = `data-i18n="${attr(key)}"`;
	if (params === undefined) return base;
	return `${base} data-i18n-params='${attrSingle(JSON.stringify(params))}'`;
}

export function section(args: SectionArgs): string {
	const span = args.span ?? 12;
	const meta = args.meta === undefined ? "" : `<span class="card-meta">${args.meta}</span>`;
	return `<section class="card span-${span}" id="${attr(args.id)}" data-card="${attr(args.id)}"><h2><span ${i18nAttrs(args.titleKey)}>${esc(t(args.lang, { key: args.titleKey }))}</span>${meta}</h2>${args.body}</section>`;
}

export interface ChipArgs {
	text: string;
	tone?: "dim" | "ok" | "warn" | "err";
	i18n?: string;
	params?: Record<string, string | number>;
}

export function chip(args: ChipArgs): string {
	const tone = args.tone === undefined ? "" : ` tone-${args.tone}`;
	const attrs = args.i18n === undefined ? "" : ` ${i18nAttrs(args.i18n, args.params)}`;
	return `<span class="chip${tone}"${attrs}>${esc(args.text)}</span>`;
}

export interface MicrobarArgs {
	value: number;
	max: number;
	/** A colour token name without the leading dashes; defaults to `accent`. */
	tone?: string;
	label?: string;
}

export function microbar(args: MicrobarArgs): string {
	const finite = Number.isFinite(args.value) && Number.isFinite(args.max) && args.max > 0;
	const pct = finite ? Math.max(0, Math.min(100, (args.value / args.max) * 100)) : 0;
	const tone = `--${args.tone ?? "accent"}`;
	const title = args.label === undefined ? "" : ` title="${attr(args.label)}"`;
	return `<i class="bar" aria-hidden="true"${title}><b style="width:${pct.toFixed(1)}%;background:var(${tone})"></b></i>`;
}

export interface LegendRowArgs {
	/** Category or segment id; doubles as the CSS colour token name. */
	id: string;
	label: string;
	value: string;
	share: string;
	bar?: { value: number; max: number };
	/** Extra attributes for the row element, already escaped by the caller. */
	tip?: string;
}

export function legendRow(args: LegendRowArgs): string {
	const bar =
		args.bar === undefined ? "<span></span>" : microbar({ value: args.bar.value, max: args.bar.max, tone: args.id });
	return `<div class="legend-row" data-cat="${attr(args.id)}"><span class="dot" style="background:var(--${attr(args.id)})"></span><span class="legend-label">${esc(args.label)}</span><span class="legend-value">${esc(args.value)}</span><span class="legend-share">${esc(args.share)}</span>${bar}</div>`;
}
