import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSandboxBashOps } from "../src/bash-ops";
import { resetRunnerCache, selectRunner } from "../src/runners";
import type { ConfinedSandboxMode } from "../src/policy";

resetRunnerCache();
const selected = selectRunner(5000);

describe.skipIf(selected.runner === "unavailable")(`real confinement via ${selected.runner}`, () => {
	let ws: string;

	beforeAll(() => {
		ws = realpathSync.native(mkdtempSync(join(tmpdir(), "sbx-int-")));
	});
	afterAll(() => {
		rmSync(ws, { recursive: true, force: true });
		rmSync(`/etc/sbx-escape-${process.pid}`, { force: true }); // 仅在沙箱失效且 root 运行时才会存在，尽力清理
	});

	async function run(mode: ConfinedSandboxMode, command: string) {
		const ops = createSandboxBashOps({ mode, workspaceRoot: ws });
		const chunks: Buffer[] = [];
		const result = await ops.exec(command, ws, { onData: (b) => chunks.push(b) });
		return { ...result, text: chunks.map((c) => c.toString()).join("") };
	}

	it("workspace-write: write inside the workspace succeeds", async () => {
		const r = await run("workspace-write", "touch inside.txt && echo ok");
		expect(r.exitCode).toBe(0);
		expect(r.text).toContain("ok");
	});

	it("workspace-write: write outside (to /etc) is denied and carries the marker", async () => {
		const r = await run("workspace-write", `touch /etc/sbx-escape-${process.pid}`);
		expect(r.exitCode).not.toBe(0);
		expect(r.text).toContain("[sandbox: file access denied under workspace-write mode]");
		expect(r.text).toContain("[sandbox: escalation available");
	});

	it("workspace-write: read outside the workspace succeeds (the core goal)", async () => {
		const r = await run("workspace-write", "cat /etc/hosts");
		expect(r.exitCode).toBe(0);
		expect(r.text).toContain("localhost");
	});

	it("read-only: write inside the workspace is denied too", async () => {
		const r = await run("read-only", "touch ro.txt");
		expect(r.exitCode).not.toBe(0);
		expect(r.text).toContain("[sandbox: file access denied under read-only mode]");
	});
}, 60_000);
