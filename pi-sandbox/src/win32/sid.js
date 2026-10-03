/**
 * Deterministic capability SIDs for the Windows ACL sandbox backend.
 *
 * The per-workspace write identity is a `S-1-4-x-y` SID derived from the
 * canonical workspace path, so every confined execution of the same workspace
 * — across sessions, server restarts, and calls — carries the SAME write SID
 * and the standing workspace ACE materializes once per workspace per machine.
 * Temporary directories get a separate, per-directory identity
 * (`S-1-4-x-y-1`) whose third sub-authority domain-separates it from every
 * two-sub-authority workspace SID; sharing the workspace identity with temp
 * would let sibling sessions write one another's temp trees.
 *
 * The callers pass canonical paths (`realpathSync.native`) — these functions
 * are pure and never touch the filesystem. `canonicalSidInput` only folds
 * spelling differences (separators, trailing separators, Windows case) so two
 * spellings of one directory derive one SID; NTFS is case-insensitive, so a
 * case difference must not mint a second half-granted capability. The folded
 * form is the canonical Windows spelling used for derivation: upper-case drive
 * letter, lower-case remainder. The derivation functions stay byte-sensitive
 * (the caller's contract), so the golden SID vectors pin the formula itself.
 *
 * Derivation ported verbatim from deepseek-harness (MIT):
 * packages/sandbox/sandbox-windows-acl/src/workspace-sid.ts.
 * @module
 */

import { createHash } from "node:crypto";

/** SDDL prefix of a Windows capability SID whose sub-authorities are 30-bit values. */
const CAPABILITY_SID_PREFIX = "S-1-4-";

/** Largest 30-bit unsigned value; sub-authorities are reduced into `[1, 2^30 - 1]`. */
const SUB_AUTHORITY_MODULUS = 2 ** 30 - 1;

/** Matches any drive-letter path (`C:\...`, `C:/...`). */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/** Matches a UNC share root (`\\server\share`); it is the shortest form of that volume path. */
const UNC_SHARE_ROOT = /^\\\\[^\\]+\\[^\\]+/;

/**
 * Whether a path is spelled the way only Windows spells paths (drive-letter or
 * UNC). This backend always receives Windows paths; a POSIX path cannot be
 * matched by these shapes, so POSIX inputs stay case-sensitive.
 * @param path - the separator-normalized path.
 */
function isWindowsSpelled(path) {
	return process.platform === "win32" || DRIVE_PATH.test(path) || path.startsWith("\\\\");
}

/**
 * Length of the shortest prefix that must not be stripped from a directory
 * path: a drive root (`C:\`) or UNC share root (`\\server\share`) keeps its
 * trailing separator; everything else keeps at least its first character.
 * @param path - the separator-normalized path.
 */
function rootFloor(path) {
	if (DRIVE_PATH.test(path)) return 3;
	const share = UNC_SHARE_ROOT.exec(path);
	if (share !== null) return share[0].length;
	// A bare `\\server` or device path (`\\.\C:`) has no share component to
	// stop stripping at; leave it exactly as spelled.
	if (path.startsWith("\\\\")) return path.length;
	return 1;
}

/**
 * Fold the spelling of a directory path so that every spelling of one
 * directory derives the same capability SID. Strips trailing `\`/`/` (keeping
 * `C:\` and `\\server\share` roots), unifies `/` to `\`, and case-folds
 * Windows-spelled paths (on a win32 host, every path — NTFS is
 * case-insensitive) to the canonical drive-upper/rest-lower form. Performs no
 * filesystem access: the caller has already resolved the path with
 * `realpathSync.native`.
 * @param path - the canonical absolute directory path.
 * @returns the normalized spelling handed to the SID hash.
 */
export function canonicalSidInput(path) {
	let normalized = path.replaceAll("/", "\\");
	const floor = rootFloor(normalized);
	while (normalized.length > floor && normalized.endsWith("\\")) {
		normalized = normalized.slice(0, -1);
	}
	if (!isWindowsSpelled(normalized)) return normalized;
	normalized = normalized.toLowerCase();
	// Keep the drive letter upper-case: `realpathSync.native` renders `C:` so,
	// and the golden vectors are the SIDs of that spelling.
	return /^[a-z]:/.test(normalized) ? normalized[0].toUpperCase() + normalized.slice(1) : normalized;
}

/**
 * Derive the workspace's write SID (`S-1-4-x-y`; 30-bit sub-authorities,
 * matching the capability shape the token and ACE layers carry).
 * @param workspaceRoot - the canonical workspace path.
 * @returns the SDDL string form.
 */
export function workspaceWriteSid(workspaceRoot) {
	const digest = createHash("sha256").update(workspaceRoot, "utf8").digest();
	const first = (digest.readUInt32LE(0) % SUB_AUTHORITY_MODULUS) + 1;
	const second = (digest.readUInt32LE(4) % SUB_AUTHORITY_MODULUS) + 1;
	return `${CAPABILITY_SID_PREFIX}${first}-${second}`;
}

/**
 * Derive one private temp directory's write SID. The random directory path is
 * the capability identity; a fixed third sub-authority (`-1`)
 * domain-separates the result from every two-sub-authority workspace SID.
 * @param tempDir - the private temp directory's absolute path.
 * @returns the SDDL string form.
 */
export function tempWriteSid(tempDir) {
	const digest = createHash("sha256").update("temp\0", "utf8").update(tempDir, "utf8").digest();
	const first = (digest.readUInt32LE(0) % SUB_AUTHORITY_MODULUS) + 1;
	const second = (digest.readUInt32LE(4) % SUB_AUTHORITY_MODULUS) + 1;
	return `${CAPABILITY_SID_PREFIX}${first}-${second}-1`;
}

/**
 * Reject a temp root nested strictly inside the workspace. The temp grant's
 * inheritable ACE would cover directories below the temp root that also sit
 * inside the workspace, blurring the two capabilities' semantics. The reverse
 * nesting (workspace inside temp) is allowed: it is redundant authorization,
 * not an error; equal roots are allowed too.
 * @param workspaceRoot - the workspace root that carries the standing ACE.
 * @param tempRoot - the temp root that carries the temp ACE.
 */
export function assertGrantRootsDisjoint(workspaceRoot, tempRoot) {
	const workspace = canonicalSidInput(workspaceRoot);
	const temp = canonicalSidInput(tempRoot);
	if (workspace.length === 0) return;
	// Compare on a separator boundary: `C:\work` must not match `C:\workshop`.
	const prefix = workspace.endsWith("\\") ? workspace : `${workspace}\\`;
	if (temp.startsWith(prefix)) {
		throw new Error(
			`Windows ACL temp root must not be inside the workspace: workspace=${workspaceRoot}; temp=${tempRoot}`,
		);
	}
}
