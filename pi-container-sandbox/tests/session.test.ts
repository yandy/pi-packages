import { beforeEach, describe, expect, it } from "vitest";
import { clearSbx, getSbx, type SbxSession, setSbx } from "../src/session";

const mockSession: SbxSession = {
	runtime: { exec: async () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }) } as any,
	name: "test-container",
	hostCwd: "/tmp/test",
	keep: false,
	mounts: [],
	allowedExternalPrefixes: [],
	imageRef: "pi-sandbox:latest",
	config: { image: "pi-sandbox", tag: "latest", containerName: null, tier: "medium", persist: false, cacheVolume: null },
	isReusable: false,
	isReattached: false,
};

beforeEach(() => {
	clearSbx();
});

describe("session state", () => {
	it("starts with null session", () => {
		expect(getSbx()).toBeNull();
	});
	it("set and get round-trip", () => {
		setSbx(mockSession);
		expect(getSbx()).toBe(mockSession);
	});
	it("clear resets to null", () => {
		setSbx(mockSession);
		clearSbx();
		expect(getSbx()).toBeNull();
	});
});
