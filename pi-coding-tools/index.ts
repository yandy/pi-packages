import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createApplyPatchTool } from "./src/apply-patch-tool";
import { loadConfig } from "./src/config";
import { enableSearchTools } from "./src/search-tools";

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  if (config.applyPatch) {
    pi.registerTool(createApplyPatchTool());
  }

  pi.on("session_start", async (_event, _ctx) => {
    enableSearchTools(pi, config);
  });
}
