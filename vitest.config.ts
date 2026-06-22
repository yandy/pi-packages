import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: ["pi-coding-tools", "pi-container-sandbox", "pi-web-tools"],
	},
});
