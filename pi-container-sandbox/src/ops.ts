import { readFileSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { BashOperations, EditOperations, ReadOperations, WriteOperations } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { hostToContainer, isAllowedExternalResource, isInsideContainer, isReadOnlyMount, containerToHost, shq } from "./paths";
import type { MountSpec, Runtime } from "./runtime";

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
		throw new Error(`exec failed (${result.exitCode}): ${result.stderr.toString("utf-8").trim().slice(0, 500)}`);
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
		timeoutMs: opts.timeout !== undefined ? opts.timeout * 1000 : undefined,
	});
	return { exitCode: result.exitCode };
}

export function createReadOps(sbx: SbxHandle): ReadOperations {
	const resolveAbs = (p: string) => resolvePath(sbx.hostCwd, p);
	const tryExternal = (p: string): { external: true; abs: string } | { external: false } => {
		if (isInsideContainer(p, sbx.hostCwd)) return { external: false };
		const abs = resolveAbs(p);
		return isAllowedExternalResource(abs, sbx.allowedExternalPrefixes) ? { external: true, abs } : { external: false };
	};

	return {
		readFile: (p) => {
			const ext = tryExternal(p);
			if (ext.external) return Promise.resolve(readFileSync(ext.abs));
			return execCapture(sbx, `cat ${shq(hostToContainer(p, sbx.hostCwd, sbx.mounts))}`);
		},
		access: (p) => {
			const ext = tryExternal(p);
			if (ext.external) {
				try {
					statSync(ext.abs);
					return Promise.resolve();
				} catch (e) {
					return Promise.reject(e);
				}
			}
			return execCapture(sbx, `test -r ${shq(hostToContainer(p, sbx.hostCwd, sbx.mounts))}`).then(() => {});
		},
		detectImageMimeType: async (p) => {
			const ext = tryExternal(p);
			if (ext.external) {
				const ext2lower = ext.abs.split(".").pop()?.toLowerCase() || "";
				const map: Record<string, string> = {
					jpg: "image/jpeg",
					jpeg: "image/jpeg",
					png: "image/png",
					gif: "image/gif",
					webp: "image/webp",
				};
				return map[ext2lower] || null;
			}
			try {
				const r = await execCapture(sbx, `file --mime-type -b ${shq(hostToContainer(p, sbx.hostCwd, sbx.mounts))}`);
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
			const containerPath = hostToContainer(p, sbx.hostCwd, sbx.mounts);
			if (isReadOnlyMount(containerPath, sbx.mounts)) {
				throw new Error(`sandbox: refusing to write to ${containerPath}: read-only skill mount`);
			}
			const parentDir = containerPath.split("/").slice(0, -1).join("/") || "/";
			await execCapture(sbx, `mkdir -p ${shq(parentDir)}`);
			const buf = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
			const b64 = buf.toString("base64");
			await execCapture(sbx, `printf %s ${shq(b64)} | base64 -d > ${shq(containerPath)}`);
		},
		mkdir: async (dir) => {
			const containerPath = hostToContainer(dir, sbx.hostCwd, sbx.mounts);
			if (isReadOnlyMount(containerPath, sbx.mounts)) {
				throw new Error(`sandbox: refusing to mkdir in ${containerPath}: read-only skill mount`);
			}
			await execCapture(sbx, `mkdir -p ${shq(containerPath)}`);
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

export function extractCommandName(command: string): string | null {
	const trimmed = command.trimStart();
	if (!trimmed) return null;
	let i = 0;
	while (i < trimmed.length) {
		const eqIdx = trimmed.indexOf("=", i);
		if (eqIdx === -1) break;
		const beforeEq = trimmed.slice(i, eqIdx);
		if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(beforeEq)) {
			i = trimmed.indexOf(" ", eqIdx);
			if (i === -1) return null;
			while (trimmed[i] === " ") i++;
		} else {
			break;
		}
	}
	const rest = trimmed.slice(i);
	const spaceIdx = rest.indexOf(" ");
	return spaceIdx === -1 ? rest || null : rest.slice(0, spaceIdx);
}

export function createHostBashOps(hostCwd: string, mounts: MountSpec[]): BashOperations {
	const hostBash = createLocalBashOperations();
	return {
		exec: (command, cwd, opts) => {
			const mappedCwd = containerToHost(cwd, hostCwd, mounts);
			return hostBash.exec(command, mappedCwd, opts);
		},
	};
}

export function createContainerBashOps(sbx: SbxHandle): BashOperations {
	return {
		exec: (command, cwd, opts) => {
			const containerCwd = hostToContainer(cwd, sbx.hostCwd, sbx.mounts);
			return execStream(
				sbx,
				`cd ${shq(containerCwd)} && ${command}`,
				opts as { onData: (b: Buffer) => void; signal?: AbortSignal; timeout?: number },
			);
		},
	};
}
