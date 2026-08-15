import { describe, expect, it } from "vitest";
import {
	SANDBOX_ROUTED_TOOLS,
	translateHostToolCall,
	translateToolCallPaths,
	workspacePathToHost,
} from "../src/path-translation";

const HOST_CWD = "/home/user/proj";

describe("workspacePathToHost", () => {
	it("maps /workspace to hostCwd", () => {
		expect(workspacePathToHost("/workspace", HOST_CWD)).toBe(HOST_CWD);
	});
	it("maps /workspace/foo.png to hostCwd/foo.png", () => {
		expect(workspacePathToHost("/workspace/foo.png", HOST_CWD)).toBe("/home/user/proj/foo.png");
	});
	it("maps nested /workspace paths", () => {
		expect(workspacePathToHost("/workspace/a/b/c.txt", HOST_CWD)).toBe("/home/user/proj/a/b/c.txt");
	});
	it("leaves relative paths unchanged", () => {
		expect(workspacePathToHost("foo.png", HOST_CWD)).toBe("foo.png");
		expect(workspacePathToHost("./src/a.ts", HOST_CWD)).toBe("./src/a.ts");
	});
	it("leaves host absolute paths unchanged", () => {
		expect(workspacePathToHost("/home/user/proj/foo.png", HOST_CWD)).toBe("/home/user/proj/foo.png");
	});
	it("leaves free text unchanged (no prefix match)", () => {
		expect(workspacePathToHost("describe /workspace/foo", HOST_CWD)).toBe("describe /workspace/foo");
	});
	it("leaves /skills unchanged (scope is /workspace only)", () => {
		expect(workspacePathToHost("/skills/foo/SKILL.md", HOST_CWD)).toBe("/skills/foo/SKILL.md");
	});
	it("refuses /workspace traversal that escapes hostCwd", () => {
		expect(workspacePathToHost("/workspace/../etc/passwd", HOST_CWD)).toBe("/workspace/../etc/passwd");
	});
});

describe("translateToolCallPaths", () => {
	it("translates a top-level string field", () => {
		const input = { image_path: "/workspace/foo.png" };
		translateToolCallPaths(input, HOST_CWD);
		expect(input.image_path).toBe("/home/user/proj/foo.png");
	});
	it("translates nested objects and arrays", () => {
		const input = { files: [{ path: "/workspace/a.png" }, "/workspace/b.png"] };
		translateToolCallPaths(input, HOST_CWD);
		expect(input.files[0]).toMatchObject({ path: "/home/user/proj/a.png" });
		expect(input.files[1]).toBe("/home/user/proj/b.png");
	});
	it("leaves relative paths and free text untouched", () => {
		const input = { prompt: "look at /workspace/x.png", path: "rel.png" };
		translateToolCallPaths(input, HOST_CWD);
		expect(input.prompt).toBe("look at /workspace/x.png");
		expect(input.path).toBe("rel.png");
	});
	it("no-ops on non-object inputs without throwing", () => {
		expect(() => translateToolCallPaths(null, HOST_CWD)).not.toThrow();
		expect(() => translateToolCallPaths(42, HOST_CWD)).not.toThrow();
		expect(() => translateToolCallPaths("just a string", HOST_CWD)).not.toThrow();
	});
});

describe("translateHostToolCall", () => {
	it("translates paths for non-sandboxed tools", () => {
		const event = { toolName: "describe_image", input: { image_path: "/workspace/foo.png" } };
		translateHostToolCall(event, HOST_CWD);
		expect(event.input.image_path).toBe("/home/user/proj/foo.png");
	});
	it("skips sandbox-routed tools", () => {
		for (const name of ["bash", "read", "write", "edit"]) {
			const event = { toolName: name, input: { path: "/workspace/foo.png" } };
			translateHostToolCall(event, HOST_CWD);
			expect(event.input.path).toBe("/workspace/foo.png");
		}
	});
});

describe("SANDBOX_ROUTED_TOOLS", () => {
	it("contains exactly bash/read/write/edit", () => {
		expect([...SANDBOX_ROUTED_TOOLS].sort()).toEqual(["bash", "edit", "read", "write"]);
	});
});
