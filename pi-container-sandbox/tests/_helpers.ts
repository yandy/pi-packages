import type { ExecOpts, ExecResult, Runtime } from "../src/runtime";
import { type SbxSession, setSbx } from "../src/session";

export function mockRuntime(overrides?: Partial<Runtime>): Runtime {
	return {
		init: async () => {},
		isReady: () => true,
		ensureImage: async () => {},
		rebuildImage: async () => {},
		startContainer: async () => {},
		withReady: async () => {},
		shutdown: async () => {},
		getContainerId: () => "mock-id",
		getWorkRoot: () => "/workspace",
		exec: async (_opts: ExecOpts): Promise<ExecResult> => ({
			exitCode: 0,
			stdout: Buffer.alloc(0),
			stderr: Buffer.alloc(0),
		}),
		...overrides,
	};
}

export function mockSbx(overrides?: Partial<SbxSession>): SbxSession {
	const session: SbxSession = {
		runtime: mockRuntime(),
		name: "test-box",
		hostCwd: "/tmp",
		keep: false,
		mounts: [],
		allowedExternalPrefixes: [],
		imageRef: "img:latest",
		config: {
			image: "pi-sandbox",
			tag: "latest",
			containerName: null,
			tier: "medium",
			persist: false,
			cacheVolume: null,
		} as any,
		isReusable: false,
		isReattached: false,
		...overrides,
	};
	setSbx(session);
	return session;
}
