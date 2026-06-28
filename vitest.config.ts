import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: ["pi-ask-user", "pi-coding-tools", "pi-container-sandbox", "pi-web-tools", "pi-todo", "pi-vision-tools"],
	},
});
