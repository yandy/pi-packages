import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInputForSurface } from "../src/input-normalizer";
import type { PermissionsService } from "../src/service";
import { getPermissionsService, publishPermissionsService, unpublishPermissionsService } from "../src/service";
import { ToolAccessExtractorRegistry } from "../src/tool-access-extractor-registry";
import { ToolInputFormatterRegistry } from "../src/tool-input-formatter-registry";
import type { PermissionCheckResult } from "../src/types";

// ── helpers ────────────────────────────────────────────────────────────────

function makeService(overrides: Partial<PermissionsService> = {}): PermissionsService {
	return {
		checkPermission: vi.fn(),
		getToolPermission: vi.fn(),
		registerToolInputFormatter: vi.fn(),
		registerToolAccessExtractor: vi.fn(),
		...overrides,
	};
}

// ── globalThis accessor ────────────────────────────────────────────────────

describe("globalThis accessor", () => {
	afterEach(() => {
		const current = getPermissionsService();
		if (current) {
			unpublishPermissionsService(current);
		}
	});

	it("returns undefined when nothing has been published", () => {
		expect(getPermissionsService()).toBeUndefined();
	});

	it("returns the published service", () => {
		const service = makeService();
		publishPermissionsService(service);
		expect(getPermissionsService()).toBe(service);
	});

	it("overwrites a previously published service", () => {
		const first = makeService();
		const second = makeService();
		publishPermissionsService(first);
		publishPermissionsService(second);
		expect(getPermissionsService()).toBe(second);
	});

	it("removes the slot when it still holds the given service", () => {
		const service = makeService();
		publishPermissionsService(service);
		unpublishPermissionsService(service);
		expect(getPermissionsService()).toBeUndefined();
	});

	it("does not remove the slot when a different service occupies it", () => {
		const parent = makeService();
		const child = makeService();
		publishPermissionsService(parent);
		// A child instance never published `parent`; unpublishing its own service
		// must be a no-op that leaves the parent's slot intact.
		unpublishPermissionsService(child);
		expect(getPermissionsService()).toBe(parent);
	});

	it("unpublish is safe to call when nothing was published", () => {
		expect(() => unpublishPermissionsService(makeService())).not.toThrow();
		expect(getPermissionsService()).toBeUndefined();
	});
});

// ── service adapter delegation ─────────────────────────────────────────────

describe("service adapter delegation", () => {
	afterEach(() => {
		const current = getPermissionsService();
		if (current) {
			unpublishPermissionsService(current);
		}
	});

	const fakeResult: PermissionCheckResult = {
		toolName: "bash",
		state: "allow",
		matchedPattern: "git *",
		source: "bash",
		origin: "global",
	};

	it("checkPermission delegates surface and value through buildInputForSurface", () => {
		const checkPermission = vi.fn().mockReturnValue(fakeResult);
		const sessionRules = [
			{
				surface: "bash",
				pattern: "*",
				action: "allow" as const,
				layer: "session" as const,
				origin: "session" as const,
			},
		];

		// Build the adapter the same way index.ts will
		const service = makeService({
			checkPermission(surface, value, agentName) {
				const input = buildInputForSurface(surface, value);
				return checkPermission(surface, input, agentName, sessionRules);
			},
		});

		publishPermissionsService(service);
		const retrieved = getPermissionsService()!;
		const result = retrieved.checkPermission("bash", "git push");

		expect(result).toBe(fakeResult);
		expect(checkPermission).toHaveBeenCalledWith("bash", { command: "git push" }, undefined, sessionRules);
	});

	it("checkPermission passes agentName through", () => {
		const checkPermission = vi.fn().mockReturnValue(fakeResult);

		const service = makeService({
			checkPermission(surface, value, agentName) {
				const input = buildInputForSurface(surface, value);
				return checkPermission(surface, input, agentName, []);
			},
		});

		publishPermissionsService(service);
		getPermissionsService()!.checkPermission("skill", "my-skill", "Explore");

		expect(checkPermission).toHaveBeenCalledWith("skill", { name: "my-skill" }, "Explore", []);
	});

	it("getToolPermission delegates to the permission manager", () => {
		const getToolPermissionFn = vi.fn((_t: string, _a?: string): "deny" => "deny");
		const service: PermissionsService = {
			checkPermission: vi.fn(),
			getToolPermission(toolName, agentName) {
				return getToolPermissionFn(toolName, agentName);
			},
			registerToolInputFormatter: vi.fn(),
			registerToolAccessExtractor: vi.fn(),
		};

		publishPermissionsService(service);
		const result = getPermissionsService()!.getToolPermission("bash", "Explore");

		expect(result).toBe("deny");
		expect(getToolPermissionFn).toHaveBeenCalledWith("bash", "Explore");
	});

	it("getToolPermission works without agentName", () => {
		const getToolPermissionFn = vi.fn((_t: string, _a?: string): "ask" => "ask");
		const service: PermissionsService = {
			checkPermission: vi.fn(),
			getToolPermission(toolName, agentName) {
				return getToolPermissionFn(toolName, agentName);
			},
			registerToolInputFormatter: vi.fn(),
			registerToolAccessExtractor: vi.fn(),
		};

		publishPermissionsService(service);
		const result = getPermissionsService()!.getToolPermission("write");

		expect(result).toBe("ask");
		expect(getToolPermissionFn).toHaveBeenCalledWith("write", undefined);
	});

	it("checkPermission uses empty object for unknown surfaces", () => {
		const checkPermission = vi.fn().mockReturnValue(fakeResult);

		const service = makeService({
			checkPermission(surface, value, agentName) {
				const input = buildInputForSurface(surface, value);
				return checkPermission(surface, input, agentName, []);
			},
		});

		publishPermissionsService(service);
		getPermissionsService()!.checkPermission("read", "/tmp/file");

		expect(checkPermission).toHaveBeenCalledWith("read", {}, undefined, []);
	});
});

// ── registerToolInputFormatter delegation ─────────────────────────────────

describe("registerToolInputFormatter delegation", () => {
	afterEach(() => {
		const current = getPermissionsService();
		if (current) {
			unpublishPermissionsService(current);
		}
	});

	it("delegates to the registry and returns its disposer", () => {
		const registry = new ToolInputFormatterRegistry();
		const formatter = () => "preview";

		const service = makeService({
			registerToolInputFormatter(toolName, fmt) {
				return registry.register(toolName, fmt);
			},
		});

		publishPermissionsService(service);
		const dispose = getPermissionsService()!.registerToolInputFormatter("my-tool", formatter);

		// Registry received the registration
		expect(registry.get("my-tool")).toBe(formatter);

		// Disposer returned from service removes it from the registry
		dispose();
		expect(registry.get("my-tool")).toBeUndefined();
	});

	it("throws when a formatter is already registered for the tool name", () => {
		const registry = new ToolInputFormatterRegistry();
		registry.register("my-tool", () => undefined);

		const service = makeService({
			registerToolInputFormatter(toolName, fmt) {
				return registry.register(toolName, fmt);
			},
		});

		publishPermissionsService(service);
		expect(() => getPermissionsService()!.registerToolInputFormatter("my-tool", () => "")).toThrow("my-tool");
	});
});

// ── registerToolAccessExtractor delegation (#352) ────────────────────────

describe("registerToolAccessExtractor delegation", () => {
	afterEach(() => {
		const current = getPermissionsService();
		if (current) {
			unpublishPermissionsService(current);
		}
	});

	it("delegates to the registry and returns its disposer", () => {
		const registry = new ToolAccessExtractorRegistry();
		const extractor = () => "/etc/hosts";

		const service = makeService({
			registerToolAccessExtractor(toolName, ext) {
				return registry.register(toolName, ext);
			},
		});

		publishPermissionsService(service);
		const dispose = getPermissionsService()!.registerToolAccessExtractor("ffgrep", extractor);

		expect(registry.get("ffgrep")).toBe(extractor);

		dispose();
		expect(registry.get("ffgrep")).toBeUndefined();
	});

	it("throws when an extractor is already registered for the tool name", () => {
		const registry = new ToolAccessExtractorRegistry();
		registry.register("ffgrep", () => undefined);

		const service = makeService({
			registerToolAccessExtractor(toolName, ext) {
				return registry.register(toolName, ext);
			},
		});

		publishPermissionsService(service);
		expect(() => getPermissionsService()!.registerToolAccessExtractor("ffgrep", () => "")).toThrow("ffgrep");
	});
});
