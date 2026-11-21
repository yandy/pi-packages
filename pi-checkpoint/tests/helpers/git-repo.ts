import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryEnvironmentVariables = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_QUARANTINE_PATH",
] as const;

export interface TestRepo {
	dir: string;
	cleanup: () => Promise<void>;
}

export async function createTestRepo(): Promise<TestRepo> {
	const dir = await mkdtemp(join(tmpdir(), "pi-checkpoint-test-"));
	try {
		await git(dir, "init");
		await git(dir, "config", "user.name", "Checkpoint Test");
		await git(dir, "config", "user.email", "checkpoint-test@localhost");
		await git(dir, "config", "commit.gpgsign", "false");
		return {
			dir,
			cleanup: () => rm(dir, { recursive: true, force: true }),
		};
	} catch (error) {
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		GIT_CONFIG_GLOBAL: join(cwd, ".pi-checkpoint-test-global-config"),
		GIT_CONFIG_NOSYSTEM: "1",
		LC_ALL: "C",
	};
	for (const name of repositoryEnvironmentVariables) delete env[name];
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		env,
		maxBuffer: 16 * 1024 * 1024,
	});
	return stdout.trim();
}

export async function writeRepoFile(cwd: string, relativePath: string, content: string | Buffer): Promise<void> {
	const path = join(cwd, relativePath);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
}

export async function readRepoFile(cwd: string, relativePath: string): Promise<Buffer> {
	return readFile(join(cwd, relativePath));
}
