import { describe, expect, it, vi } from "vitest";

const { converterRef } = vi.hoisted(() => ({
	converterRef: { current: undefined as undefined | ((entry: unknown) => unknown[]) },
}));

// 本地 node_modules 是 pi-coding-agent **0.80.2**，包根没有 `sessionEntryToContextMessages`
// 导出（0.99.2 才有）。用 getter 桥接一个可变引用，于是「导出存在」与「导出缺失」两个分支
// 都能确定性地测到，不受宿主 SDK 版本影响。
vi.mock("@earendil-works/pi-coding-agent", () => ({
	get sessionEntryToContextMessages() {
		return converterRef.current;
	},
}));

import { MEMORY_INDEX_SECTION, readRecordedMemoryIndex, replaySystemSections } from "../src/index-source";

/** 假的 `sessionEntryToContextMessages`：entry 自带 messages，原样返回。 */
const passthrough = (entry: unknown): unknown[] => {
	const record = entry as { messages?: unknown[] } | null;
	return Array.isArray(record?.messages) ? record.messages : [];
};

function systemMessage(sections: Record<string, string | null>): unknown {
	return { role: "system", content: "", sections };
}

/** 一条 session entry，转出来是 `messages`。 */
function entry(...messages: unknown[]): unknown {
	return { type: "message", messages };
}

function sessionManager(entries: unknown[], over: Record<string, unknown> = {}) {
	return {
		getEntries: () => entries,
		getLeafId: () => (entries.length > 0 ? "leaf-1" : null),
		...over,
	};
}

describe("MEMORY_INDEX_SECTION", () => {
	it("is memory_index and satisfies pi's section-name rule", () => {
		expect(MEMORY_INDEX_SECTION).toBe("memory_index");
		// 0.99.2 core/system-prompt.js: /^[a-z][a-z0-9_-]*$/ —— 不合法的名字会被 pi 拒绝
		expect(/^[a-z][a-z0-9_-]*$/.test(MEMORY_INDEX_SECTION)).toBe(true);
	});
});

describe("replaySystemSections", () => {
	it("returns an empty map for an empty transcript", () => {
		expect(replaySystemSections([]).size).toBe(0);
	});

	it("applies patches in order so the last value wins", () => {
		const map = replaySystemSections([
			systemMessage({ memory_index: "v1" }),
			systemMessage({ memory_index: "v2" }),
		]);
		expect(map.get("memory_index")).toBe("v2");
	});

	// Review Focus #3：pi 用 null 表示「该 section 不存在」，重放时必须删除，
	// 绝不能把 null 当成一个值回填。
	it("deletes a section whose patch value is null", () => {
		const map = replaySystemSections([
			systemMessage({ memory_index: "v1", preamble: "p" }),
			systemMessage({ memory_index: null }),
		]);
		expect(map.has("memory_index")).toBe(false);
		expect(map.get("preamble")).toBe("p");
	});

	it("keeps the first insertion position when a value is overwritten", () => {
		const map = replaySystemSections([
			systemMessage({ preamble: "p", tools: "t", memory_index: "v1" }),
			systemMessage({ memory_index: "v2" }),
		]);
		expect([...map.keys()]).toEqual(["preamble", "tools", "memory_index"]);
		expect(map.get("memory_index")).toBe("v2");
	});

	it("puts a re-added section at the end (delete really removed the position)", () => {
		const map = replaySystemSections([
			systemMessage({ memory_index: "v1", preamble: "p" }),
			systemMessage({ memory_index: null }),
			systemMessage({ memory_index: "v3" }),
		]);
		expect([...map.keys()]).toEqual(["preamble", "memory_index"]);
		expect(map.get("memory_index")).toBe("v3");
	});

	it("ignores non-system messages, missing sections and non-string values", () => {
		const map = replaySystemSections([
			{ role: "user", content: "hi", sections: { memory_index: "nope" } },
			{ role: "system", content: "no sections here" },
			systemMessage({ memory_index: 42 as unknown as string }),
			systemMessage({ memory_index: undefined as unknown as string | null }),
			null,
			"not a message",
			systemMessage({ preamble: "kept" }),
		]);
		expect([...map.entries()]).toEqual([["preamble", "kept"]]);
	});
});

describe("readRecordedMemoryIndex", () => {
	it("returns the recorded memory_index from the transcript", () => {
		const recorded = "- [SSH](ssh.md) — recorded value\n";
		const sm = sessionManager([entry(systemMessage({ preamble: "p", memory_index: recorded }))]);

		expect(readRecordedMemoryIndex(sm, { sessionEntryToContextMessages: passthrough })).toBe(recorded);
	});

	it("resolves the converter from the SDK export when no opts are given", () => {
		converterRef.current = passthrough;
		try {
			const sm = sessionManager([entry(systemMessage({ memory_index: "from-sdk" }))]);
			expect(readRecordedMemoryIndex(sm)).toBe("from-sdk");
		} finally {
			converterRef.current = undefined;
		}
	});

	// 0.80.2（本地类型/CI 依赖）没有这个导出：必须回退磁盘读，而不是抛错。
	it("returns null when the SDK does not export sessionEntryToContextMessages", () => {
		converterRef.current = undefined;
		const sm = sessionManager([entry(systemMessage({ memory_index: "unreachable" }))]);
		expect(readRecordedMemoryIndex(sm)).toBeNull();
	});

	it("prefers the injected converter over the SDK export", () => {
		converterRef.current = () => [systemMessage({ memory_index: "from-sdk" })];
		try {
			const sm = sessionManager([entry(systemMessage({ memory_index: "from-opts" }))]);
			expect(readRecordedMemoryIndex(sm, { sessionEntryToContextMessages: passthrough })).toBe("from-opts");
		} finally {
			converterRef.current = undefined;
		}
	});

	it("returns null when the transcript has no memory_index section", () => {
		const sm = sessionManager([entry(systemMessage({ preamble: "p" }))]);
		expect(readRecordedMemoryIndex(sm, { sessionEntryToContextMessages: passthrough })).toBeNull();
	});

	it("returns null when the recorded value was deleted by a later null patch", () => {
		const sm = sessionManager([
			entry(systemMessage({ memory_index: "v1" })),
			entry(systemMessage({ memory_index: null })),
		]);
		expect(readRecordedMemoryIndex(sm, { sessionEntryToContextMessages: passthrough })).toBeNull();
	});

	it("returns an empty recorded value as-is (an empty index is a value, not an absence)", () => {
		const sm = sessionManager([entry(systemMessage({ memory_index: "" }))]);
		expect(readRecordedMemoryIndex(sm, { sessionEntryToContextMessages: passthrough })).toBe("");
	});

	it("uses buildContextEntries to resolve the current branch when it is exposed", () => {
		const mainBranch = entry(systemMessage({ memory_index: "main" }));
		const forkedBranch = entry(systemMessage({ memory_index: "forked" }));
		const sm = sessionManager([mainBranch, forkedBranch], {
			getLeafId: () => "forked",
			buildContextEntries: (entries: unknown[], leafId?: string | null) =>
				leafId === "forked" ? [entries[1]] : [entries[0]],
		});

		expect(readRecordedMemoryIndex(sm, { sessionEntryToContextMessages: passthrough })).toBe("forked");
	});

	it("falls back to every entry when buildContextEntries throws", () => {
		const sm = sessionManager([entry(systemMessage({ memory_index: "still-found" }))], {
			buildContextEntries: () => {
				throw new Error("boom");
			},
		});

		expect(readRecordedMemoryIndex(sm, { sessionEntryToContextMessages: passthrough })).toBe("still-found");
	});

	it("skips entries whose conversion throws instead of failing the whole replay", () => {
		const converter = (e: unknown): unknown[] => {
			if ((e as { type?: string }).type === "broken") throw new Error("cannot convert");
			return passthrough(e);
		};
		const sm = sessionManager([
			{ type: "broken" },
			entry(systemMessage({ memory_index: "survived" })),
		]);

		expect(readRecordedMemoryIndex(sm, { sessionEntryToContextMessages: converter })).toBe("survived");
	});

	it("returns null for a session manager that cannot replay", () => {
		const opts = { sessionEntryToContextMessages: passthrough };
		expect(readRecordedMemoryIndex(null, opts)).toBeNull();
		expect(readRecordedMemoryIndex(undefined, opts)).toBeNull();
		expect(readRecordedMemoryIndex("nope", opts)).toBeNull();
		expect(readRecordedMemoryIndex({}, opts)).toBeNull();
		expect(readRecordedMemoryIndex({ getEntries: () => [] }, opts)).toBeNull();
		expect(readRecordedMemoryIndex({ getLeafId: () => null }, opts)).toBeNull();
	});

	it("returns null when getEntries throws", () => {
		const sm = {
			getEntries: () => {
				throw new Error("session file gone");
			},
			getLeafId: () => null,
		};
		expect(readRecordedMemoryIndex(sm, { sessionEntryToContextMessages: passthrough })).toBeNull();
	});

	it("replays across many entries, keeping the last recorded value", () => {
		const sm = sessionManager([
			entry(systemMessage({ memory_index: "first" })),
			entry({ role: "user", content: "hello" }),
			entry(systemMessage({ memory_index: "second" })),
		]);
		expect(readRecordedMemoryIndex(sm, { sessionEntryToContextMessages: passthrough })).toBe("second");
	});
});
