import { SessionManager, truncateHead } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

function extractText(content: any): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
	}
	return "";
}

export async function searchSessions(
	cwd: string,
	query: string,
	config: { maxSessions: number; maxMatches: number },
): Promise<string> {
	const sessions = (await SessionManager.list(cwd)).slice(0, config.maxSessions);
	const q = query.toLowerCase();
	const hits: string[] = [];
	for (const s of sessions) {
		const raw = await readFile(s.path, "utf8").catch(() => "");
		const lines = raw.split("\n").filter(Boolean);
		// gather message texts in order for context windows
		const msgs: { text: string; idx: number }[] = [];
		for (const [i, line] of lines.entries()) {
			let entry: any;
			try { entry = JSON.parse(line); } catch { continue; }
			if (entry.type === "message" && entry.message) {
				const t = extractText(entry.message.content);
				if (t) msgs.push({ text: t, idx: i });
			}
		}
		for (const m of msgs) {
			if (m.text.toLowerCase().includes(q)) {
				const ctx = msgs
					.filter((x) => Math.abs(x.idx - m.idx) <= 50)
					.map((x) => `  ${x.text.slice(0, 200)}`)
					.join("\n");
				hits.push(`## Session ${basename(s.path)} (${s.modified.toISOString().slice(0, 10)})\n…matched: "${m.text.slice(0, 150)}"…\ncontext:\n${ctx}`);
				if (hits.length >= config.maxMatches) break;
			}
		}
		if (hits.length >= config.maxMatches) break;
	}
	if (!hits.length) return "No matches in sessions.";
	const out = `Found ${hits.length} match(es):\n\n${hits.join("\n\n")}`;
	const trunc = truncateHead(out, { maxLines: 2000, maxBytes: 50000 });
	return trunc.content;
}
