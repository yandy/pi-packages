import type { ExecOpts, ExecResult, Runtime } from "../src/runtime";
import type { SbxConfig } from "../src/config";
import { type SbxSession, setSbx } from "../src/session";

const DEFAULT_CONFIG: SbxConfig = {
	image: "pi-sandbox",
	tag: "latest",
	containerName: null,
	tier: "medium",
	persist: false,
	cacheVolume: null,
};

export function mockRuntime(overrides?: Partial<Runtime>): Runtime {
	return {
		init: async () => {},
		isReady: () => true,
		imageExists: async () => true,
		buildImage: async () => {},
		startContainer: async () => {},
		withReady: async () => {},
		shutdown: async () => {},
		getContainerId: () => "mock-id",
		getWorkRoot: () => "/workspace",
		getImage: () => "img:latest",
		exec: async (_opts: ExecOpts): Promise<ExecResult> => ({
			exitCode: 0,
			stdout: Buffer.alloc(0),
			stderr: Buffer.alloc(0),
		}),
		...overrides,
	};
}

export function createTestSession(overrides?: Partial<SbxSession>): SbxSession {
	return {
		runtime: mockRuntime(),
		name: "test-box",
		hostCwd: "/tmp",
		keep: false,
		mounts: [],
		allowedExternalPrefixes: [],
		imageRef: "img:latest",
		config: { ...DEFAULT_CONFIG, ...overrides?.config },
		isReusable: false,
		isReattached: false,
		...overrides,
	};
}

export function mockSbx(overrides?: Partial<SbxSession>): SbxSession {
	const session = createTestSession(overrides);
	setSbx(session);
	return session;
}
