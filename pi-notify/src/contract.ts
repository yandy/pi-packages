export const NOTIFY_REQUEST = "notify:request";

export type NotifyUrgency = "low" | "normal" | "critical";

export interface NotifyRequest {
	title: string;
	body?: string;
	urgency?: NotifyUrgency;
}

export function parseNotifyRequest(data: unknown): NotifyRequest | undefined {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
	const input = data as Record<string, unknown>;
	if (typeof input.title !== "string") return undefined;
	const title = input.title.trim();
	if (!title) return undefined;
	if (input.body !== undefined && typeof input.body !== "string") return undefined;
	if (input.urgency !== undefined && !["low", "normal", "critical"].includes(input.urgency as string)) return undefined;

	const request: NotifyRequest = { title };
	if (input.body !== undefined) request.body = input.body;
	if (input.urgency !== undefined) request.urgency = input.urgency as NotifyUrgency;
	return request;
}
