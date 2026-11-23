export type EmitEvent = (channel: string, data: unknown) => void;

export function announceApproval(emit: EmitEvent, title: string): void {
	emit("notify:request", { title: "Approval required", body: title, urgency: "critical" });
}
