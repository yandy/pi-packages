import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./src/config";
import { enableSearchTools } from "./src/search-tools";

export default function (pi: ExtensionAPI) {
	const config = loadConfig();

	pi.on("session_start", async (_event, _ctx) => {
		enableSearchTools(pi, config);
	});
}
