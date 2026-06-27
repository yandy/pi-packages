import { Text } from "@earendil-works/pi-tui";
import type { NotificationDetails } from "../observation/notification";
import { formatMs, formatTokens, formatTurns } from "../ui/display";

/** Narrow theme interface — only the methods the renderer actually calls. */
interface RendererTheme {
  fg(style: string, text: string): string;
  bold(text: string): string;
}

/** Narrow message interface — only the fields the renderer reads. */
interface RendererMessage {
  details?: NotificationDetails;
}

/** Narrow render options — only the fields the renderer reads. */
interface RenderOptions {
  expanded: boolean;
}

/**
 * Create the notification renderer callback for `pi.registerMessageRenderer`.
 * Returns a factory so the renderer is independently testable without the Pi SDK.
 */
export function createNotificationRenderer() {
  return (message: RendererMessage, { expanded }: RenderOptions, theme: RendererTheme): Text | undefined => {
    const d = message.details;
    if (!d) return undefined;

    const isError = d.status === "error" || d.status === "stopped" || d.status === "aborted";
    const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
    const statusText = isError
      ? d.status
      : d.status === "steered"
        ? "completed (steered)"
        : "completed";

    // Line 1: icon + agent description + status
    let line = `${icon} ${theme.bold(d.description)} ${theme.fg("dim", statusText)}`;

    // Line 2: stats
    const parts: string[] = [];
    if (d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
    if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
    if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens));
    if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
    if (parts.length) {
      line += "\n  " + parts.map((p) => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
    }

    // Line 3: result preview (collapsed) or full (expanded)
    if (expanded) {
      const lines = d.resultPreview.split("\n").slice(0, 30);
      for (const l of lines) line += "\n" + theme.fg("dim", `  ${l}`);
    } else {
      const preview = d.resultPreview.split("\n")[0]?.slice(0, 80) ?? "";
      line += "\n  " + theme.fg("dim", `⎿  ${preview}`);
    }

    // Line 4: output file link (if present)
    if (d.outputFile) {
      line += "\n  " + theme.fg("muted", `transcript: ${d.outputFile}`);
    }

    return new Text(line, 0, 0);
  };
}
