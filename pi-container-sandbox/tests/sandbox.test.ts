import { describe, it, expect, beforeEach } from "vitest";
import { getSbx, setSbx, clearSbx, type SbxSession } from "../src/sandbox";

const mockSession: SbxSession = {
	runtime: { kind: "docker", bin: "docker", run: async () => "", stop: () => {}, remove: () => {}, exists: async () => false, isRunning: async () => false, start: async () => false, createVolume: async () => false },
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
