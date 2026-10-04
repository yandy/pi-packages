// pi-sandbox/tests/win32-proc.test.ts
import { describe, expect, it } from "vitest";
import * as abi from "../src/win32/abi.js";
import { startupInfoType } from "../src/win32/ffi.js";
import { buildCommandLine, quoteArg, spawnInheritedJobProcess, waitForProcessExit } from "../src/win32/proc.js";

describe("win32 command line quoting", () => {
	it("quotes arguments per CommandLineToArgvW rules", () => {
		expect(quoteArg("plain")).toBe("plain");
		expect(quoteArg("C:\\Program Files\\Git\\bin\\bash.exe")).toBe('"C:\\Program Files\\Git\\bin\\bash.exe"');
		expect(quoteArg('say "hi"')).toBe('"say \\"hi\\""');
		expect(quoteArg("back\\slash\\")).toBe('"back\\slash\\\\"'); // 结尾反斜杠必须翻倍
		expect(quoteArg("")).toBe('""');
		expect(quoteArg("中文 参数")).toBe('"中文 参数"');
	});

	it("joins program and args into one command line", () => {
		expect(buildCommandLine("C:\\ws\\a b.exe", ["-c", "echo hi"])).toBe('"C:\\ws\\a b.exe" -c "echo hi"');
	});
});

import koffi from "koffi";

const PVOID = koffi.pointer("void");

/** 把 PROCESS_INFORMATION 的三个字段写进 Win32 出参（布局由 abi 定死：hProcess@0、hThread@8、dwProcessId@16）。 */
function writeProcessInformation(pointer: unknown, pid = 4242): void {
	const bytes = Buffer.alloc(abi.PROCESS_INFORMATION_SIZE);
	bytes.writeBigUInt64LE(0x7000n, 0); // hProcess
	bytes.writeBigUInt64LE(0x7001n, 8); // hThread
	bytes.writeUInt32LE(pid, 16); // dwProcessId
	bytes.writeUInt32LE(1, 20); // dwThreadId
	koffi.encode(pointer as never, "uint8", bytes, bytes.length);
}

function makeApi(overrides: Record<string, unknown> = {}) {
	const calls: Array<{ name: string; args: unknown[] }> = [];
	const rec = (name: string, result: unknown) => (...args: unknown[]) => {
		calls.push({ name, args });
		return (result as never);
	};
	return {
		calls,
		getLastError: () => 0,
		formatMessage: () => "",
		getStdHandle: (which: number) => BigInt(0x100 + which * 16),
		setHandleInformation: rec("setHandleInformation", 1),
		createJobObjectW: rec("createJobObjectW", 0x5000n),
		setInformationJobObject: rec("setInformationJobObject", 1),
		createProcessAsUserW: (...args: unknown[]) => {
			calls.push({ name: "createProcessAsUserW", args });
			writeProcessInformation(args[args.length - 1]); // 最后一个参数是 PROCESS_INFORMATION*
			return 1;
		},
		assignProcessToJobObject: rec("assignProcessToJobObject", 1),
		resumeThread: rec("resumeThread", 1),
		terminateProcess: rec("terminateProcess", 1),
		closeHandle: rec("closeHandle", 1),
		waitForSingleObject: rec("waitForSingleObject", 0),
		getExitCodeProcess: rec("getExitCodeProcess", 1),
		...overrides,
	};
}

describe("win32 job-confined spawn", () => {
	it("creates the child suspended with inherited stdio and hides the window", () => {
		let capturedStartupInfo: { dwFlags: number; wShowWindow: number } | undefined;
		const api = makeApi({
			createProcessAsUserW: (...args: unknown[]) => {
				api.calls.push({ name: "createProcessAsUserW", args });
				// STARTUPINFOW 由 proc.js 用 koffi struct（startupInfoType()）真实分配并编码；
				// stub 内按同一类型解码回来直接断言字段值，而不是只检查「最后两个参数是指针」。
				capturedStartupInfo = koffi.decode(args[args.length - 2] as never, startupInfoType()) as {
					dwFlags: number;
					wShowWindow: number;
				};
				writeProcessInformation(args[args.length - 1]); // 最后一个参数是 PROCESS_INFORMATION*
				return 1;
			},
		});
		spawnInheritedJobProcess(api as never, { command: "pwsh.exe", args: ["-Command", "echo hi"], cwd: "C:\\ws", token: 7n as never });
		const create = api.calls.find((c) => c.name === "createProcessAsUserW");
		expect(create).toBeDefined();
		const suspend = create?.args.find((a) => typeof a === "number" && a === abi.CREATE_SUSPENDED);
		expect(suspend).toBe(abi.CREATE_SUSPENDED);
		// dwFlags 必须同时携带 USESTDHANDLES（继承 stdio）与 USESHOWWINDOW，且 wShowWindow=SW_HIDE；
		// 字段漏设/漂移在这里直接失败，而不再依赖「指针存在」这类恒真观察。
		expect(capturedStartupInfo?.dwFlags).toBe(abi.STARTF_USESTDHANDLES | abi.STARTF_USESHOWWINDOW);
		expect(capturedStartupInfo?.wShowWindow).toBe(abi.SW_HIDE);
		const order = api.calls.map((c) => c.name);
		expect(order).toContain("assignProcessToJobObject");
		expect(order).toContain("resumeThread");
		expect(order.indexOf("assignProcessToJobObject")).toBeLessThan(order.indexOf("resumeThread"));
	});

	it("assigns a kill-on-close job before resuming", () => {
		const api = makeApi();
		spawnInheritedJobProcess(api as never, { command: "pwsh.exe", args: [], cwd: "C:\\ws", token: 7n as never });
		const setInfo = api.calls.find((c) => c.name === "setInformationJobObject");
		const info = setInfo?.args[2] as Buffer;
		expect(info.readUInt32LE(abi.JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET)).toBe(abi.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
		expect(setInfo?.args[1]).toBe(abi.JobObjectExtendedLimitInformation);
	});

	it("kills the child and closes the job when assignment fails", () => {
		const api = makeApi({ assignProcessToJobObject: () => 0, getLastError: () => 5, formatMessage: () => "Access is denied." });
		expect(() => spawnInheritedJobProcess(api as never, { command: "pwsh.exe", args: [], cwd: "C:\\ws", token: 7n as never }))
			.toThrowError(/AssignProcessToJobObject/);
		const names = api.calls.map((c) => c.name);
		expect(names).toContain("terminateProcess");
		expect(names.filter((n) => n === "closeHandle").length).toBeGreaterThanOrEqual(3); // thread + process + job
	});

	it("closes the job when CreateProcessAsUserW fails", () => {
		const api = makeApi({ createProcessAsUserW: () => 0, getLastError: () => 740, formatMessage: () => "The requested operation requires elevation." });
		expect(() => spawnInheritedJobProcess(api as never, { command: "pwsh.exe", args: [], cwd: "C:\\ws", token: 7n as never }))
			.toThrowError(/CreateProcessAsUserW/);
		expect(api.calls.map((c) => c.name)).toContain("closeHandle");
	});

	it("waits for the child and always closes its handle", () => {
		const api = makeApi({
			getExitCodeProcess: (handle: unknown, slot: unknown) => { koffi.encode(slot as never, "uint32", 3221225477); return 1 },
		});
		expect(waitForProcessExit(api as never, 0x7000n as never)).toBe(3221225477);
		expect(api.calls.map((c) => c.name)).toContain("closeHandle");
	});
});
