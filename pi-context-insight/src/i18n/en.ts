export const DICT_EN: Record<string, string> = {
	"hint.reserveHeadroom": "Auto-compaction triggers at {p}% of the window",
	"hint.cacheHit": "Cache reads as a share of all billed input tokens.",
	"hint.estimateAnchored": "Estimated split, scaled to the billed total.",
	"label.step": "Step {s}",
	"label.turn": "Turn {t}",
	"empty.none": "Nothing recorded",
	"event.compaction": "Compacted context (summary replaced {messages} tokens)",
	"event.contextEditRemove": "Removed a context entry",
	"event.contextEditReplace": "Rewrote a context entry",
	"event.branchSummary": "Branch summary",
	"event.model": "Model switch: {to}",
	"event.thinking": "Thinking level: {to}",
	"event.skill": "Skill injected · {name}",
	"event.inject": "Injected · {customType}",
	"event.delegate": "Delegated to {id} · {description}",
	"event.childDone": "Subagent {id} {status}",
	"event.ask": "Asked the user · ×{count}",
	"event.todoAdd": "Added {count} todo item(s)",
	"event.todoUpdate": "Updated todo items · ×{count}",

	"warning.lineageMismatch": "Child session {id} does not name this session as its parent and was skipped.",
	"warning.brokenChild": "Child session {id} could not be read.",
	"warning.depthLimit": "Agent family truncated at depth {depth}.",
	"warning.memberLimit": "Agent family truncated at {count} members.",
	"warning.noSystem": "This session never recorded a system prompt; system prompt and tool definitions cannot be rebuilt.",
};


