import { readFileSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { ReadOperations, WriteOperations, EditOperations, BashOperations } from "@earendil-works/pi-coding-agent";
import type { MountSpec, Runtime } from "./runtime";
import { hostToRemote, isReadOnlyMount, isInsideCwd, isAllowedExternalResource, shq } from "./paths";

export interface SbxHandle {
	runtime: Runtime;
	name: string;
	hostCwd: string;
	mounts: MountSpec[];
	allowedExternalPrefixes: string[];
}

export async function execCapture(sbx: SbxHandle, command: string, timeoutMs?: number): Promise<Buffer> {
	const result = await sbx.runtime.exec({
		cmd: ["sh", "-c", command],
		timeoutMs,
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`exec failed (${result.exitCode}): ${result.stderr.toString("utf-8").trim().slice(0, 500)}`,
		);
	}
	return result.stdout;
}

export async function execStream(
	sbx: SbxHandle,
	command: string,
	opts: { onData: (b: Buffer) => void; signal?: AbortSignal; timeout?: number },
): Promise<{ exitCode: number | null }> {
	const result = await sbx.runtime.exec({
		cmd: ["sh", "-c", command],
		onData: opts.onData,
		signal: opts.signal,
		timeoutMs: opts.timeout,
	});
	return { exitCode: result.exitCode };
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
			return execCapture(sbx, `cat ${shq(hostToRemote(p, sbx.hostCwd, sbx.mounts))}`);
		},
		access: (p) => {
			const ext = tryExternal(p);
			if (ext.external) {
				try { statSync(ext.abs); return Promise.resolve(); }
				catch (e) { return Promise.reject(e); }
			}
			return execCapture(sbx, `test -r ${shq(hostToRemote(p, sbx.hostCwd, sbx.mounts))}`).then(() => {});
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
				const r = await execCapture(sbx, `file --mime-type -b ${shq(hostToRemote(p, sbx.hostCwd, sbx.mounts))}`);
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
			const remote = hostToRemote(p, sbx.hostCwd, sbx.mounts);
			if (isReadOnlyMount(remote, sbx.mounts)) {
				throw new Error(`sandbox: refusing to write to ${remote}: read-only skill mount`);
			}
			const parentDir = remote.split("/").slice(0, -1).join("/") || "/";
			await execCapture(sbx, `mkdir -p ${shq(parentDir)}`);
			const buf = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
			const b64 = buf.toString("base64");
			await execCapture(sbx, `printf %s ${shq(b64)} | base64 -d > ${shq(remote)}`);
		},
		mkdir: async (dir) => {
			const remote = hostToRemote(dir, sbx.hostCwd, sbx.mounts);
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
		writeFile: (p, content) => w.writeFile(p, content),
	};
}

export function createBashOps(sbx: SbxHandle): BashOperations {
	return {
		exec: (command, cwd, opts) => {
			const remoteCwd = hostToRemote(cwd, sbx.hostCwd, sbx.mounts);
			return execStream(sbx, `cd ${shq(remoteCwd)} && ${command}`, opts as { onData: (b: Buffer) => void; signal?: AbortSignal; timeout?: number });
		},
	};
}
