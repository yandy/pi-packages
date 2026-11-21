import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: ["pi-ask-user", "pi-checkpoint", "pi-coding-tools", "pi-notify", "pi-web-tools", "pi-todo", "pi-vision-tools", "pi-sandbox", "pi-subagents"],
	},
});
