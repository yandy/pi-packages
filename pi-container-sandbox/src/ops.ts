import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { ReadOperations, WriteOperations, EditOperations, BashOperations } from "@earendil-works/pi-coding-agent";
import type { Runtime, MountSpec } from "./runtime";
import { toRemote, isReadOnlyMount, isInsideCwd, isAllowedExternalResource, shq } from "./paths";

export interface SbxHandle {
	runtime: Runtime;
	name: string;
	hostCwd: string;
	mounts: MountSpec[];
	allowedExternalPrefixes: string[];
}

export function execCapture(sbx: SbxHandle, command: string, timeoutMs?: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn(sbx.runtime.bin, ["exec", sbx.name, "sh", "-c", command], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let timedOut = false;

		const timer = timeoutMs
			? setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, timeoutMs)
			: undefined;

		child.stdout.on("data", (d: Buffer) => out.push(d));
		child.stderr.on("data", (d: Buffer) => err.push(d));
		child.on("error", (e) => {
			if (timer) clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			if (timedOut) {
				reject(new Error(`exec timed out after ${timeoutMs}ms: ${command}`));
			} else if (code !== 0) {
				reject(new Error(`exec failed (${code}): ${Buffer.concat(err).toString()}`));
			} else {
				resolve(Buffer.concat(out));
			}
		});
	});
}

export function execStream(
	sbx: SbxHandle,
	command: string,
	{ onData, signal, timeout }: { onData: (b: Buffer) => void; signal?: AbortSignal; timeout?: number },
): Promise<{ exitCode: number | null }> {
	return new Promise((resolve, reject) => {
		const child = spawn(sbx.runtime.bin, ["exec", sbx.name, "sh", "-c", command], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let timedOut = false;
		const timer = timeout
			? setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, timeout * 1000)
			: undefined;
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("error", (e) => {
			if (timer) clearTimeout(timer);
			reject(e);
		});
		const onAbort = () => child.kill("SIGKILL");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (signal?.aborted) reject(new Error("aborted"));
			else if (timedOut) reject(new Error(`timeout:${timeout}`));
			else resolve({ exitCode: code });
		});
	});
}

export function createReadOps(sbx: SbxHandle): ReadOperations {
	const resolveAbs = (p: string) => resolvePath(sbx.hostCwd, p);
	const tryExternal = (p: string): { external: true; abs: string } | { external: false } => {
		if (isInsideCwd(p, sbx.hostCwd)) return { external: false };
		const abs = resolveAbs(p);
		return isAllowedExternalResource(abs, sbx.allowedExternalPrefixes)
			? { external: true, abs }
			: { external: false };
	};

	return {
		readFile: (p) => {
			const ext = tryExternal(p);
			if (ext.external) return Promise.resolve(readFileSync(ext.abs));
			return execCapture(sbx, `cat ${shq(toRemote(p, sbx.hostCwd, sbx.mounts))}`);
		},
		access: (p) => {
			const ext = tryExternal(p);
			if (ext.external) {
				try { statSync(ext.abs); return Promise.resolve(); }
				catch (e) { return Promise.reject(e); }
			}
			return execCapture(sbx, `test -r ${shq(toRemote(p, sbx.hostCwd, sbx.mounts))}`).then(() => {});
		},
		detectImageMimeType: async (p) => {
			const ext = tryExternal(p);
			if (ext.external) {
				const ext2lower = ext.abs.split(".").pop()?.toLowerCase() || "";
				const map: Record<string, string> = {
					jpg: "image/jpeg", jpeg: "image/jpeg",
					png: "image/png", gif: "image/gif", webp: "image/webp",
				};
				return map[ext2lower] || null;
			}
			try {
				const r = await execCapture(sbx, `file --mime-type -b ${shq(toRemote(p, sbx.hostCwd, sbx.mounts))}`);
				const m = r.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
			} catch {
				return null;
			}
		},
	};
}

export function createWriteOps(sbx: SbxHandle): WriteOperations {
	return {
		writeFile: async (p, content) => {
			const remote = toRemote(p, sbx.hostCwd, sbx.mounts);
			if (isReadOnlyMount(remote, sbx.mounts)) {
				throw new Error(`sandbox: refusing to write to ${remote}: read-only skill mount`);
			}
			const buf = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
			const b64 = buf.toString("base64");
			await execCapture(sbx, `printf %s ${shq(b64)} | base64 -d > ${shq(remote)}`);
		},
		mkdir: async (dir) => {
			const remote = toRemote(dir, sbx.hostCwd, sbx.mounts);
			if (isReadOnlyMount(remote, sbx.mounts)) {
				throw new Error(`sandbox: refusing to mkdir in ${remote}: read-only skill mount`);
			}
			await execCapture(sbx, `mkdir -p ${shq(remote)}`);
		},
	};
}

export function createEditOps(sbx: SbxHandle): EditOperations {
	const r = createReadOps(sbx);
	const w = createWriteOps(sbx);
	return {
		readFile: r.readFile,
		access: r.access,
		writeFile: async (p, content) => {
			const remote = toRemote(p, sbx.hostCwd, sbx.mounts);
			if (isReadOnlyMount(remote, sbx.mounts)) {
				throw new Error(`sandbox: refusing to edit ${remote}: read-only skill mount`);
			}
			return w.writeFile(p, content);
		},
	};
}

export function createBashOps(sbx: SbxHandle): BashOperations {
	return {
		exec: (command, cwd, opts) => {
			const remoteCwd = toRemote(cwd, sbx.hostCwd, sbx.mounts);
			return execStream(sbx, `cd ${shq(remoteCwd)} && ${command}`, opts as { onData: (b: Buffer) => void; signal?: AbortSignal; timeout?: number });
		},
	};
}
