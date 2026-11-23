import { DICT_EN } from "./en";
import { DICT_ZH } from "./zh";

export type Lang = "en" | "zh";

export const LANGS: readonly Lang[] = ["en", "zh"];

export const DICT: Record<Lang, Record<string, string>> = { en: DICT_EN, zh: DICT_ZH };

/** A user-visible string: a dictionary key plus interpolation params. */
export interface Msg {
	key: string;
	params?: Record<string, string | number>;
}

export function t(lang: Lang, msg: Msg): string {
	const template = DICT[lang][msg.key] ?? DICT.en[msg.key];
	if (template === undefined) return msg.key;
	if (!msg.params) return template;
	return template.replace(/\{(\w+)\}/g, (match, name: string) =>
		Object.hasOwn(msg.params as Record<string, unknown>, name) ? String(msg.params?.[name]) : match,
	);
}
