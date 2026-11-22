import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerInsightCommand } from "./src/command";

export default function (pi: ExtensionAPI): void {
	registerInsightCommand(pi);
}
