import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopedPermissionManager } from "../src/permission-manager";
import { LocalPermissionsService } from "../src/permissions-service";
import type { Ruleset } from "../src/rule";
import type { SessionRules } from "../src/session-rules";
import type { ToolAccessExtractorRegistrar } from "../src/tool-access-extractor-registry";
import type { ToolInputFormatter, ToolInputFormatterRegistrar } from "../src/tool-input-formatter-registry";

import { makeCheckResult } from "./helpers/handler-fixtures";
import { makeFakePermissionManager } from "./helpers/session-fixtures";

// ── input-normalizer stub ──────────────────────────────────────────────────

const mockBuildInputForSurface = vi.hoisted(() => vi.fn<(surface: string, value?: string) => unknown>());

vi.mock("../src/input-normalizer", () => ({
	buildInputForSurface: mockBuildInputForSurface,
}));

// ── helpers ────────────────────────────────────────────────────────────────

function makeSessionRules(rules: Ruleset = []): Pick<SessionRules, "getRuleset"> {
	return {
		getRuleset: vi.fn<SessionRules["getRuleset"]>().mockReturnValue(rules),
	};
}

function makeFormatterRegistry(): ToolInputFormatterRegistrar {
	return {
		register: vi.fn<ToolInputFormatterRegistrar["register"]>().mockReturnValue(vi.fn()),
	};
}

function makeAccessExtractorRegistry(): ToolAccessExtractorRegistrar {
	return {
		register: vi.fn<ToolAccessExtractorRegistrar["register"]>().mockReturnValue(vi.fn()),
	};
}

function makeService(overrides?: {
	permissionManager?: ScopedPermissionManager;
	sessionRules?: Pick<SessionRules, "getRuleset">;
	formatterRegistry?: ToolInputFormatterRegistrar;
	accessExtractorRegistry?: ToolAccessExtractorRegistrar;
}) {
	const permissionManager = overrides?.permissionManager ?? makeFakePermissionManager();
	const sessionRules = overrides?.sessionRules ?? makeSessionRules();
	const formatterRegistry = overrides?.formatterRegistry ?? makeFormatterRegistry();
	const accessExtractorRegistry = overrides?.accessExtractorRegistry ?? makeAccessExtractorRegistry();
	const service = new LocalPermissionsService(
		permissionManager,
		sessionRules,
		formatterRegistry,
		accessExtractorRegistry,
	);
	return {
		service,
		permissionManager,
		sessionRules,
		formatterRegistry,
		accessExtractorRegistry,
	};
}

// ── tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
	mockBuildInputForSurface.mockReset();
	mockBuildInputForSurface.mockReturnValue({ type: "tool-input" });
});

describe("checkPermission", () => {
	it("builds the surface input from surface and value", () => {
		const { service } = makeService();
		service.checkPermission("bash", "echo hi");
		expect(mockBuildInputForSurface).toHaveBeenCalledWith("bash", "echo hi");
	});

	it("builds the surface input with undefined value when value is omitted", () => {
		const { service } = makeService();
		service.checkPermission("read");
		expect(mockBuildInputForSurface).toHaveBeenCalledWith("read", undefined);
	});

	it("calls permissionManager.check with a tool intent, built input, agentName, and current ruleset", () => {
		const ruleset: Ruleset = [{ surface: "bash", pattern: "*", action: "allow", origin: "global" }];
		const builtInput = { type: "bash-input" };
		mockBuildInputForSurface.mockReturnValue(builtInput);
		const { service, permissionManager, sessionRules } = makeService({
			sessionRules: makeSessionRules(ruleset),
		});
		service.checkPermission("bash", "echo hi", "my-agent");
		expect(permissionManager.check).toHaveBeenCalledWith(
			{
				kind: "tool",
				surface: "bash",
				input: builtInput,
				agentName: "my-agent",
			},
			ruleset,
		);
		void sessionRules; // used indirectly
	});

	it("returns the result from permissionManager.check", () => {
		const expected = makeCheckResult({ state: "deny", toolName: "bash" });
		const { service, permissionManager } = makeService();
		vi.mocked(permissionManager.check).mockReturnValue(expected);
		const result = service.checkPermission("bash", "rm -rf /");
		expect(result).toBe(expected);
	});
});

describe("getToolPermission", () => {
	it("delegates to permissionManager.getToolPermission", () => {
		const { service, permissionManager } = makeService();
		vi.mocked(permissionManager.getToolPermission).mockReturnValue("deny");
		const result = service.getToolPermission("write", "my-agent");
		expect(permissionManager.getToolPermission).toHaveBeenCalledWith("write", "my-agent");
		expect(result).toBe("deny");
	});

	it("omits agentName when not provided", () => {
		const { service, permissionManager } = makeService();
		service.getToolPermission("read");
		expect(permissionManager.getToolPermission).toHaveBeenCalledWith("read", undefined);
	});
});

describe("registerToolInputFormatter", () => {
	it("delegates to formatterRegistry.register and returns the unsubscribe function", () => {
		const unsub = vi.fn();
		const { service, formatterRegistry } = makeService();
		vi.mocked(formatterRegistry.register).mockReturnValue(unsub);
		const formatter: ToolInputFormatter = vi.fn();
		const result = service.registerToolInputFormatter("my-tool", formatter);
		expect(formatterRegistry.register).toHaveBeenCalledWith("my-tool", formatter);
		expect(result).toBe(unsub);
	});
});

describe("registerToolAccessExtractor", () => {
	it("delegates to accessExtractorRegistry.register and returns the unsubscribe function", () => {
		const unsub = vi.fn();
		const { service, accessExtractorRegistry } = makeService();
		vi.mocked(accessExtractorRegistry.register).mockReturnValue(unsub);
		const extractor = vi.fn();
		const result = service.registerToolAccessExtractor("ffgrep", extractor);
		expect(accessExtractorRegistry.register).toHaveBeenCalledWith("ffgrep", extractor);
		expect(result).toBe(unsub);
	});
});
