import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "idx-"));
	mkdirSync(join(dir, "agent"), { recursive: true });
	vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

describe("extension activate", () => {
	it("registers sandboxed bash/write/edit tools and the /permission command, no flags/hooks", async () => {
		const tools: string[] = [];
		const commands: string[] = [];
		const fakePi = {
			registerTool: (t: { name: string }) => { tools.push(t.name); },
			registerCommand: (name: string) => { commands.push(name); },
			registerFlag: vi.fn(() => { throw new Error("2.0 must not register flags"); }),
			on: vi.fn(() => { throw new Error("2.0 must not register event hooks"); }),
		};
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		expect(tools.sort()).toEqual(["bash", "edit", "write"]);
		expect(commands).toEqual(["permission"]);
	});
});
