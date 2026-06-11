import { describe, it, expect, beforeEach } from "vitest";
import { getSbx, setSbx, clearSbx, type SbxSession } from "../src/session";

const mockSession: SbxSession = {
	runtime: { init: async () => {}, isReady: () => true, ensureImage: async () => {}, rebuildImage: async () => {}, startContainer: async () => {}, withReady: async () => {}, exec: async () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }), shutdown: async () => {}, getContainerId: () => null, getWorkRoot: () => "/workspace" },
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
