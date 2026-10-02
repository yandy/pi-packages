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

import {
	MEMORY_INDEX_SECTION,
	readRecordedMemoryIndex,
	replaySystemSections,
	unwrapSectionValue,
} from "../src/index-source";

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

/** 0.99.2 `core/system-prompt.js`：宿主把每个非 preamble section 渲染成这个形状再写进 transcript。 */
function wrapSection(content: string): string {
	return `<${MEMORY_INDEX_SECTION}>\n${content}\n</${MEMORY_INDEX_SECTION}>`;
}

describe("MEMORY_INDEX_SECTION", () => {
	it("is memory_index and satisfies pi's section-name rule", () => {
		expect(MEMORY_INDEX_SECTION).toBe("memory_index");
		// 0.99.2 core/system-prompt.js: /^[a-z][a-z0-9_-]*$/ —— 不合法的名字会被 pi 拒绝
		expect(/^[a-z][a-z0-9_-]*$/.test(MEMORY_INDEX_SECTION)).toBe(true);
	});
});

// R42：宿主录制的是带标签的值，回写 `options.sections[name]` 前必须脱掉一层，否则
// `wrap(wrap(x)) !== wrap(x)` —— resume/fork/reload 第一轮就产生 patch（D13/D14 失效）。
describe("unwrapSectionValue", () => {
	it("strips exactly the host's one-layer wrapper", () => {
		const raw = "- [SSH](ssh.md) — recorded value\n";
		expect(unwrapSectionValue(wrapSection(raw))).toBe(raw);
	});

	it("round-trips: re-rendering the unwrapped value reproduces the recorded bytes", () => {
		const raw = "- [A](a.md) — a &lt; b\n\n- [B](b.md) — 中文\n";
		const recorded = wrapSection(raw);
		const unwrapped = unwrapSectionValue(recorded);

		expect(unwrapped).toBe(raw);
		expect(wrapSection(unwrapped)).toBe(recorded);
		expect(unwrapSectionValue(unwrapped)).toBe(unwrapped);
	});

	it("strips only one layer, so a nested wrapper stays as content", () => {
		const inner = wrapSection("nested");
		expect(unwrapSectionValue(wrapSection(inner))).toBe(inner);
	});

	it("strips an empty-content wrapper to the empty string", () => {
		expect(unwrapSectionValue(wrapSection(""))).toBe("");
	});

	it("returns a value without the wrapper unchanged", () => {
		for (const value of [
			"",
			"- [A](a.md) — bare\n",
			"plain text",
			"<memory_index>unterminated",
			"missing </memory_index>",
			"</memory_index>\nnot-a-prefix",
			"<memory_index>x</memory_index>",
		]) {
			expect(unwrapSectionValue(value), value).toBe(value);
		}
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
	// R42：真实 transcript 里存的是宿主渲染后的带标签值，重放必须脱掉这一层再返回。
	it("returns the bare value when the transcript recorded a host-wrapped section", () => {
		const raw = "- [SSH](ssh.md) — recorded value\n";
		const recorded = wrapSection(raw);
		const sm = sessionManager([entry(systemMessage({ preamble: "p", memory_index: recorded }))]);

		expect(readRecordedMemoryIndex(sm, { sessionEntryToContextMessages: passthrough })).toBe(raw);
		// 宿主再渲染一次仍逐字节等于录制值：回写不会产生新 patch（D13/D14）。
		expect(wrapSection(raw)).toBe(recorded);
	});

	it("returns a recorded value without a wrapper unchanged", () => {
		const recorded = "- [SSH](ssh.md) — legacy bare value\n";
		const sm = sessionManager([entry(systemMessage({ memory_index: recorded }))]);

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

	it("returns an empty index from a host-wrapped empty section", () => {
		const sm = sessionManager([entry(systemMessage({ memory_index: wrapSection("") }))]);
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

	// Finding 2 / R43：index.ts 的 session_start 直接调用这里，getLeafId 抛错不能冒泡
	//（否则 memory 工具整个会话都不注册）。降级 = 没有 leaf，照样重放。
	it("replays when getLeafId throws", () => {
		const sm = sessionManager([entry(systemMessage({ memory_index: "still-found" }))], {
			getLeafId: () => {
				throw new Error("no leaf");
			},
		});
		expect(readRecordedMemoryIndex(sm, { sessionEntryToContextMessages: passthrough })).toBe("still-found");
	});

	it("replays when getLeafId throws even for a host-wrapped value", () => {
		const raw = "- [SSH](ssh.md) — recorded\n";
		const sm = sessionManager([entry(systemMessage({ memory_index: wrapSection(raw) }))], {
			getLeafId: () => {
				throw new Error("no leaf");
			},
			buildContextEntries: (entries: unknown[], leafId?: string | null) => {
				expect(leafId).toBeNull();
				return entries;
			},
		});
		expect(readRecordedMemoryIndex(sm, { sessionEntryToContextMessages: passthrough })).toBe(raw);
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

// ── Plan D（D2：优先用宿主的 buildSessionProjection 重放）────────────────────
describe("readRecordedMemoryIndex 优先用宿主的 buildSessionProjection", () => {
	/**
	 * 0.99.2 的 `SessionManager#buildSessionProjection()`：无参实例方法，返回
	 * `{ entries, messages, thinkingLevel, model }`。宿主自己算 system 消息用的就是它
	 * （session-manager.js:882 `getCurrentSystemMessage(this.buildSessionProjection().messages)`）。
	 * `getEntries` 默认抛错：一旦被调用，用例就红（投影路径不得再走 entry 重放）。
	 */
	function projecting(messages: unknown[], over: Record<string, unknown> = {}) {
		return {
			getEntries: vi.fn((): unknown[] => {
				throw new Error("getEntries must not be called on the projection path");
			}),
			getLeafId: vi.fn(() => null),
			buildSessionProjection: vi.fn(() => ({ messages })),
			...over,
		};
	}

	it("reads the recorded value from the projection and never touches getEntries or the converter", () => {
		const raw = "- [SSH](ssh.md) — recorded value\n";
		const converter = vi.fn(passthrough);
		const sm = projecting([systemMessage({ preamble: "p", memory_index: wrapSection(raw) })]);

		expect(readRecordedMemoryIndex(sm, { sessionEntryToContextMessages: converter })).toBe(raw);
		expect(sm.buildSessionProjection).toHaveBeenCalledTimes(1);
		expect(sm.getEntries).not.toHaveBeenCalled();
		expect(converter).not.toHaveBeenCalled();
	});

	// Plan E/next #3：`{ messages: [] }` 是**有效投影**（空会话），不是「投影不可用」——
	// 不能因为它是空的就回落 entry 重放（那会把被 compaction 丢弃的历史又搬回来）。
	it("treats an empty projection as valid and never falls back to the entry replay", () => {
		const converter = vi.fn(passthrough);
		const sm = projecting([]);

		expect(readRecordedMemoryIndex(sm, { sessionEntryToContextMessages: converter })).toBeNull();
		expect(sm.buildSessionProjection).toHaveBeenCalledTimes(1);
		expect(sm.getEntries).not.toHaveBeenCalled();
		expect(converter).not.toHaveBeenCalled();
	});

	// 投影路径根本不需要转换函数：旧 SDK 没有 `sessionEntryToContextMessages` 导出时，
	// 只要宿主够新（有 buildSessionProjection）就仍能拿到录制值。
	it("works without a converter at all", () => {
		converterRef.current = undefined;
		const sm = projecting([systemMessage({ memory_index: "from-projection" })]);

		expect(readRecordedMemoryIndex(sm)).toBe("from-projection");
	});

	// 双重 compaction：投影里只剩宿主保留的消息，而 getEntries 仍是全量旧数据 ——
	// 必须以投影为准，否则极端会话 resume 时会冻结一份陈旧索引。
	it("prefers the projection over the entry replay when the two disagree", () => {
		const sm = projecting([systemMessage({ memory_index: "kept-by-host" })], {
			getEntries: vi.fn(() => [entry(systemMessage({ memory_index: "pre-compaction" }))]),
			buildContextEntries: vi.fn((entries: unknown[]) => entries),
		});

		expect(readRecordedMemoryIndex(sm, { sessionEntryToContextMessages: passthrough })).toBe("kept-by-host");
	});

	it("applies the same null-patch semantics to projected messages", () => {
		const sm = projecting([systemMessage({ memory_index: "v1" }), systemMessage({ memory_index: null })]);

		expect(readRecordedMemoryIndex(sm, { sessionEntryToContextMessages: passthrough })).toBeNull();
		// 而且是真的走的投影路径（而不是因为 getEntries 抛错而降级成 null）
		expect(sm.getEntries).not.toHaveBeenCalled();
	});

	// Review Focus #3：投影抛错 / 形状不对 → 必须回落原路径，结果与没有投影时逐字相同。
	it("falls back to the entry replay when buildSessionProjection throws", () => {
		const sm = {
			getEntries: () => [entry(systemMessage({ memory_index: "from-entries" }))],
			getLeafId: () => null,
			buildSessionProjection: () => {
				throw new Error("projection unavailable");
			},
		};

		expect(readRecordedMemoryIndex(sm, { sessionEntryToContextMessages: passthrough })).toBe("from-entries");
	});

	it("falls back when the projection is not an object or carries no messages array", () => {
		const entries = [entry(systemMessage({ memory_index: "from-entries" }))];
		for (const projection of [undefined, null, "nope", {}, { messages: "nope" }, { messages: {} }]) {
			const sm = {
				getEntries: () => entries,
				getLeafId: () => null,
				buildSessionProjection: () => projection,
			};

			expect(
				readRecordedMemoryIndex(sm, { sessionEntryToContextMessages: passthrough }),
				String(JSON.stringify(projection)),
			).toBe("from-entries");
		}
	});

	it("returns null when neither the projection nor the fallback can replay", () => {
		converterRef.current = undefined;
		const sm = {
			getEntries: () => [entry(systemMessage({ memory_index: "unreachable" }))],
			getLeafId: () => null,
			buildSessionProjection: () => {
				throw new Error("nope");
			},
		};

		expect(readRecordedMemoryIndex(sm)).toBeNull();
	});
});
