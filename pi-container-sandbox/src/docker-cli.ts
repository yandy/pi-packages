import { container, containerSpawn } from "./container-cli";

export function docker(args: string[], opts?: { timeout?: number }): string {
	return container("docker", args, opts);
}

export function dockerSpawn(
	args: string[],
	opts: {
		timeoutMs?: number;
		signal?: AbortSignal;
		stdin?: string | Buffer;
		onStdout?: (d: Buffer) => void;
		onStderr?: (d: Buffer) => void;
	},
): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number | null; error?: string }> {
	return containerSpawn("docker", args, opts);
}
