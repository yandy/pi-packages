// ---- Narrow interfaces ----

/** Narrow settings interface required by the subagents:settings command. */
export interface SubagentsSettingsManager {
  readonly maxConcurrent: number;
  readonly defaultMaxTurns: number | undefined;
  readonly graceTurns: number;
  applyMaxConcurrent(n: number): { message: string; level: "info" | "warning" };
  applyDefaultMaxTurns(n: number): { message: string; level: "info" | "warning" };
  applyGraceTurns(n: number): { message: string; level: "info" | "warning" };
}

/** Narrow UI interface — only the ctx.ui methods the settings handler calls. */
export interface SubagentsSettingsUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, defaultValue?: string): Promise<string | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

// ---- Class ----

/**
 * Handler for the `/subagents:settings` slash command.
 *
 * Call `handle({ ui })` from the Pi command registration to open the interactive
 * settings list. Lifted from `AgentsMenuHandler.showSettings`.
 */
export class SubagentsSettingsHandler {
  constructor(private readonly settings: SubagentsSettingsManager) {}

  async handle({ ui }: { ui: SubagentsSettingsUI }): Promise<void> {
    const choice = await ui.select("Settings", [
      `Max concurrency (current: ${this.settings.maxConcurrent})`,
      `Default max turns (current: ${this.settings.defaultMaxTurns ?? "unlimited"})`,
      `Grace turns (current: ${this.settings.graceTurns})`,
    ]);
    if (!choice) return;

    if (choice.startsWith("Max concurrency")) {
      const val = await ui.input(
        "Max concurrent background agents",
        String(this.settings.maxConcurrent),
      );
      if (val) {
        const n = parseInt(val, 10);
        if (n >= 1) {
          const toast = this.settings.applyMaxConcurrent(n);
          ui.notify(toast.message, toast.level);
        } else {
          ui.notify("Must be a positive integer.", "warning");
        }
      }
    } else if (choice.startsWith("Default max turns")) {
      const val = await ui.input(
        "Default max turns before wrap-up (0 = unlimited)",
        String(this.settings.defaultMaxTurns ?? 0),
      );
      if (val) {
        const n = parseInt(val, 10);
        if (n >= 0) {
          const toast = this.settings.applyDefaultMaxTurns(n);
          ui.notify(toast.message, toast.level);
        } else {
          ui.notify("Must be 0 (unlimited) or a positive integer.", "warning");
        }
      }
    } else if (choice.startsWith("Grace turns")) {
      const val = await ui.input(
        "Grace turns after wrap-up steer",
        String(this.settings.graceTurns),
      );
      if (val) {
        const n = parseInt(val, 10);
        if (n >= 1) {
          const toast = this.settings.applyGraceTurns(n);
          ui.notify(toast.message, toast.level);
        } else {
          ui.notify("Must be a positive integer.", "warning");
        }
      }
    }
  }
}
