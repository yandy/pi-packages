import { describe, expect, it } from "vitest";

import { SessionApproval } from "../src/session-approval";

describe("SessionApproval", () => {
  describe("single", () => {
    it("stores surface and one pattern", () => {
      const approval = SessionApproval.single("bash", "git *");
      expect(approval.surface).toBe("bash");
      expect(approval.patterns).toEqual(["git *"]);
    });

    it("representativePattern returns the pattern", () => {
      const approval = SessionApproval.single("bash", "git *");
      expect(approval.representativePattern).toBe("git *");
    });

    it("toGateApproval returns { surface, pattern }", () => {
      const approval = SessionApproval.single("bash", "git *");
      expect(approval.toGateApproval()).toEqual({
        surface: "bash",
        pattern: "git *",
      });
    });
  });

  describe("multiple", () => {
    it("stores surface and all patterns", () => {
      const approval = SessionApproval.multiple("external_directory", [
        "/outside/a/*",
        "/outside/b/*",
      ]);
      expect(approval.surface).toBe("external_directory");
      expect(approval.patterns).toEqual(["/outside/a/*", "/outside/b/*"]);
    });

    it("representativePattern returns the first pattern", () => {
      const approval = SessionApproval.multiple("external_directory", [
        "/outside/a/*",
        "/outside/b/*",
      ]);
      expect(approval.representativePattern).toBe("/outside/a/*");
    });

    it("toGateApproval returns { surface, pattern } using the first pattern", () => {
      const approval = SessionApproval.multiple("external_directory", [
        "/outside/a/*",
        "/outside/b/*",
      ]);
      expect(approval.toGateApproval()).toEqual({
        surface: "external_directory",
        pattern: "/outside/a/*",
      });
    });

    it("defensive copy — mutating the source array does not affect patterns", () => {
      const source = ["/outside/a/*", "/outside/b/*"];
      const approval = SessionApproval.multiple("external_directory", source);
      source.push("/outside/c/*");
      expect(approval.patterns).toEqual(["/outside/a/*", "/outside/b/*"]);
    });
  });

  describe("empty patterns (degenerate case)", () => {
    it("representativePattern returns undefined", () => {
      const approval = SessionApproval.multiple("external_directory", []);
      expect(approval.representativePattern).toBeUndefined();
    });

    it("toGateApproval returns undefined", () => {
      const approval = SessionApproval.multiple("external_directory", []);
      expect(approval.toGateApproval()).toBeUndefined();
    });
  });
});
