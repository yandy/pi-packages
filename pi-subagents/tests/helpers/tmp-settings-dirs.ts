import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Shared filesystem fixture for the two-layer (global + project) settings tests.
 *
 * Creates two tmp directories — a global scope (passed as `agentDir`) and a
 * project scope (passed as `cwd`) — and exposes write helpers that land JSON at
 * the global file (`<globalDir>/<filename>`) and the project file
 * (`<projectDir>/.pi/<filename>`). Call `dispose()` in `afterEach`.
 */
export interface SettingsDirs {
  /** Global scope — pass as `agentDir`. */
  globalDir: string;
  /** Project scope — pass as `cwd`. */
  projectDir: string;
  /** Absolute path to the global settings file. */
  globalFile: () => string;
  /** Absolute path to the project settings file (`<projectDir>/.pi/<filename>`). */
  projectFile: () => string;
  /** Write `obj` as JSON to the global file. */
  writeGlobal: (obj: unknown) => void;
  /** Write `obj` as JSON to the project file, creating `<projectDir>/.pi/` first. */
  writeProject: (obj: unknown) => void;
  /** Remove both tmp directories. */
  dispose: () => void;
}

/** Stand up the global + project tmp directories for a settings file named `filename`. */
export function createSettingsDirs(filename: string): SettingsDirs {
  const globalDir = mkdtempSync(join(tmpdir(), "pi-settings-global-"));
  const projectDir = mkdtempSync(join(tmpdir(), "pi-settings-project-"));
  const globalFile = () => join(globalDir, filename);
  const projectFile = () => join(projectDir, ".pi", filename);
  return {
    globalDir,
    projectDir,
    globalFile,
    projectFile,
    writeGlobal(obj: unknown) {
      writeFileSync(globalFile(), JSON.stringify(obj));
    },
    writeProject(obj: unknown) {
      mkdirSync(join(projectDir, ".pi"), { recursive: true });
      writeFileSync(projectFile(), JSON.stringify(obj));
    },
    dispose() {
      rmSync(globalDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    },
  };
}
