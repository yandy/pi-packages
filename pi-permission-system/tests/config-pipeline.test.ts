import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadAndMergeConfigs } from "../src/config-loader";
import { normalizePermissionSystemConfig } from "../src/extension-config";

/**
 * Full-pipeline seam tests: write a temp config.json → loadAndMergeConfigs →
 * normalizePermissionSystemConfig → assert values survive end to end.
 *
 * These tests guard the seam between the two normalizers — the class of bug
 * fixed in #332, where a field declared on PermissionSystemExtensionConfig was
 * silently dropped by the UnifiedPermissionConfig intermediate.
 */
describe("config pipeline seam", () => {
  let tempDir: string;
  let agentDir: string;
  let cwd: string;
  let extensionRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "config-pipeline-test-"));
    agentDir = join(tempDir, "agent");
    cwd = join(tempDir, "project");
    extensionRoot = join(tempDir, "ext");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeGlobal(content: Record<string, unknown>): void {
    const dir = join(agentDir, "extensions", "pi-permission-system");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify(content));
  }

  it("runtime knob and preview-length field both survive the full pipeline", () => {
    writeGlobal({
      debugLog: true,
      toolInputPreviewMaxLength: 1000,
    });

    const mergeResult = loadAndMergeConfigs(agentDir, cwd, extensionRoot);
    const config = normalizePermissionSystemConfig(mergeResult.merged);

    expect(config.debugLog).toBe(true);
    expect(config.toolInputPreviewMaxLength).toBe(1000);
  });

  it("text summary length field survives the full pipeline", () => {
    writeGlobal({
      toolTextSummaryMaxLength: 250,
    });

    const mergeResult = loadAndMergeConfigs(agentDir, cwd, extensionRoot);
    const config = normalizePermissionSystemConfig(mergeResult.merged);

    expect(config.toolTextSummaryMaxLength).toBe(250);
  });

  it("project config overrides global preview-length field end to end", () => {
    writeGlobal({ toolInputPreviewMaxLength: 200 });
    const projectDir = join(cwd, ".pi", "extensions", "pi-permission-system");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "config.json"),
      JSON.stringify({ toolInputPreviewMaxLength: 500 }),
    );

    const mergeResult = loadAndMergeConfigs(agentDir, cwd, extensionRoot);
    const config = normalizePermissionSystemConfig(mergeResult.merged);

    expect(config.toolInputPreviewMaxLength).toBe(500);
  });

  it("defaults apply when config file is absent", () => {
    // No config files written — agentDir and cwd directories don't exist.
    const mergeResult = loadAndMergeConfigs(agentDir, cwd, extensionRoot);
    const config = normalizePermissionSystemConfig(mergeResult.merged);

    expect(config.debugLog).toBe(false);
    expect(config.permissionReviewLog).toBe(true);
    expect(config.yoloMode).toBe(false);
    expect(config.toolInputPreviewMaxLength).toBeUndefined();
    expect(config.toolTextSummaryMaxLength).toBeUndefined();
  });
});
