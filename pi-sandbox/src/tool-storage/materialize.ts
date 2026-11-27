import { mkdirSync, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { reportConfigWarning } from "../config-warnings";
import type { ToolStoragePlan } from "./detect";

export interface ToolStorageMaterializeDeps {
	mkdir?: typeof mkdirSync;
	warn?: (message: string) => void;
}

function pathApi(plan: ToolStoragePlan) {
	return plan.platform === "win32" ? win32 : posix;
}

function comparable(path: string, plan: ToolStoragePlan): string {
	const normalized = pathApi(plan).normalize(path);
	return plan.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string, plan: ToolStoragePlan): boolean {
	return comparable(left, plan) === comparable(right, plan);
}

/** Whether `child` is the same directory as `root` or below it. */
function isSameOrUnder(child: string, root: string, plan: ToolStoragePlan): boolean {
	const normalizedChild = comparable(child, plan);
	const normalizedRoot = comparable(root, plan);
	if (normalizedChild === normalizedRoot) return true;
	const separator = plan.platform === "win32" ? "\\" : "/";
	const prefix = normalizedRoot.endsWith(separator) ? normalizedRoot : `${normalizedRoot}${separator}`;
	return normalizedChild.startsWith(prefix);
}

/** A non-null reason means the candidate must not be created or granted. */
export function unsafeToolStorageRoot(path: string, plan: ToolStoragePlan): string | null {
	const pathImpl = pathApi(plan);
	if (!pathImpl.isAbsolute(path)) return "path is not absolute";
	const normalized = pathImpl.normalize(path);
	if (samePath(normalized, pathImpl.parse(normalized).root, plan)) return "path is a filesystem root";
	// An automatic root may live below home, but may never contain home itself.
	if (isSameOrUnder(plan.home, normalized, plan)) return "path is home or one of its ancestors";
	for (const shared of plan.sharedRoots) {
		if (samePath(normalized, shared, plan)) return "path is a shared base directory";
	}
	const protectedRoots = [
		plan.agentDir,
		...[".ssh", ".aws", ".gnupg", ".docker", ".kube", ".config", ".pi"].map((name) => pathImpl.join(plan.home, name)),
	];
	for (const protectedRoot of protectedRoots) {
		if (isSameOrUnder(normalized, protectedRoot, plan) || isSameOrUnder(protectedRoot, normalized, plan)) {
			return "path overlaps a configuration, credential, or pi agent directory";
		}
	}
	return null;
}

let warnedRoots = new Set<string>();

export function resetToolStorageWarnings(): void {
	warnedRoots = new Set();
}

function canonicalExisting(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

export function materializeToolStorageRoots(
	plan: ToolStoragePlan,
	deps: ToolStorageMaterializeDeps = {},
): string[] {
	const mkdir = deps.mkdir ?? mkdirSync;
	const warn = deps.warn ?? reportConfigWarning;
	// Protected roots can themselves be links. Compare canonical targets too, so a
	// real path cannot evade the home/agent/credential boundary by changing spelling.
	const safetyPlan: ToolStoragePlan = {
		...plan,
		home: canonicalExisting(plan.home),
		agentDir: canonicalExisting(plan.agentDir),
		sharedRoots: plan.sharedRoots.map(canonicalExisting),
	};
	const result: string[] = [];
	const seen = new Set<string>();
	const reject = (path: string, reason: string): void => {
		const key = `${plan.workspaceRoot}\0${path}`;
		if (warnedRoots.has(key)) return;
		warnedRoots.add(key);
		warn(`sandbox: ignoring built-in tool storage root ${path}: ${reason}`);
	};
	for (const root of plan.roots) {
		const lexicalReason = unsafeToolStorageRoot(root.path, safetyPlan);
		if (lexicalReason !== null) {
			reject(root.path, lexicalReason);
			continue;
		}
		try {
			mkdir(root.path, { recursive: true });
			if (!statSync(root.path).isDirectory()) throw new Error("not a directory");
			const canonical = realpathSync.native(root.path);
			const canonicalReason = unsafeToolStorageRoot(canonical, safetyPlan);
			if (canonicalReason !== null) {
				reject(root.path, `real path ${canonical}: ${canonicalReason}`);
				continue;
			}
			const key = plan.platform === "win32" ? canonical.toLowerCase() : canonical;
			if (seen.has(key)) continue;
			seen.add(key);
			result.push(canonical);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			reject(root.path, `${code ?? "initialization failed"}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return result;
}
